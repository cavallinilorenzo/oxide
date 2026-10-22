use crossbeam_channel::{Receiver, Sender};
use oxide_provider::{
    ApprovalDecision, PermissionMode, Provider, ProviderEvent, StartContext, TurnStatus,
};
use std::collections::HashMap;
use std::sync::mpsc;

use crate::error::{Error, Result};
use crate::storage_actor::StorageHandle;
use crate::thread::{SequencedThreadEvent, ThreadEvent, ThreadSnapshot, ThreadStatus};

pub enum ThreadActorMsg {
    SendPrompt {
        prompt: String,
        reply: mpsc::Sender<Result<()>>,
    },
    Interrupt {
        reply: mpsc::Sender<Result<()>>,
    },
    RespondToApproval {
        approval_id: String,
        decision: ApprovalDecision,
        reply: mpsc::Sender<Result<()>>,
    },
    SetPermissionMode {
        mode: PermissionMode,
        reply: mpsc::Sender<Result<()>>,
    },
    Subscribe {
        reply: mpsc::Sender<(ThreadSnapshot, Receiver<SequencedThreadEvent>)>,
    },
    Tick,
    Shutdown,
}

#[derive(Clone)]
pub struct ThreadActorHandle {
    sender: Sender<ThreadActorMsg>,
}

impl ThreadActorHandle {
    pub fn new(
        thread_id: u32,
        working_dir: std::path::PathBuf,
        provider: Box<dyn Provider>,
        storage: StorageHandle,
        real_time_ticker: bool,
    ) -> Result<Self> {
        let (tx, rx) = crossbeam_channel::unbounded();

        if real_time_ticker {
            let ticker_sender = tx.clone();
            std::thread::Builder::new()
                .name(format!("ticker-{thread_id}"))
                .spawn(move || {
                    while ticker_sender.send(ThreadActorMsg::Tick).is_ok() {
                        std::thread::sleep(std::time::Duration::from_millis(16));
                    }
                })
                .ok();
        }

        std::thread::Builder::new()
            .name(format!("thread-actor-{thread_id}"))
            .spawn(move || {
                run_thread_actor(thread_id, working_dir, provider, storage, rx);
            })
            .map_err(|e| Error::Io {
                path: std::path::PathBuf::from(format!("thread-{thread_id}")),
                source: e,
            })?;

        Ok(Self { sender: tx })
    }

    pub fn send_prompt(&self, prompt: String) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(ThreadActorMsg::SendPrompt {
            prompt,
            reply: reply_tx,
        });
        reply_rx.recv().unwrap_or(Ok(()))
    }

    pub fn interrupt(&self) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self
            .sender
            .send(ThreadActorMsg::Interrupt { reply: reply_tx });
        reply_rx.recv().unwrap_or(Ok(()))
    }

    pub fn respond_to_approval(
        &self,
        approval_id: String,
        decision: ApprovalDecision,
    ) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(ThreadActorMsg::RespondToApproval {
            approval_id,
            decision,
            reply: reply_tx,
        });
        reply_rx.recv().unwrap_or(Ok(()))
    }

    pub fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(ThreadActorMsg::SetPermissionMode {
            mode,
            reply: reply_tx,
        });
        reply_rx.recv().unwrap_or(Ok(()))
    }

    pub fn subscribe(&self) -> Result<(ThreadSnapshot, Receiver<SequencedThreadEvent>)> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self
            .sender
            .send(ThreadActorMsg::Subscribe { reply: reply_tx });
        reply_rx.recv().map_err(|_| Error::Io {
            path: std::path::PathBuf::from("subscribe"),
            source: std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "thread actor disconnected",
            ),
        })
    }

    pub fn tick(&self) {
        let _ = self.sender.send(ThreadActorMsg::Tick);
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(ThreadActorMsg::Shutdown);
    }
}

struct ActorState {
    thread_id: u32,
    current_turn_index: u32,
    current_turn_id: Option<u32>,
    pending_deltas: HashMap<u32, String>,
    pending_approval_id: Option<String>,
    seq: u32,
    subscribers: Vec<Sender<SequencedThreadEvent>>,
}

impl ActorState {
    fn new(thread_id: u32) -> Self {
        Self {
            thread_id,
            current_turn_index: 0,
            current_turn_id: None,
            pending_deltas: HashMap::new(),
            pending_approval_id: None,
            seq: 0,
            subscribers: Vec::new(),
        }
    }

    fn broadcast(&mut self, event: ThreadEvent) {
        if self.subscribers.is_empty() {
            return;
        }
        self.seq += 1;
        let seq_evt = SequencedThreadEvent {
            seq: self.seq,
            event,
        };
        self.subscribers.retain(|s| s.send(seq_evt.clone()).is_ok());
    }

    fn broadcast_status(&mut self, status: ThreadStatus) {
        self.broadcast(ThreadEvent::ThreadStatusChanged { status });
    }

    fn flush_pending_deltas(&mut self) {
        if self.subscribers.is_empty() {
            self.pending_deltas.clear();
            return;
        }
        let deltas = std::mem::take(&mut self.pending_deltas);
        for (item_index, delta) in deltas {
            if !delta.is_empty() {
                self.broadcast(ThreadEvent::ItemDeltaBatch { item_index, delta });
            }
        }
    }
}

fn handle_provider_event(evt: ProviderEvent, state: &mut ActorState, storage: &StorageHandle) {
    match evt {
        ProviderEvent::SessionInfo { session_id } => {
            storage.set_provider_session_id(state.thread_id, session_id);
        }
        ProviderEvent::TurnStarted { turn_index, prompt } => {
            state.current_turn_index = turn_index;
            if let Ok(turn_id) =
                storage.write_turn_started(state.thread_id, turn_index, prompt.clone())
            {
                state.current_turn_id = Some(turn_id);
            }
            let _ = storage.update_thread_status(state.thread_id, ThreadStatus::Working);
            state.broadcast(ThreadEvent::TurnStarted { turn_index, prompt });
            state.broadcast_status(ThreadStatus::Working);
        }
        ProviderEvent::ItemStarted { item_index, kind } => {
            state.broadcast(ThreadEvent::ItemStarted { item_index, kind });
        }
        ProviderEvent::ItemDelta { item_index, delta } => {
            state
                .pending_deltas
                .entry(item_index)
                .or_default()
                .push_str(&delta);
        }
        ProviderEvent::ItemCompleted {
            item_index,
            kind,
            content,
        } => {
            state.flush_pending_deltas();
            if let Some(turn_id) = state.current_turn_id {
                let _ = storage.write_item_completed(turn_id, item_index, kind, content.clone());
            }
            state.broadcast(ThreadEvent::ItemCompleted {
                item_index,
                kind,
                content,
            });
        }
        ProviderEvent::TurnCompleted {
            turn_index: _,
            status,
        } => {
            state.flush_pending_deltas();
            resolve_pending_approvals_if_any(state, storage);
            if let Some(turn_id) = state.current_turn_id.take() {
                let _ = storage.update_turn_completed(turn_id, status);
            }
            let final_thread_status = match status {
                TurnStatus::Completed => ThreadStatus::Completed,
                TurnStatus::Interrupted => ThreadStatus::Interrupted,
                TurnStatus::Error => ThreadStatus::Error,
                TurnStatus::Running => ThreadStatus::Working,
            };
            let _ = storage.update_thread_status(state.thread_id, final_thread_status);
            state.broadcast(ThreadEvent::TurnCompleted {
                turn_index: state.current_turn_index,
                status,
            });
            state.broadcast_status(final_thread_status);
            state.current_turn_index += 1;
        }
        ProviderEvent::ApprovalRequested {
            id,
            kind,
            summary,
            options,
        } => {
            state.pending_approval_id = Some(id.clone());
            if let Some(turn_id) = state.current_turn_id {
                let _ = storage.write_approval_requested(
                    turn_id,
                    id.clone(),
                    kind,
                    summary.clone(),
                    options.clone(),
                );
            }
            let _ = storage.update_thread_status(state.thread_id, ThreadStatus::NeedsInput);
            state.broadcast(ThreadEvent::ApprovalRequested {
                id,
                kind,
                summary,
                options,
            });
            state.broadcast_status(ThreadStatus::NeedsInput);
        }
        ProviderEvent::Error { message, code: _ } => {
            let _ = storage.update_thread_status(state.thread_id, ThreadStatus::Error);
            state.broadcast(ThreadEvent::Error { message });
            state.broadcast_status(ThreadStatus::Error);
        }
        ProviderEvent::Unknown { raw } => {
            state.broadcast(ThreadEvent::Unknown { raw });
        }
    }
}

fn resolve_pending_approvals_if_any(state: &mut ActorState, storage: &StorageHandle) {
    if let (Some(turn_id), true) = (
        state.current_turn_id,
        state.pending_approval_id.take().is_some(),
    ) {
        let _ = storage.resolve_pending_approvals(turn_id, ApprovalDecision::Deny, String::new());
    }
}

fn run_thread_actor(
    thread_id: u32,
    working_dir: std::path::PathBuf,
    mut provider: Box<dyn Provider>,
    storage: StorageHandle,
    rx: Receiver<ThreadActorMsg>,
) {
    let mut state = ActorState::new(thread_id);

    // Start provider
    let caps = provider.capabilities();
    let initial_mode = storage
        .get_snapshot(thread_id)
        .map(|s| s.thread.permission_mode)
        .unwrap_or_else(|_| {
            caps.supported_permission_modes
                .first()
                .copied()
                .unwrap_or(oxide_provider::PermissionMode::AutoEdit)
        });
    let start_ctx = StartContext {
        working_dir,
        model: None,
        effort: None,
        permission_mode: initial_mode,
    };
    let prx = match provider.start(&start_ctx) {
        Ok(receiver) => receiver,
        Err(e) => {
            eprintln!("failed to start provider for thread {thread_id}: {e}");
            let (_dummy_tx, dummy_rx) = crossbeam_channel::unbounded();
            dummy_rx
        }
    };

    loop {
        crossbeam_channel::select! {
            recv(rx) -> msg => {
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                    ThreadActorMsg::SendPrompt { prompt, reply } => {
                        let p_res = provider.send_prompt(&prompt).map_err(|e| Error::Io {
                            path: std::path::PathBuf::from("provider"),
                            source: std::io::Error::other(e.to_string()),
                        });
                        let _ = reply.send(p_res);
                    }
                    ThreadActorMsg::Interrupt { reply } => {
                        resolve_pending_approvals_if_any(&mut state, &storage);
                        if let Some(turn_id) = state.current_turn_id.take() {
                            let _ = storage.update_turn_completed(turn_id, TurnStatus::Interrupted);
                        }
                        let _ = storage.update_thread_status(state.thread_id, ThreadStatus::Interrupted);
                        state.broadcast(ThreadEvent::TurnCompleted {
                            turn_index: state.current_turn_index,
                            status: TurnStatus::Interrupted,
                        });
                        state.broadcast_status(ThreadStatus::Interrupted);
                        let _ = provider.interrupt();
                        let _ = reply.send(Ok(()));
                    }
                    ThreadActorMsg::RespondToApproval { approval_id, decision, reply } => {
                        let p_res = provider.respond_to_approval(&approval_id, decision).map_err(|e| Error::Io {
                            path: std::path::PathBuf::from("provider"),
                            source: std::io::Error::other(e.to_string()),
                        });
                        let decided_at = if let Some(turn_id) = state.current_turn_id {
                            storage
                                .update_approval_decision(turn_id, approval_id.clone(), decision, String::new())
                                .unwrap_or_default()
                        } else {
                            String::new()
                        };
                        state.pending_approval_id = None;
                        let _ = storage.update_thread_status(state.thread_id, ThreadStatus::Working);
                        state.broadcast(ThreadEvent::ApprovalResponded {
                            id: approval_id,
                            decision,
                            decided_at,
                        });
                        state.broadcast_status(ThreadStatus::Working);
                        let _ = reply.send(p_res);
                    }
                    ThreadActorMsg::SetPermissionMode { mode, reply } => {
                        let p_res = provider.set_permission_mode(mode).map_err(|e| Error::Io {
                            path: std::path::PathBuf::from("provider"),
                            source: std::io::Error::other(e.to_string()),
                        });
                        let s_res = storage.update_thread_permission_mode(state.thread_id, mode);
                        let _ = reply.send(p_res.and(s_res));
                    }
                    ThreadActorMsg::Subscribe { reply } => {
                        let (sub_tx, sub_rx) = crossbeam_channel::unbounded();
                        let mut snapshot = match storage.get_snapshot(thread_id) {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("failed to get snapshot for thread {thread_id}: {e}");
                                continue;
                            }
                        };
                        snapshot.last_seq = state.seq;
                        snapshot.supported_permission_modes = provider.capabilities().supported_permission_modes;
                        state.subscribers.push(sub_tx);
                        let _ = reply.send((snapshot, sub_rx));
                    }
                    ThreadActorMsg::Tick => {
                        while let Ok(evt) = prx.try_recv() {
                            handle_provider_event(
                                evt,
                                &mut state,
                                &storage,
                            );
                        }
                        state.flush_pending_deltas();
                    }
                    ThreadActorMsg::Shutdown => {
                        let _ = provider.shutdown();
                        break;
                    }
                }
            }
            recv(prx) -> evt => {
                let evt = match evt {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                handle_provider_event(
                    evt,
                    &mut state,
                    &storage,
                );
            }
        }
    }
}
