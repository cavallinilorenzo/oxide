use crossbeam_channel::{Receiver, Sender, TryRecvError};
use oxide_provider::{Provider, ProviderEvent, StartContext, TurnStatus};
use std::collections::HashMap;
use std::sync::mpsc;

use crate::error::{Error, Result};
use crate::storage_actor::StorageHandle;
use crate::thread::{SequencedThreadEvent, ThreadEvent, ThreadSnapshot, ThreadStatus, TurnError};

pub enum ThreadActorMsg {
    SendPrompt {
        prompt: String,
        reply: mpsc::Sender<Result<()>>,
    },
    Interrupt {
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

/// The Turn in flight. Oxide numbers Turns itself; the Provider's own `turn_index` is ignored.
struct CurrentTurn {
    index: u32,
    id: Option<u32>,
    /// The Provider's own error, kept until the Turn ends.
    error_message: Option<String>,
}

struct ActorState {
    thread_id: u32,
    next_turn_index: u32,
    current_turn: Option<CurrentTurn>,
    pending_deltas: HashMap<u32, String>,
    seq: u32,
    subscribers: Vec<Sender<SequencedThreadEvent>>,
}

impl ActorState {
    fn new(thread_id: u32, next_turn_index: u32) -> Self {
        Self {
            thread_id,
            next_turn_index,
            current_turn: None,
            pending_deltas: HashMap::new(),
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
        ProviderEvent::TurnStarted {
            turn_index: _,
            prompt,
        } => {
            let turn_index = state.next_turn_index;
            state.next_turn_index += 1;
            let id = storage
                .write_turn_started(state.thread_id, turn_index, prompt.clone())
                .ok();
            state.current_turn = Some(CurrentTurn {
                index: turn_index,
                id,
                error_message: None,
            });
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
            if let Some(turn_id) = state.current_turn.as_ref().and_then(|t| t.id) {
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
        } => finish_turn(state, storage, status, None),
        ProviderEvent::ApprovalRequested { id, description } => {
            let _ = storage.update_thread_status(state.thread_id, ThreadStatus::NeedsInput);
            state.broadcast(ThreadEvent::ApprovalRequested { id, description });
            state.broadcast_status(ThreadStatus::NeedsInput);
        }
        ProviderEvent::Error {
            message,
            code: _,
            retrying: true,
        } => {
            state.broadcast(ThreadEvent::ProviderRetrying { message });
        }
        ProviderEvent::Error {
            message,
            code: _,
            retrying: false,
        } => {
            if let Some(turn) = state.current_turn.as_mut() {
                turn.error_message = Some(message);
            } else {
                let _ = storage.update_thread_status(state.thread_id, ThreadStatus::Error);
                state.broadcast(ThreadEvent::Error { message });
                state.broadcast_status(ThreadStatus::Error);
            }
        }
        ProviderEvent::Exited { code, stderr_tail } => {
            provider_exited(state, storage, code, stderr_tail)
        }
        ProviderEvent::Unknown { raw } => {
            state.broadcast(ThreadEvent::Unknown { raw });
        }
    }
}

/// Ends the Turn in flight, if any. Never re-sends anything to the Provider.
/// A failed Turn keeps the Provider's own error message when it sent one, else `exit_error`'s.
fn finish_turn(
    state: &mut ActorState,
    storage: &StorageHandle,
    status: TurnStatus,
    exit_error: Option<TurnError>,
) {
    state.flush_pending_deltas();
    let Some(turn) = state.current_turn.take() else {
        return;
    };
    let error = (status == TurnStatus::Error).then(|| {
        let stderr_tail = exit_error.as_ref().and_then(|e| e.stderr_tail.clone());
        let message = turn
            .error_message
            .or(exit_error.map(|e| e.message))
            .unwrap_or_else(|| "The Turn failed".to_string());
        TurnError {
            message,
            stderr_tail,
        }
    });
    if let Some(turn_id) = turn.id {
        let _ = storage.update_turn_completed(turn_id, status, error.clone());
    }
    let final_thread_status = match status {
        TurnStatus::Completed => ThreadStatus::Completed,
        TurnStatus::Interrupted => ThreadStatus::Interrupted,
        TurnStatus::Error => ThreadStatus::Error,
        TurnStatus::Running => ThreadStatus::Working,
    };
    let _ = storage.update_thread_status(state.thread_id, final_thread_status);
    state.broadcast(ThreadEvent::TurnCompleted {
        turn_index: turn.index,
        status,
        error,
    });
    state.broadcast_status(final_thread_status);
}

/// A Provider ending mid-Turn (or during an Approval) fails that Turn; while idle it's silent.
fn provider_exited(
    state: &mut ActorState,
    storage: &StorageHandle,
    code: Option<i32>,
    stderr_tail: Option<String>,
) {
    let message = match code {
        Some(code) => format!("The Provider exited unexpectedly (exit code {code})"),
        None => "The Provider exited unexpectedly".to_string(),
    };
    finish_turn(
        state,
        storage,
        TurnStatus::Error,
        Some(TurnError {
            message,
            stderr_tail,
        }),
    );
}

fn run_thread_actor(
    thread_id: u32,
    working_dir: std::path::PathBuf,
    mut provider: Box<dyn Provider>,
    storage: StorageHandle,
    rx: Receiver<ThreadActorMsg>,
) {
    let next_turn_index = storage
        .get_snapshot(thread_id)
        .ok()
        .and_then(|s| s.turns.last().map(|t| t.turn_index + 1))
        .unwrap_or(0);
    let mut state = ActorState::new(thread_id, next_turn_index);

    // Start provider
    let caps = provider.capabilities();
    let start_ctx = StartContext {
        working_dir,
        model: None,
        effort: None,
        permission_mode: caps
            .supported_permission_modes
            .first()
            .copied()
            .unwrap_or(oxide_provider::PermissionMode::AutoEdit),
    };
    let mut prx = match provider.start(&start_ctx) {
        Ok(receiver) => receiver,
        Err(e) => {
            eprintln!("failed to start provider for thread {thread_id}: {e}");
            crossbeam_channel::never()
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
                        // Stop applies only to a running Turn; the Provider ends it with
                        // `TurnCompleted { Interrupted }`.
                        let result = if state.current_turn.is_some() {
                            provider.interrupt().map_err(|e| Error::Io {
                                path: std::path::PathBuf::from("provider"),
                                source: std::io::Error::other(e.to_string()),
                            })
                        } else {
                            Ok(())
                        };
                        let _ = reply.send(result);
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
                        state.subscribers.push(sub_tx);
                        let _ = reply.send((snapshot, sub_rx));
                    }
                    ThreadActorMsg::Tick => {
                        loop {
                            match prx.try_recv() {
                                Ok(evt) => handle_provider_event(evt, &mut state, &storage),
                                Err(TryRecvError::Empty) => break,
                                Err(TryRecvError::Disconnected) => {
                                    provider_channel_closed(&mut prx, &mut state, &storage);
                                    break;
                                }
                            }
                        }
                        state.flush_pending_deltas();
                    }
                    ThreadActorMsg::Shutdown => {
                        let _ = provider.shutdown();
                        break;
                    }
                }
            }
            recv(prx) -> evt => match evt {
                Ok(evt) => handle_provider_event(evt, &mut state, &storage),
                Err(_) => provider_channel_closed(&mut prx, &mut state, &storage),
            }
        }
    }
}

/// The Provider's event channel closed (after `Exited`, or because an adapter's reader died):
/// treat it as an exit, and stop selecting on the dead channel.
fn provider_channel_closed(
    prx: &mut Receiver<ProviderEvent>,
    state: &mut ActorState,
    storage: &StorageHandle,
) {
    *prx = crossbeam_channel::never();
    provider_exited(state, storage, None, None);
}
