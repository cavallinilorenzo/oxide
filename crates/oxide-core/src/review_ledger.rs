//! The Review ledger: how long finished work waits between a Thread's last completed Turn and the
//! merge of its pull request. An entry holds identifiers, Provider, Model and two timestamps,
//! never Transcript text (ADR-0010), and no foreign key to the Thread: it outlives the Thread.
//! Nothing here is sent anywhere.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Most recent entries a [`ReviewLedger`] lists.
pub const RECENT_ENTRIES: usize = 20;

/// One merged pull request of a Thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLedgerEntry {
    pub project_id: u32,
    /// The Thread's id when it merged. The Thread itself may be gone.
    pub thread_id: u32,
    pub pull_request: u32,
    pub provider: String,
    pub model: Option<String>,
    /// When the Thread's last Turn completed, seconds since the Unix epoch (UTC).
    pub turn_completed_at: i64,
    /// When the pull request was merged, seconds since the Unix epoch (UTC).
    pub merged_at: i64,
}

impl ReviewLedgerEntry {
    /// How long the work waited, never negative.
    pub fn wait_secs(&self) -> i64 {
        (self.merged_at - self.turn_completed_at).max(0)
    }
}

/// A Project's figures: the median wait and the most recent entries, newest merge first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLedger {
    /// Median wait in seconds; `None` without entries.
    pub median_secs: Option<i64>,
    /// How many entries the Project has.
    pub count: u32,
    pub entries: Vec<ReviewLedgerEntry>,
}

pub(crate) struct LedgerStore {
    db_path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl LedgerStore {
    pub(crate) fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            conn: Mutex::new(None),
        }
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let conn = Connection::open(&self.db_path)?;
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
            *guard = Some(conn);
        }
        f(guard.as_ref().expect("connection opened above"))
    }

    /// Records the merge of `pull_request`, opened from the Thread's branch, at `merged_at` (an
    /// ISO 8601 UTC timestamp from GitHub). Does nothing when the Thread is gone, has no
    /// completed Turn, `merged_at` is unreadable, or the pull request is already recorded.
    pub(crate) fn record_merge(
        &self,
        thread_id: u32,
        pull_request: u32,
        merged_at: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO review_ledger
                     (project_id, thread_id, pull_request, provider, model, turn_completed_at, merged_at)
                 SELECT t.project_id, t.id, ?2, t.provider, t.model,
                        CAST(strftime('%s', (SELECT MAX(u.completed_at) FROM turns u
                                             WHERE u.thread_id = t.id AND u.status = 'completed')) AS INTEGER),
                        CAST(strftime('%s', ?3) AS INTEGER)
                 FROM threads t
                 WHERE t.id = ?1
                   AND EXISTS (SELECT 1 FROM turns u WHERE u.thread_id = t.id AND u.status = 'completed')
                   AND strftime('%s', ?3) IS NOT NULL",
                rusqlite::params![thread_id, pull_request, merged_at],
            )?;
            Ok(())
        })
    }

    pub(crate) fn thread_of_branch(&self, project_id: u32, branch: &str) -> Result<Option<u32>> {
        self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id FROM threads WHERE project_id = ?1 AND branch = ?2 ORDER BY id DESC",
                    rusqlite::params![project_id, branch],
                    |r| r.get(0),
                )
                .optional()?)
        })
    }

    pub(crate) fn ledger(&self, project_id: u32) -> Result<ReviewLedger> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT project_id, thread_id, pull_request, provider, model, turn_completed_at, merged_at
                 FROM review_ledger WHERE project_id = ?1 ORDER BY merged_at DESC, id DESC",
            )?;
            let all = stmt
                .query_map([project_id], |r| {
                    Ok(ReviewLedgerEntry {
                        project_id: r.get(0)?,
                        thread_id: r.get(1)?,
                        pull_request: r.get(2)?,
                        provider: r.get(3)?,
                        model: r.get(4)?,
                        turn_completed_at: r.get(5)?,
                        merged_at: r.get(6)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut waits: Vec<i64> = all.iter().map(ReviewLedgerEntry::wait_secs).collect();
            waits.sort_unstable();
            let median_secs = match waits.len() {
                0 => None,
                n if n % 2 == 1 => Some(waits[n / 2]),
                n => Some((waits[n / 2 - 1] + waits[n / 2]) / 2),
            };
            let count = all.len() as u32;
            Ok(ReviewLedger {
                median_secs,
                count,
                entries: all.into_iter().take(RECENT_ENTRIES).collect(),
            })
        })
    }

    pub(crate) fn clear(&self) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM review_ledger", [])?;
            Ok(())
        })
    }
}
