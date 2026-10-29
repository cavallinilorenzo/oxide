use super::types::{BackendId, BackendProbe, BuildManifest, CapabilityState, ExecutionDetails};
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use thiserror::Error;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TranscriptionRequest {
    // Cancellation is process-local; isolated workers are cancelled by terminating the process.
    #[serde(skip)]
    pub cancelled: Arc<AtomicBool>,
    pub model_path: PathBuf,
    pub language: Option<String>,
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub threads: usize,
}

#[derive(Debug, Clone)]
pub struct TranscriptionOutcome {
    pub text: String,
    pub execution: ExecutionDetails,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, serde::Serialize, serde::Deserialize)]
pub enum BackendError {
    #[error("Transcription cancelled")]
    Cancelled,
    #[error("Backend unavailable: {0:?}")]
    Unavailable(CapabilityState),
    #[error("Initialization failed: {0}")]
    InitializationFailed(String),
    #[error("Inference failed: {0}")]
    InferenceFailed(String),
    #[error("Insufficient memory: required {required_bytes} bytes")]
    InsufficientMemory {
        required_bytes: u64,
        available_bytes: Option<u64>,
    },
}

pub trait WhisperBackendRuntime: Send + Sync {
    fn cancel(&self) {}
    fn backend_id(&self) -> BackendId;
    fn probe(&self) -> BackendProbe;
    fn transcribe(
        &self,
        request: &TranscriptionRequest,
    ) -> Result<TranscriptionOutcome, BackendError>;
}

/// Shared whisper inference execution for CPU and native GPU backends.
pub fn run_whisper_inference(
    request: &TranscriptionRequest,
    use_gpu: bool,
) -> Result<(String, bool, Option<String>), BackendError> {
    run_whisper_on_device(request, use_gpu, 0)
}

/// Called by an isolated native worker after resolving a stable adapter identity.
pub fn run_whisper_on_device(
    request: &TranscriptionRequest,
    use_gpu: bool,
    gpu_device: i32,
) -> Result<(String, bool, Option<String>), BackendError> {
    let context = load_context(request, use_gpu, gpu_device)?;
    let mut state = context
        .create_state()
        .map_err(|e| BackendError::InitializationFailed(e.to_string()))?;
    infer(request, &mut state)?;
    let text = state
        .as_iter()
        .map(|s| s.to_string())
        .collect::<String>()
        .trim()
        .to_string();
    Ok((text, use_gpu, None))
}

fn load_context(
    request: &TranscriptionRequest,
    use_gpu: bool,
    gpu_device: i32,
) -> Result<WhisperContext, BackendError> {
    if !request.model_path.is_file() {
        return Err(BackendError::InitializationFailed(format!(
            "Model file not found at: {}",
            request.model_path.display()
        )));
    }

    // GPU-specific checks run in the native adapters as well. This last host check
    // refreshes RAM immediately before context allocation, including CPU retries.
    super::resources::check_before_load(&request.model_path, &CpuRuntime.probe())?;

    let mut context_params = WhisperContextParameters::default();
    context_params.use_gpu(use_gpu);
    context_params.gpu_device(gpu_device);

    let path_str = request
        .model_path
        .to_str()
        .ok_or_else(|| BackendError::InitializationFailed("Invalid model path".into()))?;

    WhisperContext::new_with_params(path_str, context_params).map_err(|e| {
        let message = e.to_string();
        let lower = message.to_lowercase();
        if lower.contains("out of memory") || lower.contains("cannot allocate") {
            BackendError::InsufficientMemory {
                required_bytes: super::models::catalogue()
                    .entry_for_path(&request.model_path)
                    .and_then(|entry| entry.estimated_peak(BackendId::Cpu))
                    .expect("preflight checked catalogue estimate"),
                available_bytes: super::resources::capture(
                    request
                        .model_path
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new(".")),
                )
                .available_ram_bytes,
            }
        } else {
            BackendError::InitializationFailed(message)
        }
    })
}

fn infer(
    request: &TranscriptionRequest,
    state: &mut whisper_rs::WhisperState,
) -> Result<(), BackendError> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    unsafe extern "C" fn abort_cancelled(data: *mut std::ffi::c_void) -> bool {
        // SAFETY: installed below from the request's Arc, alive throughout synchronous full().
        unsafe { &*data.cast::<AtomicBool>() }.load(Ordering::SeqCst)
    }
    // SAFETY: whisper.cpp only calls this during synchronous inference; the request owns
    // the stable AtomicBool allocation until full() returns. The callback never unwinds.
    // Avoid 0.16.0's safe helper: it double-boxes a closure but casts its pointer as F.
    unsafe {
        params.set_abort_callback(Some(abort_cancelled));
        params.set_abort_callback_user_data(Arc::as_ptr(&request.cancelled).cast_mut().cast());
    }
    params.set_language(request.language.as_deref());
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_print_special(false);
    params.set_n_threads(request.threads.clamp(1, 8) as i32);

    let resampled = super::resample(&request.samples, request.sample_rate);
    state
        .full(params, &resampled)
        .map_err(|e| BackendError::InferenceFailed(e.to_string()))?;

    Ok(())
}

/// One cold context/state, one discarded warmup and three warm runs. No text leaves
/// this boundary. The calling process is disposable and is killed on timeout/cancel.
pub(crate) fn benchmark_on_device(
    request: &TranscriptionRequest,
    backend: BackendId,
    gpu_device: i32,
    mut progress: impl FnMut(super::benchmark::Phase),
) -> Result<super::benchmark::Timing, BackendError> {
    use std::time::Instant;
    progress(super::benchmark::Phase::Loading);
    let started = Instant::now();
    let context = load_context(request, backend != BackendId::Cpu, gpu_device)?;
    let mut state = context
        .create_state()
        .map_err(|e| BackendError::InitializationFailed(e.to_string()))?;
    let cold_load_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    super::benchmark::measure(
        super::benchmark::FIXTURE_DURATION_MS,
        cold_load_ms,
        || {
            let started = Instant::now();
            infer(request, &mut state)?;
            Ok(started.elapsed())
        },
        progress,
    )
}

/// Native CPU execution runtime. Never requests offload.
#[derive(Default)]
pub struct CpuRuntime;

impl WhisperBackendRuntime for CpuRuntime {
    fn backend_id(&self) -> BackendId {
        BackendId::Cpu
    }

    fn probe(&self) -> BackendProbe {
        // Probes report Available at best; never VerifiedByInference.
        BackendProbe {
            backend: BackendId::Cpu,
            state: CapabilityState::Available,
            adapter: Some("CPU".into()),
            memory_pool: None,
        }
    }

    fn transcribe(
        &self,
        request: &TranscriptionRequest,
    ) -> Result<TranscriptionOutcome, BackendError> {
        let (text, _, _) = run_whisper_inference(request, false)?;

        Ok(TranscriptionOutcome {
            text,
            execution: ExecutionDetails {
                backend: BackendId::Cpu,
                adapter: Some("CPU".into()),
                offloaded: false,
                offload_evidence: None,
            },
        })
    }
}

/// Probes all backend capabilities asynchronously or on-demand without crashing the host app.
/// Probes NEVER return VerifiedByInference (verified status requires an actual inference run).
pub fn probe_backends() -> Vec<BackendProbe> {
    let manifest = BuildManifest::current();
    let mut probes = Vec::new();

    // 1. CPU
    probes.push(BackendProbe {
        backend: BackendId::Cpu,
        state: CapabilityState::Available,
        adapter: Some("CPU".into()),
        memory_pool: None,
    });

    // 2. Metal
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        probes.push(super::metal::MetalRuntime.probe());
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        probes.push(BackendProbe {
            backend: BackendId::Metal,
            state: CapabilityState::OmittedFromBuild,
            adapter: None,
            memory_pool: None,
        });
    }

    // 3. Vulkan
    if manifest.included_backends.contains(&BackendId::Vulkan) {
        probes.push(super::vulkan::VulkanRuntime::default().probe());
    } else {
        probes.push(BackendProbe {
            backend: BackendId::Vulkan,
            state: CapabilityState::OmittedFromBuild,
            adapter: None,
            memory_pool: None,
        });
    }

    // 4. CUDA
    if manifest.included_backends.contains(&BackendId::Cuda) {
        probes.push(super::cuda::CudaRuntime::default().probe());
    } else {
        probes.push(BackendProbe {
            backend: BackendId::Cuda,
            state: CapabilityState::OmittedFromBuild,
            adapter: None,
            memory_pool: None,
        });
    }

    probes
}
