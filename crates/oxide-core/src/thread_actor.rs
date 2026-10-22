use crossbeam_channel::{Receiver, Sender, TryRecvError};
use oxide_provider::{
    ApprovalDecision, ItemKind, PermissionMode, Provider, ProviderCapabilities, ProviderEvent,
    StartContext, TurnStatus,
};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::Instant;

use crate::clock::{Clock, PROVIDER_IDLE_TIMEOUT};
use crate::error::{Error, Result};
use crate::storage_actor::StorageHandle;
use crate::thread::{
    DebugSequencedThreadEvent, SequencedThreadEvent, ThreadCapabilities, ThreadEvent,
    ThreadSnapshot, ThreadStatus, TurnError,
};

pub enum ThreadActorMsg {
    SendPrompt {
        prompt: String,
        attachments: Vec<PathBuf>,
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
    SubscribeDebug {
        reply: mpsc::Sender<(ThreadSnapshot, Receiver<DebugSequencedThreadEvent>)>,
    },
    Tick,
    Shutdown {
        reply: mpsc::Sender<()>,
    },
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
        clock: Arc<dyn Clock>,
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
                run_thread_actor(thread_id, working_dir, provider, storage, clock, rx);
            })
            .map_err(|e| Error::Io {
                path: std::path::PathBuf::from(format!("thread-{thread_id}")),
                source: e,
            })?;

        Ok(Self { sender: tx })
    }

    pub fn send_prompt(&self, prompt: String, attachments: Vec<PathBuf>) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self.sender.send(ThreadActorMsg::SendPrompt {
            prompt,
            attachments,
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

    pub fn subscribe_debug(&self) -> Result<(ThreadSnapshot, Receiver<DebugSequencedThreadEvent>)> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let _ = self
            .sender
            .send(ThreadActorMsg::SubscribeDebug { reply: reply_tx });
        reply_rx.recv().map_err(|_| Error::Io {
            path: std::path::PathBuf::from("subscribe-debug"),
            source: std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "thread actor disconnected",
            ),
        })
    }

    pub fn tick(&self) {
        let _ = self.sender.send(ThreadActorMsg::Tick);
    }

    /// Shuts the Provider down (escalating to SIGKILL if it won't go) and stops the actor.
    /// Returns once the Provider's processes are gone.
    pub fn shutdown(&self) {
        let (reply_tx, reply_rx) = mpsc::channel();
        if self
            .sender
            .send(ThreadActorMsg::Shutdown { reply: reply_tx })
            .is_ok()
        {
            let _ = reply_rx.recv();
        }
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
    pending_deltas: HashMap<u32, PendingDelta>,
    capabilities: ProviderCapabilities,
    /// Attachments of the prompt in flight, claimed by the Turn it starts.
    pending_attachments: Vec<String>,
    /// Items withheld from the Transcript (reasoning the Provider shouldn't expose).
    dropped_items: HashSet<u32>,
    pending_approval_id: Option<String>,
    seq: u32,
    subscribers: Vec<Sender<SequencedThreadEvent>>,
    debug_subscribers: Vec<Sender<DebugSequencedThreadEvent>>,
    clock: Arc<dyn Clock>,
    /// A Provider process is running for this Thread.
    provider_live: bool,
    /// The Provider ended on its own; its adapter still has to be shut down before a restart.
    provider_exited: bool,
    /// Since when no Turn has been in flight. `None` while a prompt is on its way.
    idle_since: Option<Instant>,
}

#[derive(Default)]
struct PendingDelta {
    text: String,
    raw_payloads: Vec<String>,
}

impl ActorState {
    fn new(
        thread_id: u32,
        next_turn_index: u32,
        capabilities: ProviderCapabilities,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let idle_since = Some(clock.now());
        Self {
            clock,
            provider_live: false,
            provider_exited: false,
            idle_since,
            thread_id,
            next_turn_index,
            current_turn: None,
            pending_deltas: HashMap::new(),
            capabilities,
            pending_attachments: Vec::new(),
            dropped_items: HashSet::new(),
            pending_approval_id: None,
            seq: 0,
            subscribers: Vec::new(),
            debug_subscribers: Vec::new(),
        }
    }

    fn current_turn_id(&self) -> Option<u32> {
        self.current_turn.as_ref().and_then(|t| t.id)
    }

    fn has_any_subscriber(&self) -> bool {
        !self.subscribers.is_empty() || !self.debug_subscribers.is_empty()
    }

    fn broadcast_with_raw(&mut self, event: ThreadEvent, raw_payload: Option<String>) {
        if !self.has_any_subscriber() {
            return;
        }
        self.seq += 1;
        let seq = self.seq;

        if !self.subscribers.is_empty() {
            let seq_evt = SequencedThreadEvent {
                seq,
                event: event.clone(),
            };
            self.subscribers.retain(|s| s.send(seq_evt.clone()).is_ok());
        }

        if !self.debug_subscribers.is_empty() {
            let dbg_evt = DebugSequencedThreadEvent {
                seq,
                event,
                raw_payload,
            };
            self.debug_subscribers
                .retain(|s| s.send(dbg_evt.clone()).is_ok());
        }
    }

    fn broadcast(&mut self, event: ThreadEvent) {
        self.broadcast_with_raw(event, None);
    }

    fn broadcast_status(&mut self, status: ThreadStatus) {
        self.broadcast(ThreadEvent::ThreadStatusChanged { status });
    }

    fn flush_pending_deltas(&mut self) {
        if !self.has_any_subscriber() {
            self.pending_deltas.clear();
            return;
        }
        let deltas = std::mem::take(&mut self.pending_deltas);
        for (item_index, delta) in deltas {
            if !delta.text.is_empty() && !self.dropped_items.contains(&item_index) {
                let raw_payload = if delta.raw_payloads.is_empty() {
                    None
                } else {
                    serde_json::to_string(&delta.raw_payloads).ok()
                };
                self.broadcast_with_raw(
                    ThreadEvent::ItemDeltaBatch {
                        item_index,
                        delta: delta.text,
                    },
                    raw_payload,
                );
            }
        }
    }
}

fn handle_provider_event(evt: ProviderEvent, state: &mut ActorState, storage: &StorageHandle) {
    let raw = if !state.debug_subscribers.is_empty() {
        serde_json::to_string(&evt).ok()
    } else {
        None
    };

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
            state.dropped_items.clear();
            let attachments = std::mem::take(&mut state.pending_attachments);
            let (mut model, mut effort) = (None, None);
            let mut id = None;
            if let Ok(started) = storage.write_turn_started(
                state.thread_id,
                turn_index,
                prompt.clone(),
                attachments.clone(),
            ) {
                id = Some(started.id);
                model = started.model;
                effort = started.effort;
            }
            state.current_turn = Some(CurrentTurn {
                index: turn_index,
                id,
                error_message: None,
            });
            let _ = storage.update_thread_status(state.thread_id, ThreadStatus::Working);
            state.broadcast_with_raw(
                ThreadEvent::TurnStarted {
                    turn_index,
                    prompt,
                    model,
                    effort,
                    attachments,
                },
                raw,
            );
            state.broadcast_status(ThreadStatus::Working);
        }
        ProviderEvent::ItemStarted {
            item_index,
            kind,
            parent_item_index,
        } => {
            if kind == ItemKind::Reasoning && !state.capabilities.supports_reasoning {
                state.dropped_items.insert(item_index);
                return;
            }
            state.broadcast_with_raw(
                ThreadEvent::ItemStarted {
                    item_index,
                    kind,
                    parent_item_index,
                },
                raw,
            );
        }
        ProviderEvent::ItemDelta { item_index, delta } => {
            if state.dropped_items.contains(&item_index) {
                return;
            }
            let pending = state.pending_deltas.entry(item_index).or_default();
            pending.text.push_str(&delta);
            if let Some(raw) = raw {
                pending.raw_payloads.push(raw);
            }
        }
        ProviderEvent::ItemCompleted {
            item_index,
            kind,
            content,
            parent_item_index,
        } => {
            if kind == ItemKind::Reasoning && !state.capabilities.supports_reasoning {
                state.dropped_items.insert(item_index);
                return;
            }
            state.flush_pending_deltas();
            if let Some(turn_id) = state.current_turn_id() {
                let _ = storage.write_item_completed(
                    turn_id,
                    item_index,
                    kind,
                    content.clone(),
                    parent_item_index,
                );
            }
            state.broadcast_with_raw(
                ThreadEvent::ItemCompleted {
                    item_index,
                    kind,
                    content,
                    parent_item_index,
                },
                raw,
            );
        }
        ProviderEvent::TurnCompleted {
            turn_index: _,
            status,
        } => finish_turn(state, storage, status, None, raw),
        ProviderEvent::ApprovalRequested {
            id,
            kind,
            summary,
            options,
        } => {
            state.pending_approval_id = Some(id.clone());
            if let Some(turn_id) = state.current_turn_id() {
                let _ = storage.write_approval_requested(
                    turn_id,
                    id.clone(),
                    kind,
                    summary.clone(),
                    options.clone(),
                );
            }
            let _ = storage.update_thread_status(state.thread_id, ThreadStatus::NeedsInput);
            state.broadcast_with_raw(
                ThreadEvent::ApprovalRequested {
                    id,
                    kind,
                    summary,
                    options,
                },
                raw,
            );
            state.broadcast_status(ThreadStatus::NeedsInput);
        }
        ProviderEvent::Error {
            message,
            code: _,
            retrying: true,
        } => {
            state.broadcast_with_raw(ThreadEvent::ProviderRetrying { message }, raw);
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
                state.broadcast_with_raw(ThreadEvent::Error { message }, raw);
                state.broadcast_status(ThreadStatus::Error);
            }
        }
        ProviderEvent::Exited { code, stderr_tail } => {
            provider_exited(state, storage, code, stderr_tail, raw)
        }
        ProviderEvent::Unknown { raw: raw_str } => {
            if let Some(turn_id) = state.current_turn_id() {
                let _ = storage.write_unknown_event(turn_id, raw_str.clone());
            }
            let debug_raw = if !state.debug_subscribers.is_empty() {
                Some(raw_str.clone())
            } else {
                None
            };
            state.broadcast_with_raw(ThreadEvent::Unknown, debug_raw);
        }
    }
}

fn resolve_pending_approvals_if_any(state: &mut ActorState, storage: &StorageHandle) {
    if let (Some(turn_id), true) = (
        state.current_turn_id(),
        state.pending_approval_id.take().is_some(),
    ) {
        let _ = storage.resolve_pending_approvals(turn_id, ApprovalDecision::Deny, String::new());
    }
}

/// Ends the Turn in flight, if any. Never re-sends anything to the Provider.
/// A failed Turn keeps the Provider's own error message when it sent one, else `exit_error`'s.
fn finish_turn(
    state: &mut ActorState,
    storage: &StorageHandle,
    status: TurnStatus,
    exit_error: Option<TurnError>,
    raw: Option<String>,
) {
    state.flush_pending_deltas();
    resolve_pending_approvals_if_any(state, storage);
    let Some(turn) = state.current_turn.take() else {
        return;
    };
    state.idle_since = Some(state.clock.now());
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
    state.broadcast_with_raw(
        ThreadEvent::TurnCompleted {
            turn_index: turn.index,
            status,
            error,
        },
        raw,
    );
    state.broadcast_status(final_thread_status);
}

/// A Provider ending mid-Turn (or during an Approval) fails that Turn; while idle it's silent.
fn provider_exited(
    state: &mut ActorState,
    storage: &StorageHandle,
    code: Option<i32>,
    stderr_tail: Option<String>,
    raw: Option<String>,
) {
    state.provider_live = false;
    state.provider_exited = true;
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
        raw,
    );
}

fn run_thread_actor(
    thread_id: u32,
    working_dir: std::path::PathBuf,
    mut provider: Box<dyn Provider>,
    storage: StorageHandle,
    clock: Arc<dyn Clock>,
    rx: Receiver<ThreadActorMsg>,
) {
    let next_turn_index = storage
        .get_snapshot(thread_id, 0)
        .map(|s| s.turn_count)
        .unwrap_or(0);

    // The Provider starts lazily, on the first prompt (resuming the stored session if there is one).
    let caps = provider.capabilities();
    let mut state = ActorState::new(thread_id, next_turn_index, caps.clone(), clock);
    let mut prx: Receiver<ProviderEvent> = crossbeam_channel::never();

    loop {
        crossbeam_channel::select! {
            recv(rx) -> msg => {
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => break,
                };
                match msg {
                    ThreadActorMsg::SendPrompt { prompt, attachments, reply } => {
                        if !attachments.is_empty() && !state.capabilities.image_attachments {
                            let _ = reply.send(Err(Error::Io {
                                path: PathBuf::from("attachments"),
                                source: std::io::Error::other(
                                    "this Provider does not accept image attachments",
                                ),
                            }));
                            continue;
                        }
                        if let Err(e) = ensure_provider_started(
                            &mut *provider, &mut state, &storage, &working_dir, &mut prx,
                        ) {
                            let _ = reply.send(Err(e));
                            continue;
                        }
                        state.idle_since = None;
                        state.pending_attachments = attachments
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect();
                        let sent = if attachments.is_empty() {
                            provider.send_prompt(&prompt)
                        } else {
                            provider.send_prompt_with_images(&prompt, &attachments)
                        };
                        let p_res = sent.map_err(|e| Error::Io {
                            path: PathBuf::from("provider"),
                            source: std::io::Error::other(e.to_string()),
                        });
                        if p_res.is_err() && state.current_turn.is_none() {
                            state.idle_since = Some(state.clock.now());
                        }
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
                    ThreadActorMsg::RespondToApproval { approval_id, decision, reply } => {
                        let p_res = provider.respond_to_approval(&approval_id, decision).map_err(|e| Error::Io {
                            path: std::path::PathBuf::from("provider"),
                            source: std::io::Error::other(e.to_string()),
                        });
                        let decided_at = if let Some(turn_id) = state.current_turn_id() {
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
                        // Without a live Provider the stored mode applies when the next one starts.
                        let p_res = if state.provider_live {
                            provider.set_permission_mode(mode).map_err(|e| Error::Io {
                                path: std::path::PathBuf::from("provider"),
                                source: std::io::Error::other(e.to_string()),
                            })
                        } else {
                            Ok(())
                        };
                        let s_res = storage.update_thread_permission_mode(state.thread_id, mode);
                        let _ = reply.send(p_res.and(s_res));
                    }
                    ThreadActorMsg::Subscribe { reply } => {
                        let (sub_tx, sub_rx) = crossbeam_channel::unbounded();
                        let mut snapshot = match storage.get_snapshot(thread_id, crate::SNAPSHOT_TURNS) {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("failed to get snapshot for thread {thread_id}: {e}");
                                continue;
                            }
                        };
                        snapshot.last_seq = state.seq;
                        for turn in &mut snapshot.turns {
                            turn.unknown_events.clear();
                        }
                        snapshot.capabilities = ThreadCapabilities {
                            reasoning_text: state.capabilities.supports_reasoning,
                            image_attachments: state.capabilities.image_attachments,
                        };
                        snapshot.supported_permission_modes = provider.capabilities().supported_permission_modes;
                        state.subscribers.push(sub_tx);
                        let _ = reply.send((snapshot, sub_rx));
                    }
                    ThreadActorMsg::SubscribeDebug { reply } => {
                        let (sub_tx, sub_rx) = crossbeam_channel::unbounded();
                        let mut snapshot = match storage.get_snapshot(thread_id, u32::MAX) {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("failed to get snapshot for thread {thread_id}: {e}");
                                continue;
                            }
                        };
                        snapshot.last_seq = state.seq;
                        snapshot.supported_permission_modes = provider.capabilities().supported_permission_modes;
                        state.debug_subscribers.push(sub_tx);
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
                        reap_if_idle(&mut *provider, &mut state, &mut prx);
                    }
                    ThreadActorMsg::Shutdown { reply } => {
                        stop_provider(&mut *provider, &mut state, &mut prx);
                        let _ = reply.send(());
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
    stop_provider(&mut *provider, &mut state, &mut prx);
}

/// Starts the Provider if none is running: resumes the Thread's stored session when it has one,
/// otherwise starts a fresh one.
fn ensure_provider_started(
    provider: &mut dyn Provider,
    state: &mut ActorState,
    storage: &StorageHandle,
    working_dir: &std::path::Path,
    prx: &mut Receiver<ProviderEvent>,
) -> Result<()> {
    if state.provider_live {
        return Ok(());
    }
    if state.provider_exited {
        // Reap what is left of the process that went away on its own.
        let _ = provider.shutdown();
        state.provider_exited = false;
    }
    let permission_mode = storage
        .get_snapshot(state.thread_id, 0)
        .map(|s| s.thread.permission_mode)
        .unwrap_or_else(|_| {
            state
                .capabilities
                .supported_permission_modes
                .first()
                .copied()
                .unwrap_or(PermissionMode::AutoEdit)
        });
    let context = StartContext {
        working_dir: working_dir.to_path_buf(),
        model: None,
        effort: None,
        permission_mode,
    };
    let started = match storage.get_provider_session_id(state.thread_id) {
        Some(session_id) => provider.resume(&session_id, &context),
        None => provider.start(&context),
    };
    match started {
        Ok(receiver) => {
            *prx = receiver;
            state.provider_live = true;
            Ok(())
        }
        Err(e) => Err(Error::Io {
            path: PathBuf::from("provider"),
            source: std::io::Error::other(e.to_string()),
        }),
    }
}

/// Shuts the Provider down and stops listening to it, if one is running.
fn stop_provider(
    provider: &mut dyn Provider,
    state: &mut ActorState,
    prx: &mut Receiver<ProviderEvent>,
) {
    if state.provider_live || state.provider_exited {
        let _ = provider.shutdown();
    }
    state.provider_live = false;
    state.provider_exited = false;
    *prx = crossbeam_channel::never();
}

/// Shuts the Provider down once the Thread has had no Turn in flight for the idle timeout.
/// The next prompt resumes it lazily from the stored session; the Thread's status is untouched.
fn reap_if_idle(
    provider: &mut dyn Provider,
    state: &mut ActorState,
    prx: &mut Receiver<ProviderEvent>,
) {
    let idle = state.provider_live
        && state.current_turn.is_none()
        && state.idle_since.is_some_and(|since| {
            state.clock.now().saturating_duration_since(since) >= PROVIDER_IDLE_TIMEOUT
        });
    if idle {
        stop_provider(provider, state, prx);
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
    provider_exited(state, storage, None, None, None);
}
