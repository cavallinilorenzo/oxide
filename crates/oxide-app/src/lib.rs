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
    pub image_attachments: bool,
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
    pub title: Option<String>,
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
    pub model: Option<String>,
    pub effort: Option<String>,
    pub attachments: Vec<String>,
    pub status: TurnStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub items: Vec<ItemSnapshot>,
    pub error: Option<TurnError>,
    pub approvals: Vec<ApprovalSnapshot>,
    pub unknown_events: Vec<UnknownEventSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    pub message: String,
    pub stderr_tail: Option<String>,
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
    pub turn_offset: u32,
    pub turn_count: u32,
    pub last_seq: u32,
    pub supported_permission_modes: Vec<PermissionMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TurnPage {
    pub offset: u32,
    pub turns: Vec<TurnSnapshot>,
    pub turn_count: u32,
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
        error: Option<TurnError>,
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
    ProviderRetrying {
        message: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    pub id: u32,
    pub pid: u32,
    pub cwd: String,
}

#[tauri::command]
#[specta::specta]
fn start_terminal(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    thread_id: Option<u32>,
    on_output: tauri::ipc::Channel<Vec<u8>>,
) -> Result<Terminal, AppError> {
    let terminal = core.start_terminal(project_id, thread_id)?;
    let rx = core.subscribe_terminal(terminal.id)?;
    std::thread::spawn(move || {
        while let Ok(chunk) = rx.recv() {
            if on_output.send(chunk).is_err() {
                break;
            }
        }
    });
    Ok(convert(&terminal))
}

#[tauri::command]
#[specta::specta]
fn write_terminal(
    core: State<'_, Arc<Core>>,
    terminal_id: u32,
    input: Vec<u8>,
) -> Result<(), AppError> {
    Ok(core.write_terminal(terminal_id, &input)?)
}

#[tauri::command]
#[specta::specta]
fn resize_terminal(
    core: State<'_, Arc<Core>>,
    terminal_id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), AppError> {
    Ok(core.resize_terminal(terminal_id, rows, cols)?)
}

#[tauri::command]
#[specta::specta]
fn close_terminal(core: State<'_, Arc<Core>>, terminal_id: u32) -> Result<(), AppError> {
    Ok(core.close_terminal(terminal_id)?)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    /// Saturates at 4 GiB.
    pub size: u32,
    pub truncated: bool,
    pub binary: bool,
}

/// Lists one directory of a Thread's checkout (`""` is the root), minus
/// `.git` and gitignored entries.
#[tauri::command]
#[specta::specta]
async fn list_dir(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    thread_id: Option<u32>,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.list_dir(project_id, thread_id, &path))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map(|entries| entries.iter().map(convert).collect())
        .map_err(AppError::from)
}

/// Reads a file of a Thread's checkout, capped at 1 MiB.
#[tauri::command]
#[specta::specta]
async fn read_file(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    thread_id: Option<u32>,
    path: String,
) -> Result<FileContent, AppError> {
    let core = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core.read_file(project_id, thread_id, &path))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map(|file| FileContent {
            size: u32::try_from(file.size).unwrap_or(u32::MAX),
            content: file.content,
            truncated: file.truncated,
            binary: file.binary,
        })
        .map_err(AppError::from)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// `null` while HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub added: u32,
    pub removed: u32,
    pub changed_files: u32,
    /// Why the branch picker is disabled, if it is.
    pub picker_disabled_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
}

/// Runs blocking Git work off the async runtime.
async fn git_blocking<T: Send + 'static>(
    core: &State<'_, Arc<Core>>,
    f: impl FnOnce(&Core) -> oxide_core::Result<T> + Send + 'static,
) -> Result<T, AppError> {
    let core = Arc::clone(core);
    tauri::async_runtime::spawn_blocking(move || f(&core))
        .await
        .map_err(|e| AppError {
            message: e.to_string(),
        })?
        .map_err(AppError::from)
}

/// Branch, ahead/behind and uncommitted-change counts of the main checkout.
#[tauri::command]
#[specta::specta]
async fn git_status(core: State<'_, Arc<Core>>, project_id: u32) -> Result<GitStatus, AppError> {
    git_blocking(&core, move |core| core.git_status(project_id))
        .await
        .map(|status| convert(&status))
}

#[tauri::command]
#[specta::specta]
async fn list_branches(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<Vec<GitBranch>, AppError> {
    git_blocking(&core, move |core| core.list_branches(project_id))
        .await
        .map(|branches| branches.iter().map(convert).collect())
}

/// Checks out a branch; a remote one (`origin/x`) becomes a tracking branch.
#[tauri::command]
#[specta::specta]
async fn checkout_branch(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    name: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.checkout_branch(project_id, &name)).await
}

/// Creates a branch from HEAD and checks it out.
#[tauri::command]
#[specta::specta]
async fn create_branch(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    name: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.create_branch(project_id, &name)).await
}

/// Background fetch; returns whether it ran (it is throttled).
#[tauri::command]
#[specta::specta]
async fn fetch_project(core: State<'_, Arc<Core>>, project_id: u32) -> Result<bool, AppError> {
    git_blocking(&core, move |core| core.fetch_project(project_id)).await
}

/// `git pull --ff-only`.
#[tauri::command]
#[specta::specta]
async fn pull(core: State<'_, Arc<Core>>, project_id: u32) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.pull(project_id)).await
}

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
fn set_thread_provider(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    provider: String,
) -> Result<Thread, AppError> {
    let summary = core.set_thread_provider(thread_id, &provider)?;
    Ok(convert(&summary))
}

#[tauri::command]
#[specta::specta]
fn rename_thread(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    title: String,
) -> Result<(), AppError> {
    Ok(core.rename_thread(thread_id, &title)?)
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub available: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
    pub warning: Option<String>,
}

#[tauri::command]
#[specta::specta]
fn detect_provider(core: State<'_, Arc<Core>>, provider: String) -> Result<Detection, AppError> {
    let det = core.detect_provider(&provider);
    Ok(convert(&det))
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

/// Up to `limit` Turns of a Thread from position `offset`, for paging in
/// Turns older than what `subscribe_thread` returned.
#[tauri::command]
#[specta::specta]
async fn list_turns(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    offset: u32,
    limit: u32,
) -> Result<TurnPage, AppError> {
    let core = Arc::clone(&core);
    let page =
        tauri::async_runtime::spawn_blocking(move || core.list_turns(thread_id, offset, limit))
            .await
            .map_err(|e| AppError {
                message: e.to_string(),
            })??;
    Ok(convert(&page))
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
        set_thread_provider,
        rename_thread,
        respond_to_approval,
        detect_provider,
        get_provider_capabilities,
        list_threads,
        send_prompt,
        save_attachment,
        read_attachment,
        provider_capabilities,
        interrupt_thread,
        list_turns,
        subscribe_thread,
        subscribe_thread_debug,
        start_terminal,
        write_terminal,
        resize_terminal,
        close_terminal,
        list_dir,
        read_file,
        git_status,
        list_branches,
        checkout_branch,
        create_branch,
        fetch_project,
        pull
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
        .build(tauri::generate_context!())
        .expect("error while building Oxide")
        .run(|app, event| {
            // Managed state is not dropped on exit, so stop every Provider and shell by hand.
            if let tauri::RunEvent::Exit = event {
                app.state::<Arc<Core>>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_snapshots_and_events_convert_from_core() {
        let error = oxide_core::TurnError {
            message: "The Provider exited unexpectedly".into(),
            stderr_tail: Some("panicked".into()),
        };
        let core = oxide_core::ThreadSnapshot {
            thread: oxide_core::ThreadSummary {
                id: 1,
                project_id: 2,
                provider: "fake".into(),
                model: None,
                effort: None,
                permission_mode: oxide_core::PermissionMode::Ask,
                status: oxide_core::ThreadStatus::Error,
                archived: false,
                created_at: "a".into(),
                updated_at: "b".into(),
                title: None,
            },
            turns: vec![oxide_core::TurnSnapshot {
                id: 3,
                turn_index: 0,
                prompt: "hi".into(),
                model: None,
                effort: None,
                attachments: vec![],
                status: oxide_core::TurnStatus::Error,
                started_at: "a".into(),
                completed_at: Some("b".into()),
                items: vec![oxide_core::ItemSnapshot {
                    id: 4,
                    item_index: 0,
                    kind: oxide_core::ItemKind::AgentMessage,
                    content: "partial".into(),
                    created_at: "a".into(),
                    parent_item_index: None,
                }],
                error: Some(error.clone()),
                approvals: vec![],
                unknown_events: vec![],
            }],
            capabilities: oxide_core::ThreadCapabilities::default(),
            turn_offset: 0,
            turn_count: 1,
            last_seq: 7,
            supported_permission_modes: vec![],
        };
        let app: ThreadSnapshot = convert(&core);
        let turn_error = app.turns[0].error.as_ref().unwrap();
        assert_eq!(turn_error.stderr_tail.as_deref(), Some("panicked"));

        let event = oxide_core::SequencedThreadEvent {
            seq: 8,
            event: oxide_core::ThreadEvent::TurnCompleted {
                turn_index: 0,
                status: oxide_core::TurnStatus::Error,
                error: Some(error),
            },
        };
        let app: SequencedThreadEvent = convert(&event);
        assert!(matches!(
            app.event,
            ThreadEvent::TurnCompleted { error: Some(_), .. }
        ));
        let app: SequencedThreadEvent = convert(&oxide_core::SequencedThreadEvent {
            seq: 9,
            event: oxide_core::ThreadEvent::ProviderRetrying {
                message: "rate limited".into(),
            },
        });
        assert!(matches!(app.event, ThreadEvent::ProviderRetrying { .. }));
    }
}
