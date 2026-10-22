//! The Provider contract: the seam between Core and the agent CLI adapters
//! (Claude Code, Codex, Antigravity CLI). Adapters implement it; Core depends only on it.

pub mod claude;
pub mod contract_suite;

use crossbeam_channel::Receiver;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    },
    ItemDelta {
        item_index: u32,
        delta: String,
    },
    ItemCompleted {
        item_index: u32,
        kind: ItemKind,
        content: String,
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
    Error {
        message: String,
        code: Option<String>,
    },
    SessionInfo {
        session_id: String,
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

type PromptHandler = Box<dyn Fn(&str) + Send + Sync>;
type ApprovalHandler = Box<dyn Fn(&str, ApprovalDecision) + Send + Sync>;

pub struct FakeProvider {
    capabilities: ProviderCapabilities,
    detection: Detection,
    event_sender: Option<crossbeam_channel::Sender<ProviderEvent>>,
    event_receiver: crossbeam_channel::Receiver<ProviderEvent>,
    prompt_handler: Arc<Mutex<Option<PromptHandler>>>,
    approval_handler: Arc<Mutex<Option<ApprovalHandler>>>,
    current_permission_mode: Arc<Mutex<PermissionMode>>,
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
            },
            detection: Detection {
                available: true,
                installed: true,
                version: Some("0.1.0-fake".to_string()),
                authenticated: true,
                warning: None,
            },
            event_sender: Some(event_sender),
            event_receiver,
            prompt_handler: Arc::new(Mutex::new(None)),
            approval_handler: Arc::new(Mutex::new(None)),
            current_permission_mode: Arc::new(Mutex::new(PermissionMode::Ask)),
        }
    }
}

impl FakeProvider {
    pub fn new(capabilities: ProviderCapabilities, detection: Detection) -> Self {
        let (event_sender, event_receiver) = crossbeam_channel::unbounded();
        Self {
            capabilities,
            detection,
            event_sender: Some(event_sender),
            event_receiver,
            prompt_handler: Arc::new(Mutex::new(None)),
            approval_handler: Arc::new(Mutex::new(None)),
            current_permission_mode: Arc::new(Mutex::new(PermissionMode::Ask)),
        }
    }

    pub fn sender(&self) -> crossbeam_channel::Sender<ProviderEvent> {
        self.event_sender
            .as_ref()
            .expect("provider already shut down")
            .clone()
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
        Ok(self.event_receiver.clone())
    }

    fn resume(
        &mut self,
        _session_id: &str,
        _context: &StartContext,
    ) -> Result<Receiver<ProviderEvent>, ProviderError> {
        Ok(self.event_receiver.clone())
    }

    fn send_prompt(&mut self, prompt: &str) -> Result<(), ProviderError> {
        if let Some(ref handler) = *self.prompt_handler.lock().unwrap() {
            handler(prompt);
        } else if let Some(ref sender) = self.event_sender {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt: prompt.to_string(),
            });
        }
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), ProviderError> {
        if let Some(ref sender) = self.event_sender {
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
        *self.prompt_handler.lock().unwrap() = None;
        *self.approval_handler.lock().unwrap() = None;
        self.event_sender.take();
        Ok(())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.capabilities.clone()
    }
}
