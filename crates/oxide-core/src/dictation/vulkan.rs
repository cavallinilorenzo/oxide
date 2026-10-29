//! Optional Vulkan worker. No Vulkan library is linked or loaded by the host.
use super::{
    BackendError, BackendId, BackendProbe, CapabilityState, MemoryPool, TranscriptionOutcome,
    TranscriptionRequest, WhisperBackendRuntime,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

pub const ENGINE_VERSION: &str = "1.8.3";
const MAX_FRAME: usize = 64 * 1024 * 1024;
const SMALL_WORKING_SET: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VulkanAdapter {
    pub id: String,
    pub name: String,
    pub driver: Option<String>,
    pub api_version: String,
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
    Adapters(Vec<VulkanAdapter>),
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
    std::env::var_os("OXIDE_VULKAN_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap_or_default()
                .with_file_name(format!(
                    "oxide-vulkan-worker{}",
                    std::env::consts::EXE_SUFFIX
                ))
        })
}

/// Provisional conservative Small working set, separate from model file size.
/// Keep 20% of the current reported device budget free; unknown stays unknown.
pub fn check_memory(device: &VulkanAdapter) -> Result<(), BackendError> {
    let required = SMALL_WORKING_SET;
    if let Some(available) = device.memory.as_ref().and_then(|m| m.available_bytes)
        && available.saturating_mul(4) / 5 < required
    {
        return Err(BackendError::InsufficientMemory {
            required_bytes: required,
            available_bytes: Some(available),
        });
    }
    Ok(())
}

pub struct VulkanRuntime {
    worker: PathBuf,
    adapter_id: Option<String>,
    generation: AtomicU64,
}

impl Default for VulkanRuntime {
    fn default() -> Self {
        Self::new(worker_path(), std::env::var("OXIDE_VULKAN_ADAPTER").ok())
    }
}

impl VulkanRuntime {
    pub fn new(worker: PathBuf, adapter_id: Option<String>) -> Self {
        Self {
            worker,
            adapter_id,
            generation: AtomicU64::new(0),
        }
    }

    fn exchange(
        &self,
        request: WorkerRequest,
        generation: Option<u64>,
    ) -> Result<(WorkerResult, String), BackendError> {
        let generation = generation.unwrap_or_else(|| self.generation.load(Ordering::Acquire));
        if self.generation.load(Ordering::Acquire) != generation {
            return Err(BackendError::Cancelled);
        }
        let timeout = if matches!(request, WorkerRequest::Probe) {
            Duration::from_secs(15)
        } else {
            Duration::from_secs(180)
        };
        if !self.worker.is_file() {
            return Err(BackendError::Unavailable(CapabilityState::OmittedFromBuild));
        }
        let mut command = Command::new(&self.worker);
        command
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GGML_VK_PERF_LOGGER", "1")
            .env("GGML_VK_PERF_LOGGER_FREQUENCY", "1")
            .env_remove("GGML_VK_VISIBLE_DEVICES");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| BackendError::InitializationFailed(e.to_string()))?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let mut errors = child.stderr.take().unwrap();
        let writer = std::thread::spawn(move || write_frame(input, &request));
        let reader = std::thread::spawn(move || read_frame::<WorkerResponse>(output));
        // Drain all native output, retaining a bounded prefix containing device
        // selection and the first GPU timestamp report. Never log input audio.
        let logger = std::thread::spawn(move || {
            let mut retained = Vec::new();
            let mut chunk = [0; 8192];
            while let Ok(n) = errors.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let keep = n.min((1024 * 1024usize).saturating_sub(retained.len()));
                retained.extend_from_slice(&chunk[..keep]);
            }
            String::from_utf8_lossy(&retained).into_owned()
        });
        let start = Instant::now();
        let status = loop {
            if self.generation.load(Ordering::Acquire) != generation {
                let _ = child.kill();
                let _ = child.wait();
                break Err(BackendError::Cancelled);
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
                        "Vulkan worker timed out or failed: {other:?}"
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
            "outofhostmemory",
            "outofmemory",
            "badalloc",
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
                required_bytes: SMALL_WORKING_SET,
                available_bytes: None,
            });
        }
        if !status.success() {
            // Windows loader exits before main when vulkan-1.dll is absent.
            if status.code().map(|c| c as u32) == Some(0xc0000135) {
                return Err(BackendError::Unavailable(
                    CapabilityState::MissingDriverOrRuntime,
                ));
            }
            return Err(BackendError::InitializationFailed(format!(
                "Vulkan worker exited {status}: {}",
                logs.chars().take(2000).collect::<String>()
            )));
        }
        let response = response.map_err(|e| BackendError::InitializationFailed(e.to_string()))?;
        if response.protocol_version != 1 || response.engine_version != ENGINE_VERSION {
            return Err(BackendError::InitializationFailed(
                "Incompatible Vulkan worker protocol or native version".into(),
            ));
        }
        Ok((response.result?, logs))
    }

    pub fn adapters(&self) -> Result<Vec<VulkanAdapter>, BackendError> {
        match self.exchange(WorkerRequest::Probe, None)?.0 {
            WorkerResult::Adapters(devices) => Ok(devices),
            _ => Err(BackendError::InitializationFailed(
                "Unexpected probe response".into(),
            )),
        }
    }

    fn selected(&self) -> Result<VulkanAdapter, BackendError> {
        let devices = self.adapters()?;
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

impl WhisperBackendRuntime for VulkanRuntime {
    fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
    fn backend_id(&self) -> BackendId {
        BackendId::Vulkan
    }
    fn probe(&self) -> BackendProbe {
        let state = match self.selected() {
            Ok(device) => {
                return BackendProbe {
                    backend: BackendId::Vulkan,
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
            backend: BackendId::Vulkan,
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
        let device = self.selected()?;
        if device.capability != CapabilityState::Available {
            return Err(BackendError::Unavailable(device.capability));
        }
        check_memory(&device)?;
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
                let timing = logs.lines().find(|line| {
                    line.starts_with("Total time: ")
                        && line
                            .trim_start_matches("Total time: ")
                            .split_whitespace()
                            .next()
                            .and_then(|n| n.parse::<f64>().ok())
                            .is_some_and(|n| n.is_finite() && n > 0.0)
                });
                if !logs.contains(&selected)
                    || !logs.contains("Vulkan Timings:")
                    || !logs.contains("MUL_MAT")
                    || timing.is_none()
                {
                    return Err(BackendError::InferenceFailed("Vulkan offload was not evidenced by native GPU kernel timestamps; CPU fallback is refused".into()));
                }
                let evidence = format!(
                    "whisper.cpp {ENGINE_VERSION}; {}; {selected}; Vulkan Timings: {}",
                    device.id,
                    timing.unwrap()
                );
                Ok(TranscriptionOutcome {
                    text,
                    execution: super::ExecutionDetails {
                        backend: BackendId::Vulkan,
                        adapter: Some(device.name),
                        offloaded: true,
                        offload_evidence: Some(evidence),
                    },
                })
            }
            _ => Err(BackendError::InferenceFailed(
                "Worker used an unexpected adapter".into(),
            )),
        }
    }
}
