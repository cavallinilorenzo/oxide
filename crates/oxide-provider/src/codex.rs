//! Codex native provider adapter.

use crate::process;
use crate::{
    ActivityCategory, ApprovalDecision, ApprovalKind, Detection, ItemKind, ModelInfo,
    PermissionMode, Provider, ProviderCapabilities, ProviderError, ProviderEvent, SlashCommandInfo,
    SlashRoute, StartContext, TurnStatus, UsageStatus, UsageWindow, UsageWindowKind,
};
use crossbeam_channel::{Receiver, Sender};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub const DEFAULT_CODEX_COMMAND: &str = "codex";

/// Pinned version range for Codex CLI tested with Oxide.
/// Range: >= 0.100.0, < 1.0.0
pub const PINNED_VERSION_MIN: (u64, u64, u64) = (0, 100, 0);
pub const PINNED_VERSION_MAX: (u64, u64, u64) = (1, 0, 0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexModelEntry {
    pub id: String,
    pub display_name: Option<String>,
    pub supported_reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
    pub is_default: bool,
}

#[derive(Default)]
struct ThreadItemState {
    item_ids: HashMap<String, u32>,
    next_index: u32,
}

impl ThreadItemState {
    fn resolve_index(&mut self, item_id: &str) -> u32 {
        if let Some(&idx) = self.item_ids.get(item_id) {
            idx
        } else {
            let idx = self.next_index;
            self.next_index += 1;
            self.item_ids.insert(item_id.to_string(), idx);
            idx
        }
    }
}

type PendingRequestsMap = Arc<Mutex<HashMap<u64, Sender<Result<serde_json::Value, String>>>>>;
type ThreadItemsMap = Arc<Mutex<HashMap<String, ThreadItemState>>>;
type ServerRequestsMap = Arc<Mutex<HashMap<String, (serde_json::Value, String)>>>;
type ThreadsMap = Arc<Mutex<HashMap<String, Sender<ProviderEvent>>>>;
struct ActiveTurn {
    index: u32,
    id: Option<String>,
    interrupt_requested: bool,
}

type ActiveTurnsMap = Arc<Mutex<HashMap<String, ActiveTurn>>>;

fn dispatch_to_thread(threads: &ThreadsMap, thread_id: Option<&str>, event: ProviderEvent) {
    let threads_guard = threads.lock().unwrap();
    if let Some(tid) = thread_id {
        if let Some(tx) = threads_guard.get(tid) {
            let _ = tx.send(event);
        }
    } else {
        for tx in threads_guard.values() {
            let _ = tx.send(event.clone());
        }
    }
}

fn emit_compaction(threads: &ThreadsMap, items: &ThreadItemsMap, thread_id: Option<&str>) {
    let mut items = items.lock().unwrap();
    let state = items
        .entry(thread_id.unwrap_or_default().to_owned())
        .or_default();
    if state.item_ids.contains_key("oxide-compact-output") {
        return;
    }
    let idx = state.resolve_index("oxide-compact-output");
    dispatch_to_thread(
        threads,
        thread_id,
        ProviderEvent::ItemStarted {
            item_index: idx,
            kind: ItemKind::SlashCommandOutput,
            parent_item_index: None,
            category: None,
        },
    );
    dispatch_to_thread(
        threads,
        thread_id,
        ProviderEvent::ItemCompleted {
            item_index: idx,
            kind: ItemKind::SlashCommandOutput,
            content: "Conversation compacted.".into(),
            parent_item_index: None,
            category: None,
        },
    );
}

/// Maps Codex rate limits (the `account/rateLimits/updated` params or the
/// `account/rateLimits/read` result) to a `UsageLimits` event. Windows are classified by
/// duration, not by whether Codex calls them primary or secondary.
pub fn parse_rate_limits(params: &serde_json::Value) -> Option<ProviderEvent> {
    let limits = params.get("rateLimits")?;
    let windows: Vec<UsageWindow> = ["primary", "secondary"]
        .iter()
        .filter_map(|key| {
            let window = limits.get(key)?;
            let kind = match window.get("windowDurationMins")?.as_i64()? {
                300 => UsageWindowKind::FiveHour,
                10080 => UsageWindowKind::Weekly,
                _ => return None,
            };
            let percent = window.get("usedPercent")?.as_f64()?;
            let status = if percent >= 100.0 {
                UsageStatus::Limited
            } else if percent >= 80.0 {
                UsageStatus::Warning
            } else {
                UsageStatus::Ok
            };
            Some(UsageWindow {
                kind,
                percent_used: Some(percent),
                resets_at: window.get("resetsAt").and_then(|v| v.as_i64()),
                status,
            })
        })
        .collect();
    if windows.is_empty() {
        None
    } else {
        Some(ProviderEvent::UsageLimits { windows })
    }
}

struct AppServerProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

struct AppServerInner {
    process: AppServerProcess,
    handshake_warning: Option<String>,
    models: Vec<CodexModelEntry>,
    skills_cache: HashMap<PathBuf, Vec<serde_json::Value>>,
    next_request_id: AtomicU64,
    pending_requests: PendingRequestsMap,
    pending_server_requests: ServerRequestsMap,
    threads: ThreadsMap,
    thread_items: ThreadItemsMap,
    active_turns: ActiveTurnsMap,
}

pub struct CodexAppServer {
    pub command: String,
    pub extra_env: HashMap<String, String>,
    inner: Arc<Mutex<Option<AppServerInner>>>,
}

impl Default for CodexAppServer {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAppServer {
    pub fn new() -> Self {
        Self::with_command(DEFAULT_CODEX_COMMAND)
    }

    pub fn with_command(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            extra_env: HashMap::new(),
            inner: Arc::new(Mutex::new(None)),
        }
    }

    pub fn shared() -> Arc<Self> {
        static SHARED: OnceLock<Arc<CodexAppServer>> = OnceLock::new();
        SHARED
            .get_or_init(|| Arc::new(CodexAppServer::new()))
            .clone()
    }

    pub fn set_env(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.extra_env.insert(key.into(), value.into());
    }

    pub fn create_provider(self: &Arc<Self>) -> CodexProvider {
        CodexProvider::with_app_server(self.clone())
    }

    fn ensure_running(&self) -> Result<(), ProviderError> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }

        let mut cmd = crate::command::provider_command(&self.command, &self.extra_env);
        cmd.arg("app-server").arg("--listen").arg("stdio://");
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        process::spawn_in_own_group(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            ProviderError::StartFailed(format!(
                "Failed to spawn Codex app-server `{}`: {e}",
                self.command
            ))
        })?;
        process::attach_child_to_job(&mut child).map_err(|e| {
            ProviderError::StartFailed(format!("Failed to contain Codex app-server process: {e}"))
        })?;

        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("stdin must be piped")));
        let stdout = child.stdout.take().expect("stdout must be piped");

        let pending_requests: PendingRequestsMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_server_requests: ServerRequestsMap = Arc::new(Mutex::new(HashMap::new()));
        let threads: ThreadsMap = Arc::new(Mutex::new(HashMap::new()));
        let thread_items: ThreadItemsMap = Arc::new(Mutex::new(HashMap::new()));
        let active_turns: ActiveTurnsMap = Arc::new(Mutex::new(HashMap::new()));

        let pending_requests_clone = pending_requests.clone();
        let pending_server_requests_clone = pending_server_requests.clone();
        let threads_clone = threads.clone();
        let thread_items_clone = thread_items.clone();
        let active_turns_clone = active_turns.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
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
                let val = match parsed {
                    Ok(v) => v,
                    Err(_) => {
                        dispatch_to_thread(
                            &threads_clone,
                            None,
                            ProviderEvent::Unknown { raw: line.clone() },
                        );
                        continue;
                    }
                };

                let has_id = val.get("id").is_some();
                let has_method = val.get("method").and_then(|m| m.as_str()).is_some();

                if has_id && !has_method {
                    // Response to client-initiated request
                    if let Some(id_u64) = val.get("id").and_then(|i| i.as_u64()) {
                        let sender_opt = pending_requests_clone.lock().unwrap().remove(&id_u64);
                        if let Some(tx) = sender_opt {
                            if let Some(err) = val.get("error") {
                                let _ = tx.send(Err(err.to_string()));
                            } else {
                                let res = val
                                    .get("result")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                let _ = tx.send(Ok(res));
                            }
                        }
                    }
                } else if has_id && has_method {
                    // Server-initiated request (e.g. approval)
                    let method = val.get("method").and_then(|m| m.as_str()).unwrap_or("");
                    let id_val = val.get("id").cloned().unwrap_or_default();
                    let id_str = match &id_val {
                        serde_json::Value::String(s) => s.clone(),
                        serde_json::Value::Number(n) => n.to_string(),
                        _ => id_val.to_string(),
                    };
                    pending_server_requests_clone
                        .lock()
                        .unwrap()
                        .insert(id_str.clone(), (id_val, method.to_string()));

                    let params = val.get("params").cloned().unwrap_or_default();
                    let thread_id = params
                        .get("threadId")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());

                    let kind = match method {
                        "item/commandExecution/requestApproval" | "execCommandApproval" => {
                            ApprovalKind::Command
                        }
                        "item/fileChange/requestApproval" | "applyPatchApproval" => {
                            ApprovalKind::FileChange
                        }
                        "item/tool/requestUserInput" | "item/tool/call" => ApprovalKind::Tool,
                        _ => ApprovalKind::Other,
                    };

                    let summary = params
                        .get("command")
                        .and_then(|s| s.as_str())
                        .or_else(|| params.get("reason").and_then(|s| s.as_str()))
                        .unwrap_or(method)
                        .to_string();

                    let options = vec!["allow".to_string(), "deny".to_string()];

                    let event = ProviderEvent::ApprovalRequested {
                        id: id_str,
                        kind,
                        summary,
                        options,
                    };

                    dispatch_to_thread(&threads_clone, thread_id.as_deref(), event);
                } else if has_method {
                    // Server notification
                    let method = val.get("method").and_then(|m| m.as_str()).unwrap_or("");
                    let params = val.get("params").cloned().unwrap_or_default();
                    let thread_id = params
                        .get("threadId")
                        .and_then(|s| s.as_str())
                        .or_else(|| {
                            params
                                .get("thread")
                                .and_then(|t| t.get("id"))
                                .and_then(|s| s.as_str())
                        })
                        .map(|s| s.to_string());

                    match method {
                        "thread/compacted" => {
                            emit_compaction(
                                &threads_clone,
                                &thread_items_clone,
                                thread_id.as_deref(),
                            );
                        }
                        "turn/started" => {
                            // TurnStarted event already emitted immediately on send_prompt
                            if let Some(tid) = &thread_id {
                                let mut turns = active_turns_clone.lock().unwrap();
                                if let Some(turn) = turns.get_mut(tid) {
                                    turn.id = params["turn"]["id"].as_str().map(str::to_owned);
                                }
                            }
                        }
                        "skills/changed" => dispatch_to_thread(
                            &threads_clone,
                            None,
                            ProviderEvent::SlashCommandsChanged,
                        ),
                        "thread/started"
                        | "thread/status/changed"
                        | "account/updated"
                        | "mcpServer/startupStatus/updated"
                        | "hook/started"
                        | "hook/completed"
                        | "thread/tokenUsage/updated"
                        | "remoteControl/status/changed" => {
                            // Known app-server lifecycle and telemetry notifications
                        }
                        "account/rateLimits/updated" => {
                            // Account-wide: goes to every Thread of this app-server.
                            if let Some(event) = parse_rate_limits(&params) {
                                dispatch_to_thread(&threads_clone, None, event);
                            }
                        }
                        "item/started" => {
                            let item = params.get("item").cloned().unwrap_or_default();
                            let item_id =
                                item.get("id").and_then(|s| s.as_str()).unwrap_or("item-0");
                            let itype = item
                                .get("type")
                                .and_then(|s| s.as_str())
                                .unwrap_or("agentMessage");
                            if itype == "contextCompaction" {
                                continue;
                            }

                            let kind = match itype {
                                "agentMessage" => ItemKind::AgentMessage,
                                "reasoning" => ItemKind::Reasoning,
                                "commandExecution" => ItemKind::ToolCall,
                                "fileChange" => ItemKind::FileChange,
                                "subAgentActivity" | "collabAgentToolCall" => ItemKind::Subagent,
                                "enteredReviewMode" | "exitedReviewMode" => {
                                    ItemKind::SlashCommandOutput
                                }
                                _ => {
                                    dispatch_to_thread(
                                        &threads_clone,
                                        thread_id.as_deref(),
                                        ProviderEvent::Unknown { raw: line.clone() },
                                    );
                                    continue;
                                }
                            };

                            let t_key = thread_id.clone().unwrap_or_default();
                            let mut item_map_guard = thread_items_clone.lock().unwrap();
                            let state = item_map_guard.entry(t_key).or_default();
                            let idx = state.resolve_index(item_id);

                            dispatch_to_thread(
                                &threads_clone,
                                thread_id.as_deref(),
                                ProviderEvent::ItemStarted {
                                    item_index: idx,
                                    kind,
                                    parent_item_index: None,
                                    category: codex_category(kind),
                                },
                            );
                        }
                        "item/agentMessage/delta"
                        | "item/reasoning/textDelta"
                        | "item/reasoning/summaryTextDelta"
                        | "item/commandExecution/outputDelta"
                        | "item/fileChange/outputDelta" => {
                            let item_id = params
                                .get("itemId")
                                .and_then(|s| s.as_str())
                                .unwrap_or("item-0");
                            let delta = params.get("delta").and_then(|s| s.as_str()).unwrap_or("");

                            let t_key = thread_id.clone().unwrap_or_default();
                            let mut item_map_guard = thread_items_clone.lock().unwrap();
                            let state = item_map_guard.entry(t_key).or_default();
                            let idx = state.resolve_index(item_id);

                            dispatch_to_thread(
                                &threads_clone,
                                thread_id.as_deref(),
                                ProviderEvent::ItemDelta {
                                    item_index: idx,
                                    delta: delta.to_string(),
                                },
                            );
                        }
                        "item/completed" => {
                            let item = params.get("item").cloned().unwrap_or_default();
                            let item_id =
                                item.get("id").and_then(|s| s.as_str()).unwrap_or("item-0");
                            let itype = item
                                .get("type")
                                .and_then(|s| s.as_str())
                                .unwrap_or("agentMessage");
                            if itype == "contextCompaction" {
                                emit_compaction(
                                    &threads_clone,
                                    &thread_items_clone,
                                    thread_id.as_deref(),
                                );
                                continue;
                            }

                            let kind = match itype {
                                "agentMessage" => ItemKind::AgentMessage,
                                "reasoning" => ItemKind::Reasoning,
                                "commandExecution" => ItemKind::ToolCall,
                                "fileChange" => ItemKind::FileChange,
                                "subAgentActivity" | "collabAgentToolCall" => ItemKind::Subagent,
                                "enteredReviewMode" | "exitedReviewMode" => {
                                    ItemKind::SlashCommandOutput
                                }
                                _ => {
                                    dispatch_to_thread(
                                        &threads_clone,
                                        thread_id.as_deref(),
                                        ProviderEvent::Unknown { raw: line.clone() },
                                    );
                                    continue;
                                }
                            };

                            let content = match itype {
                                "enteredReviewMode" | "exitedReviewMode" => item
                                    .get("review")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                "agentMessage" => item
                                    .get("text")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                "commandExecution" => {
                                    let cmd =
                                        item.get("command").and_then(|s| s.as_str()).unwrap_or("");
                                    let out = item
                                        .get("aggregatedOutput")
                                        .and_then(|s| s.as_str())
                                        .unwrap_or("");
                                    if out.is_empty() {
                                        cmd.to_string()
                                    } else {
                                        format!("{cmd}\n{out}")
                                    }
                                }
                                _ => item
                                    .get("text")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                            };

                            let t_key = thread_id.clone().unwrap_or_default();
                            let mut item_map_guard = thread_items_clone.lock().unwrap();
                            let state = item_map_guard.entry(t_key).or_default();
                            let idx = state.resolve_index(item_id);

                            dispatch_to_thread(
                                &threads_clone,
                                thread_id.as_deref(),
                                ProviderEvent::ItemCompleted {
                                    item_index: idx,
                                    kind,
                                    content,
                                    parent_item_index: None,
                                    category: codex_category(kind),
                                },
                            );
                        }
                        "turn/completed" => {
                            let turn = params.get("turn").cloned().unwrap_or_default();
                            let status_str = turn
                                .get("status")
                                .and_then(|s| s.as_str())
                                .unwrap_or("completed");
                            let status = match status_str {
                                "completed" => TurnStatus::Completed,
                                "interrupted" => TurnStatus::Interrupted,
                                _ => TurnStatus::Error,
                            };

                            let turn_idx = if let Some(ref tid) = thread_id {
                                active_turns_clone
                                    .lock()
                                    .unwrap()
                                    .remove(tid)
                                    .map(|turn| turn.index)
                                    .unwrap_or(0)
                            } else {
                                0
                            };

                            dispatch_to_thread(
                                &threads_clone,
                                thread_id.as_deref(),
                                ProviderEvent::TurnCompleted {
                                    turn_index: turn_idx,
                                    status,
                                },
                            );

                            // Clear thread item indexing for next turn
                            if let Some(ref tid) = thread_id {
                                thread_items_clone.lock().unwrap().remove(tid);
                            }
                        }
                        _ => {
                            // Unrecognized notification -> emit Unknown
                            dispatch_to_thread(
                                &threads_clone,
                                thread_id.as_deref(),
                                ProviderEvent::Unknown { raw: line.clone() },
                            );
                        }
                    }
                } else {
                    // Unrecognized JSON without id or method
                    dispatch_to_thread(
                        &threads_clone,
                        None,
                        ProviderEvent::Unknown { raw: line.clone() },
                    );
                }
            }

            // Reader exited / EOF
            let threads = threads_clone.lock().unwrap();
            for tx in threads.values() {
                let _ = tx.send(ProviderEvent::Exited {
                    code: None,
                    stderr_tail: None,
                });
            }
        });

        let app_inner = AppServerInner {
            process: AppServerProcess { child, stdin },
            handshake_warning: None,
            models: Vec::new(),
            skills_cache: HashMap::new(),
            next_request_id: AtomicU64::new(1),
            pending_requests,
            pending_server_requests,
            threads,
            thread_items,
            active_turns,
        };

        *guard = Some(app_inner);
        drop(guard);

        // Perform handshake (initialize)
        self.initialize_handshake()?;
        // Fetch model list
        let _ = self.fetch_model_catalog();

        Ok(())
    }

    fn send_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ProviderError> {
        self.ensure_running()?;
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or_else(|| {
            ProviderError::CommandFailed("App server process is not running".to_string())
        })?;

        let id = inner.next_request_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = crossbeam_channel::bounded(1);
        inner.pending_requests.lock().unwrap().insert(id, tx);

        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let req_str = req.to_string();
        let stdin_arc = inner.process.stdin.clone();
        drop(guard);

        let mut stdin = stdin_arc.lock().unwrap();
        stdin.write_all(req_str.as_bytes()).map_err(|e| {
            ProviderError::CommandFailed(format!("Failed to write request to app-server: {e}"))
        })?;
        stdin.write_all(b"\n").map_err(|e| {
            ProviderError::CommandFailed(format!("Failed to write newline to app-server: {e}"))
        })?;
        stdin.flush().map_err(|e| {
            ProviderError::CommandFailed(format!("Failed to flush app-server stdin: {e}"))
        })?;
        drop(stdin);

        let res = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| {
                ProviderError::CommandFailed(format!("Timeout waiting for response to {method}"))
            })?;

        res.map_err(ProviderError::CommandFailed)
    }

    fn initialize_handshake(&self) -> Result<(), ProviderError> {
        let params = json!({
            "clientInfo": {
                "name": "oxide",
                "title": "Oxide",
                "version": "0.1.0"
            },
            "capabilities": {
                "experimentalApi": false
            }
        });

        let res = self.send_request("initialize", params)?;
        let user_agent = res.get("userAgent").and_then(|s| s.as_str()).unwrap_or("");

        let parsed_ver = CodexProvider::parse_version_string(user_agent);
        let warning = if let Some(ref ver) = parsed_ver {
            if !CodexProvider::is_version_within_pinned_range(ver) {
                Some(format!(
                    "Codex app-server version {ver} is outside the pinned range tested with Oxide (>= 0.100.0, < 1.0.0)"
                ))
            } else {
                None
            }
        } else {
            None
        };

        if let Some(w) = warning {
            let mut guard = self.inner.lock().unwrap();
            if let Some(ref mut inner) = *guard {
                inner.handshake_warning = Some(w);
            }
        }

        Ok(())
    }

    fn fetch_model_catalog(&self) -> Result<Vec<CodexModelEntry>, ProviderError> {
        let res = self.send_request("model/list", json!({}))?;
        let data = res
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();

        let mut models = Vec::new();
        for item in data {
            let id = item
                .get("id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let display_name = item
                .get("displayName")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let is_default = item
                .get("isDefault")
                .and_then(|b| b.as_bool())
                .unwrap_or(false);

            let mut efforts = Vec::new();
            if let Some(arr) = item
                .get("supportedReasoningEfforts")
                .and_then(|a| a.as_array())
            {
                for effort_obj in arr {
                    if let Some(eff) = effort_obj.get("reasoningEffort").and_then(|s| s.as_str()) {
                        efforts.push(eff.to_string());
                    }
                }
            }

            models.push(CodexModelEntry {
                id,
                display_name,
                supported_reasoning_efforts: efforts,
                default_reasoning_effort: item
                    .get("defaultReasoningEffort")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned),
                is_default,
            });
        }

        let mut guard = self.inner.lock().unwrap();
        if let Some(ref mut inner) = *guard {
            inner.models = models.clone();
        }

        Ok(models)
    }

    pub fn models(&self) -> Vec<CodexModelEntry> {
        let guard = self.inner.lock().unwrap();
        guard.as_ref().map(|i| i.models.clone()).unwrap_or_default()
    }

    pub fn warning(&self) -> Option<String> {
        let guard = self.inner.lock().unwrap();
        guard.as_ref().and_then(|i| i.handshake_warning.clone())
    }

    fn respond_to_server_request(
        &self,
        id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or_else(|| {
            ProviderError::CommandFailed("App server process is not running".to_string())
        })?;

        let (raw_id, method) = inner
            .pending_server_requests
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| {
                ProviderError::CommandFailed(format!("No pending server request with id `{id}`"))
            })?;

        let res_payload = match method.as_str() {
            "execCommandApproval" | "applyPatchApproval" => {
                let dec = match decision {
                    ApprovalDecision::Allow => "approved",
                    ApprovalDecision::Deny => "denied",
                };
                json!({ "decision": dec })
            }
            _ => {
                let dec = match decision {
                    ApprovalDecision::Allow => "accept",
                    ApprovalDecision::Deny => "decline",
                };
                json!({ "decision": dec })
            }
        };

        let response = json!({
            "jsonrpc": "2.0",
            "id": raw_id,
            "result": res_payload,
        });

        let resp_str = response.to_string();
        let stdin_arc = inner.process.stdin.clone();
        drop(guard);

        let mut stdin = stdin_arc.lock().unwrap();
        stdin.write_all(resp_str.as_bytes()).map_err(|e| {
            ProviderError::CommandFailed(format!("Failed to write approval response: {e}"))
        })?;
        stdin
            .write_all(b"\n")
            .map_err(|e| ProviderError::CommandFailed(format!("Failed to write newline: {e}")))?;
        stdin
            .flush()
            .map_err(|e| ProviderError::CommandFailed(format!("Failed to flush: {e}")))?;

        Ok(())
    }

    fn register_thread(&self, thread_id: String, sender: Sender<ProviderEvent>) {
        let guard = self.inner.lock().unwrap();
        if let Some(ref inner) = *guard {
            inner.threads.lock().unwrap().insert(thread_id, sender);
        }
    }

    fn unregister_thread(&self, thread_id: &str) {
        let guard = self.inner.lock().unwrap();
        if let Some(ref inner) = *guard {
            inner.threads.lock().unwrap().remove(thread_id);
            inner.thread_items.lock().unwrap().remove(thread_id);
            inner.active_turns.lock().unwrap().remove(thread_id);
        }
    }

    fn record_active_turn(&self, thread_id: String, turn_index: u32) {
        let guard = self.inner.lock().unwrap();
        if let Some(ref inner) = *guard {
            inner.active_turns.lock().unwrap().insert(
                thread_id,
                ActiveTurn {
                    index: turn_index,
                    id: None,
                    interrupt_requested: false,
                },
            );
        }
    }

    fn start_turn(
        &self,
        thread_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), ProviderError> {
        let response = self.send_request(method, params)?;
        // A caller may interrupt immediately after send_prompt returns, before turn/started.
        let interrupt_requested = {
            let guard = self.inner.lock().unwrap();
            if let Some(inner) = guard.as_ref() {
                let mut turns = inner.active_turns.lock().unwrap();
                if let Some(turn) = turns.get_mut(thread_id) {
                    turn.id = response["turn"]["id"].as_str().map(str::to_owned);
                    turn.interrupt_requested
                } else {
                    false
                }
            } else {
                false
            }
        };
        if interrupt_requested {
            self.interrupt_turn(thread_id)?;
        }
        Ok(())
    }

    fn interrupt_turn(&self, thread_id: &str) -> Result<(), ProviderError> {
        let turn_id = {
            let guard = self.inner.lock().unwrap();
            guard.as_ref().and_then(|inner| {
                inner
                    .active_turns
                    .lock()
                    .unwrap()
                    .get(thread_id)
                    .and_then(|turn| turn.id.clone())
            })
        };
        if let Some(turn_id) = turn_id {
            self.send_request(
                "turn/interrupt",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                }),
            )?;
        } else {
            let guard = self.inner.lock().unwrap();
            if let Some(inner) = guard.as_ref()
                && let Some(turn) = inner.active_turns.lock().unwrap().get_mut(thread_id)
            {
                turn.interrupt_requested = true;
            }
        }
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), ProviderError> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(mut inner) = guard.take() {
            inner.threads.lock().unwrap().clear();
            inner.pending_requests.lock().unwrap().clear();
            inner.pending_server_requests.lock().unwrap().clear();
            let pid = inner.process.child.id() as i32;
            process::terminate_group(pid, process::SHUTDOWN_GRACE, || {
                let _ = inner.process.child.try_wait();
            });
            let _ = inner.process.child.wait();
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct CodexProvider {
    app_server: Arc<CodexAppServer>,
    thread_id: Arc<Mutex<Option<String>>>,
    event_sender: Arc<Mutex<Option<Sender<ProviderEvent>>>>,
    turn_counter: Arc<AtomicU32>,
    active_model: Arc<Mutex<Option<String>>>,
    active_effort: Arc<Mutex<Option<String>>>,
    active_permission_mode: Arc<Mutex<PermissionMode>>,
    working_dir: Arc<Mutex<PathBuf>>,
    capabilities: Arc<Mutex<ProviderCapabilities>>,
}

impl Default for CodexProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexProvider {
    /// Asks Codex for the account's current limits so the ring is current before the first
    /// prompt. Best effort: a failed read just leaves the last known figures.
    fn request_usage_limits(&self, tx: Sender<ProviderEvent>) {
        let app_server = self.app_server.clone();
        std::thread::spawn(move || {
            if let Ok(res) = app_server.send_request("account/rateLimits/read", json!({}))
                && let Some(event) = parse_rate_limits(&res)
            {
                let _ = tx.send(event);
            }
        });
    }

    pub fn new() -> Self {
        Self::with_app_server(CodexAppServer::shared())
    }

    pub fn with_app_server(app_server: Arc<CodexAppServer>) -> Self {
        Self {
            app_server,
            thread_id: Arc::new(Mutex::new(None)),
            event_sender: Arc::new(Mutex::new(None)),
            turn_counter: Arc::new(AtomicU32::new(0)),
            active_model: Arc::new(Mutex::new(None)),
            active_effort: Arc::new(Mutex::new(None)),
            active_permission_mode: Arc::new(Mutex::new(PermissionMode::Ask)),
            working_dir: Arc::new(Mutex::new(PathBuf::new())),
            capabilities: Arc::new(Mutex::new(ProviderCapabilities {
                supported_permission_modes: vec![
                    PermissionMode::Ask,
                    PermissionMode::AutoEdit,
                    PermissionMode::FullAccess,
                ],
                interactive_approvals: true,
                supports_reasoning: true,
                image_attachments: true,
                mid_thread_model_switch: true,
                reports_usage_limits: true,
            })),
        }
    }

    pub fn with_command(command: impl Into<String>) -> Self {
        let server = Arc::new(CodexAppServer::with_command(command));
        Self::with_app_server(server)
    }

    pub fn set_env(&mut self, key: impl Into<String>, value: impl Into<String>) {
        if let Some(server) = Arc::get_mut(&mut self.app_server) {
            server.set_env(key, value);
        } else {
            let mut new_server = CodexAppServer::with_command(&self.app_server.command);
            for (k, v) in &self.app_server.extra_env {
                new_server.set_env(k, v);
            }
            new_server.set_env(key, value);
            self.app_server = Arc::new(new_server);
        }
    }

    pub fn app_server(&self) -> Arc<CodexAppServer> {
        self.app_server.clone()
    }

    pub fn models(&self) -> Vec<CodexModelEntry> {
        self.app_server.models()
    }

    pub fn parse_version_string(raw: &str) -> Option<String> {
        crate::parse_version_string(raw)
    }

    pub fn is_version_within_pinned_range(version: &str) -> bool {
        crate::is_version_within_range(version, PINNED_VERSION_MIN, PINNED_VERSION_MAX)
    }

    fn map_permission_mode_to_thread_start(mode: PermissionMode) -> (&'static str, &'static str) {
        match mode {
            PermissionMode::Ask => ("read-only", "untrusted"),
            PermissionMode::AutoEdit => ("workspace-write", "on-request"),
            PermissionMode::FullAccess => ("danger-full-access", "never"),
        }
    }

    fn skills(
        &self,
        working_dir: &std::path::Path,
    ) -> Result<Vec<serde_json::Value>, ProviderError> {
        let result = self.app_server.send_request(
            "skills/list",
            json!({"cwds": [working_dir.to_string_lossy()]}),
        )?;
        let skills: Vec<_> = result["data"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
            .filter(|skill| skill["enabled"].as_bool() == Some(true))
            .cloned()
            .collect();
        if let Some(inner) = self.app_server.inner.lock().unwrap().as_mut() {
            inner
                .skills_cache
                .insert(working_dir.to_owned(), skills.clone());
        }
        Ok(skills)
    }

    fn finish_native_request(
        &self,
        thread_id: &str,
        turn_index: u32,
        result: Result<(), ProviderError>,
    ) -> Result<(), ProviderError> {
        if let Err(ref error) = result {
            let guard = self.app_server.inner.lock().unwrap();
            if let Some(inner) = guard.as_ref() {
                inner.active_turns.lock().unwrap().remove(thread_id);
            }
            drop(guard);
            if let Some(sender) = self.event_sender.lock().unwrap().as_ref() {
                let _ = sender.send(ProviderEvent::Error {
                    message: error.to_string(),
                    code: None,
                    retrying: false,
                });
                let _ = sender.send(ProviderEvent::TurnCompleted {
                    turn_index,
                    status: TurnStatus::Error,
                });
            }
        }
        result
    }

    fn map_permission_mode_to_turn_start(
        mode: PermissionMode,
    ) -> (serde_json::Value, &'static str) {
        match mode {
            PermissionMode::Ask => (json!({ "type": "readOnly" }), "untrusted"),
            PermissionMode::AutoEdit => (json!({ "type": "workspaceWrite" }), "on-request"),
            PermissionMode::FullAccess => (json!({ "type": "dangerFullAccess" }), "never"),
        }
    }
}

impl Provider for CodexProvider {
    fn slash_commands(
        &self,
        working_dir: &std::path::Path,
    ) -> Result<Vec<SlashCommandInfo>, ProviderError> {
        let mut commands = vec![
            SlashCommandInfo {
                name: "compact".into(),
                description: Some("Compact the conversation".into()),
                argument_hint: None,
                aliases: vec![],
                route: SlashRoute::Native,
            },
            SlashCommandInfo {
                name: "review".into(),
                description: Some("Review changes".into()),
                argument_hint: Some("[instructions]".into()),
                aliases: vec![],
                route: SlashRoute::Native,
            },
        ];
        for skill in self.skills(working_dir)? {
            if let Some(name) = skill["name"].as_str() {
                commands.push(SlashCommandInfo {
                    name: name.into(),
                    description: skill["description"].as_str().map(str::to_owned),
                    argument_hint: Some("[text]".into()),
                    aliases: vec![],
                    route: SlashRoute::Native,
                });
            }
        }
        Ok(commands)
    }
    fn detect(&self) -> Result<Detection, ProviderError> {
        let mut cmd =
            crate::command::provider_command(&self.app_server.command, &self.app_server.extra_env);
        cmd.arg("--version");

        let version_output = match process::output_in_own_group(&mut cmd) {
            Ok(out) if out.status.success() => out,
            _ => {
                return Ok(Detection {
                    available: false,
                    installed: false,
                    version: None,
                    authenticated: false,
                    warning: Some(
                        "Codex CLI is not installed. Install it with `npm install -g @openai/codex` or visit https://developers.openai.com/codex/cli".to_string(),
                    ),
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

        let mut warning = if let Some(ref ver) = parsed_version {
            if !Self::is_version_within_pinned_range(ver) {
                Some(format!(
                    "Codex version {ver} is outside the pinned range tested with Oxide (>= 0.100.0, < 1.0.0)"
                ))
            } else {
                None
            }
        } else {
            None
        };

        let mut auth_cmd =
            crate::command::provider_command(&self.app_server.command, &self.app_server.extra_env);
        auth_cmd.args(["login", "status"]);

        let auth_output = process::output_in_own_group(&mut auth_cmd);
        let authenticated = match auth_output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_lowercase();
                stdout.contains("logged in")
            }
            _ => false,
        };

        if !authenticated && warning.is_none() {
            warning =
                Some("Codex CLI is not logged in. Run `codex login` to authenticate.".to_string());
        }

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
        let (sandbox, approval_policy) =
            Self::map_permission_mode_to_thread_start(context.permission_mode);

        let cwd_str = context.working_dir.to_string_lossy().to_string();
        let mut params = json!({
            "cwd": cwd_str,
            "sandbox": sandbox,
            "approvalPolicy": approval_policy,
        });

        if let Some(ref m) = context.model {
            params["model"] = json!(m);
        }

        *self.active_permission_mode.lock().unwrap() = context.permission_mode;
        *self.active_model.lock().unwrap() = context.model.clone();
        *self.active_effort.lock().unwrap() = context.effort.clone();
        *self.working_dir.lock().unwrap() = context.working_dir.clone();

        let res = self.app_server.send_request("thread/start", params)?;
        let tid = res
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(|s| s.as_str())
            .ok_or_else(|| {
                ProviderError::StartFailed(
                    "App-server thread/start did not return thread ID".into(),
                )
            })?
            .to_string();

        *self.thread_id.lock().unwrap() = Some(tid.clone());

        let (tx, rx) = crossbeam_channel::unbounded();
        *self.event_sender.lock().unwrap() = Some(tx.clone());

        self.app_server.register_thread(tid.clone(), tx.clone());

        // Emit SessionInfo
        let _ = tx.send(ProviderEvent::SessionInfo { session_id: tid });
        self.request_usage_limits(tx);

        Ok(rx)
    }

    fn resume(
        &mut self,
        session_id: &str,
        context: &StartContext,
    ) -> Result<Receiver<ProviderEvent>, ProviderError> {
        let cwd_str = context.working_dir.to_string_lossy().to_string();
        let (sandbox, approval_policy) =
            Self::map_permission_mode_to_thread_start(context.permission_mode);

        let params = json!({
            "threadId": session_id,
            "cwd": cwd_str,
            "sandbox": sandbox,
            "approvalPolicy": approval_policy,
        });

        *self.active_permission_mode.lock().unwrap() = context.permission_mode;
        *self.active_model.lock().unwrap() = context.model.clone();
        *self.active_effort.lock().unwrap() = context.effort.clone();
        *self.working_dir.lock().unwrap() = context.working_dir.clone();

        let _res = self.app_server.send_request("thread/resume", params)?;

        *self.thread_id.lock().unwrap() = Some(session_id.to_string());

        let (tx, rx) = crossbeam_channel::unbounded();
        *self.event_sender.lock().unwrap() = Some(tx.clone());

        self.app_server
            .register_thread(session_id.to_string(), tx.clone());

        let _ = tx.send(ProviderEvent::SessionInfo {
            session_id: session_id.to_string(),
        });
        self.request_usage_limits(tx);

        Ok(rx)
    }

    fn send_prompt(&mut self, prompt: &str) -> Result<(), ProviderError> {
        let tid = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ProviderError::CommandFailed("Thread not started".into()))?;

        let turn_index = self.turn_counter.fetch_add(1, Ordering::SeqCst);
        self.app_server.record_active_turn(tid.clone(), turn_index);

        if let Some(ref sender) = *self.event_sender.lock().unwrap() {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index,
                prompt: prompt.to_string(),
            });
        }

        if prompt.trim() == "/compact" {
            let result = self
                .app_server
                .send_request("thread/compact/start", json!({"threadId": tid}))
                .map(|_| ());
            return self.finish_native_request(&tid, turn_index, result);
        }
        if let Some(rest) = prompt.trim().strip_prefix("/review")
            && (rest.is_empty() || rest.starts_with(char::is_whitespace))
        {
            let instructions = rest.trim();
            let target = if instructions.is_empty() {
                json!({"type": "uncommittedChanges"})
            } else {
                json!({"type": "custom", "instructions": instructions})
            };
            let result = self.app_server.start_turn(
                &tid,
                "review/start",
                json!({"threadId": tid, "target": target, "delivery": "inline"}),
            );
            return self.finish_native_request(&tid, turn_index, result);
        }

        let mut input = vec![json!({"type": "text", "text": prompt})];
        if let Some(command) = prompt.trim_start().strip_prefix('/') {
            let split = command.find(char::is_whitespace).unwrap_or(command.len());
            let name = &command[..split];
            let cwd = self.working_dir.lock().unwrap().clone();
            let skills = self.skills(&cwd).or_else(|error| {
                let guard = self.app_server.inner.lock().unwrap();
                guard
                    .as_ref()
                    .and_then(|inner| inner.skills_cache.get(&cwd).cloned())
                    .ok_or(error)
            });
            if let Ok(skills) = skills
                && let Some(skill) = skills
                    .into_iter()
                    .find(|skill| skill["name"].as_str() == Some(name) && skill["path"].is_string())
            {
                input = vec![
                    json!({"type": "skill", "name": name, "path": skill["path"]}),
                    json!({"type": "text", "text": command[split..].trim_start()}),
                ];
            }
        }

        let mode = *self.active_permission_mode.lock().unwrap();
        let (sandbox_policy, approval_policy) = Self::map_permission_mode_to_turn_start(mode);

        let mut params = json!({
            "threadId": tid,
            "input": input,
            "sandboxPolicy": sandbox_policy,
            "approvalPolicy": approval_policy,
        });

        if let Some(ref m) = *self.active_model.lock().unwrap() {
            params["model"] = json!(m);
        }
        if let Some(ref eff) = *self.active_effort.lock().unwrap() {
            params["effort"] = json!(eff);
        }

        self.app_server.start_turn(&tid, "turn/start", params)?;
        Ok(())
    }

    fn send_prompt_with_images(
        &mut self,
        prompt: &str,
        images: &[PathBuf],
    ) -> Result<(), ProviderError> {
        let tid = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ProviderError::CommandFailed("Thread not started".into()))?;

        let turn_index = self.turn_counter.fetch_add(1, Ordering::SeqCst);
        self.app_server.record_active_turn(tid.clone(), turn_index);

        if let Some(ref sender) = *self.event_sender.lock().unwrap() {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index,
                prompt: prompt.to_string(),
            });
        }

        let mut input_arr = vec![json!({
            "type": "text",
            "text": prompt
        })];

        for img in images {
            input_arr.push(json!({
                "type": "localImage",
                "path": img.to_string_lossy()
            }));
        }

        let mode = *self.active_permission_mode.lock().unwrap();
        let (sandbox_policy, approval_policy) = Self::map_permission_mode_to_turn_start(mode);

        let mut params = json!({
            "threadId": tid,
            "input": input_arr,
            "sandboxPolicy": sandbox_policy,
            "approvalPolicy": approval_policy,
        });

        if let Some(ref m) = *self.active_model.lock().unwrap() {
            params["model"] = json!(m);
        }
        if let Some(ref eff) = *self.active_effort.lock().unwrap() {
            params["effort"] = json!(eff);
        }

        self.app_server.start_turn(&tid, "turn/start", params)?;
        Ok(())
    }

    fn interrupt(&mut self) -> Result<(), ProviderError> {
        let tid = self
            .thread_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ProviderError::CommandFailed("Thread not started".into()))?;

        self.app_server.interrupt_turn(&tid)
    }

    fn respond_to_approval(
        &mut self,
        id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        self.app_server.respond_to_server_request(id, decision)
    }

    fn set_model(&mut self, model: &str) -> Result<(), ProviderError> {
        *self.active_model.lock().unwrap() = Some(model.to_string());
        Ok(())
    }

    fn set_effort(&mut self, effort: &str) -> Result<(), ProviderError> {
        *self.active_effort.lock().unwrap() = Some(effort.to_string());
        Ok(())
    }

    fn models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let entries = self.app_server.models();
        if entries.is_empty() {
            let _ = self.app_server.fetch_model_catalog();
        }
        let entries = self.app_server.models();
        if entries.is_empty() {
            return Ok(vec![
                ModelInfo {
                    id: "gpt-5".into(),
                    name: "GPT-5".into(),
                    description: Some("Flagship reasoning model".into()),
                    supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    default_effort: Some("medium".into()),
                    is_legacy: false,
                },
                ModelInfo {
                    id: "o3-mini".into(),
                    name: "o3-mini".into(),
                    description: Some("Fast reasoning model".into()),
                    supported_efforts: vec!["low".into(), "medium".into(), "high".into()],
                    default_effort: Some("medium".into()),
                    is_legacy: false,
                },
                ModelInfo {
                    id: "gpt-4o".into(),
                    name: "GPT-4o".into(),
                    description: None,
                    supported_efforts: vec![],
                    default_effort: None,
                    is_legacy: true,
                },
            ]);
        }
        Ok(entries
            .into_iter()
            .map(|e| {
                let is_legacy = (e.id.contains("gpt-4") && !e.id.contains("gpt-4.5"))
                    || e.id.contains("gpt-3.5");
                let default_effort = e
                    .default_reasoning_effort
                    .filter(|effort| e.supported_reasoning_efforts.contains(effort));
                ModelInfo {
                    name: e.display_name.unwrap_or_else(|| e.id.clone()),
                    id: e.id,
                    description: None,
                    supported_efforts: e.supported_reasoning_efforts,
                    default_effort,
                    is_legacy,
                }
            })
            .collect())
    }

    fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<(), ProviderError> {
        *self.active_permission_mode.lock().unwrap() = mode;
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), ProviderError> {
        if let Some(tid) = self.thread_id.lock().unwrap().take() {
            self.app_server.unregister_thread(&tid);
        }
        self.event_sender.lock().unwrap().take();
        Ok(())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.capabilities.lock().unwrap().clone()
    }
}

/// Codex only surfaces `commandExecution` as a tool call, so every one is a command run.
fn codex_category(kind: ItemKind) -> Option<ActivityCategory> {
    (kind == ItemKind::ToolCall).then_some(ActivityCategory::Run)
}
