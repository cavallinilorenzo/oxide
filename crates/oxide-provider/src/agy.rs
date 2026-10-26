//! Antigravity CLI (`agy`) native provider adapter.
//!
//! `agy -p <prompt> --output-format stream-json` runs one Turn and exits, so every Turn is its
//! own process; Turns after the first resume the conversation with `--conversation <id>`.
//! Headless `agy` cannot ask for Approval, so only Auto-edit (soft-deny) and Full access are
//! offered (ADR-0004), and Oxide never touches `agy`'s settings file.

use crate::process::{self, ProcessRegistry, SHUTDOWN_GRACE};
use crate::{
    ApprovalDecision, Detection, ItemKind, ModelInfo, PermissionMode, Provider,
    ProviderCapabilities, ProviderError, ProviderEvent, StartContext, TurnStatus,
};
use crossbeam_channel::{Receiver, Sender};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const DEFAULT_AGY_COMMAND: &str = "agy";

/// Pinned version range for `agy` tested with Oxide (the fixtures come from 1.4.5).
/// Range: >= 1.4.0, < 1.5.0
pub const PINNED_VERSION_MIN: (u64, u64, u64) = (1, 4, 0);
pub const PINNED_VERSION_MAX: (u64, u64, u64) = (1, 5, 0);

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const STDERR_TAIL_LINES: usize = 20;

/// Tools whose steps are reported as file changes.
const FILE_CHANGE_TOOLS: &[&str] = &[
    "write_to_file",
    "replace_file_content",
    "multi_replace_file_content",
    "sed_file",
    "notebook_edit",
];
const PATH_PARAMS: &[&str] = &[
    "TargetFile",
    "AbsolutePath",
    "FilePath",
    "file_path",
    "path",
    "Path",
];
const HEADLINE_PARAMS: &[&str] = &[
    "CommandLine",
    "command",
    "AbsolutePath",
    "TargetFile",
    "FilePath",
    "file_path",
    "path",
    "Path",
    "DirectoryPath",
    "Query",
    "Pattern",
    "Url",
    "url",
];

/// One entry of `agy models`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgyModel {
    pub slug: String,
    pub label: String,
}

#[derive(Default)]
struct Session {
    context: Option<StartContext>,
    conversation: Option<String>,
}

pub struct AgyProvider {
    command: String,
    extra_env: HashMap<String, String>,
    session: Arc<Mutex<Session>>,
    event_sender: Arc<Mutex<Option<Sender<ProviderEvent>>>>,
    turn_counter: Arc<AtomicU32>,
    /// A Turn's process is running and has not produced its result yet.
    turn_running: Arc<AtomicBool>,
    /// Process group of the latest Turn's process while it lives.
    group: Arc<Mutex<Option<i32>>>,
    interrupted: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    registry: Option<Arc<ProcessRegistry>>,
}

impl Default for AgyProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AgyProvider {
    pub fn new() -> Self {
        Self::with_command(DEFAULT_AGY_COMMAND)
    }

    pub fn with_command(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            extra_env: HashMap::new(),
            session: Arc::new(Mutex::new(Session::default())),
            event_sender: Arc::new(Mutex::new(None)),
            turn_counter: Arc::new(AtomicU32::new(0)),
            turn_running: Arc::new(AtomicBool::new(false)),
            group: Arc::new(Mutex::new(None)),
            interrupted: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
            registry: None,
        }
    }

    /// Records the process group of every Turn in `registry`, so a crashed Oxide's orphans can
    /// be found and killed on the next launch.
    pub fn set_registry(&mut self, registry: Arc<ProcessRegistry>) {
        self.registry = Some(registry);
    }

    pub fn set_env(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.extra_env.insert(key.into(), value.into());
    }

    pub fn parse_version_string(raw: &str) -> Option<String> {
        crate::parse_version_string(raw)
    }

    pub fn is_version_within_pinned_range(version: &str) -> bool {
        crate::is_version_within_range(version, PINNED_VERSION_MIN, PINNED_VERSION_MAX)
    }

    /// The Model catalog, from `agy models`.
    pub fn list_models(&self) -> Result<Vec<AgyModel>, ProviderError> {
        let output = self
            .run_probe(&["models"])
            .map_err(|e| ProviderError::NotAvailable(format!("`agy models` failed: {e}")))?;
        if !output.status.success() {
            return Err(ProviderError::NotAvailable(format!(
                "`agy models` exited with {}",
                output.status
            )));
        }
        Ok(parse_models(&String::from_utf8_lossy(&output.stdout)))
    }

    fn run_probe(&self, args: &[&str]) -> std::io::Result<std::process::Output> {
        let mut cmd = Command::new(&self.command);
        cmd.args(args)
            .envs(&self.extra_env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        process::spawn_in_own_group(&mut cmd);
        let mut child = cmd.spawn()?;
        let pgid = child.id() as i32;
        process::attach_child_to_job(&mut child)?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(PROBE_TIMEOUT) {
            Ok(result) => {
                process::release_job(pgid);
                result
            }
            Err(_) => {
                process::terminate_group(pgid, SHUTDOWN_GRACE, || {});
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "timed out",
                ))
            }
        }
    }

    fn open_channel(&self) -> Receiver<ProviderEvent> {
        let (tx, rx) = crossbeam_channel::unbounded();
        *self.event_sender.lock().unwrap() = Some(tx);
        self.closed.store(false, Ordering::SeqCst);
        rx
    }

    fn begin(
        &mut self,
        context: &StartContext,
        conversation: Option<String>,
    ) -> Result<Receiver<ProviderEvent>, ProviderError> {
        ensure_honourable(context.permission_mode)
            .map_err(|e| ProviderError::StartFailed(e.to_string()))?;
        *self.session.lock().unwrap() = Session {
            context: Some(context.clone()),
            conversation,
        };
        Ok(self.open_channel())
    }

    fn send(&self, event: ProviderEvent) {
        if let Some(sender) = self.event_sender.lock().unwrap().as_ref() {
            let _ = sender.send(event);
        }
    }
}

fn ensure_honourable(mode: PermissionMode) -> Result<(), ProviderError> {
    match mode {
        PermissionMode::Ask => Err(ProviderError::CommandFailed(
            "agy cannot ask for Approval, so the Ask permission mode is not offered".into(),
        )),
        PermissionMode::AutoEdit | PermissionMode::FullAccess => Ok(()),
    }
}

fn parse_models(stdout: &str) -> Vec<AgyModel> {
    stdout
        .lines()
        .filter_map(|line| {
            let (slug, label) = line.split_once('\t')?;
            Some(AgyModel {
                slug: slug.trim().to_string(),
                label: label.trim().to_string(),
            })
        })
        .filter(|m| !m.slug.is_empty())
        .collect()
}

impl Provider for AgyProvider {
    fn detect(&self) -> Result<Detection, ProviderError> {
        let version_output = match self.run_probe(&["--version"]) {
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
        let raw = String::from_utf8_lossy(&version_output.stdout);
        let version = Self::parse_version_string(&raw)
            .or_else(|| Some(raw.trim().to_string()).filter(|v| !v.is_empty()));
        let warning = version
            .as_deref()
            .filter(|v| !Self::is_version_within_pinned_range(v))
            .map(|v| {
                format!(
                    "Antigravity CLI version {v} is outside the pinned range tested with Oxide (>= 1.4.0, < 1.5.0)"
                )
            });

        // `agy` has no auth command; listing models needs the cached credentials.
        let authenticated = self
            .run_probe(&["models"])
            .is_ok_and(|out| out.status.success());

        Ok(Detection {
            available: authenticated,
            installed: true,
            version,
            authenticated,
            warning,
        })
    }

    fn start(&mut self, context: &StartContext) -> Result<Receiver<ProviderEvent>, ProviderError> {
        self.begin(context, None)
    }

    fn resume(
        &mut self,
        session_id: &str,
        context: &StartContext,
    ) -> Result<Receiver<ProviderEvent>, ProviderError> {
        self.begin(context, Some(session_id.to_string()))
    }

    fn send_prompt(&mut self, prompt: &str) -> Result<(), ProviderError> {
        let (context, conversation) = {
            let session = self.session.lock().unwrap();
            let context = session
                .context
                .clone()
                .ok_or_else(|| ProviderError::CommandFailed("session not started".into()))?;
            (context, session.conversation.clone())
        };
        if self.turn_running.swap(true, Ordering::SeqCst) {
            return Err(ProviderError::CommandFailed(
                "a Turn is already running".into(),
            ));
        }

        let mut cmd = Command::new(&self.command);
        cmd.arg("-p")
            .arg(prompt)
            .arg("--output-format")
            .arg("stream-json");
        if let Some(model) = &context.model {
            cmd.arg("--model").arg(model);
        }
        if let Some(effort) = &context.effort {
            cmd.arg("--effort").arg(effort);
        }
        if let Some(id) = &conversation {
            cmd.arg("--conversation").arg(id);
        }
        if context.permission_mode == PermissionMode::FullAccess {
            cmd.arg("--dangerously-skip-permissions");
        }
        cmd.current_dir(&context.working_dir)
            .envs(&self.extra_env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        process::spawn_in_own_group(&mut cmd);

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                self.turn_running.store(false, Ordering::SeqCst);
                return Err(ProviderError::CommandFailed(format!(
                    "Failed to spawn Antigravity CLI `{}`: {e}",
                    self.command
                )));
            }
        };
        let pgid = child.id() as i32;
        if let Err(error) = process::attach_child_to_job(&mut child) {
            self.turn_running.store(false, Ordering::SeqCst);
            return Err(ProviderError::CommandFailed(format!(
                "Failed to contain Antigravity CLI process: {error}"
            )));
        }
        if let Some(registry) = &self.registry {
            registry.register(pgid, &self.command);
        }
        *self.group.lock().unwrap() = Some(pgid);
        self.interrupted.store(false, Ordering::SeqCst);

        let turn_index = self.turn_counter.fetch_add(1, Ordering::SeqCst);
        self.send(ProviderEvent::TurnStarted {
            turn_index,
            prompt: prompt.to_string(),
        });

        let Some(tx) = self.event_sender.lock().unwrap().clone() else {
            return Err(ProviderError::CommandFailed("session is shut down".into()));
        };
        let stdout = child.stdout.take().expect("stdout must be piped");
        let stderr = child.stderr.take().expect("stderr must be piped");
        let turn = TurnRun {
            turn_index,
            working_dir: context.working_dir,
            tx,
            session: Arc::clone(&self.session),
            turn_running: Arc::clone(&self.turn_running),
            group: Arc::clone(&self.group),
            interrupted: Arc::clone(&self.interrupted),
            closed: Arc::clone(&self.closed),
            registry: self.registry.clone(),
        };
        std::thread::spawn(move || turn.run(child, pgid, stdout, stderr));
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), ProviderError> {
        if let Some(_pgid) = *self.group.lock().unwrap() {
            self.interrupted.store(true, Ordering::SeqCst);
            #[cfg(unix)]
            unsafe {
                libc::kill(-_pgid, libc::SIGINT)
            };
        }
        Ok(())
    }

    fn respond_to_approval(
        &mut self,
        _id: &str,
        _decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::CommandFailed(
            "agy has no interactive Approvals".into(),
        ))
    }

    fn set_model(&mut self, model: &str) -> Result<(), ProviderError> {
        let mut session = self.session.lock().unwrap();
        let context = session
            .context
            .as_mut()
            .ok_or_else(|| ProviderError::CommandFailed("session not started".into()))?;
        context.model = Some(model.to_string());
        Ok(())
    }

    fn set_effort(&mut self, effort: &str) -> Result<(), ProviderError> {
        let mut session = self.session.lock().unwrap();
        let context = session
            .context
            .as_mut()
            .ok_or_else(|| ProviderError::CommandFailed("session not started".into()))?;
        context.effort = Some(effort.to_string());
        Ok(())
    }

    fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        match self.list_models() {
            Ok(models) if !models.is_empty() => Ok(models
                .into_iter()
                .map(|m| {
                    let is_legacy = m.slug.contains("1.5") || m.slug.contains("legacy");
                    ModelInfo {
                        id: m.slug,
                        name: m.label,
                        description: None,
                        supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                        default_effort: Some("medium".into()),
                        is_legacy,
                    }
                })
                .collect()),
            _ => Ok(vec![
                ModelInfo {
                    id: "gemini-3.8-flash-high".into(),
                    name: "Gemini 3.8 Flash (High)".into(),
                    description: Some("Fast model with high reasoning".into()),
                    supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    default_effort: Some("high".into()),
                    is_legacy: false,
                },
                ModelInfo {
                    id: "gemini-3.8-flash-medium".into(),
                    name: "Gemini 3.8 Flash (Medium)".into(),
                    description: Some("Fast model with medium reasoning".into()),
                    supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    default_effort: Some("medium".into()),
                    is_legacy: false,
                },
                ModelInfo {
                    id: "claude-sonnet-4-6".into(),
                    name: "Claude Sonnet 4.6 (Thinking)".into(),
                    description: Some("Advanced reasoning model".into()),
                    supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    default_effort: Some("high".into()),
                    is_legacy: false,
                },
                ModelInfo {
                    id: "gemini-1.5-pro".into(),
                    name: "Gemini 1.5 Pro".into(),
                    description: None,
                    supported_efforts: vec![],
                    default_effort: None,
                    is_legacy: true,
                },
            ]),
        }
    }

    fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<(), ProviderError> {
        ensure_honourable(mode)?;
        let mut session = self.session.lock().unwrap();
        let context = session
            .context
            .as_mut()
            .ok_or_else(|| ProviderError::CommandFailed("session not started".into()))?;
        context.permission_mode = mode;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), ProviderError> {
        self.closed.store(true, Ordering::SeqCst);
        let pgid = self.group.lock().unwrap().take();
        if let Some(pgid) = pgid {
            // The Turn's reader thread owns the child and reaps it.
            process::terminate_group(pgid, SHUTDOWN_GRACE, || {});
        }
        self.event_sender.lock().unwrap().take();
        Ok(())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            supported_permission_modes: vec![PermissionMode::AutoEdit, PermissionMode::FullAccess],
            interactive_approvals: false,
            supports_reasoning: false,
            image_attachments: false,
            mid_thread_model_switch: true,
            slash_command_passthrough: false,
        }
    }
}

/// Everything the reader thread of one Turn needs.
struct TurnRun {
    turn_index: u32,
    working_dir: std::path::PathBuf,
    tx: Sender<ProviderEvent>,
    session: Arc<Mutex<Session>>,
    turn_running: Arc<AtomicBool>,
    group: Arc<Mutex<Option<i32>>>,
    interrupted: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    registry: Option<Arc<ProcessRegistry>>,
}

/// An Item being assembled from the steps of one Turn.
struct OpenItem {
    item_index: u32,
    kind: ItemKind,
    content: String,
}

impl TurnRun {
    fn run(
        self,
        mut child: Child,
        pgid: i32,
        stdout: std::process::ChildStdout,
        stderr: std::process::ChildStderr,
    ) {
        let stderr_reader = std::thread::spawn(move || {
            let mut tail = VecDeque::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if tail.len() == STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
            tail.into_iter().collect::<Vec<_>>().join("\n")
        });

        let mut steps: HashMap<u64, OpenItem> = HashMap::new();
        let mut next_item = 0u32;
        let mut result_seen = false;

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                let _ = self.tx.send(ProviderEvent::Unknown { raw: line });
                continue;
            };
            match value.get("event").and_then(Value::as_str) {
                Some("init") => {
                    if let Some(id) = value.get("conversation_id").and_then(Value::as_str) {
                        self.session.lock().unwrap().conversation = Some(id.to_string());
                        let _ = self.tx.send(ProviderEvent::SessionInfo {
                            session_id: id.to_string(),
                        });
                    }
                }
                Some("step_update") => {
                    if !self.step_update(&value["step_update"], &mut steps, &mut next_item) {
                        let _ = self.tx.send(ProviderEvent::Unknown { raw: line });
                    }
                }
                Some("result") => {
                    result_seen = true;
                    self.finish_open_items(&mut steps);
                    self.result(&value["result"]);
                }
                _ => {
                    let _ = self.tx.send(ProviderEvent::Unknown { raw: line });
                }
            }
        }

        let code = child.wait().ok().and_then(|s| s.code());
        let stderr_tail = stderr_reader.join().ok().filter(|t| !t.is_empty());
        if let Some(registry) = &self.registry {
            registry.unregister(pgid);
        }
        {
            let mut group = self.group.lock().unwrap();
            if *group == Some(pgid) {
                *group = None;
            }
        }
        if result_seen || self.closed.load(Ordering::SeqCst) {
            return;
        }
        self.turn_running.store(false, Ordering::SeqCst);
        if self.interrupted.load(Ordering::SeqCst) {
            self.finish_open_items(&mut steps);
            let _ = self.tx.send(ProviderEvent::TurnCompleted {
                turn_index: self.turn_index,
                status: TurnStatus::Interrupted,
            });
        } else {
            let _ = self.tx.send(ProviderEvent::Exited { code, stderr_tail });
        }
    }

    /// Handles one `step_update`; false when its shape is not recognised.
    fn step_update(
        &self,
        step: &Value,
        steps: &mut HashMap<u64, OpenItem>,
        next_item: &mut u32,
    ) -> bool {
        let Some(step_index) = step.get("step_index").and_then(Value::as_u64) else {
            return false;
        };
        let done = step.get("state").and_then(Value::as_str) == Some("DONE");
        match step.get("step_type").and_then(Value::as_str) {
            Some("user_input" | "checkpoint" | "error_message") => true,
            Some("agent_response") => {
                let delta = step
                    .get("text_delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !delta.is_empty() {
                    let item = self.open(steps, step_index, next_item, ItemKind::AgentMessage);
                    item.content.push_str(delta);
                    let _ = self.tx.send(ProviderEvent::ItemDelta {
                        item_index: item.item_index,
                        delta: delta.to_string(),
                    });
                }
                if done {
                    self.complete(steps, step_index, None);
                }
                true
            }
            Some("tool") => {
                let info = &step["tool_info"];
                let kind = tool_kind(step, info);
                self.open(steps, step_index, next_item, kind);
                if done {
                    let content = self.tool_content(kind, step, info);
                    self.complete(steps, step_index, Some(content));
                }
                true
            }
            _ => false,
        }
    }

    /// The Item of `step_index`, started on first sight.
    fn open<'a>(
        &self,
        steps: &'a mut HashMap<u64, OpenItem>,
        step_index: u64,
        next_item: &mut u32,
        kind: ItemKind,
    ) -> &'a mut OpenItem {
        steps.entry(step_index).or_insert_with(|| {
            let item_index = *next_item;
            *next_item += 1;
            let _ = self.tx.send(ProviderEvent::ItemStarted {
                item_index,
                kind,
                parent_item_index: None,
            });
            OpenItem {
                item_index,
                kind,
                content: String::new(),
            }
        })
    }

    /// Completes the Item of `step_index` (a no-op if none was started).
    fn complete(
        &self,
        steps: &mut HashMap<u64, OpenItem>,
        step_index: u64,
        content: Option<String>,
    ) {
        if let Some(item) = steps.remove(&step_index) {
            let _ = self.tx.send(ProviderEvent::ItemCompleted {
                item_index: item.item_index,
                kind: item.kind,
                content: content.unwrap_or(item.content),
                parent_item_index: None,
            });
        }
    }

    fn finish_open_items(&self, steps: &mut HashMap<u64, OpenItem>) {
        let mut open: Vec<_> = steps.drain().collect();
        open.sort_by_key(|(_, item)| item.item_index);
        for (_, item) in open {
            let _ = self.tx.send(ProviderEvent::ItemCompleted {
                item_index: item.item_index,
                kind: item.kind,
                content: item.content,
                parent_item_index: None,
            });
        }
    }

    /// By convention the first line is the headline and the rest is detail.
    fn tool_content(&self, kind: ItemKind, step: &Value, info: &Value) -> String {
        let name = tool_name(step, info);
        let params = &info["parameters"];
        match kind {
            ItemKind::FileChange => {
                let path = first_string(params, PATH_PARAMS).unwrap_or(name);
                let path = std::path::Path::new(path);
                path.strip_prefix(&self.working_dir)
                    .unwrap_or(path)
                    .to_string_lossy()
                    .into_owned()
            }
            ItemKind::Subagent => {
                let subagent = info
                    .get("subagent_info")
                    .or_else(|| step.get("subagent_info"))
                    .and_then(|s| s["subagents"].get(0));
                let type_name = subagent
                    .and_then(|s| s["type_name"].as_str())
                    .unwrap_or(name);
                let role = subagent.and_then(|s| s["role"].as_str()).unwrap_or("");
                join_headline(type_name.to_string(), role)
            }
            _ => {
                let headline = match first_string(params, HEADLINE_PARAMS) {
                    Some(target) => format!("{name} {target}"),
                    None => name.to_string(),
                };
                let detail = match info.get("error").filter(|e| !e.is_null()) {
                    Some(error) => {
                        let kind = error["type"].as_str().unwrap_or("error");
                        let message = error["message"].as_str().unwrap_or("");
                        format!("{kind}: {message}")
                    }
                    None => info["output"].as_str().unwrap_or("").to_string(),
                };
                join_headline(headline, &detail)
            }
        }
    }

    fn result(&self, result: &Value) {
        let status = match result.get("status").and_then(Value::as_str) {
            Some("SUCCESS") => TurnStatus::Completed,
            Some("CANCELED" | "INTERRUPTED") => TurnStatus::Interrupted,
            _ => TurnStatus::Error,
        };
        if status == TurnStatus::Error {
            let message = result
                .get("error")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    format!(
                        "agy ended the Turn with status {}",
                        result["status"].as_str().unwrap_or("unknown")
                    )
                });
            let _ = self.tx.send(ProviderEvent::Error {
                message,
                code: None,
                retrying: false,
            });
        }
        self.turn_running.store(false, Ordering::SeqCst);
        let _ = self.tx.send(ProviderEvent::TurnCompleted {
            turn_index: self.turn_index,
            status,
        });
    }
}

fn tool_name<'a>(step: &'a Value, info: &'a Value) -> &'a str {
    info["name"]
        .as_str()
        .or_else(|| step["tool_name"].as_str())
        .unwrap_or("tool")
}

fn tool_kind(step: &Value, info: &Value) -> ItemKind {
    let has_subagents = info
        .get("subagent_info")
        .or_else(|| step.get("subagent_info"))
        .and_then(|s| s["subagents"].as_array())
        .is_some_and(|s| !s.is_empty());
    if has_subagents {
        ItemKind::Subagent
    } else if FILE_CHANGE_TOOLS.contains(&tool_name(step, info)) {
        ItemKind::FileChange
    } else {
        ItemKind::ToolCall
    }
}

fn first_string<'a>(params: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| params.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
}

fn join_headline(headline: String, detail: &str) -> String {
    if detail.is_empty() {
        headline
    } else {
        format!("{headline}\n{detail}")
    }
}
