//! The Provider contract: the seam between Core and the agent CLI adapters
//! (Claude Code, Codex, Antigravity CLI). Adapters implement it; Core depends only on it.

pub mod agy;
pub mod claude;
pub mod codex;
pub mod contract_suite;
pub mod process;

use crossbeam_channel::Receiver;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Ask,
    AutoEdit,
    FullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalKind {
    Command,
    #[serde(alias = "file_change")]
    FileChange,
    Tool,
    #[default]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    AgentMessage,
    Reasoning,
    ToolCall,
    FileChange,
    Subagent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    Completed,
    Interrupted,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub available: bool,
    #[serde(default)]
    pub installed: bool,
    pub version: Option<String>,
    #[serde(default)]
    pub authenticated: bool,
    #[serde(default)]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    pub supported_permission_modes: Vec<PermissionMode>,
    pub interactive_approvals: bool,
    pub supports_reasoning: bool,
    /// The Provider accepts image attachments with a prompt.
    #[serde(default)]
    pub image_attachments: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartContext {
    pub working_dir: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider not available: {0}")]
    NotAvailable(String),
    #[error("failed to start session: {0}")]
    StartFailed(String),
    #[error("command failed: {0}")]
    CommandFailed(String),
    /// Resuming failed because the Provider no longer has the session (e.g. it was pruned).
    #[error("Provider session no longer available")]
    SessionNotFound,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ProviderEvent {
    TurnStarted {
        turn_index: u32,
        prompt: String,
    },
    TurnCompleted {
        turn_index: u32,
        status: TurnStatus,
    },
    ItemStarted {
        item_index: u32,
        kind: ItemKind,
        /// The Subagent Item this Item runs inside, if any.
        #[serde(default)]
        parent_item_index: Option<u32>,
    },
    ItemDelta {
        item_index: u32,
        delta: String,
    },
    ItemCompleted {
        item_index: u32,
        kind: ItemKind,
        content: String,
        #[serde(default)]
        parent_item_index: Option<u32>,
    },
    ApprovalRequested {
        id: String,
        #[serde(default)]
        kind: ApprovalKind,
        #[serde(alias = "description")]
        summary: String,
        #[serde(default)]
        options: Vec<String>,
    },
    /// A Provider-side failure. With `retrying` the Provider is retrying on its own (e.g. a rate
    /// limit); otherwise the Turn in flight has failed and must still end with `TurnCompleted`
    /// or `Exited`.
    Error {
        message: String,
        code: Option<String>,
        #[serde(default)]
        retrying: bool,
    },
    SessionInfo {
        session_id: String,
    },
    /// The Provider process ended on its own. Adapters send it once, then drop the channel.
    Exited {
        code: Option<i32>,
        /// The last lines the Provider wrote to stderr, if it wrote any.
        stderr_tail: Option<String>,
    },
    Unknown {
        raw: String,
    },
}

pub trait Provider: Send + 'static {
    fn detect(&self) -> Result<Detection, ProviderError>;
    fn start(&mut self, context: &StartContext) -> Result<Receiver<ProviderEvent>, ProviderError>;
    fn resume(
        &mut self,
        session_id: &str,
        context: &StartContext,
    ) -> Result<Receiver<ProviderEvent>, ProviderError>;
    fn send_prompt(&mut self, prompt: &str) -> Result<(), ProviderError>;
    /// Sends a prompt with image files. Only called when `image_attachments` holds.
    fn send_prompt_with_images(
        &mut self,
        prompt: &str,
        _images: &[PathBuf],
    ) -> Result<(), ProviderError> {
        self.send_prompt(prompt)
    }
    fn interrupt(&mut self) -> Result<(), ProviderError>;
    fn respond_to_approval(
        &mut self,
        id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError>;
    fn set_model(&mut self, model: &str) -> Result<(), ProviderError>;
    fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<(), ProviderError>;
    fn shutdown(&mut self) -> Result<(), ProviderError>;
    fn capabilities(&self) -> ProviderCapabilities;
}

/// The events of one scripted Turn. By convention the first line of a tool call, file change
/// or Subagent `content` is its headline and the rest is detail.
pub fn scripted_turn(turn_index: u32, prompt: &str) -> Vec<ProviderEvent> {
    fn item(
        item_index: u32,
        kind: ItemKind,
        parent_item_index: Option<u32>,
        content: &str,
    ) -> [ProviderEvent; 2] {
        [
            ProviderEvent::ItemStarted {
                item_index,
                kind,
                parent_item_index,
            },
            ProviderEvent::ItemCompleted {
                item_index,
                kind,
                content: content.to_string(),
                parent_item_index,
            },
        ]
    }
    let answer = "All done: the fix is in place.";
    let mut events = vec![ProviderEvent::TurnStarted {
        turn_index,
        prompt: prompt.to_string(),
    }];
    events.extend(item(
        0,
        ItemKind::Reasoning,
        None,
        "The user wants a change; look at the file first.",
    ));
    events.extend(item(
        1,
        ItemKind::ToolCall,
        None,
        "Read src/main.rs\nfn main() {}",
    ));
    events.extend(item(
        2,
        ItemKind::ToolCall,
        None,
        "Run cargo test\n1 passed",
    ));
    events.push(ProviderEvent::ItemStarted {
        item_index: 3,
        kind: ItemKind::Subagent,
        parent_item_index: None,
    });
    events.extend(item(
        4,
        ItemKind::ToolCall,
        Some(3),
        "Grep TODO\nsrc/main.rs:1",
    ));
    events.extend(item(
        5,
        ItemKind::AgentMessage,
        Some(3),
        "No other TODOs found.",
    ));
    events.push(ProviderEvent::ItemCompleted {
        item_index: 3,
        kind: ItemKind::Subagent,
        content: "Explore\nSearch the codebase for TODOs".to_string(),
        parent_item_index: None,
    });
    events.extend(item(6, ItemKind::FileChange, None, "src/main.rs"));
    events.push(ProviderEvent::ItemStarted {
        item_index: 7,
        kind: ItemKind::AgentMessage,
        parent_item_index: None,
    });
    events.push(ProviderEvent::ItemDelta {
        item_index: 7,
        delta: answer.to_string(),
    });
    events.push(ProviderEvent::ItemCompleted {
        item_index: 7,
        kind: ItemKind::AgentMessage,
        content: answer.to_string(),
        parent_item_index: None,
    });
    events.push(ProviderEvent::TurnCompleted {
        turn_index,
        status: TurnStatus::Completed,
    });
    events
}

type PromptHandler = Box<dyn Fn(&str) + Send + Sync>;
type ApprovalHandler = Box<dyn Fn(&str, ApprovalDecision) + Send + Sync>;

/// What a [`FakeProvider`] was asked to do, readable after the Fake is handed to Core.
#[derive(Clone, Default)]
pub struct FakeRecorder {
    starts: Arc<Mutex<u32>>,
    resumes: Arc<Mutex<Vec<String>>>,
    shutdowns: Arc<Mutex<u32>>,
    prompts: Arc<Mutex<Vec<String>>>,
}

impl FakeRecorder {
    /// How many times a session was started or resumed.
    pub fn starts(&self) -> u32 {
        *self.starts.lock().unwrap()
    }

    /// The session id of every resume, in order (each also counts as a start).
    pub fn resumes(&self) -> Vec<String> {
        self.resumes.lock().unwrap().clone()
    }

    /// How many times the Provider was shut down.
    pub fn shutdowns(&self) -> u32 {
        *self.shutdowns.lock().unwrap()
    }

    /// Every prompt sent, in order.
    pub fn prompts(&self) -> Vec<String> {
        self.prompts.lock().unwrap().clone()
    }
}

pub struct FakeProvider {
    capabilities: ProviderCapabilities,
    detection: Detection,
    event_sender: Arc<Mutex<Option<crossbeam_channel::Sender<ProviderEvent>>>>,
    event_receiver: Arc<Mutex<crossbeam_channel::Receiver<ProviderEvent>>>,
    prompt_handler: Arc<Mutex<Option<PromptHandler>>>,
    recorder: FakeRecorder,
    approval_handler: Arc<Mutex<Option<ApprovalHandler>>>,
    current_permission_mode: Arc<Mutex<PermissionMode>>,
    reusable: bool,
    session_not_found: bool,
}

impl Default for FakeProvider {
    fn default() -> Self {
        let (event_sender, event_receiver) = crossbeam_channel::unbounded();
        Self {
            capabilities: ProviderCapabilities {
                supported_permission_modes: vec![
                    PermissionMode::Ask,
                    PermissionMode::AutoEdit,
                    PermissionMode::FullAccess,
                ],
                interactive_approvals: true,
                supports_reasoning: true,
                image_attachments: true,
            },
            detection: Detection {
                available: true,
                installed: true,
                version: Some("0.1.0-fake".to_string()),
                authenticated: true,
                warning: None,
            },
            event_sender: Arc::new(Mutex::new(Some(event_sender))),
            event_receiver: Arc::new(Mutex::new(event_receiver)),
            prompt_handler: Arc::new(Mutex::new(None)),
            recorder: FakeRecorder::default(),
            approval_handler: Arc::new(Mutex::new(None)),
            current_permission_mode: Arc::new(Mutex::new(PermissionMode::Ask)),
            reusable: false,
            session_not_found: false,
        }
    }
}

impl FakeProvider {
    pub fn new(capabilities: ProviderCapabilities, detection: Detection) -> Self {
        let (event_sender, event_receiver) = crossbeam_channel::unbounded();
        Self {
            capabilities,
            detection,
            event_sender: Arc::new(Mutex::new(Some(event_sender))),
            event_receiver: Arc::new(Mutex::new(event_receiver)),
            prompt_handler: Arc::new(Mutex::new(None)),
            recorder: FakeRecorder::default(),
            approval_handler: Arc::new(Mutex::new(None)),
            current_permission_mode: Arc::new(Mutex::new(PermissionMode::Ask)),
            reusable: false,
            session_not_found: false,
        }
    }

    /// A fake that answers every prompt with a Turn containing every Item kind:
    /// reasoning, tool calls, a Subagent with nested tool calls, a file change and a final answer.
    pub fn scripted() -> Self {
        let fake = Self::default().reusable();
        let slot = Arc::clone(&fake.event_sender);
        let turn_counter = Arc::new(AtomicU32::new(0));
        fake.on_prompt(move |prompt| {
            let turn_index = turn_counter.fetch_add(1, Ordering::SeqCst);
            if let Some(sender) = slot.lock().unwrap().as_ref() {
                for event in scripted_turn(turn_index, prompt) {
                    let _ = sender.send(event);
                }
            }
        });
        fake
    }

    /// The event channel of a new session: the current one, or a fresh one after a shutdown.
    fn open_channel(&mut self) -> Receiver<ProviderEvent> {
        let mut sender = self.event_sender.lock().unwrap();
        let mut receiver = self.event_receiver.lock().unwrap();
        if sender.is_none() {
            let (tx, rx) = crossbeam_channel::unbounded();
            *sender = Some(tx);
            *receiver = rx;
        }
        receiver.clone()
    }

    /// Keeps the prompt and approval handlers across a shutdown, so a later `start` or
    /// `resume` brings the same Fake back to life. Handlers must not capture a sender
    /// (use [`FakeProvider::scripted`]'s approach), or the old channel never closes.
    /// Makes every `resume` fail as if the Provider had lost the session.
    pub fn fail_resume_with_session_not_found(&mut self) {
        self.session_not_found = true;
    }

    pub fn reusable(mut self) -> Self {
        self.reusable = true;
        self
    }

    pub fn set_capabilities(&mut self, capabilities: ProviderCapabilities) {
        self.capabilities = capabilities;
    }

    pub fn sender(&self) -> crossbeam_channel::Sender<ProviderEvent> {
        self.event_sender
            .lock()
            .unwrap()
            .as_ref()
            .expect("provider already shut down")
            .clone()
    }

    pub fn recorder(&self) -> FakeRecorder {
        self.recorder.clone()
    }

    pub fn on_prompt(&self, handler: impl Fn(&str) + Send + Sync + 'static) {
        *self.prompt_handler.lock().unwrap() = Some(Box::new(handler));
    }

    pub fn on_approval(&self, handler: impl Fn(&str, ApprovalDecision) + Send + Sync + 'static) {
        *self.approval_handler.lock().unwrap() = Some(Box::new(handler));
    }

    pub fn current_permission_mode(&self) -> PermissionMode {
        *self.current_permission_mode.lock().unwrap()
    }
}

impl Provider for FakeProvider {
    fn detect(&self) -> Result<Detection, ProviderError> {
        Ok(self.detection.clone())
    }

    fn start(&mut self, _context: &StartContext) -> Result<Receiver<ProviderEvent>, ProviderError> {
        *self.recorder.starts.lock().unwrap() += 1;
        Ok(self.open_channel())
    }

    fn resume(
        &mut self,
        session_id: &str,
        _context: &StartContext,
    ) -> Result<Receiver<ProviderEvent>, ProviderError> {
        if self.session_not_found {
            return Err(ProviderError::SessionNotFound);
        }
        *self.recorder.starts.lock().unwrap() += 1;
        self.recorder
            .resumes
            .lock()
            .unwrap()
            .push(session_id.to_string());
        Ok(self.open_channel())
    }

    fn send_prompt(&mut self, prompt: &str) -> Result<(), ProviderError> {
        self.recorder
            .prompts
            .lock()
            .unwrap()
            .push(prompt.to_string());
        if let Some(ref handler) = *self.prompt_handler.lock().unwrap() {
            handler(prompt);
        } else if let Some(ref sender) = *self.event_sender.lock().unwrap() {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt: prompt.to_string(),
            });
        }
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), ProviderError> {
        if let Some(ref sender) = *self.event_sender.lock().unwrap() {
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Interrupted,
            });
        }
        Ok(())
    }

    fn respond_to_approval(
        &mut self,
        id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        if let Some(ref handler) = *self.approval_handler.lock().unwrap() {
            handler(id, decision);
        }
        Ok(())
    }

    fn set_model(&mut self, _model: &str) -> Result<(), ProviderError> {
        Ok(())
    }

    fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<(), ProviderError> {
        *self.current_permission_mode.lock().unwrap() = mode;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), ProviderError> {
        *self.recorder.shutdowns.lock().unwrap() += 1;
        if !self.reusable {
            // Dropping the handlers releases any event sender they captured, so the channel closes.
            *self.prompt_handler.lock().unwrap() = None;
            *self.approval_handler.lock().unwrap() = None;
        }
        self.event_sender.lock().unwrap().take();
        Ok(())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.capabilities.clone()
    }
}
