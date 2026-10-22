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

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        list_projects,
        rescan_projects,
        set_project_hidden,
        get_settings,
        save_settings
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
