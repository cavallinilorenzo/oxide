//! Trusted, versioned multilingual artifacts. No catalogue URLs come from the webview.
mod transport;
use super::err;
use super::{BackendId, ModelId};
use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
};
use transport::HttpSource;
pub use transport::ModelSource;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogue {
    pub version: u32,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: ModelId,
    pub language_coverage: String,
    pub url: String,
    pub revision: String,
    pub expected_bytes: u64,
    pub sha256: String,
    pub format: String,
    pub quantization: String,
    pub license: String,
    pub license_url: String,
    pub native_revision: String,
    pub estimated_peak_bytes: Vec<MemoryEstimate>,
    pub tradeoff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEstimate {
    pub backend: BackendId,
    pub bytes: u64,
    pub measured: bool,
}

impl ModelCatalogue {
    pub fn entry(&self, id: ModelId) -> Option<&ModelEntry> {
        self.models.iter().find(|entry| entry.id == id)
    }

    pub fn entry_for_path(&self, path: &Path) -> Option<&ModelEntry> {
        self.models.iter().find(|entry| {
            path.file_name()
                .is_some_and(|name| name == entry.file_name().as_str())
        })
    }
}

impl ModelEntry {
    pub fn file_name(&self) -> String {
        format!("ggml-{}.bin", self.id)
    }

    pub fn estimated_peak(&self, backend: BackendId) -> Option<u64> {
        self.estimated_peak_bytes
            .iter()
            .find(|estimate| estimate.backend == backend)
            .map(|estimate| estimate.bytes)
    }
}

pub fn catalogue() -> &'static ModelCatalogue {
    static CATALOGUE: LazyLock<ModelCatalogue> = LazyLock::new(|| {
        serde_json::from_str(include_str!("catalogue.json")).expect("trusted model catalogue")
    });
    &CATALOGUE
}

pub fn model_path(home: &Path, id: ModelId) -> PathBuf {
    home.join("models").join(format!("ggml-{id}.bin"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ModelState {
    Missing,
    Installed,
    Installing { received: u64, total: u64 },
    Cancelled,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: ModelId,
    pub state: ModelState,
}

/// Holding a lease protects a selected or recording model from deletion/replacement.
/// OS locks also serialize operations across manager instances and application processes.
pub struct ModelLease {
    _lock: File,
}

pub struct ModelManager {
    catalogue: ModelCatalogue,
    source: Arc<dyn ModelSource>,
    states: Mutex<HashMap<PathBuf, ModelState>>,
    cancellations: Mutex<HashMap<PathBuf, Arc<AtomicBool>>>,
}

impl Default for ModelManager {
    fn default() -> Self {
        Self::with_source(catalogue().clone(), Arc::new(HttpSource))
    }
}

impl ModelManager {
    /// The caller owns the trust boundary of this catalogue. Never accept it from user settings.
    pub fn with_source(catalogue: ModelCatalogue, source: Arc<dyn ModelSource>) -> Self {
        Self {
            catalogue,
            source,
            states: Mutex::new(HashMap::new()),
            cancellations: Mutex::new(HashMap::new()),
        }
    }

    pub fn catalogue(&self) -> &ModelCatalogue {
        &self.catalogue
    }

    fn entry(&self, id: ModelId) -> Result<&ModelEntry> {
        self.catalogue.entry(id).ok_or_else(|| err("Unknown model"))
    }

    fn lock(&self, home: &Path, id: ModelId) -> Result<File> {
        self.entry(id)?;
        let directory = home.join("models");
        fs::create_dir_all(&directory).map_err(err)?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(format!(".{id}.lock")))
            .map_err(err)
    }

    fn verify(&self, path: &Path, entry: &ModelEntry) -> Result<bool> {
        if !path.exists() {
            return Ok(false);
        }
        let mut file = File::open(path).map_err(err)?;
        if file.metadata().map_err(err)?.len() != entry.expected_bytes {
            return Ok(false);
        }
        let mut hash = Sha256::new();
        let mut buffer = [0; 262144];
        loop {
            let n = file.read(&mut buffer).map_err(err)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        Ok(format!("{:x}", hash.finalize()) == entry.sha256)
    }

    pub fn status(&self, home: &Path, id: ModelId) -> Result<ModelStatus> {
        let path = model_path(home, id);
        let state = self.states.lock().unwrap().get(&path).cloned();
        let state = if matches!(state, Some(ModelState::Installing { .. })) {
            state.unwrap()
        } else if self.verify(&path, self.entry(id)?)? {
            ModelState::Installed
        } else if path.exists() {
            ModelState::Error {
                message: "Model checksum or size mismatch. Download again.".into(),
            }
        } else {
            state
                .filter(|s| !matches!(s, ModelState::Installed))
                .unwrap_or(ModelState::Missing)
        };
        Ok(ModelStatus { id, state })
    }

    pub fn list(&self, home: &Path) -> Result<Vec<ModelStatus>> {
        self.catalogue
            .models
            .iter()
            .map(|m| self.status(home, m.id))
            .collect()
    }

    pub fn acquire(&self, home: &Path, id: ModelId) -> Result<ModelLease> {
        let lock = self.lock(home, id)?;
        lock.try_lock_shared()
            .map_err(|_| err("Model operation is already active"))?;
        if !self.verify(&model_path(home, id), self.entry(id)?)? {
            return Err(err("Download and verify the selected model first"));
        }
        Ok(ModelLease { _lock: lock })
    }

    pub fn cancel(&self, home: &Path, id: ModelId) {
        if let Some(cancel) = self
            .cancellations
            .lock()
            .unwrap()
            .get(&model_path(home, id))
        {
            cancel.store(true, Ordering::SeqCst);
        }
    }

    pub fn delete(&self, home: &Path, id: ModelId) -> Result<()> {
        let lock = self.lock(home, id)?;
        lock.try_lock()
            .map_err(|_| err("Model is active or another operation is in progress"))?;
        let path = model_path(home, id);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
        self.states.lock().unwrap().remove(&path);
        Ok(())
    }

    /// Explicit install/retry only. A verified cached artifact needs neither network nor free space.
    pub fn install(&self, home: &Path, id: ModelId, progress: impl Fn(ModelStatus)) -> Result<()> {
        let lock = self.lock(home, id)?;
        lock.try_lock()
            .map_err(|_| err("Model is active or another operation is in progress"))?;
        let path = model_path(home, id);
        let entry = self.entry(id)?;
        if self.verify(&path, entry)? {
            return Ok(());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.cancellations
            .lock()
            .unwrap()
            .insert(path.clone(), cancelled.clone());
        self.states.lock().unwrap().insert(
            path.clone(),
            ModelState::Installing {
                received: 0,
                total: entry.expected_bytes,
            },
        );
        let result = (|| {
            if self.source.available_space(path.parent().unwrap())? < entry.expected_bytes {
                return Err(err("Insufficient disk space for selected model"));
            }
            let mut response = self.source.open(entry, cancelled.clone())?;
            let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(err)?;
            let mut hash = Sha256::new();
            let mut received = 0;
            let mut buffer = [0; 262144];
            loop {
                if cancelled.load(Ordering::SeqCst) {
                    return Err(err("Model download cancelled"));
                }
                let n = response.read(&mut buffer).map_err(err)?;
                if n == 0 {
                    break;
                }
                received += n as u64;
                if received > entry.expected_bytes {
                    return Err(err("Unexpected model size"));
                }
                hash.update(&buffer[..n]);
                file.write_all(&buffer[..n]).map_err(err)?;
                let state = ModelState::Installing {
                    received,
                    total: entry.expected_bytes,
                };
                self.states
                    .lock()
                    .unwrap()
                    .insert(path.clone(), state.clone());
                progress(ModelStatus { id, state });
            }
            if received != entry.expected_bytes {
                return Err(err("Unexpected model size"));
            }
            if format!("{:x}", hash.finalize()) != entry.sha256 {
                return Err(err("Model checksum mismatch. Download again."));
            }
            file.as_file().sync_all().map_err(err)?;
            let mut cancellations = self.cancellations.lock().unwrap();
            if cancelled.load(Ordering::SeqCst) {
                return Err(err("Model download cancelled"));
            }
            file.persist(&path).map_err(err)?;
            cancellations.remove(&path);
            Ok(())
        })();
        self.cancellations.lock().unwrap().remove(&path);
        let state = match &result {
            Ok(()) => ModelState::Installed,
            Err(_) if cancelled.load(Ordering::SeqCst) => ModelState::Cancelled,
            Err(e) => ModelState::Error {
                message: e.to_string(),
            },
        };
        self.states.lock().unwrap().insert(path, state.clone());
        progress(ModelStatus { id, state });
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn cancellation_interrupts_a_stalled_http_request() {
        for headers_sent in [false, true] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let mut catalogue = catalogue().clone();
            catalogue.models.truncate(1);
            catalogue.models[0].url = format!("http://{}/model", listener.local_addr().unwrap());
            let expected_bytes = catalogue.models[0].expected_bytes;
            let (ready_tx, ready) = std::sync::mpsc::channel();
            let (release, released) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut connection, _) = listener.accept().unwrap();
                connection
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let received = connection.read(&mut request).unwrap();
                assert!(received > 0);
                if headers_sent {
                    write!(
                        connection,
                        "HTTP/1.1 200 OK\r\nContent-Length: {expected_bytes}\r\n\r\n"
                    )
                    .unwrap();
                }
                ready_tx.send(()).unwrap();
                let _ = released.recv_timeout(Duration::from_secs(5));
            });
            let models = Arc::new(ModelManager::with_source(catalogue, Arc::new(HttpSource)));
            let home = tempfile::tempdir().unwrap();
            let (completed, result) = std::sync::mpsc::channel();
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _ = completed.send(models.install(home.path(), ModelId::Tiny, |_| {}));
                });
                ready.recv_timeout(Duration::from_secs(5)).unwrap();
                models.cancel(home.path(), ModelId::Tiny);
                let stopped = result.recv_timeout(Duration::from_secs(2));
                let _ = release.send(());
                assert!(
                    stopped.is_ok(),
                    "Cancellation must interrupt a stalled request"
                );
                assert!(stopped.unwrap().is_err());
            });
            server.join().unwrap();
            assert!(matches!(
                models.status(home.path(), ModelId::Tiny).unwrap().state,
                ModelState::Cancelled
            ));
        }
    }

    #[test]
    fn http_install_checks_headers_and_publishes_only_verified_body() {
        for content_length in [3, 4] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let mut catalogue = catalogue().clone();
            catalogue.models.truncate(1);
            let entry = &mut catalogue.models[0];
            entry.url = format!("http://{}/model", listener.local_addr().unwrap());
            entry.expected_bytes = 3;
            entry.sha256 =
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
            let server = std::thread::spawn(move || {
                let (mut connection, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let received = connection.read(&mut request).unwrap();
                assert!(received > 0);
                write!(connection, "HTTP/1.1 200 OK\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\nabc").unwrap();
            });
            let home = tempfile::tempdir().unwrap();
            let models = ModelManager::with_source(catalogue, Arc::new(HttpSource));
            assert_eq!(
                models.install(home.path(), ModelId::Tiny, |_| {}).is_ok(),
                content_length == 3
            );
            server.join().unwrap();
            assert_eq!(
                models.acquire(home.path(), ModelId::Tiny).is_ok(),
                content_length == 3
            );
        }
    }
}
