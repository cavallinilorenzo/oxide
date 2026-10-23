//! The Thread Board's feed. The Board stores nothing of its own: a card is a Thread row plus its
//! pending Approvals, read fresh whenever a Thread changes and pushed to that Project's subscribers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::github::BranchPullRequest;
use crate::thread::{self, ThreadSummary};
use oxide_provider::ApprovalKind;

/// An Approval the Provider is still waiting on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub approval_id: String,
    pub kind: ApprovalKind,
    pub summary: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCard {
    pub thread: ThreadSummary,
    pub pending_approvals: Vec<PendingApproval>,
    /// The Thread's branch's pull request, as last refreshed; `None` when it has none.
    pub pull_request: Option<BranchPullRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum BoardEvent {
    /// A Thread appeared or changed (status, title, archived, pending Approvals).
    ThreadChanged(BoardCard),
}

pub(crate) struct BoardHub {
    db_path: PathBuf,
    conn: Mutex<Option<Connection>>,
    subscribers: Mutex<Vec<(u32, crossbeam_channel::Sender<BoardEvent>)>>,
    /// Pull requests by Thread, kept in memory: GitHub owns them, the Board only shows them.
    pull_requests: Mutex<HashMap<u32, BranchPullRequest>>,
}

impl BoardHub {
    pub(crate) fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            conn: Mutex::new(None),
            subscribers: Mutex::new(Vec::new()),
            pull_requests: Mutex::new(HashMap::new()),
        }
    }

    /// Records what GitHub says about the Thread's pull request and tells subscribers.
    pub(crate) fn set_pull_request(&self, thread_id: u32, pr: Option<BranchPullRequest>) {
        let changed = {
            let mut map = self.pull_requests.lock().unwrap_or_else(|e| e.into_inner());
            let previous = match &pr {
                Some(pr) => map.insert(thread_id, pr.clone()),
                None => map.remove(&thread_id),
            };
            previous != pr
        };
        if changed {
            self.publish(thread_id);
        }
    }

    fn pull_request(&self, thread_id: u32) -> Option<BranchPullRequest> {
        self.pull_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&thread_id)
            .cloned()
    }

    /// Every Thread of the Project, newest activity first, and a feed of what changes next.
    /// Subscribing happens before reading, so no change falls between the snapshot and the feed.
    pub(crate) fn subscribe(
        &self,
        project_id: u32,
    ) -> Result<(Vec<BoardCard>, crossbeam_channel::Receiver<BoardEvent>)> {
        let (tx, rx) = crossbeam_channel::unbounded();
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((project_id, tx));
        let cards = self.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT {} FROM threads WHERE project_id = ?1 ORDER BY updated_at DESC, id DESC",
                thread::THREAD_COLUMNS
            ))?;
            let threads = stmt
                .query_map([project_id], thread::parse_thread_summary)?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            threads
                .into_iter()
                .map(|thread| self.card(conn, thread))
                .collect()
        })?;
        Ok((cards, rx))
    }

    /// Tells the Thread's Project's subscribers that the Thread changed.
    pub(crate) fn publish(&self, thread_id: u32) {
        if self
            .subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
        {
            return;
        }
        let Ok(card) = self.with_conn(|conn| {
            let thread = conn.query_row(
                &format!(
                    "SELECT {} FROM threads WHERE id = ?1",
                    thread::THREAD_COLUMNS
                ),
                [thread_id],
                thread::parse_thread_summary,
            )?;
            self.card(conn, thread)
        }) else {
            return;
        };
        let project_id = card.thread.project_id;
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(project, tx)| {
                *project != project_id || tx.send(BoardEvent::ThreadChanged(card.clone())).is_ok()
            });
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

    fn card(&self, conn: &Connection, thread: ThreadSummary) -> Result<BoardCard> {
        let mut stmt = conn.prepare(
            "SELECT a.approval_id, a.kind, a.summary, a.options
             FROM approvals a JOIN turns t ON t.id = a.turn_id
             WHERE t.thread_id = ?1 AND a.decision IS NULL ORDER BY a.id ASC",
        )?;
        let pending_approvals = stmt
            .query_map([thread.id], |r| {
                let kind: String = r.get(1)?;
                let options: String = r.get(3)?;
                Ok(PendingApproval {
                    approval_id: r.get(0)?,
                    kind: serde_json::from_value(serde_json::Value::String(kind))
                        .unwrap_or_default(),
                    summary: r.get(2)?,
                    options: serde_json::from_str(&options).unwrap_or_default(),
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        // Only a Thread waiting on the user has Approvals to answer; older ones were resolved
        // by an interrupt or a restart.
        let pending_approvals = if thread.status == thread::ThreadStatus::NeedsInput {
            pending_approvals
        } else {
            Vec::new()
        };
        Ok(BoardCard {
            pull_request: self.pull_request(thread.id),
            thread,
            pending_approvals,
        })
    }
}
