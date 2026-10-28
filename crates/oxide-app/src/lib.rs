//! The App shell: a thin Tauri layer that exposes [`oxide_core::Core`] to the webview.
//! The webview talks only to the TypeScript bindings generated from here.

mod system;

use std::sync::Arc;

use oxide_core::{Core, ProjectSummary};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State, WebviewWindow};
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
    /// Listed in the sidebar; scanned Projects stay closed until the user opens one.
    open: bool,
    missing: bool,
}

impl From<ProjectSummary> for Project {
    fn from(p: ProjectSummary) -> Self {
        Self {
            id: p.id,
            name: p.name,
            path: p.path,
            hidden: p.hidden,
            open: p.open,
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

/// Registers an existing folder as a Project.
#[tauri::command]
#[specta::specta]
async fn add_project(core: State<'_, Arc<Core>>, path: String) -> Result<Project, AppError> {
    git_blocking(&core, move |core| core.add_project(&path))
        .await
        .map(Project::from)
}

/// Creates `parent/name` with `git init` and registers it as a Project.
#[tauri::command]
#[specta::specta]
async fn create_project(
    core: State<'_, Arc<Core>>,
    parent: String,
    name: String,
) -> Result<Project, AppError> {
    git_blocking(&core, move |core| core.create_project(&parent, &name))
        .await
        .map(Project::from)
}

/// Clones a Git URL into `parent` and registers the clone as a Project.
#[tauri::command]
#[specta::specta]
async fn clone_project(
    core: State<'_, Arc<Core>>,
    url: String,
    parent: String,
) -> Result<Project, AppError> {
    git_blocking(&core, move |core| core.clone_project(&url, &parent))
        .await
        .map(Project::from)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    name_with_owner: String,
    description: String,
    is_private: bool,
}

#[tauri::command]
#[specta::specta]
async fn search_github_repositories(
    core: State<'_, Arc<Core>>,
    query: String,
) -> Result<Vec<GithubRepository>, AppError> {
    git_blocking(&core, move |core| core.search_github_repositories(&query))
        .await
        .map(|list| list.iter().map(convert).collect())
}

/// Clones one of the user's GitHub repositories into `parent` and registers it as a Project.
#[tauri::command]
#[specta::specta]
async fn clone_github_repository(
    core: State<'_, Arc<Core>>,
    name_with_owner: String,
    parent: String,
) -> Result<Project, AppError> {
    git_blocking(&core, move |core| {
        core.clone_github_repository(&name_with_owner, &parent)
    })
    .await
    .map(Project::from)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    name: String,
    bundle_id: String,
}

/// The known editors installed on this machine.
#[tauri::command]
#[specta::specta]
async fn detected_editors(core: State<'_, Arc<Core>>) -> Result<Vec<Editor>, AppError> {
    git_blocking(&core, |core| Ok(core.detected_editors()))
        .await
        .map(|list| list.iter().map(convert).collect())
}

/// Opens the Project's checkout (or the Thread's) in the editor chosen in Settings.
#[tauri::command]
#[specta::specta]
fn open_in_editor(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    thread_id: Option<u32>,
) -> Result<(), AppError> {
    Ok(core.open_in_editor(project_id, thread_id)?)
}

#[tauri::command]
#[specta::specta]
fn reveal_in_finder(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    thread_id: Option<u32>,
) -> Result<(), AppError> {
    Ok(core.reveal_in_finder(project_id, thread_id)?)
}

#[tauri::command]
#[specta::specta]
fn set_project_hidden(core: State<'_, Arc<Core>>, id: u32, hidden: bool) -> Result<(), AppError> {
    Ok(core.set_project_hidden(id, hidden)?)
}

/// Lists the Project in the sidebar, or takes it out (it stays in the Project palette).
#[tauri::command]
#[specta::specta]
fn set_project_open(core: State<'_, Arc<Core>>, id: u32, open: bool) -> Result<(), AppError> {
    Ok(core.set_project_open(id, open)?)
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCustomizations {
    claude_md: bool,
    skills: bool,
    plugins: bool,
    mcp_servers: bool,
    hooks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    default_provider: Provider,
    providers: Providers,
    confirm_quit: bool,
    editor: String,
    claude_customizations: ClaudeCustomizations,
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
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub supported_efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub is_legacy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub supported_permission_modes: Vec<PermissionMode>,
    pub interactive_approvals: bool,
    pub supports_reasoning: bool,
    pub image_attachments: bool,
    pub mid_thread_model_switch: bool,
    pub reports_usage_limits: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus {
    Ok,
    Warning,
    Limited,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitWindow {
    pub percent_used: Option<f64>,
    /// Seconds since the Unix epoch (UTC).
    pub resets_at: Option<f64>,
    pub status: UsageStatus,
    /// Seconds since the Unix epoch (UTC).
    pub reported_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub five_hour: Option<UsageLimitWindow>,
    pub weekly: Option<UsageLimitWindow>,
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
#[serde(rename_all = "kebab-case")]
pub enum DeleteOutcome {
    Deleted,
    NeedsConfirmation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    AgentMessage,
    Reasoning,
    ToolCall,
    FileChange,
    Subagent,
    SlashCommandOutput,
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
    pub created_at: String,
    pub updated_at: String,
    pub title: Option<String>,
    pub session_lost: bool,
    pub continued_from: Option<u32>,
    pub continued_in: Option<u32>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub setup_output: Option<String>,
    pub issue_number: Option<u32>,
}

/// An Approval the Provider is still waiting on.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub approval_id: String,
    pub kind: ApprovalKind,
    pub summary: String,
    pub options: Vec<String>,
}

/// A Thread on the Thread Board with the Approvals it is waiting on.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BoardCard {
    pub thread: Thread,
    pub pending_approvals: Vec<PendingApproval>,
    /// The Thread's branch's pull request, once GitHub has been asked.
    pub pull_request: Option<BranchPullRequest>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestPhase {
    Draft,
    Open,
    Merged,
    Closed,
}

/// A Board Thread's pull request: its state and a tally of its checks.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BranchPullRequest {
    pub number: u32,
    pub url: String,
    pub phase: PullRequestPhase,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum BoardEvent {
    ThreadChanged(Box<BoardCard>),
    ThreadDeleted(u32),
}

/// A new Thread continuing one whose Provider session is gone, and the recap to prefill.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContinuedThread {
    pub thread: Thread,
    pub recap: String,
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
    ThreadRenamed {
        title: String,
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
    SlashCommandsChanged,
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
    /// Pushing this branch (`main`, `master`) needs the user's consent.
    pub protected: bool,
    /// A branch with commits and no upstream yet; the first push publishes it.
    pub unpublished: bool,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    Uncommitted,
    Branch,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: DiffStatus,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// What the Branch scope compares against, if a base branch exists.
    pub base: Option<String>,
    pub files: Vec<DiffFile>,
}

/// The changes of the main checkout in one scope, from Git.
#[tauri::command]
#[specta::specta]
async fn git_diff(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    scope: DiffScope,
) -> Result<Diff, AppError> {
    git_blocking(&core, move |core| core.diff(project_id, convert(&scope)))
        .await
        .map(|diff| convert(&diff))
}

/// What a Thread's latest Turn changed, from its two Checkpoints.
#[tauri::command]
#[specta::specta]
async fn git_turn_diff(core: State<'_, Arc<Core>>, thread_id: u32) -> Result<Diff, AppError> {
    git_blocking(&core, move |core| core.latest_turn_diff(thread_id))
        .await
        .map(|diff| convert(&diff))
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

/// Commits exactly the given files; other staged state is untouched.
#[tauri::command]
#[specta::specta]
async fn commit(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    paths: Vec<String>,
    message: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.commit(project_id, &paths, &message)).await
}

/// Pushes the current branch; never forced.
#[tauri::command]
#[specta::specta]
async fn push(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    allow_protected: bool,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.push(project_id, allow_protected)).await
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GithubAvailability {
    Ready,
    Missing,
    LoggedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub draft: bool,
    pub base: String,
    pub head: String,
    pub author: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    pub name: String,
    pub state: CheckState,
    /// Where GitHub shows the run, to find out why it failed.
    pub url: Option<String>,
    /// Whether branch protection requires it: only these hold the merge up.
    pub required: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MergeState {
    Clean,
    Conflicting,
    Behind,
    Blocked,
    Unstable,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Requested,
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewer {
    pub login: String,
    pub state: ReviewState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// Set when the entry is a review rather than a plain comment.
    pub review: Option<ReviewState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCandidates {
    pub users: Vec<String>,
    pub labels: Vec<PullRequestLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestEdit {
    pub add_reviewers: Vec<String>,
    pub remove_reviewers: Vec<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub pull_request: PullRequest,
    pub phase: PullRequestPhase,
    pub body: String,
    pub checks: Vec<PullRequestCheck>,
    pub comments: Vec<PullRequestComment>,
    pub merge_state: MergeState,
    pub review_decision: Option<ReviewDecision>,
    pub reviewers: Vec<PullRequestReviewer>,
    pub assignees: Vec<String>,
    pub labels: Vec<PullRequestLabel>,
    pub additions: u32,
    pub deletions: u32,
    /// The signed-in GitHub user.
    pub viewer: String,
    /// The merge methods the repository allows.
    pub merge_methods: Vec<MergeMethod>,
    /// The method GitHub's own merge box would preselect for the user.
    pub default_merge_method: Option<MergeMethod>,
    /// Whether the repository deletes merged branches on its own.
    pub delete_branch_on_merge: bool,
    /// The changed files, for the Diff Surface.
    pub diff: Diff,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestState {
    pub availability: GithubAvailability,
    /// How to get `gh` working, when it is not.
    pub guidance: Option<String>,
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    pub pull_request: Option<PullRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub state_reason: String,
    pub author: String,
    pub url: String,
    pub comments_count: u32,
    pub created_at: String,
    pub labels: Vec<PullRequestLabel>,
    pub assignees: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub state: String,
    pub state_reason: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub comments: Vec<IssueComment>,
    pub labels: Vec<PullRequestLabel>,
    pub assignees: Vec<String>,
    pub viewer: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IssueCloseReason {
    Completed,
    NotPlanned,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueEdit {
    pub title: Option<String>,
    pub body: Option<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplateFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IssuesState {
    pub availability: GithubAvailability,
    pub guidance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDraft {
    pub title: String,
    pub body: String,
    pub base: String,
    pub head: String,
}

/// Whether `gh` works and the branch's open pull request. Runs `gh` only when
/// asked; the Surface decides when to refresh.
#[tauri::command]
#[specta::specta]
async fn pull_request_state(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<PullRequestState, AppError> {
    git_blocking(&core, move |core| core.pull_request_state(project_id))
        .await
        .map(|state| convert(&state))
}

/// The repository's branches on GitHub, for choosing a pull request's base.
#[tauri::command]
#[specta::specta]
async fn pull_request_base_branches(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<Vec<String>, AppError> {
    git_blocking(&core, move |core| {
        core.pull_request_base_branches(project_id)
    })
    .await
}

/// Title, body and base prefilled from the branch's commits.
#[tauri::command]
#[specta::specta]
async fn pull_request_draft(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<PullRequestDraft, AppError> {
    git_blocking(&core, move |core| core.pull_request_draft(project_id))
        .await
        .map(|draft| convert(&draft))
}

/// Pushes the branch if needed, then opens a pull request for it.
#[tauri::command]
#[specta::specta]
async fn create_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    title: String,
    body: String,
    base: String,
    draft: bool,
) -> Result<PullRequest, AppError> {
    git_blocking(&core, move |core| {
        core.create_pull_request(
            project_id,
            &oxide_core::PullRequestInput {
                title,
                body,
                base,
                draft,
            },
        )
    })
    .await
    .map(|pr| convert(&pr))
}

/// Availability of GitHub CLI for issues, and guidance if missing/logged out.
#[tauri::command]
#[specta::specta]
async fn issues_state(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<IssuesState, AppError> {
    git_blocking(&core, move |core| core.issues_state(project_id))
        .await
        .map(|state| convert(&state))
}

/// The repository's issue templates (`.github/ISSUE_TEMPLATE`) as raw files; empty when it has none.
#[tauri::command]
#[specta::specta]
async fn issue_templates(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<Vec<IssueTemplateFile>, AppError> {
    git_blocking(&core, move |core| core.issue_templates(project_id))
        .await
        .map(|files| convert(&files))
}

#[tauri::command]
#[specta::specta]
async fn list_issues(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    closed: bool,
    mine: bool,
    search: String,
) -> Result<Vec<IssueSummary>, AppError> {
    git_blocking(&core, move |core| {
        core.list_issues(project_id, closed, mine, &search)
    })
    .await
    .map(|list| list.iter().map(convert).collect())
}

#[tauri::command]
#[specta::specta]
async fn issue_detail(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<IssueDetail, AppError> {
    git_blocking(&core, move |core| core.issue_detail(project_id, number))
        .await
        .map(|detail| convert(&detail))
}

#[tauri::command]
#[specta::specta]
async fn create_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    title: String,
    body: String,
    assignees: Vec<String>,
    labels: Vec<String>,
) -> Result<IssueSummary, AppError> {
    git_blocking(&core, move |core| {
        core.create_issue(project_id, &title, &body, &assignees, &labels)
    })
    .await
    .map(|summary| convert(&summary))
}

#[tauri::command]
#[specta::specta]
async fn comment_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    body: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.comment_issue(project_id, number, &body)
    })
    .await
}

/// Closes an issue with a reason, leaving `comment` first when it is not empty.
#[tauri::command]
#[specta::specta]
async fn close_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    reason: IssueCloseReason,
    comment: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.close_issue(project_id, number, convert(&reason), &comment)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn reopen_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.reopen_issue(project_id, number)).await
}

/// Changes an issue's title, description, assignees and labels.
#[tauri::command]
#[specta::specta]
async fn edit_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    edit: IssueEdit,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.edit_issue(project_id, number, &convert(&edit))
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn open_issue(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.open_issue(project_id, number)).await
}

#[tauri::command]
#[specta::specta]
async fn open_pull_request(core: State<'_, Arc<Core>>, project_id: u32) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.open_pull_request(project_id)).await
}

/// Open pull requests; `mine` keeps the user's own, `search` is a GitHub query.
#[tauri::command]
#[specta::specta]
async fn list_pull_requests(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    mine: bool,
    search: String,
) -> Result<Vec<PullRequest>, AppError> {
    git_blocking(&core, move |core| {
        core.list_pull_requests(project_id, mine, &search)
    })
    .await
    .map(|prs| convert(&prs))
}

/// One pull request's description, checks, conversation and changed files.
#[tauri::command]
#[specta::specta]
async fn pull_request_detail(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<PullRequestDetail, AppError> {
    git_blocking(&core, move |core| {
        core.pull_request_detail(project_id, number)
    })
    .await
    .map(|detail| convert(&detail))
}

#[tauri::command]
#[specta::specta]
async fn comment_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    body: String,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.comment_pull_request(project_id, number, &body)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn merge_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    method: MergeMethod,
    delete_branch: bool,
    auto: bool,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.merge_pull_request(project_id, number, convert(&method), delete_branch, auto)
    })
    .await
}

/// Closes a pull request without merging it.
#[tauri::command]
#[specta::specta]
async fn close_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.close_pull_request(project_id, number)
    })
    .await
}

/// Opens a GitHub link, such as a check's run, in the system browser.
#[tauri::command]
#[specta::specta]
async fn open_link(core: State<'_, Arc<Core>>, url: String) -> Result<(), AppError> {
    git_blocking(&core, move |core| core.open_link(&url)).await
}

/// Moves a pull request out of draft (`draft` false), or back into it.
#[tauri::command]
#[specta::specta]
async fn set_pull_request_draft(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    draft: bool,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.set_pull_request_draft(project_id, number, draft)
    })
    .await
}

/// Brings a pull request's branch up to date with its base.
#[tauri::command]
#[specta::specta]
async fn update_pull_request_branch(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.update_pull_request_branch(project_id, number)
    })
    .await
}

/// The people and labels a pull request's settings can pick from.
#[tauri::command]
#[specta::specta]
async fn pull_request_candidates(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<PullRequestCandidates, AppError> {
    git_blocking(&core, move |core| core.pull_request_candidates(project_id))
        .await
        .map(|candidates| convert(&candidates))
}

/// Changes a pull request's reviewers, assignees and labels.
#[tauri::command]
#[specta::specta]
async fn edit_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
    edit: PullRequestEdit,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.edit_pull_request(project_id, number, &convert(&edit))
    })
    .await
}

/// Checks the pull request's branch out in the main checkout.
#[tauri::command]
#[specta::specta]
async fn checkout_pull_request(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    number: u32,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.checkout_pull_request(project_id, number)
    })
    .await
}

#[tauri::command]
#[specta::specta]
async fn create_thread(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    provider: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<PermissionMode>,
) -> Result<Thread, AppError> {
    let mode: Option<oxide_core::PermissionMode> = permission_mode.map(|m| convert(&m));
    git_blocking(&core, move |core| {
        core.create_thread(project_id, &provider, model, effort, mode)
    })
    .await
    .map(|summary| convert(&summary))
}

/// A Board Thread handed off from the Thread Board.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    pub project_id: u32,
    pub prompt: String,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub base_branch: Option<String>,
    pub issue_number: Option<u32>,
    pub issue_title: Option<String>,
}

/// Creates the Thread's worktree and branch, runs the Project's Setup command, starts its first Turn.
#[tauri::command]
#[specta::specta]
async fn dispatch_thread(
    core: State<'_, Arc<Core>>,
    request: DispatchRequest,
) -> Result<Thread, AppError> {
    let request: oxide_core::DispatchRequest = convert(&request);
    git_blocking(&core, move |core| core.dispatch_thread(request))
        .await
        .map(|thread| convert(&thread))
}

#[tauri::command]
#[specta::specta]
fn get_project_setup_command(
    core: State<'_, Arc<Core>>,
    project_id: u32,
) -> Result<Option<String>, AppError> {
    Ok(core.project_setup_command(project_id)?)
}

#[tauri::command]
#[specta::specta]
fn set_project_setup_command(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    command: Option<String>,
) -> Result<(), AppError> {
    Ok(core.set_project_setup_command(project_id, command.as_deref())?)
}

/// Starts a new Thread that continues one whose Provider session is gone.
#[tauri::command]
#[specta::specta]
fn continue_thread(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
) -> Result<ContinuedThread, AppError> {
    Ok(convert(&core.continue_thread(thread_id)?))
}

/// Deletes a Thread and its Transcript. Deleting a Board Thread removes its worktree; with
/// uncommitted changes that waits for `discard_changes`.
#[tauri::command]
#[specta::specta]
fn delete_thread(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    discard_changes: bool,
) -> Result<DeleteOutcome, AppError> {
    Ok(match core.delete_thread(thread_id, discard_changes)? {
        oxide_core::DeleteOutcome::Deleted => DeleteOutcome::Deleted,
        oxide_core::DeleteOutcome::NeedsConfirmation => DeleteOutcome::NeedsConfirmation,
    })
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
async fn set_thread_provider(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    provider: String,
) -> Result<Thread, AppError> {
    git_blocking(&core, move |core| {
        core.set_thread_provider(thread_id, &provider)
    })
    .await
    .map(|summary| convert(&summary))
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
async fn detect_provider(
    core: State<'_, Arc<Core>>,
    provider: String,
) -> Result<Detection, AppError> {
    git_blocking(&core, move |core| Ok(core.detect_provider(&provider)))
        .await
        .map(|det| convert(&det))
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
async fn get_model_catalog(
    core: State<'_, Arc<Core>>,
    provider: String,
    refresh: bool,
) -> Result<Vec<ModelInfo>, AppError> {
    git_blocking(&core, move |core| {
        core.get_model_catalog(&provider, refresh)
    })
    .await
    .map(|models| convert(&models))
}

#[tauri::command]
#[specta::specta]
fn get_favourite_models(core: State<'_, Arc<Core>>) -> Result<Vec<String>, AppError> {
    Ok(core.get_favourite_models()?)
}

#[tauri::command]
#[specta::specta]
fn set_favourite_models(
    core: State<'_, Arc<Core>>,
    favourites: Vec<String>,
) -> Result<(), AppError> {
    Ok(core.set_favourite_models(&favourites)?)
}

#[tauri::command]
#[specta::specta]
async fn set_thread_model_and_effort(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), AppError> {
    git_blocking(&core, move |core| {
        core.set_thread_model_and_effort(thread_id, model, effort)
    })
    .await
}

#[tauri::command]
#[specta::specta]
fn list_threads(core: State<'_, Arc<Core>>, project_id: u32) -> Result<Vec<Thread>, AppError> {
    // Listing a Project's Threads is what opening it does.
    core.open_project(project_id)?;
    let list = core.list_threads(project_id)?;
    Ok(convert(&list))
}

#[tauri::command]
#[specta::specta]
async fn send_prompt(
    core: State<'_, Arc<Core>>,
    thread_id: u32,
    prompt: String,
    attachments: Vec<String>,
) -> Result<(), AppError> {
    let paths: Vec<std::path::PathBuf> = attachments.into_iter().map(Into::into).collect();
    git_blocking(&core, move |core| {
        core.send_prompt_with_attachments(thread_id, &prompt, &paths)
    })
    .await
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SlashRoute {
    Oxide,
    Passthrough,
    Native,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub aliases: Vec<String>,
    pub route: SlashRoute,
}

/// The Slash command catalog the `/` menu offers for a Provider in a Project.
#[tauri::command]
#[specta::specta]
async fn list_slash_commands(
    core: State<'_, Arc<Core>>,
    provider: String,
    project_id: u32,
    thread_id: Option<u32>,

    refresh: bool,
) -> Result<Vec<SlashCommand>, AppError> {
    git_blocking(&core, move |core| {
        core.thread_slash_commands(&provider, project_id, thread_id, refresh)
    })
    .await
    .map(|commands| commands.iter().map(convert).collect())
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

/// A Provider's Usage limits now (if Oxide has seen any), then every update on `on_event`.
#[tauri::command]
#[specta::specta]
fn subscribe_usage_limits(
    core: State<'_, Arc<Core>>,
    provider: String,
    on_event: tauri::ipc::Channel<UsageLimits>,
) -> Result<Option<UsageLimits>, AppError> {
    let (current, rx) = core.subscribe_usage_limits(&provider);
    std::thread::spawn(move || {
        while let Ok(limits) = rx.recv() {
            if on_event.send(convert(&limits)).is_err() {
                break;
            }
        }
    });
    Ok(current.as_ref().map(convert))
}

/// The Project's Thread Board: its cards now, then every change on `on_event`.
#[tauri::command]
#[specta::specta]
fn subscribe_board(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    on_event: tauri::ipc::Channel<BoardEvent>,
) -> Result<Vec<BoardCard>, AppError> {
    let (cards, rx) = core.subscribe_board(project_id)?;
    std::thread::spawn(move || {
        while let Ok(evt) = rx.recv() {
            if on_event.send(convert(&evt)).is_err() {
                break;
            }
        }
    });
    Ok(convert(&cards))
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

/// Emitted when ⌘N is pressed (even with the window hidden): start a new Thread.
pub const NEW_THREAD: &str = "new-thread";

/// Emitted when Oxide is asked to quit while Threads are running; payload is how many.
pub const QUIT_REQUESTED: &str = "quit-requested";

const MAIN_WINDOW: &str = "main";

#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    project_id: u32,
    thread_id: Option<u32>,
}

/// The Project and Thread to reopen on launch.
#[tauri::command]
#[specta::specta]
fn last_selection(core: State<'_, Arc<Core>>) -> Result<Option<Selection>, AppError> {
    Ok(core.last_selection()?.map(|s| Selection {
        project_id: s.project_id,
        thread_id: s.thread_id,
    }))
}

#[tauri::command]
#[specta::specta]
fn remember_selection(
    core: State<'_, Arc<Core>>,
    project_id: u32,
    thread_id: Option<u32>,
) -> Result<(), AppError> {
    Ok(core.remember_selection(project_id, thread_id)?)
}

/// The user confirmed quitting: interrupt every Thread and exit.
#[tauri::command]
#[specta::specta]
fn confirm_quit(
    core: State<'_, Arc<Core>>,
    app: tauri::AppHandle,
    dont_ask_again: bool,
) -> Result<(), AppError> {
    if dont_ask_again {
        // A failed save must not trap the user in the dialog.
        let _ = core.disable_quit_confirmation();
    }
    app.exit(0);
    Ok(())
}

/// Brings the window back from hidden (Dock icon, ⌘N) and focuses it.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn window_is_active(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new_thread = MenuItem::with_id(app, "new-thread", "New Thread", true, Some("CmdOrCtrl+N"))?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_id_and_items(
                app,
                "oxide",
                "Oxide",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(app, "file", "File", true, &[&new_thread])?,
            &Submenu::with_id_and_items(
                app,
                "edit",
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                "window",
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                ],
            )?,
        ],
    )
}

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        list_projects,
        rescan_projects,
        add_project,
        create_project,
        clone_project,
        search_github_repositories,
        clone_github_repository,
        detected_editors,
        open_in_editor,
        reveal_in_finder,
        set_project_hidden,
        set_project_open,
        get_settings,
        save_settings,
        create_thread,
        dispatch_thread,
        get_project_setup_command,
        set_project_setup_command,
        continue_thread,
        delete_thread,
        set_thread_permission_mode,
        set_thread_provider,
        rename_thread,
        respond_to_approval,
        detect_provider,
        get_provider_capabilities,
        get_model_catalog,
        get_favourite_models,
        set_favourite_models,
        set_thread_model_and_effort,
        list_threads,
        send_prompt,
        save_attachment,
        read_attachment,
        provider_capabilities,
        list_slash_commands,
        interrupt_thread,
        list_turns,
        subscribe_thread,
        subscribe_thread_debug,
        subscribe_board,
        subscribe_usage_limits,
        start_terminal,
        write_terminal,
        resize_terminal,
        close_terminal,
        list_dir,
        read_file,
        git_status,
        list_branches,
        git_diff,
        git_turn_diff,
        checkout_branch,
        create_branch,
        fetch_project,
        pull,
        commit,
        push,
        pull_request_state,
        pull_request_base_branches,
        pull_request_draft,
        create_pull_request,
        open_pull_request,
        list_pull_requests,
        pull_request_detail,
        comment_pull_request,
        merge_pull_request,
        close_pull_request,
        checkout_pull_request,
        open_link,
        set_pull_request_draft,
        update_pull_request_branch,
        pull_request_candidates,
        edit_pull_request,
        issues_state,
        issue_templates,
        list_issues,
        issue_detail,
        create_issue,
        comment_issue,
        close_issue,
        reopen_issue,
        edit_issue,
        open_issue,
        last_selection,
        remember_selection,
        confirm_quit
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "new-thread" {
                show_main_window(app);
                let _ = app.emit(NEW_THREAD, ());
            }
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW {
                return;
            }
            match event {
                // Closing only hides the window: Threads keep running in the background.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(core) = window.app_handle().try_state::<Arc<Core>>() {
                        core.set_window_active(false);
                    }
                }
                tauri::WindowEvent::Focused(focused) => {
                    let active = *focused && window.is_visible().unwrap_or(false);
                    if let Some(core) = window.app_handle().try_state::<Arc<Core>>() {
                        core.set_window_active(active);
                    }
                }
                _ => {}
            }
        })
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
            core.set_system(Arc::new(system::MacSystem::new(app.handle().clone())));
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                #[cfg(target_os = "windows")]
                {
                    window.hide_menu()?;
                    window.set_decorations(false)?;
                }
                core.set_window_active(window_is_active(&window));
            }
            app.manage(Arc::new(core));
            use tauri_plugin_notification::NotificationExt;
            let _ = app.notification().request_permission();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Oxide")
        .run(|app, event| match event {
            // The Dock icon was clicked while the window was hidden.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            // ⌘Q: ask first when Threads are running.
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                if let Some(running) = app.state::<Arc<Core>>().quit_confirmation() {
                    api.prevent_exit();
                    show_main_window(app);
                    let _ = app.emit(QUIT_REQUESTED, running);
                }
            }
            // Managed state is not dropped on exit: interrupt every Turn, then stop every
            // Provider and shell by hand.
            tauri::RunEvent::Exit => app.state::<Arc<Core>>().quit(),
            _ => {}
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
                created_at: "a".into(),
                updated_at: "b".into(),
                title: None,
                session_lost: false,
                continued_from: None,
                continued_in: None,
                branch: None,
                worktree_path: None,
                setup_output: None,
                issue_number: None,
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
