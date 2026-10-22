//! Claude Code native provider adapter.

use crate::{
    ApprovalDecision, ApprovalKind, Detection, ItemKind, PermissionMode, Provider,
    ProviderCapabilities, ProviderError, ProviderEvent, StartContext, TurnStatus,
};
use crossbeam_channel::{Receiver, Sender};
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

pub const DEFAULT_CLAUDE_COMMAND: &str = "claude";

/// Pinned version range for Claude Code tested with Oxide.
/// Range: >= 0.2.0, < 2.0.0
pub const PINNED_VERSION_MIN: (u64, u64, u64) = (0, 2, 0);
pub const PINNED_VERSION_MAX: (u64, u64, u64) = (2, 0, 0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCatalogEntry {
    pub alias: &'static str,
    pub efforts: &'static [&'static str],
}

pub const CLAUDE_MODEL_CATALOG: &[ModelCatalogEntry] = &[
    ModelCatalogEntry {
        alias: "opus",
        efforts: &["low", "medium", "high", "max"],
    },
    ModelCatalogEntry {
        alias: "sonnet",
        efforts: &["low", "medium", "high", "max"],
    },
    ModelCatalogEntry {
        alias: "haiku",
        efforts: &["low", "medium", "high"],
    },
];

pub struct ClaudeCodeProvider {
    command: String,
    extra_env: HashMap<String, String>,
    capabilities: Arc<Mutex<ProviderCapabilities>>,
    child_process: Arc<Mutex<Option<Child>>>,
    child_stdin: Arc<Mutex<Option<ChildStdin>>>,
    event_sender: Arc<Mutex<Option<Sender<ProviderEvent>>>>,
    turn_counter: Arc<AtomicU32>,
    active_turn: Arc<Mutex<Option<u32>>>,
}

impl Default for ClaudeCodeProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeCodeProvider {
    pub fn new() -> Self {
        Self::with_command(DEFAULT_CLAUDE_COMMAND)
    }

    pub fn with_command(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            extra_env: HashMap::new(),
            capabilities: Arc::new(Mutex::new(ProviderCapabilities {
                supported_permission_modes: vec![
                    PermissionMode::Ask,
                    PermissionMode::AutoEdit,
                    PermissionMode::FullAccess,
                ],
                interactive_approvals: true,
                supports_reasoning: true,
                image_attachments: false,
            })),
            child_process: Arc::new(Mutex::new(None)),
            child_stdin: Arc::new(Mutex::new(None)),
            event_sender: Arc::new(Mutex::new(None)),
            turn_counter: Arc::new(AtomicU32::new(0)),
            active_turn: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_env(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.extra_env.insert(key.into(), value.into());
    }

    pub fn parse_version_string(raw: &str) -> Option<String> {
        for word in raw.split_whitespace() {
            let clean = word
                .trim_start_matches('v')
                .trim_matches(|c: char| !c.is_numeric() && c != '.');
            let parts: Vec<&str> = clean.split('.').collect();
            if parts.len() >= 2 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
                return Some(clean.to_string());
            }
        }
        None
    }

    pub fn is_version_within_pinned_range(version: &str) -> bool {
        let parts: Vec<u64> = version
            .split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect();
        if parts.len() < 2 {
            return false;
        }
        let major = parts[0];
        let minor = parts[1];
        let patch = if parts.len() > 2 { parts[2] } else { 0 };

        let ver = (major, minor, patch);
        ver >= PINNED_VERSION_MIN && ver < PINNED_VERSION_MAX
    }

    fn spawn_process(
        &mut self,
        context: &StartContext,
        resume_session_id: Option<&str>,
    ) -> Result<Receiver<ProviderEvent>, ProviderError> {
        let mut cmd = Command::new(&self.command);
        cmd.arg("-p")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--include-partial-messages");

        if let Some(ref model) = context.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(ref effort) = context.effort {
            cmd.arg("--effort").arg(effort);
        }
        match context.permission_mode {
            PermissionMode::Ask => {
                cmd.arg("--permission-prompt-tool").arg("oxide_approval");
            }
            PermissionMode::AutoEdit => {
                cmd.arg("--permission-mode").arg("acceptEdits");
                cmd.arg("--permission-prompt-tool").arg("oxide_approval");
            }
            PermissionMode::FullAccess => {
                cmd.arg("--permission-mode").arg("bypassPermissions");
            }
        }

        if let Some(sid) = resume_session_id {
            cmd.arg("--resume").arg(sid);
        }

        cmd.current_dir(&context.working_dir);
        for (k, v) in &self.extra_env {
            cmd.env(k, v);
        }

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::StartFailed(format!(
                "Failed to spawn Claude Code binary `{}`: {e}",
                self.command
            ))
        })?;

        let stdin = child.stdin.take().expect("stdin must be piped");
        let stdout = child.stdout.take().expect("stdout must be piped");

        *self.child_stdin.lock().unwrap() = Some(stdin);
        *self.child_process.lock().unwrap() = Some(child);

        let (tx, rx) = crossbeam_channel::unbounded();
        *self.event_sender.lock().unwrap() = Some(tx.clone());

        let active_turn_clone = Arc::clone(&self.active_turn);
        let capabilities_clone = Arc::clone(&self.capabilities);

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut accumulated_items: HashMap<u32, (ItemKind, String)> = HashMap::new();

            for line_res in reader.lines() {
                let line = match line_res {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let parsed: Result<serde_json::Value, _> = serde_json::from_str(trimmed);
                match parsed {
                    Ok(val) => {
                        let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match event_type {
                            "system" => {
                                if val.get("subtype").and_then(|v| v.as_str()) == Some("init") {
                                    if let Some(session_id) =
                                        val.get("session_id").and_then(|v| v.as_str())
                                    {
                                        let _ = tx.send(ProviderEvent::SessionInfo {
                                            session_id: session_id.to_string(),
                                        });
                                    }
                                    if val
                                        .get("model")
                                        .and_then(|v| v.as_str())
                                        .is_some_and(|m| m.contains("haiku"))
                                    {
                                        capabilities_clone.lock().unwrap().supports_reasoning =
                                            false;
                                    }
                                    if let Some(reasoning) = val
                                        .get("capabilities")
                                        .and_then(|c| c.get("supports_reasoning"))
                                        .and_then(|v| v.as_bool())
                                    {
                                        capabilities_clone.lock().unwrap().supports_reasoning =
                                            reasoning;
                                    }
                                } else {
                                    let _ = tx.send(ProviderEvent::Unknown { raw: line.clone() });
                                }
                            }
                            "stream_event" => {
                                if let Some(event) = val.get("event") {
                                    let sub_type =
                                        event.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    let index =
                                        event.get("index").and_then(|v| v.as_u64()).unwrap_or(0)
                                            as u32;

                                    match sub_type {
                                        "content_block_start" => {
                                            let block = event.get("content_block");
                                            let btype = block
                                                .and_then(|b| b.get("type"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("text");
                                            let kind = if btype == "thinking" {
                                                ItemKind::Reasoning
                                            } else {
                                                ItemKind::AgentMessage
                                            };
                                            accumulated_items.insert(index, (kind, String::new()));
                                            let _ = tx.send(ProviderEvent::ItemStarted {
                                                item_index: index,
                                                kind,
                                            });
                                        }
                                        "content_block_delta" => {
                                            let delta = event.get("delta");
                                            let dtype = delta
                                                .and_then(|d| d.get("type"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");

                                            let (text, is_known) = if dtype == "text_delta" {
                                                (
                                                    delta
                                                        .and_then(|d| d.get("text"))
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or(""),
                                                    true,
                                                )
                                            } else if dtype == "thinking_delta" {
                                                (
                                                    delta
                                                        .and_then(|d| d.get("thinking"))
                                                        .and_then(|v| v.as_str())
                                                        .unwrap_or(""),
                                                    true,
                                                )
                                            } else {
                                                ("", false)
                                            };

                                            if is_known {
                                                if !text.is_empty() {
                                                    if let Some(item) =
                                                        accumulated_items.get_mut(&index)
                                                    {
                                                        item.1.push_str(text);
                                                    }
                                                    let _ = tx.send(ProviderEvent::ItemDelta {
                                                        item_index: index,
                                                        delta: text.to_string(),
                                                    });
                                                }
                                            } else {
                                                let _ = tx.send(ProviderEvent::Unknown {
                                                    raw: line.clone(),
                                                });
                                            }
                                        }
                                        "content_block_stop" => {
                                            let (kind, content) = accumulated_items
                                                .remove(&index)
                                                .unwrap_or((ItemKind::AgentMessage, String::new()));
                                            let _ = tx.send(ProviderEvent::ItemCompleted {
                                                item_index: index,
                                                kind,
                                                content,
                                            });
                                        }
                                        _ => {
                                            let _ = tx
                                                .send(ProviderEvent::Unknown { raw: line.clone() });
                                        }
                                    }
                                } else {
                                    let _ = tx.send(ProviderEvent::Unknown { raw: line.clone() });
                                }
                            }
                            "approval_request" => {
                                let id = val
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let kind = match val.get("kind").and_then(|v| v.as_str()) {
                                    Some("command") => ApprovalKind::Command,
                                    Some("file_change") | Some("file-change") => {
                                        ApprovalKind::FileChange
                                    }
                                    Some("tool") => ApprovalKind::Tool,
                                    _ => ApprovalKind::Other,
                                };
                                let summary = val
                                    .get("summary")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let options = val
                                    .get("options")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                            .collect()
                                    })
                                    .unwrap_or_default();

                                let _ = tx.send(ProviderEvent::ApprovalRequested {
                                    id,
                                    kind,
                                    summary,
                                    options,
                                });
                            }
                            "result" => {
                                let subtype =
                                    val.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                                let is_error = val
                                    .get("is_error")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);

                                let status = if subtype == "interrupted" {
                                    TurnStatus::Interrupted
                                } else if is_error {
                                    TurnStatus::Error
                                } else {
                                    TurnStatus::Completed
                                };

                                let t_idx = active_turn_clone.lock().unwrap().unwrap_or(0);
                                let _ = tx.send(ProviderEvent::TurnCompleted {
                                    turn_index: t_idx,
                                    status,
                                });
                            }
                            _ => {
                                let _ = tx.send(ProviderEvent::Unknown { raw: line.clone() });
                            }
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(ProviderEvent::Unknown { raw: line });
                    }
                }
            }
        });

        Ok(rx)
    }

    fn write_to_stdin(&self, json_val: &serde_json::Value) -> Result<(), ProviderError> {
        let mut stdin_guard = self.child_stdin.lock().unwrap();
        if let Some(ref mut stdin) = *stdin_guard {
            let data = json_val.to_string();
            stdin.write_all(data.as_bytes()).map_err(|e| {
                ProviderError::CommandFailed(format!("Failed to write to stdin: {e}"))
            })?;
            stdin.write_all(b"\n").map_err(|e| {
                ProviderError::CommandFailed(format!("Failed to write newline to stdin: {e}"))
            })?;
            stdin
                .flush()
                .map_err(|e| ProviderError::CommandFailed(format!("Failed to flush stdin: {e}")))?;
            Ok(())
        } else {
            Err(ProviderError::CommandFailed(
                "Child stdin is not available".into(),
            ))
        }
    }
}

impl Provider for ClaudeCodeProvider {
    fn detect(&self) -> Result<Detection, ProviderError> {
        let mut cmd = Command::new(&self.command);
        cmd.arg("--version");
        for (k, v) in &self.extra_env {
            cmd.env(k, v);
        }

        let version_output = match cmd.output() {
            Ok(out) if out.status.success() => out,
            _ => {
                return Ok(Detection {
                    available: false,
                    installed: false,
                    version: None,
                    authenticated: false,
                    warning: None,
                });
            }
        };

        let raw_version_str = String::from_utf8_lossy(&version_output.stdout);
        let parsed_version = Self::parse_version_string(&raw_version_str).or_else(|| {
            let trimmed = raw_version_str.trim();
            if !trimmed.is_empty() {
                Some(trimmed.to_string())
            } else {
                None
            }
        });

        let warning = if let Some(ref ver) = parsed_version {
            if !Self::is_version_within_pinned_range(ver) {
                Some(format!(
                    "Claude Code version {ver} is outside the pinned range tested with Oxide (>= 0.2.0, < 2.0.0)"
                ))
            } else {
                None
            }
        } else {
            None
        };

        let mut auth_cmd = Command::new(&self.command);
        auth_cmd.args(["auth", "status"]);
        for (k, v) in &self.extra_env {
            auth_cmd.env(k, v);
        }

        let auth_output = auth_cmd.output();

        let authenticated = match auth_output {
            Ok(out) => out.status.success(),
            Err(_) => false,
        };

        let available = authenticated;

        Ok(Detection {
            available,
            installed: true,
            version: parsed_version,
            authenticated,
            warning,
        })
    }

    fn start(&mut self, context: &StartContext) -> Result<Receiver<ProviderEvent>, ProviderError> {
        self.spawn_process(context, None)
    }

    fn resume(
        &mut self,
        session_id: &str,
        context: &StartContext,
    ) -> Result<Receiver<ProviderEvent>, ProviderError> {
        self.spawn_process(context, Some(session_id))
    }

    fn send_prompt(&mut self, prompt: &str) -> Result<(), ProviderError> {
        let turn_index = self.turn_counter.fetch_add(1, Ordering::SeqCst);
        *self.active_turn.lock().unwrap() = Some(turn_index);

        // Emit TurnStarted event
        if let Some(ref sender) = *self.event_sender.lock().unwrap() {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index,
                prompt: prompt.to_string(),
            });
        }

        let payload = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": prompt
            }
        });
        self.write_to_stdin(&payload)
    }

    fn interrupt(&mut self) -> Result<(), ProviderError> {
        // Send SIGINT to child process
        if let Some(ref child) = *self.child_process.lock().unwrap() {
            let pid = child.id() as i32;
            unsafe {
                libc::kill(pid, libc::SIGINT);
            }
        }

        // Also write control interrupt to stdin as fallback
        let payload = json!({
            "type": "control",
            "command": "interrupt"
        });
        let _ = self.write_to_stdin(&payload);

        Ok(())
    }

    fn respond_to_approval(
        &mut self,
        id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        let dec_str = match decision {
            ApprovalDecision::Allow => "allow",
            ApprovalDecision::Deny => "deny",
        };
        let payload = json!({
            "type": "approval_response",
            "id": id,
            "decision": dec_str
        });
        self.write_to_stdin(&payload)
    }

    fn set_model(&mut self, model: &str) -> Result<(), ProviderError> {
        let payload = json!({
            "type": "control",
            "command": "set_model",
            "model": model
        });
        self.write_to_stdin(&payload)
    }

    fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<(), ProviderError> {
        let mode_str = match mode {
            PermissionMode::Ask => "ask",
            PermissionMode::AutoEdit => "acceptEdits",
            PermissionMode::FullAccess => "bypassPermissions",
        };
        let payload = json!({
            "type": "control",
            "command": "set_permission_mode",
            "mode": mode_str
        });
        self.write_to_stdin(&payload)
    }

    fn shutdown(&mut self) -> Result<(), ProviderError> {
        // Drop child stdin to signal EOF
        self.child_stdin.lock().unwrap().take();

        // Kill or wait for child process
        if let Some(mut child) = self.child_process.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        // Drop event sender
        self.event_sender.lock().unwrap().take();
        Ok(())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.capabilities.lock().unwrap().clone()
    }
}
