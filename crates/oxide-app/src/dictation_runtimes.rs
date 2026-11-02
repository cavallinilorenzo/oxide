//! Tauri commands over `oxide_core::dictation::runtimes`: list, install/update, cancel, remove.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use oxide_core::Core;
use oxide_core::dictation::BackendId as CoreBackend;
use oxide_core::dictation::runtimes::{self, HttpRuntimeSource, RuntimeManager};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Emitter, State};

use crate::{AppError, BackendId, convert};

/// Where the signed index lives and the minisign key that must have signed it. Both are fixed at
/// build time (`OXIDE_RUNTIME_INDEX_URL`, `OXIDE_RUNTIME_PUBLIC_KEY`); a build without them
/// reports downloads as unavailable and keeps CPU dictation working.
const INDEX_URL: Option<&str> = option_env!("OXIDE_RUNTIME_INDEX_URL");
const PUBLIC_KEY: Option<&str> = option_env!("OXIDE_RUNTIME_PUBLIC_KEY");

pub const PROGRESS_EVENT: &str = "dictation-runtime-progress";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntime {
    backend: BackendId,
    version: String,
    protocol_version: u32,
    compatible: bool,
    #[specta(type = f64)]
    bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableRuntime {
    backend: BackendId,
    version: String,
    #[specta(type = f64)]
    bytes: u64,
    requirements: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCatalogue {
    /// Protocol the app speaks; installed runtimes with another value are unusable.
    protocol_version: u32,
    installed: Vec<InstalledRuntime>,
    available: Vec<AvailableRuntime>,
    /// Why the published list could not be read (offline, bad signature…). Installed runtimes
    /// are still listed.
    index_error: Option<String>,
    /// Backends being installed right now.
    installing: Vec<BackendId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProgress {
    backend: BackendId,
    #[specta(type = f64)]
    received: u64,
    #[specta(type = f64)]
    total: u64,
}

/// In-flight installs, one cancel flag per backend.
#[derive(Default)]
pub struct RuntimeOps {
    active: Mutex<HashMap<&'static str, Arc<AtomicBool>>>,
}

const DOWNLOADABLE: [CoreBackend; 2] = [CoreBackend::Vulkan, CoreBackend::Cuda];

fn key(backend: CoreBackend) -> &'static str {
    match backend {
        CoreBackend::Vulkan => "vulkan",
        CoreBackend::Cuda => "cuda",
        CoreBackend::Cpu => "cpu",
        CoreBackend::Metal => "metal",
    }
}

fn manager() -> Result<RuntimeManager, oxide_core::Error> {
    match (INDEX_URL, PUBLIC_KEY) {
        (Some(url), Some(public_key)) if !url.is_empty() && !public_key.is_empty() => {
            Ok(RuntimeManager::new(
                Box::new(HttpRuntimeSource {
                    index_url: url.to_string(),
                }),
                public_key,
            ))
        }
        _ => Err(oxide_core::Error::Dictation(
            "GPU runtime downloads are not configured in this build".into(),
        )),
    }
}

fn join_error(e: impl std::fmt::Display) -> oxide_core::Error {
    oxide_core::Error::Dictation(e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn dictation_runtimes(
    core: State<'_, Arc<Core>>,
    ops: State<'_, Arc<RuntimeOps>>,
) -> Result<RuntimeCatalogue, AppError> {
    let root = runtimes::runtimes_dir(core.home());
    let installing: Vec<CoreBackend> = {
        let active = ops.active.lock().unwrap();
        DOWNLOADABLE
            .into_iter()
            .filter(|b| active.contains_key(key(*b)))
            .collect()
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        catalogue(&root, manager().and_then(|m| m.available()), &installing)
    })
    .await
    .map_err(join_error)?)
}

/// Installed runtimes are always listed, even when the published index cannot be read.
fn catalogue(
    root: &std::path::Path,
    available: Result<Vec<runtimes::RuntimeEntry>, oxide_core::Error>,
    installing: &[CoreBackend],
) -> RuntimeCatalogue {
    let (available, index_error) = match available {
        Ok(entries) => (entries, None),
        Err(e) => (Vec::new(), Some(e.to_string())),
    };
    RuntimeCatalogue {
        protocol_version: runtimes::PROTOCOL_VERSION,
        installed: runtimes::list(root).iter().map(convert).collect(),
        available: available.iter().map(convert).collect(),
        index_error,
        installing: installing.iter().map(convert).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(root: &std::path::Path, backend: &str, version: &str, protocol: u32) {
        let dir = root.join(backend).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("worker.bin"), b"x").unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            format!(
                r#"{{"backend":"{backend}","version":"{version}","protocolVersion":{protocol},"worker":"worker.bin","files":{{}}}}"#
            ),
        )
        .unwrap();
    }

    fn entry(version: &str) -> runtimes::RuntimeEntry {
        runtimes::RuntimeEntry {
            backend: CoreBackend::Vulkan,
            version: version.into(),
            protocol_version: runtimes::PROTOCOL_VERSION,
            platform: runtimes::platform(),
            url: "https://example.invalid/v.zip".into(),
            bytes: 10,
            sha256: String::new(),
            requirements: "Vulkan 1.2 driver".into(),
        }
    }

    #[test]
    fn lists_installed_and_available_with_versions_and_requirements() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path(), "vulkan", "1.0.0", runtimes::PROTOCOL_VERSION);
        let c = catalogue(dir.path(), Ok(vec![entry("1.1.0")]), &[CoreBackend::Cuda]);
        assert_eq!(c.installed.len(), 1);
        assert_eq!(c.installed[0].version, "1.0.0");
        assert!(c.installed[0].compatible);
        assert_eq!(c.available[0].version, "1.1.0");
        assert_eq!(c.available[0].requirements, "Vulkan 1.2 driver");
        assert!(c.index_error.is_none());
        assert_eq!(c.installing.len(), 1);
    }

    #[test]
    fn shows_an_incompatible_runtime_instead_of_hiding_it() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path(), "cuda", "0.9.0", runtimes::PROTOCOL_VERSION + 1);
        let c = catalogue(dir.path(), Ok(vec![]), &[]);
        assert_eq!(c.installed.len(), 1);
        assert!(!c.installed[0].compatible);
        assert_eq!(
            c.installed[0].protocol_version,
            runtimes::PROTOCOL_VERSION + 1
        );
    }

    #[test]
    fn keeps_installed_runtimes_when_the_index_fails() {
        let dir = tempfile::tempdir().unwrap();
        install(dir.path(), "vulkan", "1.0.0", runtimes::PROTOCOL_VERSION);
        let failure = oxide_core::Error::Dictation("Runtime index signature is not valid".into());
        let c = catalogue(dir.path(), Err(failure), &[]);
        assert_eq!(c.installed.len(), 1);
        assert!(c.available.is_empty());
        assert!(c.index_error.unwrap().contains("signature is not valid"));
    }

    #[test]
    fn unconfigured_builds_report_downloads_unavailable() {
        if INDEX_URL.is_none() || PUBLIC_KEY.is_none() {
            let e = manager().err().expect("not configured");
            assert!(e.to_string().contains("not configured"));
        }
    }
}

/// Installs the newest published runtime for `backend`; also the update action.
#[tauri::command]
#[specta::specta]
pub async fn dictation_runtime_install(
    core: State<'_, Arc<Core>>,
    ops: State<'_, Arc<RuntimeOps>>,
    app: tauri::AppHandle,
    backend: BackendId,
) -> Result<InstalledRuntime, AppError> {
    let backend: CoreBackend = convert(&backend);
    let name = key(backend);
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = ops.active.lock().unwrap();
        if active.contains_key(name) {
            return Err(oxide_core::Error::Dictation(
                "This runtime is already being installed".into(),
            )
            .into());
        }
        active.insert(name, cancelled.clone());
    }
    let root = runtimes::runtimes_dir(core.home());
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager()?.install(&root, backend, cancelled, |received, total| {
            let _ = app.emit(
                PROGRESS_EVENT,
                RuntimeProgress {
                    backend: convert(&backend),
                    received,
                    total,
                },
            );
        })
    })
    .await;
    ops.active.lock().unwrap().remove(name);
    Ok(convert(&result.map_err(join_error)??))
}

#[tauri::command]
#[specta::specta]
pub fn dictation_runtime_cancel(ops: State<'_, Arc<RuntimeOps>>, backend: BackendId) {
    let backend: CoreBackend = convert(&backend);
    if let Some(flag) = ops.active.lock().unwrap().get(key(backend)) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn dictation_runtime_remove(
    core: State<'_, Arc<Core>>,
    ops: State<'_, Arc<RuntimeOps>>,
    backend: BackendId,
) -> Result<(), AppError> {
    let backend: CoreBackend = convert(&backend);
    if ops.active.lock().unwrap().contains_key(key(backend)) {
        return Err(oxide_core::Error::Dictation(
            "Cancel the installation before removing this runtime".into(),
        )
        .into());
    }
    let root = runtimes::runtimes_dir(core.home());
    Ok(
        tauri::async_runtime::spawn_blocking(move || runtimes::remove(&root, backend))
            .await
            .map_err(join_error)??,
    )
}
