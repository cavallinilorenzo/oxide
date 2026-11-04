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
    "
    CREATE TABLE unknown_events (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        raw TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
",
    "
    ALTER TABLE items ADD COLUMN parent_item_index INTEGER;
    ALTER TABLE turns ADD COLUMN model TEXT;
    ALTER TABLE turns ADD COLUMN effort TEXT;
    ALTER TABLE turns ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
",
    "
    ALTER TABLE turns ADD COLUMN error_message TEXT;
    ALTER TABLE turns ADD COLUMN stderr_tail TEXT;
",
    // Transcript paging reads Turns by position and Items by Turn.
    "
    CREATE INDEX turns_by_thread ON turns(thread_id, id);
    CREATE INDEX items_by_turn ON items(turn_id, item_index);
",
    // Small app-level facts, such as the Project and Thread last open.
    "
    CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
",
    // A Thread whose Provider session is gone, and the Thread that continues it.
    "
    ALTER TABLE threads ADD COLUMN session_lost INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE threads ADD COLUMN continued_from INTEGER REFERENCES threads(id);
",
    "
    ALTER TABLE threads ADD COLUMN title TEXT;
",
    // Board Threads: a worktree of their own, and the output of the Project's Setup command
    // that ran in it. The Setup command itself lives with the Project, never in its repository.
    "
    ALTER TABLE threads ADD COLUMN branch TEXT;
    ALTER TABLE threads ADD COLUMN worktree_path TEXT;
    ALTER TABLE threads ADD COLUMN setup_output TEXT;
    ALTER TABLE projects ADD COLUMN setup_command TEXT;
",
    // The GitHub issue a Board Thread was started from.
    "
    ALTER TABLE threads ADD COLUMN issue_number INTEGER;
",
    // Open Projects: the ones the user opened, listed in the sidebar. A scan only makes
    // Projects known (findable in the Project palette); Projects with Threads start open.
    "
    ALTER TABLE projects ADD COLUMN opened_at TEXT;
    UPDATE projects SET opened_at = created_at
        WHERE id IN (SELECT DISTINCT project_id FROM threads);
",
    // Threads are deleted, not archived: a finished Thread leaves nothing behind in the sidebar
    // or the context of the next one. Threads archived before this reappear in the list.
    "
    ALTER TABLE threads DROP COLUMN archived;
",
    // The macro category of a tool-call Item; NULL for other Items and for Items stored before.
    "
    ALTER TABLE items ADD COLUMN category TEXT;
",
    // A Turn's prompt as segments: text and Attachments in order. NULL for Turns stored before,
    // whose Attachments are the paths in `attachments`.
    "
    ALTER TABLE turns ADD COLUMN segments TEXT;
",
    // The Review ledger (ADR-0010): one row per merged pull request of a Thread. Identifiers,
    // Provider, Model and timestamps only, no Transcript text and no foreign key, so a row
    // outlives its Thread.
    "
    CREATE TABLE review_ledger (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        pull_request INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        turn_completed_at INTEGER NOT NULL,
        merged_at INTEGER NOT NULL,
        UNIQUE (project_id, pull_request)
    );
",
    // Line comments: drafts on a Diff line, kept per Thread until sent.
    "
    CREATE TABLE line_comments (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        scope TEXT NOT NULL,
        path TEXT NOT NULL,
        side TEXT NOT NULL,
        line INTEGER NOT NULL,
        code TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX line_comments_by_thread ON line_comments(thread_id, id);
",
    // A per-Project choice: keep chat Threads in the main checkout instead of
    // giving each one its own worktree on its first prompt. Default off, so new
    // chat Threads work in their own worktree like Board Threads do.
    "
    ALTER TABLE projects ADD COLUMN threads_in_main_checkout INTEGER NOT NULL DEFAULT 0;
",
    // Line comments drafted on a pull request's Diff, kept per Project and pull request until one
    // review is submitted. They belong to no checkout, so reviewing never needs one.
    "
    CREATE TABLE pull_request_line_comments (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        pull_request INTEGER NOT NULL,
        path TEXT NOT NULL,
        side TEXT NOT NULL,
        line INTEGER NOT NULL,
        code TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX pull_request_line_comments_by_pr
        ON pull_request_line_comments(project_id, pull_request, id);
",
    // What a Provider reported about a command an Item ran, and the permission mode a Turn
    // started in. NULL on Items and Turns stored before command evidence existed: their outcome
    // reads as unknown, and their Turn's permission mode as not recorded.
    "
    ALTER TABLE items ADD COLUMN command_line TEXT;
    ALTER TABLE items ADD COLUMN command_outcome TEXT;
    ALTER TABLE items ADD COLUMN command_exit_code INTEGER;
    ALTER TABLE turns ADD COLUMN permission_mode TEXT;
",
    // A restore: a Thread's files put back to before a Turn, and the Checkpoint
    // that undoes it (ADR-0011).
    "
    CREATE TABLE restores (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id),
        turn_index INTEGER NOT NULL,
        safety_ref TEXT NOT NULL,
        files TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        undone_at TEXT
    );
    CREATE INDEX restores_by_thread ON restores(thread_id, id);
",
    // What the agent is told on the next prompt of a Thread whose files were restored.
    "
    ALTER TABLE threads ADD COLUMN restore_notice TEXT;
",
    // A Project's own Verification commands: a JSON array of command lines that count as checks
    // beside the built-in patterns. Kept with the Project, never in its repository.
    "
    ALTER TABLE projects ADD COLUMN verification_commands TEXT NOT NULL DEFAULT '[]';
",
    // The labels of the GitHub issue a Board Thread was started from, so a Review round can
    // describe its kind of work without asking GitHub again. Names only, never issue text.
    "
    ALTER TABLE threads ADD COLUMN issue_labels TEXT NOT NULL DEFAULT '[]';
",
    // The Review ledger's review rounds (ADR-0010): one row per send of Line comments or
    // reviewer comments, with Provider, Model, kind of work and counts, never Transcript text
    // and no foreign key, so a row outlives its Thread.
    "
    CREATE TABLE review_rounds (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        languages TEXT NOT NULL DEFAULT '[]',
        size_band TEXT NOT NULL,
        issue_labels TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX review_rounds_by_project ON review_rounds(project_id, id);
",
    // The title and link of the GitHub issue a Board Thread was started from, so its Dossier can
    // show what was asked without asking GitHub again.
    "
    ALTER TABLE threads ADD COLUMN issue_title TEXT;
    ALTER TABLE threads ADD COLUMN issue_url TEXT;
",
    // A Project's own sensitive paths for the Dossier's risk signals, as glob patterns. The
    // built-in CI, dependency manifest and migration patterns are matched beside these.
    "
    ALTER TABLE projects ADD COLUMN sensitive_paths TEXT NOT NULL DEFAULT '[]';
",
    // The branch HEAD when a Turn started and when it ended, so the Dossier can tell the commits
    // the Turn produced from those it did not. NULL for Turns stored before this.
    "
    ALTER TABLE turns ADD COLUMN head_before TEXT;
    ALTER TABLE turns ADD COLUMN head_after TEXT;
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
