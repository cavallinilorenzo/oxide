use oxide_core::Core;
use rusqlite::Connection;

fn user_version(path: &std::path::Path) -> u32 {
    Connection::open(path)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}

#[test]
fn core_detects_claude_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let core = Core::open(tmp.path()).unwrap();
    let det = core.detect_provider("claude");
    assert_eq!(det.available, det.installed && det.authenticated);
}

#[test]
fn core_detects_codex_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let core = Core::open(tmp.path()).unwrap();
    let det = core.detect_provider("codex");
    assert_eq!(det.available, det.installed && det.authenticated);
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
fn threads_archived_before_deletion_existed_reappear_in_the_list() {
    let tmp = tempfile::tempdir().unwrap();
    let before_drop = &oxide_core::MIGRATIONS[..oxide_core::MIGRATIONS.len() - 1];
    drop(Core::open_with_migrations(tmp.path(), before_drop).unwrap());
    Connection::open(tmp.path().join("oxide.db"))
        .unwrap()
        .execute_batch(
            "INSERT INTO projects (id, name, path) VALUES (1, 'p', '/p');
             INSERT INTO threads (id, project_id, provider, permission_mode, status, archived)
             VALUES (5, 1, 'fake', 'ask', 'completed', 1);",
        )
        .unwrap();

    let core = Core::open(tmp.path()).unwrap();

    let threads = core.list_threads(1).unwrap();
    assert_eq!(threads.iter().map(|t| t.id).collect::<Vec<_>>(), [5]);
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

#[cfg(unix)]
#[test]
fn terminal_session_accepts_input_streams_output_and_shuts_down_its_process_group() {
    use std::time::Duration;

    let tmp = tempfile::tempdir().unwrap();
    let core = Core::open(tmp.path().join("oxide")).unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let project_id = {
        let conn = Connection::open(tmp.path().join("oxide/oxide.db")).unwrap();
        conn.execute(
            "INSERT INTO projects (name, path) VALUES ('project', ?1)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        conn.last_insert_rowid() as u32
    };
    let thread = core
        .create_thread(project_id, "claude", None, None, None)
        .unwrap();
    let terminal = core.start_terminal(project_id, Some(thread.id)).unwrap();
    assert_eq!(terminal.cwd, root.to_string_lossy());
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    let pid = terminal.pid;

    core.write_terminal(
        terminal.id,
        b"sleep 60 & child=$(pgrep -P $$ sleep); echo CHILD=$child; echo READY$((6*7))\n",
    )
    .unwrap();
    let mut output = String::new();
    while !output.contains("READY42") {
        let chunk = rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|error| panic!("terminal output: {error}; received {output:?}"));
        output.push_str(&String::from_utf8_lossy(&chunk));
    }
    assert!(output.contains("READY42"));
    let child_pid = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("CHILD="))
        .unwrap_or_else(|| panic!("background child pid in {output:?}"))
        .parse::<i32>()
        .unwrap();
    core.write_terminal(terminal.id, b"read value; echo received:$value\n")
        .unwrap();
    core.write_terminal(terminal.id, b"hello\n").unwrap();
    while !output.contains("received:hello") {
        let chunk = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("echoed terminal input");
        output.push_str(&String::from_utf8_lossy(&chunk));
    }

    core.close_terminal(terminal.id).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let result = unsafe { libc::kill(-(pid as i32), 0) };
        let child_result = unsafe { libc::kill(child_pid, 0) };
        let missing = |result| {
            result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        };
        if missing(result) && missing(child_result) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "terminal process group {pid} survived shutdown"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
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
        assert!(!state.settings.claude_customizations);

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
            r#"{ "defaultProvider": "codex", "confirmQuit": false, "claudeCustomizations": true,
                 "providers": { "codex": { "model": "gpt-x", "permissionMode": "auto-edit" } } }"#,
        )
        .unwrap();

        let state = next(&rx);
        assert!(state.errors.is_empty(), "{:?}", state.errors);
        assert_eq!(state.settings.default_provider, Provider::Codex);
        assert!(!state.settings.confirm_quit);
        assert!(state.settings.claude_customizations);
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

    #[test]
    fn a_deleted_file_is_recreated_from_the_settings_in_effect() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("settings.json");
        let core = Core::open(tmp.path()).unwrap();
        let mut settings = core.settings().settings;
        settings.editor = "zed".into();
        core.save_settings(&settings).unwrap();

        std::fs::remove_file(&file).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !file.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            std::fs::read_to_string(&file)
                .unwrap()
                .contains("\"editor\": \"zed\"")
        );
    }
}

mod discovery {
    use std::fs;
    use std::path::{Path, PathBuf};

    use oxide_core::{Core, ProjectSummary};

    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        core: Core,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("dev").canonicalize_or_create();
        let core = Core::open(tmp.path().join("home")).unwrap();
        let mut settings = core.settings().settings;
        settings.scan_roots = vec![root.to_string_lossy().into_owned()];
        core.save_settings(&settings).unwrap();
        Fixture {
            _tmp: tmp,
            root,
            core,
        }
    }

    trait CanonicalizeOrCreate {
        fn canonicalize_or_create(self) -> PathBuf;
    }
    impl CanonicalizeOrCreate for PathBuf {
        fn canonicalize_or_create(self) -> PathBuf {
            fs::create_dir_all(&self).unwrap();
            self.canonicalize().unwrap()
        }
    }

    fn repo(path: &Path) {
        fs::create_dir_all(path.join(".git")).unwrap();
    }

    fn names(projects: &[ProjectSummary]) -> Vec<&str> {
        let mut n: Vec<_> = projects.iter().map(|p| p.name.as_str()).collect();
        n.sort();
        n
    }

    #[test]
    fn finds_repositories_within_the_depth_limit_without_descending_into_them() {
        let f = fixture();
        repo(&f.root.join("a"));
        repo(&f.root.join("group/b"));
        repo(&f.root.join("a/nested-in-repo"));
        repo(&f.root.join("l1/l2/l3/deep"));
        repo(&f.root.join("l1/l2/l3/l4/l5/too-deep"));
        fs::create_dir_all(f.root.join("plain")).unwrap();

        let found = f.core.rescan_projects().unwrap();

        assert_eq!(names(&found), ["a", "b", "deep"]);
        assert_eq!(names(&f.core.list_projects().unwrap()), ["a", "b", "deep"]);
        assert!(found.iter().all(|p| !p.hidden && !p.missing));
    }

    #[test]
    fn skips_dependency_build_and_hidden_folders() {
        let f = fixture();
        for dir in [
            "node_modules",
            "target",
            "dist",
            "vendor",
            ".venv",
            ".cache",
        ] {
            repo(&f.root.join(dir).join("pkg"));
        }
        repo(&f.root.join("ok"));

        assert_eq!(names(&f.core.rescan_projects().unwrap()), ["ok"]);
    }

    #[test]
    fn a_missing_scan_root_is_ignored_and_tilde_means_the_user_home() {
        let tmp = tempfile::tempdir().unwrap();
        let user_home = tmp.path().join("user").canonicalize_or_create();
        repo(&user_home.join("Developer/mine"));
        let core = Core::open_with_user_home(tmp.path().join("oxide"), &user_home).unwrap();
        let mut settings = core.settings().settings;
        settings.scan_roots = vec!["~/Developer".into(), "~/nope".into()];
        core.save_settings(&settings).unwrap();

        assert_eq!(names(&core.rescan_projects().unwrap()), ["mine"]);
    }

    #[test]
    fn rescan_picks_up_a_new_repository_and_keeps_existing_records() {
        let f = fixture();
        repo(&f.root.join("first"));
        let before = f.core.rescan_projects().unwrap();

        repo(&f.root.join("second"));
        let after = f.core.rescan_projects().unwrap();

        assert_eq!(names(&after), ["first", "second"]);
        let first = |ps: &[ProjectSummary]| ps.iter().find(|p| p.name == "first").unwrap().id;
        assert_eq!(first(&before), first(&after));
    }

    #[test]
    fn hidden_projects_stay_hidden_across_rescans_until_unhidden() {
        let f = fixture();
        repo(&f.root.join("keep"));
        repo(&f.root.join("hide"));
        let id = f
            .core
            .rescan_projects()
            .unwrap()
            .iter()
            .find(|p| p.name == "hide")
            .unwrap()
            .id;

        f.core.set_project_hidden(id, true).unwrap();
        let after = f.core.rescan_projects().unwrap();
        let hidden: Vec<_> = after.iter().filter(|p| p.hidden).map(|p| &p.name).collect();
        assert_eq!(hidden, ["hide"]);

        f.core.set_project_hidden(id, false).unwrap();
        assert!(f.core.list_projects().unwrap().iter().all(|p| !p.hidden));
    }

    #[test]
    fn a_deleted_folder_shows_as_missing_and_keeps_its_record() {
        let f = fixture();
        repo(&f.root.join("gone"));
        let id = f.core.rescan_projects().unwrap()[0].id;

        fs::remove_dir_all(f.root.join("gone")).unwrap();
        let after = f.core.rescan_projects().unwrap();

        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, id);
        assert!(after[0].missing);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_paths_resolve_to_one_project() {
        let f = fixture();
        repo(&f.root.join("real"));
        std::os::unix::fs::symlink(f.root.join("real"), f.root.join("alias")).unwrap();
        let second_root = f._tmp.path().join("other-root");
        std::os::unix::fs::symlink(&f.root, &second_root).unwrap();
        let mut settings = f.core.settings().settings;
        settings
            .scan_roots
            .push(second_root.to_string_lossy().into_owned());
        f.core.save_settings(&settings).unwrap();

        let found = f.core.rescan_projects().unwrap();

        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].path, f.root.join("real").to_string_lossy());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_loops_do_not_hang_the_scan() {
        let f = fixture();
        fs::create_dir_all(f.root.join("a")).unwrap();
        std::os::unix::fs::symlink(&f.root, f.root.join("a/back")).unwrap();
        repo(&f.root.join("x"));

        assert_eq!(names(&f.core.rescan_projects().unwrap()), ["x"]);
    }
}
