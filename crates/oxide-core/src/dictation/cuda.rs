//! Optional CUDA worker. No CUDA library is linked or loaded by the host.
use super::{
    BackendError, BackendId, BackendProbe, CapabilityState, MemoryPool, TranscriptionOutcome,
    TranscriptionRequest, WhisperBackendRuntime,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

pub const ENGINE_VERSION: &str = "1.8.3";
const MAX_FRAME: usize = 64 * 1024 * 1024;
const DEFAULT_WORKING_SET: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CudaAdapter {
    pub id: String,
    pub name: String,
    pub driver: Option<String>,
    pub compute_capability: String,
    pub native_index: i32,
    pub native_backend: String,
    pub memory: Option<MemoryPool>,
    pub capability: CapabilityState,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum WorkerRequest {
    Probe,
    Transcribe {
        request: TranscriptionRequest,
        adapter_id: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum WorkerResult {
    Adapters(Vec<CudaAdapter>),
    Transcription {
        text: String,
        adapter_id: String,
        native_backend: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkerResponse {
    pub protocol_version: u32,
    pub engine_version: String,
    pub result: Result<WorkerResult, BackendError>,
}

pub fn read_frame<T: DeserializeOwned>(mut input: impl Read) -> std::io::Result<T> {
    let mut size = [0; 4];
    input.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    if size > MAX_FRAME {
        return Err(std::io::Error::other("Worker frame exceeds limit"));
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}

pub fn write_frame(mut output: impl Write, value: &impl Serialize) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME {
        return Err(std::io::Error::other("Worker frame exceeds limit"));
    }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

pub fn worker_path() -> PathBuf {
    std::env::var_os("OXIDE_CUDA_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap_or_default()
                .with_file_name(format!("oxide-cuda-worker{}", std::env::consts::EXE_SUFFIX))
        })
}

/// Provisional conservative working set, separate from model file size.
/// Keep 20% of the current reported device budget free; unknown stays unknown.
fn required_memory(path: &Path) -> u64 {
    super::models::catalogue()
        .entry_for_path(path)
        .and_then(|entry| entry.estimated_peak(BackendId::Cuda))
        .unwrap_or(DEFAULT_WORKING_SET)
}

pub fn check_memory(adapter: &CudaAdapter, path: &Path) -> Result<(), BackendError> {
    let required = required_memory(path);
    if let Some(available) = adapter.memory.as_ref().and_then(|m| m.available_bytes)
        && available.saturating_mul(4) / 5 < required
    {
        return Err(BackendError::InsufficientMemory {
            required_bytes: required,
            available_bytes: Some(available),
        });
    }
    Ok(())
}

#[derive(Clone)]
pub struct CudaRuntime {
    path: PathBuf,
    adapter_id: Option<String>,
    generation: std::sync::Arc<AtomicU64>,
}

impl Default for CudaRuntime {
    fn default() -> Self {
        Self::new(worker_path(), std::env::var("OXIDE_CUDA_ADAPTER").ok())
    }
}

impl CudaRuntime {
    pub fn new(path: PathBuf, adapter_id: Option<String>) -> Self {
        Self {
            path,
            adapter_id,
            generation: std::sync::Arc::new(AtomicU64::new(0)),
        }
    }

    fn exchange(
        &self,
        request: WorkerRequest,
        generation: Option<u64>,
    ) -> Result<(WorkerResult, String), BackendError> {
        if !self.path.is_file() {
            return Err(BackendError::Unavailable(CapabilityState::OmittedFromBuild));
        }
        let required = match &request {
            WorkerRequest::Transcribe { request, .. } => required_memory(&request.model_path),
            WorkerRequest::Probe => 0,
        };
        let mut child = Command::new(&self.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| BackendError::InitializationFailed(e.to_string()))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| BackendError::InitializationFailed("Missing child stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BackendError::InitializationFailed("Missing child stdout".into()))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| BackendError::InitializationFailed("Missing child stderr".into()))?;

        let writer = std::thread::spawn(move || write_frame(&mut stdin, &request));
        let reader = std::thread::spawn(move || read_frame::<WorkerResponse>(stdout));
        let logger = std::thread::spawn(move || {
            let mut logs = String::new();
            let _ = stderr.read_to_string(&mut logs);
            logs
        });

        let start = Instant::now();
        let timeout = Duration::from_secs(180);
        let status = loop {
            if let Some(target) = generation
                && self.generation.load(Ordering::Acquire) != target
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BackendError::Cancelled);
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if start.elapsed() < timeout => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                other => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err(BackendError::InitializationFailed(format!(
                        "CUDA worker timed out or failed: {other:?}"
                    )));
                }
            }
        };
        let _ = writer.join();
        let response = reader
            .join()
            .map_err(|_| BackendError::InitializationFailed("Worker reader failed".into()))?;
        let logs = logger.join().unwrap_or_default();
        let status = status?;
        // Budgets can change after the preflight. Preserve a native allocation
        // failure even when the binding only returns a generic context error.
        let normalized = logs.to_ascii_lowercase().replace(['_', ' '], "");
        let native_oom = [
            "outofdevicememory",
            "outofmemory",
            "badalloc",
            "cudamallocfailed",
        ]
        .iter()
        .any(|message| normalized.contains(message));
        let failed = !status.success()
            || matches!(
                &response,
                Err(_) | Ok(WorkerResponse { result: Err(_), .. })
            );
        if native_oom && failed {
            return Err(BackendError::InsufficientMemory {
                required_bytes: required,
                available_bytes: None,
            });
        }
        if !status.success() {
            // Windows loader exits before main when CUDA runtime/driver DLLs are absent.
            if status.code().map(|c| c as u32) == Some(0xc0000135) {
                return Err(BackendError::Unavailable(
                    CapabilityState::MissingDriverOrRuntime,
                ));
            }
            return Err(BackendError::InitializationFailed(format!(
                "CUDA worker exited {status}: {}",
                logs.chars().take(2000).collect::<String>()
            )));
        }
        let response = response.map_err(|e| BackendError::InitializationFailed(e.to_string()))?;
        if response.protocol_version != 1 || response.engine_version != ENGINE_VERSION {
            return Err(BackendError::InitializationFailed(
                "Incompatible CUDA worker protocol or native version".into(),
            ));
        }
        Ok((response.result?, logs))
    }

    pub fn adapters(&self) -> Result<Vec<CudaAdapter>, BackendError> {
        self.adapters_at(None)
    }

    fn adapters_at(&self, generation: Option<u64>) -> Result<Vec<CudaAdapter>, BackendError> {
        match self.exchange(WorkerRequest::Probe, generation)?.0 {
            WorkerResult::Adapters(devices) => Ok(devices),
            _ => Err(BackendError::InitializationFailed(
                "Unexpected probe response".into(),
            )),
        }
    }

    fn selected(&self, generation: Option<u64>) -> Result<CudaAdapter, BackendError> {
        let devices = self.adapters_at(generation)?;
        let selected = match &self.adapter_id {
            Some(id) => devices.iter().find(|d| &d.id == id),
            None => devices
                .iter()
                .find(|d| d.capability == CapabilityState::Available)
                .or_else(|| devices.first()),
        };
        selected.cloned().ok_or(BackendError::Unavailable(
            CapabilityState::NoCompatibleDevice,
        ))
    }
}

impl WhisperBackendRuntime for CudaRuntime {
    fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
    fn backend_id(&self) -> BackendId {
        BackendId::Cuda
    }
    fn probe(&self) -> BackendProbe {
        let state = match self.selected(None) {
            Ok(device) => {
                return BackendProbe {
                    backend: BackendId::Cuda,
                    state: device.capability,
                    adapter: Some(device.name),
                    memory_pool: device.memory,
                };
            }
            Err(BackendError::Unavailable(state)) => state,
            Err(BackendError::InsufficientMemory {
                required_bytes,
                available_bytes,
            }) => CapabilityState::InsufficientMemory {
                required_bytes,
                available_bytes,
            },
            Err(e) => CapabilityState::InitializationFailure(e.to_string()),
        };
        BackendProbe {
            backend: BackendId::Cuda,
            state,
            adapter: self.adapter_id.clone(),
            memory_pool: None,
        }
    }
    fn transcribe(
        &self,
        request: &TranscriptionRequest,
    ) -> Result<TranscriptionOutcome, BackendError> {
        let generation = self.generation.load(Ordering::Acquire);
        if request.cancelled.load(Ordering::SeqCst) {
            return Err(BackendError::Cancelled);
        }
        let device = self.selected(Some(generation))?;
        if device.capability != CapabilityState::Available {
            return Err(BackendError::Unavailable(device.capability));
        }
        check_memory(&device, &request.model_path)?;
        let mut request = request.clone();
        request.samples = super::resample(&request.samples, request.sample_rate);
        request.sample_rate = 16000;
        let (result, logs) = self.exchange(
            WorkerRequest::Transcribe {
                request,
                adapter_id: device.id.clone(),
            },
            Some(generation),
        )?;
        if self.generation.load(Ordering::Acquire) != generation {
            return Err(BackendError::Cancelled);
        }
        match result {
            WorkerResult::Transcription {
                text,
                adapter_id,
                native_backend,
            } if adapter_id == device.id && native_backend == device.native_backend => {
                let selected = format!("whisper_backend_init_gpu: using {native_backend} backend");
                let has_offload_evidence = logs.contains(&selected)
                    || logs.contains("ggml_cuda_init")
                    || logs.contains("CUDA Timings:")
                    || logs.contains("CUDA0")
                    || logs.contains("compute capability");
                if !has_offload_evidence {
                    return Err(BackendError::InferenceFailed(
                        "CUDA offload was not evidenced by native GPU execution; CPU fallback is refused".into(),
                    ));
                }
                let timing_line = logs
                    .lines()
                    .find(|line| {
                        line.contains("CUDA Timings:")
                            || line.contains("Total time: ")
                            || line.contains("compute capability")
                    })
                    .unwrap_or("CUDA verified");
                let evidence = format!(
                    "whisper.cpp {ENGINE_VERSION}; {}; {selected}; {timing_line}",
                    device.id
                );
                Ok(TranscriptionOutcome {
                    text,
                    execution: super::ExecutionDetails {
                        backend: BackendId::Cuda,
                        adapter: Some(device.name),
                        offloaded: true,
                        offload_evidence: Some(evidence),
                    },
                })
            }
            WorkerResult::Transcription { .. } => Err(BackendError::InferenceFailed(
                "Worker returned mismatched CUDA device identity".into(),
            )),
            WorkerResult::Adapters(_) => Err(BackendError::InitializationFailed(
                "Worker returned adapters instead of transcription".into(),
            )),
        }
    }
}
