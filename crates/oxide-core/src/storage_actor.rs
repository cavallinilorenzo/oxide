use crossbeam_channel::{Receiver, Sender};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::mpsc;

use crate::error::{Error, Result};
use crate::thread::{
    ApprovalSnapshot, ItemSnapshot, ThreadCapabilities, ThreadSnapshot, ThreadStatus,
    ThreadSummary, TurnSnapshot, UnknownEventSnapshot,
};
use oxide_provider::{ApprovalDecision, ApprovalKind, ItemKind, PermissionMode, TurnStatus};

/// What storage recorded when a Turn started.
pub struct TurnStarted {
    pub id: u32,
    pub model: Option<String>,
    pub effort: Option<String>,
}

pub enum StorageMsg {
    WriteTurnStarted {
        thread_id: u32,
        turn_index: u32,
        prompt: String,
        attachments: Vec<String>,
        reply: mpsc::Sender<Result<TurnStarted>>,
    },
    UpdateTurnCompleted {
        turn_id: u32,
        status: TurnStatus,
        reply: mpsc::Sender<Result<()>>,
    },
    WriteItemCompleted {
        turn_id: u32,
        item_index: u32,
        kind: ItemKind,
        content: String,
        parent_item_index: Option<u32>,
        reply: mpsc::Sender<Result<u32>>,
    },
    WriteApprovalRequested {
        turn_id: u32,
        approval_id: String,
        kind: ApprovalKind,
        summary: String,
        options: Vec<String>,
        reply: mpsc::Sender<Result<u32>>,
    },
    UpdateApprovalDecision {
        turn_id: u32,
        approval_id: String,
        decision: ApprovalDecision,
        decided_at: String,
        reply: mpsc::Sender<Result<String>>,
    },
    ResolvePendingApprovals {
        turn_id: u32,
        decision: ApprovalDecision,
        decided_at: String,
        reply: mpsc::Sender<Result<String>>,
    },
    UpdateThreadPermissionMode {
        thread_id: u32,
        permission_mode: PermissionMode,
        reply: mpsc::Sender<Result<()>>,
    },
    UpdateThreadStatus {
        thread_id: u32,
        status: ThreadStatus,
        reply: mpsc::Sender<Result<()>>,
    },
    GetSnapshot {
        thread_id: u32,
        reply: mpsc::Sender<Result<ThreadSnapshot>>,
    },
    SetProviderSessionId {
        thread_id: u32,
        session_id: String,
    },
    WriteUnknownEvent {
        turn_id: u32,
        raw: String,
        reply: mpsc::Sender<Result<u32>>,
    },
    Shutdown,
}

#[derive(Clone)]
pub struct StorageHandle {
    sender: Sender<StorageMsg>,
}

impl StorageHandle {
    pub fn new(db_path: PathBuf) -> Result<Self> {
        let (tx, rx) = crossbeam_channel::unbounded();
        let path = db_path.clone();
        std::thread::Builder::new()
            .name("storage-actor".into())
            .spawn(move || {
                let conn = match rusqlite::Connection::open(&path) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("storage actor failed to open db at {:?}: {}", path, e);
                        return;
                    }
                };
                let _ = conn.pragma_update(None, "journal_mode", "WAL");
                let _ = conn.pragma_update(None, "foreign_keys", "ON");

                run_storage_actor(conn, rx);
            })
            .map_err(|e| Error::Io {
                path: db_path,
                source: e,
            })?;

        Ok(Self { sender: tx })
    }

    pub fn write_turn_started(
        &self,
        thread_id: u32,
        turn_index: u32,
        prompt: String,
        attachments: Vec<String>,
    ) -> Result<TurnStarted> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::WriteTurnStarted {
            thread_id,
            turn_index,
            prompt,
            attachments,
            reply: reply_tx,
        });
        reply_rx
            .recv()
            .unwrap_or(Err(rusqlite::Error::QueryReturnedNoRows.into()))
    }

    pub fn update_turn_completed(&self, turn_id: u32, status: TurnStatus) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::UpdateTurnCompleted {
            turn_id,
            status,
            reply: reply_tx,
        });
        reply_rx.recv().unwrap_or(Ok(()))
    }

    pub fn write_item_completed(
        &self,
        turn_id: u32,
        item_index: u32,
        kind: ItemKind,
        content: String,
        parent_item_index: Option<u32>,
    ) -> Result<u32> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::WriteItemCompleted {
            turn_id,
            item_index,
            kind,
            content,
            parent_item_index,
            reply: reply_tx,
        });
        reply_rx
            .recv()
            .unwrap_or(Err(rusqlite::Error::QueryReturnedNoRows.into()))
    }

    pub fn write_approval_requested(
        &self,
        turn_id: u32,
        approval_id: String,
        kind: ApprovalKind,
        summary: String,
        options: Vec<String>,
    ) -> Result<u32> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::WriteApprovalRequested {
            turn_id,
            approval_id,
            kind,
            summary,
            options,
            reply: reply_tx,
        });
        reply_rx
            .recv()
            .unwrap_or(Err(rusqlite::Error::QueryReturnedNoRows.into()))
    }

    pub fn update_approval_decision(
        &self,
        turn_id: u32,
        approval_id: String,
        decision: ApprovalDecision,
        decided_at: String,
    ) -> Result<String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::UpdateApprovalDecision {
            turn_id,
            approval_id,
            decision,
            decided_at,
            reply: reply_tx,
        });
        reply_rx
            .recv()
            .unwrap_or(Err(rusqlite::Error::QueryReturnedNoRows.into()))
    }

    pub fn resolve_pending_approvals(
        &self,
        turn_id: u32,
        decision: ApprovalDecision,
        decided_at: String,
    ) -> Result<String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::ResolvePendingApprovals {
            turn_id,
            decision,
            decided_at,
            reply: reply_tx,
        });
        reply_rx
            .recv()
            .unwrap_or(Err(rusqlite::Error::QueryReturnedNoRows.into()))
    }

    pub fn update_thread_permission_mode(
        &self,
        thread_id: u32,
        permission_mode: PermissionMode,
    ) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::UpdateThreadPermissionMode {
            thread_id,
            permission_mode,
            reply: reply_tx,
        });
        reply_rx.recv().unwrap_or(Ok(()))
    }

    pub fn update_thread_status(&self, thread_id: u32, status: ThreadStatus) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::UpdateThreadStatus {
            thread_id,
            status,
            reply: reply_tx,
        });
        reply_rx.recv().unwrap_or(Ok(()))
    }

    pub fn get_snapshot(&self, thread_id: u32) -> Result<ThreadSnapshot> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::GetSnapshot {
            thread_id,
            reply: reply_tx,
        });
        reply_rx
            .recv()
            .unwrap_or(Err(rusqlite::Error::QueryReturnedNoRows.into()))
    }

    pub fn set_provider_session_id(&self, thread_id: u32, session_id: String) {
        let _ = self.sender.send(StorageMsg::SetProviderSessionId {
            thread_id,
            session_id,
        });
    }

    pub fn write_unknown_event(&self, turn_id: u32, raw: String) -> Result<u32> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(StorageMsg::WriteUnknownEvent {
            turn_id,
            raw,
            reply: reply_tx,
        });
        reply_rx
            .recv()
            .unwrap_or(Err(rusqlite::Error::QueryReturnedNoRows.into()))
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(StorageMsg::Shutdown);
    }
}

fn run_storage_actor(conn: Connection, rx: Receiver<StorageMsg>) {
    while let Ok(msg) = rx.recv() {
        match msg {
            StorageMsg::WriteTurnStarted {
                thread_id,
                turn_index,
                prompt,
                attachments,
                reply,
            } => {
                let res = (|| -> Result<TurnStarted> {
                    let tx = conn.unchecked_transaction()?;
                    let (model, effort): (Option<String>, Option<String>) = tx.query_row(
                        "SELECT model, effort FROM threads WHERE id = ?1",
                        [thread_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?;
                    let attachments_json =
                        serde_json::to_string(&attachments).unwrap_or_else(|_| "[]".into());
                    tx.execute(
                        "INSERT INTO turns (thread_id, turn_index, prompt, model, effort, attachments, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running')",
                        rusqlite::params![thread_id, turn_index, prompt, model, effort, attachments_json],
                    )?;
                    let turn_id = tx.last_insert_rowid() as u32;
                    tx.execute(
                        "UPDATE threads SET status = 'working', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
                        rusqlite::params![thread_id],
                    )?;
                    tx.commit()?;
                    Ok(TurnStarted {
                        id: turn_id,
                        model,
                        effort,
                    })
                })();
                let _ = reply.send(res);
            }
            StorageMsg::UpdateTurnCompleted {
                turn_id,
                status,
                reply,
            } => {
                let res = (|| -> Result<()> {
                    let status_str = match status {
                        TurnStatus::Running => "running",
                        TurnStatus::Completed => "completed",
                        TurnStatus::Interrupted => "interrupted",
                        TurnStatus::Error => "error",
                    };
                    conn.execute(
                        "UPDATE turns SET status = ?1, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                        rusqlite::params![status_str, turn_id],
                    )?;
                    Ok(())
                })();
                let _ = reply.send(res);
            }
            StorageMsg::WriteItemCompleted {
                turn_id,
                item_index,
                kind,
                content,
                parent_item_index,
                reply,
            } => {
                let res = (|| -> Result<u32> {
                    let kind_str = serde_json::to_string(&kind)
                        .unwrap_or_default()
                        .trim_matches('"')
                        .to_string();
                    conn.execute(
                        "INSERT INTO items (turn_id, item_index, kind, content, parent_item_index) VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![turn_id, item_index, kind_str, content, parent_item_index],
                    )?;
                    let item_id = conn.last_insert_rowid() as u32;
                    Ok(item_id)
                })();
                let _ = reply.send(res);
            }
            StorageMsg::WriteApprovalRequested {
                turn_id,
                approval_id,
                kind,
                summary,
                options,
                reply,
            } => {
                let res = (|| -> Result<u32> {
                    let kind_str = serde_json::to_string(&kind)
                        .unwrap_or_default()
                        .trim_matches('"')
                        .to_string();
                    let options_str =
                        serde_json::to_string(&options).unwrap_or_else(|_| "[]".into());
                    conn.execute(
                        "INSERT INTO approvals (turn_id, approval_id, kind, summary, options) VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![turn_id, approval_id, kind_str, summary, options_str],
                    )?;
                    let id = conn.last_insert_rowid() as u32;
                    Ok(id)
                })();
                let _ = reply.send(res);
            }
            StorageMsg::UpdateApprovalDecision {
                turn_id,
                approval_id,
                decision,
                decided_at,
                reply,
            } => {
                let res = (|| -> Result<String> {
                    let dec_str = serde_json::to_string(&decision)
                        .unwrap_or_default()
                        .trim_matches('"')
                        .to_string();
                    let final_decided_at: String = if !decided_at.is_empty() {
                        decided_at
                    } else {
                        conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| {
                            r.get(0)
                        })?
                    };
                    conn.execute(
                        "UPDATE approvals SET decision = ?1, decided_at = ?2 WHERE turn_id = ?3 AND approval_id = ?4",
                        rusqlite::params![dec_str, final_decided_at, turn_id, approval_id],
                    )?;
                    Ok(final_decided_at)
                })();
                let _ = reply.send(res);
            }
            StorageMsg::ResolvePendingApprovals {
                turn_id,
                decision,
                decided_at,
                reply,
            } => {
                let res = (|| -> Result<String> {
                    let dec_str = serde_json::to_string(&decision)
                        .unwrap_or_default()
                        .trim_matches('"')
                        .to_string();
                    let final_decided_at: String = if !decided_at.is_empty() {
                        decided_at
                    } else {
                        conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| {
                            r.get(0)
                        })?
                    };
                    conn.execute(
                        "UPDATE approvals SET decision = ?1, decided_at = ?2 WHERE turn_id = ?3 AND decision IS NULL",
                        rusqlite::params![dec_str, final_decided_at, turn_id],
                    )?;
                    Ok(final_decided_at)
                })();
                let _ = reply.send(res);
            }
            StorageMsg::UpdateThreadPermissionMode {
                thread_id,
                permission_mode,
                reply,
            } => {
                let res = (|| -> Result<()> {
                    let mode_str = serde_json::to_string(&permission_mode)
                        .unwrap_or_default()
                        .trim_matches('"')
                        .to_string();
                    conn.execute(
                        "UPDATE threads SET permission_mode = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                        rusqlite::params![mode_str, thread_id],
                    )?;
                    Ok(())
                })();
                let _ = reply.send(res);
            }
            StorageMsg::UpdateThreadStatus {
                thread_id,
                status,
                reply,
            } => {
                let res = (|| -> Result<()> {
                    let status_str = status.to_string();
                    conn.execute(
                        "UPDATE threads SET status = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
                        rusqlite::params![status_str, thread_id],
                    )?;
                    Ok(())
                })();
                let _ = reply.send(res);
            }
            StorageMsg::GetSnapshot { thread_id, reply } => {
                let res = query_snapshot(&conn, thread_id);
                let _ = reply.send(res);
            }
            StorageMsg::SetProviderSessionId {
                thread_id,
                session_id,
            } => {
                let _ = conn.execute(
                    "UPDATE threads SET provider_session_id = ?1 WHERE id = ?2",
                    rusqlite::params![session_id, thread_id],
                );
            }
            StorageMsg::WriteUnknownEvent {
                turn_id,
                raw,
                reply,
            } => {
                let res = (|| -> Result<u32> {
                    conn.execute(
                        "INSERT INTO unknown_events (turn_id, raw) VALUES (?1, ?2)",
                        rusqlite::params![turn_id, raw],
                    )?;
                    Ok(conn.last_insert_rowid() as u32)
                })();
                let _ = reply.send(res);
            }
            StorageMsg::Shutdown => break,
        }
    }
}

pub fn query_snapshot(conn: &Connection, thread_id: u32) -> Result<ThreadSnapshot> {
    let thread: ThreadSummary = conn.query_row(
        "SELECT id, project_id, provider, model, effort, permission_mode, status, archived, created_at, updated_at
         FROM threads WHERE id = ?1",
        [thread_id],
        crate::thread::parse_thread_summary,
    )?;

    let mut turn_stmt = conn.prepare(
        "SELECT id, turn_index, prompt, status, started_at, completed_at, model, effort, attachments
         FROM turns WHERE thread_id = ?1 ORDER BY turn_index ASC",
    )?;
    let turn_rows = turn_stmt.query_map([thread_id], |r| {
        let status_str: String = r.get(3)?;
        let turn_status = match status_str.as_str() {
            "running" => TurnStatus::Running,
            "completed" => TurnStatus::Completed,
            "interrupted" => TurnStatus::Interrupted,
            _ => TurnStatus::Error,
        };
        Ok((
            r.get::<_, u32>(0)?,
            r.get::<_, u32>(1)?,
            r.get::<_, String>(2)?,
            turn_status,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, String>(8)?,
        ))
    })?;

    let mut turns = Vec::new();
    let mut item_stmt = conn.prepare(
        "SELECT id, item_index, kind, content, created_at, parent_item_index
         FROM items WHERE turn_id = ?1 ORDER BY item_index ASC",
    )?;
    let mut approval_stmt = conn.prepare(
        "SELECT id, approval_id, kind, summary, options, decision, created_at, decided_at
         FROM approvals WHERE turn_id = ?1 ORDER BY id ASC",
    )?;
    let mut unknown_stmt = conn.prepare(
        "SELECT id, raw, created_at FROM unknown_events WHERE turn_id = ?1 ORDER BY id ASC",
    )?;

    for t in turn_rows {
        let (t_id, t_idx, prompt, status, started_at, completed_at, model, effort, attachments) =
            t?;
        let item_rows = item_stmt.query_map([t_id], |r| {
            let kind_str: String = r.get(2)?;
            let kind: ItemKind = serde_json::from_value(serde_json::Value::String(kind_str))
                .unwrap_or(ItemKind::AgentMessage);
            Ok(ItemSnapshot {
                id: r.get(0)?,
                item_index: r.get(1)?,
                kind,
                content: r.get(3)?,
                created_at: r.get(4)?,
                parent_item_index: r.get(5)?,
            })
        })?;
        let items: Vec<ItemSnapshot> = item_rows.collect::<std::result::Result<_, _>>()?;

        let app_rows = approval_stmt.query_map([t_id], |r| {
            let kind_str: String = r.get(2)?;
            let kind: ApprovalKind = serde_json::from_value(serde_json::Value::String(kind_str))
                .unwrap_or(ApprovalKind::Other);
            let options_str: String = r.get(4)?;
            let options: Vec<String> = serde_json::from_str(&options_str).unwrap_or_default();
            let decision_str: Option<String> = r.get(5)?;
            let decision: Option<ApprovalDecision> = decision_str
                .and_then(|d| serde_json::from_value(serde_json::Value::String(d)).ok());
            Ok(ApprovalSnapshot {
                id: r.get(0)?,
                turn_id: t_id,
                approval_id: r.get(1)?,
                kind,
                summary: r.get(3)?,
                options,
                decision,
                created_at: r.get(6)?,
                decided_at: r.get(7)?,
            })
        })?;
        let approvals: Vec<ApprovalSnapshot> = app_rows.collect::<std::result::Result<_, _>>()?;

        let unk_rows = unknown_stmt.query_map([t_id], |r| {
            Ok(UnknownEventSnapshot {
                id: r.get(0)?,
                raw: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        let unknown_events: Vec<UnknownEventSnapshot> =
            unk_rows.collect::<std::result::Result<_, _>>()?;

        turns.push(TurnSnapshot {
            id: t_id,
            turn_index: t_idx,
            prompt,
            model,
            effort,
            attachments: serde_json::from_str(&attachments).unwrap_or_default(),
            status,
            started_at,
            completed_at,
            items,
            approvals,
            unknown_events,
        });
    }

    let supported_permission_modes = match thread.provider.as_str() {
        "agy" | "antigravity" => vec![PermissionMode::AutoEdit, PermissionMode::FullAccess],
        _ => vec![
            PermissionMode::Ask,
            PermissionMode::AutoEdit,
            PermissionMode::FullAccess,
        ],
    };

    Ok(ThreadSnapshot {
        thread,
        // Filled in by the Thread actor, which knows its Provider.
        capabilities: ThreadCapabilities::default(),
        turns,
        last_seq: 0,
        supported_permission_modes,
    })
}
