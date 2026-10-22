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
