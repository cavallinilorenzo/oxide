use oxide_core::Core;
use rusqlite::Connection;

fn user_version(path: &std::path::Path) -> u32 {
    Connection::open(path)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}

#[test]
fn creates_home_and_lists_no_projects() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join(".oxide");

    let core = Core::open(&home).unwrap();

    assert!(home.join("oxide.db").exists());
    assert_eq!(core.list_projects().unwrap(), vec![]);
}

#[test]
fn database_uses_wal() {
    let tmp = tempfile::tempdir().unwrap();
    let core = Core::open(tmp.path()).unwrap();
    drop(core);
    let mode: String = Connection::open(tmp.path().join("oxide.db"))
        .unwrap()
        .pragma_query_value(None, "journal_mode", |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

#[test]
fn fresh_database_migrates_to_latest_without_backup() {
    let tmp = tempfile::tempdir().unwrap();
    Core::open(tmp.path()).unwrap();

    assert_eq!(
        user_version(&tmp.path().join("oxide.db")),
        oxide_core::MIGRATIONS.len() as u32
    );
    assert!(!tmp.path().join("oxide.db.bak-0").exists());
}

#[test]
fn migration_bumps_user_version_after_backing_up_previous_version() {
    let tmp = tempfile::tempdir().unwrap();
    let db = tmp.path().join("oxide.db");
    let v1 = "CREATE TABLE a (x INTEGER); INSERT INTO a VALUES (7);";
    let v2 = "CREATE TABLE b (y INTEGER);";

    drop(Core::open_with_migrations(tmp.path(), &[v1]).unwrap());
    assert_eq!(user_version(&db), 1);
    assert!(!tmp.path().join("oxide.db.bak-1").exists());

    drop(Core::open_with_migrations(tmp.path(), &[v1, v2]).unwrap());
    assert_eq!(user_version(&db), 2);

    let backup = tmp.path().join("oxide.db.bak-1");
    assert_eq!(user_version(&backup), 1);
    let rows: i64 = Connection::open(&backup)
        .unwrap()
        .query_row("SELECT x FROM a", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 7);
}

#[test]
fn refuses_a_database_from_a_newer_build() {
    let tmp = tempfile::tempdir().unwrap();
    drop(Core::open_with_migrations(tmp.path(), &["SELECT 1;", "SELECT 2;"]).unwrap());

    let err = Core::open_with_migrations(tmp.path(), &["SELECT 1;"])
        .err()
        .unwrap();
    assert!(matches!(
        err,
        oxide_core::Error::DatabaseTooNew {
            found: 2,
            supported: 1
        }
    ));
}

#[test]
fn lists_projects_most_recent_first() {
    let tmp = tempfile::tempdir().unwrap();
    drop(Core::open(tmp.path()).unwrap());
    let conn = Connection::open(tmp.path().join("oxide.db")).unwrap();
    conn.execute_batch(
        "INSERT INTO projects (name, path) VALUES ('first', '/a'), ('second', '/b');",
    )
    .unwrap();
    drop(conn);

    let names: Vec<_> = Core::open(tmp.path())
        .unwrap()
        .list_projects()
        .unwrap()
        .into_iter()
        .map(|p| p.name)
        .collect();

    assert_eq!(names, ["second", "first"]);
}

mod settings {
    use oxide_core::{Core, PermissionMode, Provider, SettingsState};

    #[test]
    fn fresh_home_gets_a_default_settings_file() {
        let tmp = tempfile::tempdir().unwrap();

        let core = Core::open(tmp.path()).unwrap();

        let state = core.settings();
        assert!(state.errors.is_empty());
        assert_eq!(state.settings.default_provider, Provider::Claude);
        assert_eq!(
            state.settings.providers.claude.permission_mode,
            PermissionMode::Ask
        );
        assert!(!state.settings.scan_roots.is_empty());
        assert!(state.settings.confirm_quit);

        let on_disk = std::fs::read_to_string(tmp.path().join("settings.json")).unwrap();
        assert!(
            on_disk.contains("\"defaultProvider\": \"claude\""),
            "{on_disk}"
        );
        assert!(on_disk.contains('\n'), "file should be pretty-printed");
    }

    fn watch(core: &Core) -> std::sync::mpsc::Receiver<SettingsState> {
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        core.subscribe_settings(move |s| {
            let _ = tx.lock().unwrap().send(s.clone());
        });
        rx
    }

    fn next(rx: &std::sync::mpsc::Receiver<SettingsState>) -> SettingsState {
        rx.recv_timeout(std::time::Duration::from_secs(5))
            .expect("no settings change within 5s")
    }

    #[test]
    fn editing_the_file_on_disk_is_picked_up_and_published() {
        let tmp = tempfile::tempdir().unwrap();
        let core = Core::open(tmp.path()).unwrap();
        let rx = watch(&core);

        std::fs::write(
            tmp.path().join("settings.json"),
            r#"{ "defaultProvider": "codex", "confirmQuit": false,
                 "providers": { "codex": { "model": "gpt-x", "permissionMode": "auto-edit" } } }"#,
        )
        .unwrap();

        let state = next(&rx);
        assert!(state.errors.is_empty(), "{:?}", state.errors);
        assert_eq!(state.settings.default_provider, Provider::Codex);
        assert!(!state.settings.confirm_quit);
        assert_eq!(
            state.settings.providers.codex.model.as_deref(),
            Some("gpt-x")
        );
        assert_eq!(
            state.settings.providers.codex.permission_mode,
            PermissionMode::AutoEdit
        );
        assert_eq!(core.settings(), state);
    }

    #[test]
    fn invalid_edit_reports_field_errors_and_keeps_last_valid_settings_until_fixed() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        let core = Core::open(tmp.path()).unwrap();
        let rx = watch(&core);

        std::fs::write(&file, r#"{ "defaultProvider": "codex" }"#).unwrap();
        assert_eq!(next(&rx).settings.default_provider, Provider::Codex);

        std::fs::write(
            &file,
            r#"{ "defaultProvider": "gemini", "confirmQuit": "yes",
                 "providers": { "claude": { "permissionMode": "yolo" } }, "colour": 1 }"#,
        )
        .unwrap();
        let bad = next(&rx);
        let mut paths: Vec<_> = bad.errors.iter().map(|e| e.path.as_str()).collect();
        paths.sort();
        assert_eq!(
            paths,
            [
                "colour",
                "confirmQuit",
                "defaultProvider",
                "providers.claude.permissionMode"
            ]
        );
        assert_eq!(
            bad.settings.default_provider,
            Provider::Codex,
            "last valid stays"
        );
        assert!(bad.settings.confirm_quit);

        std::fs::write(&file, "{ not json").unwrap();
        let broken = next(&rx);
        assert_eq!(broken.errors.len(), 1);
        assert_eq!(broken.errors[0].path, "");
        assert_eq!(broken.settings.default_provider, Provider::Codex);

        std::fs::write(&file, r#"{ "defaultProvider": "antigravity" }"#).unwrap();
        let fixed = next(&rx);
        assert!(fixed.errors.is_empty());
        assert_eq!(fixed.settings.default_provider, Provider::Antigravity);
    }

    #[test]
    fn saved_settings_apply_immediately_and_survive_reopening() {
        let tmp = tempfile::tempdir().unwrap();
        let core = Core::open(tmp.path()).unwrap();
        let mut settings = core.settings().settings;
        settings.editor = "zed".into();
        settings.providers.claude.effort = Some("high".into());
        settings.scan_roots = vec!["~/src".into()];

        core.save_settings(&settings).unwrap();

        assert_eq!(core.settings().settings, settings);
        drop(core);
        assert_eq!(
            Core::open(tmp.path()).unwrap().settings().settings,
            settings
        );
    }
}
