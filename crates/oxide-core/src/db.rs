use std::fs;
use std::path::Path;

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Forward-only migrations. Index `i` upgrades `user_version` from `i` to `i + 1`.
pub const MIGRATIONS: &[&str] = &[
    "
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
",
    "
    ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
",
    "
    CREATE TABLE threads (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        model TEXT,
        effort TEXT,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE turns (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        turn_index INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        completed_at TEXT
    );

    CREATE TABLE items (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        item_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
",
    "
    CREATE TABLE approvals (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        approval_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        options TEXT NOT NULL DEFAULT '[]',
        decision TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        decided_at TEXT
    );
",
];

/// Opens the database at `path` (WAL) and applies pending `migrations`, writing
/// `<path>.bak-<version>` first, where `<version>` is the version being migrated away from.
pub fn open(path: &Path, migrations: &[&str]) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn, path, migrations)?;
    Ok(conn)
}

fn migrate(conn: &Connection, path: &Path, migrations: &[&str]) -> Result<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let target = migrations.len() as u32;
    if current > target {
        return Err(Error::DatabaseTooNew {
            found: current,
            supported: target,
        });
    }
    for version in current..target {
        if version > 0 {
            backup(conn, path, version)?;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(migrations[version as usize])?;
        tx.pragma_update(None, "user_version", version + 1)?;
        tx.commit()?;
    }
    Ok(())
}

fn backup(conn: &Connection, path: &Path, version: u32) -> Result<()> {
    // Fold the WAL into the main file so the copy is complete.
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".bak-{version}"));
    let dest = std::path::PathBuf::from(name);
    fs::copy(path, &dest).map_err(|source| Error::Io { path: dest, source })?;
    Ok(())
}
