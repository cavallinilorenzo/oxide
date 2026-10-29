//! Signed application updates. URLs and public keys stay native; the webview only
//! checks the configured feed and installs the update returned by that check.
use crate::{AppError, Core};
use serde::Serialize;
use specta::Type;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
}

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    phase: UpdatePhase,
    downloaded: f64,
    total: Option<f64>,
}

#[derive(Default)]
struct Pending {
    update: Option<Update>,
    phase: UpdatePhase,
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Pending>,
    busy: AtomicBool,
}

fn error(message: impl ToString) -> AppError {
    AppError {
        message: message.to_string(),
    }
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Updates {
    fn begin(&self) -> Result<Operation<'_>, AppError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| error("An update operation is already running."))?;
        Ok(Operation(&self.busy))
    }
    fn status(&self, app: &AppHandle) -> UpdateStatus {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        UpdateStatus {
            current_version: app.package_info().version.to_string(),
            version: pending.update.as_ref().map(|u| u.version.clone()),
            notes: pending.update.as_ref().and_then(|u| u.body.clone()),
            phase: pending.phase,
            downloaded: pending.downloaded as f64,
            total: pending.total.map(|n| n as f64),
        }
    }
    fn recover(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.phase = if pending.update.is_some() {
            UpdatePhase::Available
        } else {
            UpdatePhase::Idle
        };
    }
}

#[tauri::command]
#[specta::specta]
pub fn app_update_status(app: AppHandle, updates: State<'_, Arc<Updates>>) -> UpdateStatus {
    updates.status(&app)
}

#[tauri::command]
#[specta::specta]
pub async fn check_app_update(
    app: AppHandle,
    updates: State<'_, Arc<Updates>>,
) -> Result<UpdateStatus, AppError> {
    let _operation = updates.begin()?;
    updates
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .phase = UpdatePhase::Checking;
    let handle = app.clone();
    let result = async {
        app.updater_builder().timeout(Duration::from_secs(30))
            .on_before_exit(move || {
                handle.state::<Arc<Core>>().quit();
                handle.cleanup_before_exit();
            }).build().map_err(error)?.check().await.map_err(|e| {
                error(format!("Could not check for updates. Check your connection and try again. The update feed may not be published yet. ({e})"))
            })
    }.await;
    match result {
        Ok(update) => {
            let mut pending = updates.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.phase = if update.is_some() {
                UpdatePhase::Available
            } else {
                UpdatePhase::UpToDate
            };
            pending.update = update;
            pending.downloaded = 0;
            pending.total = None;
        }
        Err(e) => {
            updates.recover();
            return Err(e);
        }
    }
    Ok(updates.status(&app))
}

fn validate_install(dirty: u32, active: u32) -> Result<(), AppError> {
    if dirty > 0 {
        return Err(error("Save your open files before installing the update."));
    }
    if active > 0 {
        return Err(error(
            "Stop working Threads and resolve pending approvals before installing the update.",
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn install_app_update(
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    updates: State<'_, Arc<Updates>>,
    on_progress: tauri::ipc::Channel<UpdateStatus>,
) -> Result<(), AppError> {
    let _operation = updates.begin()?;
    validate_install(core.dirty_editor_count(), core.active_thread_count())?;
    let mut update = updates
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .update
        .clone()
        .ok_or_else(|| error("Check for updates before installing."))?;
    // Checking is short-lived; downloading a full app can take longer.
    update.timeout = Some(Duration::from_secs(600));
    {
        let mut pending = updates.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.phase = UpdatePhase::Downloading;
        pending.downloaded = 0;
        pending.total = None;
    }
    let result = async {
        let bytes = update
            .download(
                |length, total| {
                    {
                        let mut pending = updates.pending.lock().unwrap_or_else(|e| e.into_inner());
                        pending.downloaded += length as u64;
                        pending.total = total;
                    }
                    let _ = on_progress.send(updates.status(&app));
                },
                || {},
            )
            .await
            .map_err(error)?;
        validate_install(core.dirty_editor_count(), core.active_thread_count())?;
        updates
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .phase = UpdatePhase::Installing;
        let _ = on_progress.send(updates.status(&app));
        // install() verifies the signature again, then invokes the platform installer.
        tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(error)?
            .map_err(error)?;
        Ok::<_, AppError>(())
    }
    .await;
    if let Err(e) = result {
        updates.recover();
        return Err(e);
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_waits_for_unsaved_files_and_active_threads() {
        assert!(validate_install(0, 0).is_ok());
        assert!(validate_install(1, 0).unwrap_err().message.contains("Save"));
        assert!(validate_install(0, 1).unwrap_err().message.contains("Stop"));
    }
    #[test]
    fn operations_cannot_overlap_and_errors_release_the_lock() {
        let updates = Updates::default();
        let first = updates.begin().unwrap();
        assert!(updates.begin().is_err());
        drop(first);
        assert!(updates.begin().is_ok());
    }
}
