//! The App shell: a thin Tauri layer that exposes [`oxide_core::Core`] to the webview.
//! The webview talks only to the TypeScript bindings generated from here.

use std::sync::Arc;

use oxide_core::{Core, ProjectSummary};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Emitter, Manager, State};
use tauri_specta::{Builder, collect_commands};

#[derive(Debug, Serialize, Type)]
pub struct AppError {
    message: String,
}

impl From<oxide_core::Error> for AppError {
    fn from(e: oxide_core::Error) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Serialize, Type)]
pub struct Project {
    id: u32,
    name: String,
    path: String,
    hidden: bool,
    missing: bool,
}

impl From<ProjectSummary> for Project {
    fn from(p: ProjectSummary) -> Self {
        Self {
            id: p.id,
            name: p.name,
            path: p.path,
            hidden: p.hidden,
            missing: p.missing,
        }
    }
}

#[tauri::command]
#[specta::specta]
fn list_projects(core: State<'_, Arc<Core>>) -> Result<Vec<Project>, AppError> {
    Ok(core
        .list_projects()?
        .into_iter()
        .map(Project::from)
        .collect())
}

/// Scans the scan roots for new repositories, then lists all Projects.
/// The walk runs on a blocking thread, off the main thread and the async runtime.
#[tauri::command]
#[specta::specta]
async fn rescan_projects(core: State<'_, Arc<Core>>) -> Result<Vec<Project>, AppError> {
    let core = Arc::clone(&core);
    let projects = tauri::async_runtime::spawn_blocking(move || core.rescan_projects())
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })??;
    Ok(projects.into_iter().map(Project::from).collect())
}

#[tauri::command]
#[specta::specta]
fn set_project_hidden(core: State<'_, Arc<Core>>, id: u32, hidden: bool) -> Result<(), AppError> {
    Ok(core.set_project_hidden(id, hidden)?)
}

// Settings cross the boundary as the same JSON shape as `settings.json`, so
// these mirror the Core types field for field (Core stays free of specta).

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Claude,
    Codex,
    Antigravity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Ask,
    AutoEdit,
    FullAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    model: Option<String>,
    effort: Option<String>,
    permission_mode: PermissionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Providers {
    claude: ProviderSettings,
    codex: ProviderSettings,
    antigravity: ProviderSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    default_provider: Provider,
    providers: Providers,
    scan_roots: Vec<String>,
    confirm_quit: bool,
    editor: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct FieldError {
    path: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct SettingsState {
    settings: Settings,
    errors: Vec<FieldError>,
}

/// Mirrors are identical in shape to the Core types; converting through JSON
/// keeps the field lists in one place (the serde derives on each side).
fn convert<A: Serialize, B: serde::de::DeserializeOwned>(a: &A) -> B {
    serde_json::from_value(serde_json::to_value(a).expect("serialize"))
        .expect("App and Core settings types out of sync")
}

impl From<&oxide_core::SettingsState> for SettingsState {
    fn from(s: &oxide_core::SettingsState) -> Self {
        Self {
            settings: convert(&s.settings),
            errors: s
                .errors
                .iter()
                .map(|e| FieldError {
                    path: e.path.clone(),
                    message: e.message.clone(),
                })
                .collect(),
        }
    }
}

/// Event emitted whenever the Settings state changes; payload is [`SettingsState`].
pub const SETTINGS_CHANGED: &str = "settings-changed";

#[tauri::command]
#[specta::specta]
fn get_settings(core: State<'_, Arc<Core>>) -> SettingsState {
    (&core.settings()).into()
}

#[tauri::command]
#[specta::specta]
fn save_settings(core: State<'_, Arc<Core>>, settings: Settings) -> Result<(), AppError> {
    Ok(core.save_settings(&convert(&settings))?)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalKind {
    Command,
    #[serde(alias = "file_change")]
    FileChange,
    Tool,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub supported_permission_modes: Vec<PermissionMode>,
    pub interactive_approvals: bool,
    pub supports_reasoning: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadStatus {
    Working,
    NeedsInput,
    Completed,
    Error,
    Interrupted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    AgentMessage,
    Reasoning,
    ToolCall,
    FileChange,
    Subagent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Running,
    Completed,
    Interrupted,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: u32,
    pub project_id: u32,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
    pub status: ThreadStatus,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ItemSnapshot {
    pub id: u32,
    pub item_index: u32,
    pub kind: ItemKind,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalSnapshot {
    pub id: u32,
    pub turn_id: u32,
    pub approval_id: String,
    pub kind: ApprovalKind,
    pub summary: String,
    pub options: Vec<String>,
    pub decision: Option<ApprovalDecision>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub id: u32,
    pub turn_index: u32,
    pub prompt: String,
    pub status: TurnStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub items: Vec<ItemSnapshot>,
    pub approvals: Vec<ApprovalSnapshot>,
    pub unknown_events: Vec<UnknownEventSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnknownEventSnapshot {
    pub id: u32,
    pub raw: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread: Thread,
    pub turns: Vec<TurnSnapshot>,
    pub last_seq: u32,
    pub supported_permission_modes: Vec<PermissionMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum ThreadEvent {
    TurnStarted {
        turn_index: u32,
        prompt: String,
    },
    ItemStarted {
        item_index: u32,
        kind: ItemKind,
    },
    ItemDeltaBatch {
        item_index: u32,
        delta: String,
    },
    ItemCompleted {
        item_index: u32,
        kind: ItemKind,
        content: String,
    },
    TurnCompleted {
        turn_index: u32,
        status: TurnStatus,
    },
    ThreadStatusChanged {
        status: ThreadStatus,
    },
    ApprovalRequested {
        id: String,
        kind: ApprovalKind,
        summary: String,
        options: Vec<String>,
    },
    ApprovalResponded {
        id: String,
        decision: ApprovalDecision,
        decided_at: String,
    },
    Error {
        message: String,
    },
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SequencedThreadEvent {
    pub seq: u32,
    pub event: ThreadEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DebugSequencedThreadEvent {
    pub seq: u32,
    pub event: ThreadEvent,
    pub raw_payload: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatusChangedPayload {
    pub thread_id: u32,
    pub status: ThreadStatus,
}

pub const THREAD_STATUS_CHANGED: &str = "thread-status-changed";

#[tauri::command]
#[specta::specta]
fn create_thread(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    provider: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<PermissionMode>,
) -> Result<Thread, AppError> {
    let mode: Option<oxide_core::PermissionMode> = permission_mode.map(|m| convert(&m));
    let summary = core.create_thread(project_id, &provider, model, effort, mode)?;
    Ok(convert(&summary))
}

#[tauri::command]
#[specta::specta]
fn set_thread_permission_mode(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    permission_mode: PermissionMode,
) -> Result<(), AppError> {
    let mode: oxide_core::PermissionMode = convert(&permission_mode);
    Ok(core.set_thread_permission_mode(thread_id, mode)?)
}

#[tauri::command]
#[specta::specta]
fn respond_to_approval(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    approval_id: String,
    decision: ApprovalDecision,
) -> Result<(), AppError> {
    let dec: oxide_core::ApprovalDecision = convert(&decision);
    Ok(core.respond_to_approval(thread_id, &approval_id, dec)?)
}

#[tauri::command]
#[specta::specta]
fn get_provider_capabilities(
    core: State<'_, Arc<Core>>,
    provider: String,
) -> Result<ProviderCapabilities, AppError> {
    let caps = core.get_provider_capabilities(&provider);
    Ok(convert(&caps))
}

#[tauri::command]
#[specta::specta]
fn list_threads(core: State<'_, Arc<Core>>, project_id: u32) -> Result<Vec<Thread>, AppError> {
    let list = core.list_threads(project_id)?;
    Ok(convert(&list))
}

#[tauri::command]
#[specta::specta]
fn send_prompt(core: State<'_, Arc<Core>>, thread_id: u32, prompt: String) -> Result<(), AppError> {
    Ok(core.send_prompt(thread_id, &prompt)?)
}

#[tauri::command]
#[specta::specta]
fn interrupt_thread(core: State<'_, Arc<Core>>, thread_id: u32) -> Result<(), AppError> {
    Ok(core.interrupt_thread(thread_id)?)
}

#[tauri::command]
#[specta::specta]
fn subscribe_thread(
    core: State<'_, Arc<Core>>,
    app: tauri::AppHandle,
    thread_id: u32,
    on_event: tauri::ipc::Channel<SequencedThreadEvent>,
) -> Result<ThreadSnapshot, AppError> {
    let (snapshot, rx) = core.subscribe_thread(thread_id)?;
    let app_clone = app.clone();
    std::thread::spawn(move || {
        while let Ok(evt) = rx.recv() {
            let app_evt: SequencedThreadEvent = convert(&evt);
            if let ThreadEvent::ThreadStatusChanged { status } = app_evt.event {
                let _ = app_clone.emit(
                    THREAD_STATUS_CHANGED,
                    ThreadStatusChangedPayload { thread_id, status },
                );
            }
            if on_event.send(app_evt).is_err() {
                break;
            }
        }
    });
    Ok(convert(&snapshot))
}

#[tauri::command]
#[specta::specta]
fn subscribe_thread_debug(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    on_event: tauri::ipc::Channel<DebugSequencedThreadEvent>,
) -> Result<ThreadSnapshot, AppError> {
    let (snapshot, rx) = core.subscribe_thread_debug(thread_id)?;
    std::thread::spawn(move || {
        while let Ok(evt) = rx.recv() {
            let app_evt: DebugSequencedThreadEvent = convert(&evt);
            if on_event.send(app_evt).is_err() {
                break;
            }
        }
    });
    Ok(convert(&snapshot))
}

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        list_projects,
        rescan_projects,
        set_project_hidden,
        get_settings,
        save_settings,
        create_thread,
        set_thread_permission_mode,
        respond_to_approval,
        get_provider_capabilities,
        list_threads,
        send_prompt,
        interrupt_thread,
        subscribe_thread,
        subscribe_thread_debug
    ])
}

/// Path of the generated TypeScript bindings, anchored to this crate.
pub const BINDINGS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/bindings.ts");

pub fn export_bindings() {
    builder()
        .export(
            specta_typescript::Typescript::default().header("// @ts-nocheck\n/* eslint-disable */"),
            BINDINGS_PATH,
        )
        .expect("failed to export TypeScript bindings");
}

pub fn run() {
    let builder = builder();

    #[cfg(debug_assertions)]
    export_bindings();

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(|app| {
            let home = app
                .path()
                .home_dir()
                .expect("no home directory")
                .join(".oxide");
            let core = Core::open(home)?;
            let handle = app.handle().clone();
            core.subscribe_settings(move |state| {
                let _ = handle.emit(SETTINGS_CHANGED, SettingsState::from(state));
            });
            app.manage(Arc::new(core));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Oxide");
}
