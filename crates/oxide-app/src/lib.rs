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
    pub parent_item_index: Option<u32>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub id: u32,
    pub turn_index: u32,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub attachments: Vec<String>,
    pub status: TurnStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub items: Vec<ItemSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCapabilities {
    pub reasoning_text: bool,
    pub image_attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread: Thread,
    pub capabilities: ThreadCapabilities,
    pub turns: Vec<TurnSnapshot>,
    pub last_seq: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum ThreadEvent {
    TurnStarted {
        turn_index: u32,
        prompt: String,
        model: Option<String>,
        effort: Option<String>,
        attachments: Vec<String>,
    },
    ItemStarted {
        item_index: u32,
        kind: ItemKind,
        parent_item_index: Option<u32>,
    },
    ItemDeltaBatch {
        item_index: u32,
        delta: String,
    },
    ItemCompleted {
        item_index: u32,
        kind: ItemKind,
        content: String,
        parent_item_index: Option<u32>,
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
        description: String,
    },
    Error {
        message: String,
    },
    Unknown {
        raw: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SequencedThreadEvent {
    pub seq: u32,
    pub event: ThreadEvent,
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
    permission_mode: PermissionMode,
) -> Result<Thread, AppError> {
    let mode: oxide_core::PermissionMode = convert(&permission_mode);
    let summary = core.create_thread(project_id, &provider, model, effort, mode)?;
    Ok(convert(&summary))
}

#[tauri::command]
#[specta::specta]
fn list_threads(core: State<'_, Arc<Core>>, project_id: u32) -> Result<Vec<Thread>, AppError> {
    let list = core.list_threads(project_id)?;
    Ok(convert(&list))
}

#[tauri::command]
#[specta::specta]
fn send_prompt(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    prompt: String,
    attachments: Vec<String>,
) -> Result<(), AppError> {
    let paths: Vec<std::path::PathBuf> = attachments.into_iter().map(Into::into).collect();
    Ok(core.send_prompt_with_attachments(thread_id, &prompt, &paths)?)
}

/// Stores a pasted or picked image under `~/.oxide/attachments/`; returns its path.
#[tauri::command]
#[specta::specta]
fn save_attachment(
    core: State<'_, Arc<Core>>,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, AppError> {
    let path = core.save_attachment(&bytes, &extension)?;
    Ok(path.to_string_lossy().to_string())
}

/// Bytes of a stored attachment, for rendering it in the Transcript.
#[tauri::command]
#[specta::specta]
fn read_attachment(core: State<'_, Arc<Core>>, path: String) -> Result<Vec<u8>, AppError> {
    Ok(core.read_attachment(std::path::Path::new(&path))?)
}

/// What a Provider supports, so the composer can offer image attachments before a Thread exists.
#[tauri::command]
#[specta::specta]
fn provider_capabilities(core: State<'_, Arc<Core>>, provider: String) -> ThreadCapabilities {
    convert(&core.provider_capabilities(&provider))
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

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        list_projects,
        rescan_projects,
        set_project_hidden,
        get_settings,
        save_settings,
        create_thread,
        list_threads,
        send_prompt,
        save_attachment,
        read_attachment,
        provider_capabilities,
        interrupt_thread,
        subscribe_thread
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
