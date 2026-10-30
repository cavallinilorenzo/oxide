use super::*;
use crate::dictation::vulkan::{read_frame, write_frame};
use crate::dictation::{CapabilityState, MetalRuntime, WhisperBackendRuntime};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Instant,
};

#[derive(Serialize, Deserialize)]
struct Job {
    home: PathBuf,
    model: ModelId,
    backend: BackendId,
    adapter_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
enum Event {
    Progress(Phase),
    Finished(Result<Box<Observation>, BackendError>),
}

fn handle_event(
    event: std::io::Result<Event>,
    progress: &mut dyn FnMut(Phase),
    observation: &mut Option<Result<Box<Observation>, BackendError>>,
) {
    match event {
        Ok(Event::Progress(phase)) => progress(phase),
        Ok(Event::Finished(result)) => *observation = Some(result),
        Err(_) => {
            *observation = Some(Err(BackendError::InferenceFailed(
                "Invalid performance response".into(),
            )))
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Observation {
    candidate: BackendCandidate,
    native_backend: String,
    timing: Timing,
    cpu: CpuResources,
}

/// Identity freshly enumerated inside the backend-specific worker.
pub struct NativeDevice {
    pub candidate: BackendCandidate,
    pub native_index: i32,
    pub native_backend: String,
}

pub struct ProcessWorker {
    host: PathBuf,
    vulkan: PathBuf,
    cuda: PathBuf,
    timeout: Duration,
}

impl Default for ProcessWorker {
    fn default() -> Self {
        Self::new(
            std::env::current_exe().unwrap_or_default(),
            crate::dictation::vulkan::worker_path(),
            crate::dictation::cuda::worker_path(),
        )
    }
}
impl ProcessWorker {
    pub fn new(host: PathBuf, vulkan: PathBuf, cuda: PathBuf) -> Self {
        Self {
            host,
            vulkan,
            cuda,
            timeout: MAX_RUNTIME,
        }
    }
    /// May shorten the bound for a host/test; never extend the product limit.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout.min(MAX_RUNTIME);
        self
    }
}

struct Reap(Child);
impl Drop for Reap {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl PerformanceWorker for ProcessWorker {
    fn run(
        &self,
        home: &Path,
        model: ModelId,
        candidate: &BackendCandidate,
        cancelled: Arc<AtomicBool>,
        progress: &mut dyn FnMut(Phase),
    ) -> Result<BenchmarkResult, BackendError> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(BackendError::Cancelled);
        }
        if matches!(candidate.probe.backend, BackendId::Cuda | BackendId::Metal) {
            return Err(BackendError::InferenceFailed(
                "This native runtime does not expose CUDA/Metal execution counters for performance checks. Choose CPU or Vulkan; ordinary dictation remains available.".into()
            ));
        }
        let executable = match candidate.probe.backend {
            BackendId::Cpu | BackendId::Metal => &self.host,
            BackendId::Vulkan => &self.vulkan,
            BackendId::Cuda => &self.cuda,
        };
        let mut command = Command::new(executable);
        command
            .arg("--dictation-benchmark-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GGML_VK_PERF_LOGGER", "1")
            .env("GGML_VK_PERF_LOGGER_FREQUENCY", "1")
            .env_remove("GGML_VK_VISIBLE_DEVICES")
            .env_remove("CUDA_VISIBLE_DEVICES");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = Reap(command.spawn().map_err(|_| {
            BackendError::InitializationFailed(
                "Cannot launch performance worker. Check the installed backend.".into(),
            )
        })?);
        let input = child.0.stdin.take().unwrap();
        let output = child.0.stdout.take().unwrap();
        let mut errors = child.0.stderr.take().unwrap();
        let job = Job {
            home: home.into(),
            model,
            backend: candidate.probe.backend,
            adapter_id: candidate.adapter_id.clone(),
        };
        write_frame(input, &job).map_err(|_| {
            BackendError::InitializationFailed("Cannot initialize performance worker".into())
        })?;
        let (tx, rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut output = output;
            for _ in 0..8 {
                let event = read_frame::<Event>(&mut output);
                let done = !matches!(event, Ok(Event::Progress(_)));
                if tx.send(event).is_err() || done {
                    break;
                }
            }
        });
        let logger = std::thread::spawn(move || {
            let mut retained = Vec::new();
            let mut bytes = [0; 8192];
            while let Ok(n) = errors.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                let keep = n.min((1024 * 1024usize).saturating_sub(retained.len()));
                retained.extend_from_slice(&bytes[..keep]);
            }
            String::from_utf8_lossy(&retained).into_owned()
        });
        let started = Instant::now();
        let mut observation = None;
        let status = loop {
            if cancelled.load(Ordering::SeqCst) {
                break Err(BackendError::Cancelled);
            }
            if started.elapsed() >= self.timeout {
                break Err(BackendError::InferenceFailed(
                    "Performance check timed out. Choose a smaller model or another backend."
                        .into(),
                ));
            }
            while let Ok(event) = rx.try_recv() {
                handle_event(event, progress, &mut observation);
            }
            match child.0.try_wait() {
                Ok(Some(status)) => {
                    break if status.success() {
                        Ok(())
                    } else {
                        Err(BackendError::InferenceFailed(
                            "Performance worker exited unexpectedly. Try CPU or repair the driver."
                                .into(),
                        ))
                    };
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(_) => {
                    break Err(BackendError::InferenceFailed(
                        "Performance worker failed".into(),
                    ));
                }
            }
        };
        let _ = child.0.kill();
        let _ = child.0.wait();
        let _ = reader.join();
        let logs = logger.join().unwrap_or_default();
        status?;
        for event in rx.try_iter() {
            handle_event(event, progress, &mut observation);
        }
        if cancelled.load(Ordering::SeqCst) {
            return Err(BackendError::Cancelled);
        }
        let observed = observation.ok_or_else(|| {
            BackendError::InferenceFailed("Performance worker returned no result".into())
        })??;
        if observed.candidate.probe.backend != candidate.probe.backend
            || observed.candidate.adapter_id != candidate.adapter_id
            || (candidate.driver_version.is_some()
                && observed.candidate.driver_version != candidate.driver_version)
            || observed.candidate.runtime_version != candidate.runtime_version
        {
            return Err(BackendError::InferenceFailed(
                "Backend identity changed. Refresh devices and retry.".into(),
            ));
        }
        let backend = observed.candidate.probe.backend;
        let evidence = execution_evidence(backend, &observed.native_backend, &logs)?;
        let result = BenchmarkResult {
            fixture_version: FIXTURE_VERSION.into(),
            model,
            measurement: MeasuredPerformance {
                key: PerformanceKey::for_candidate(model, &observed.candidate, &observed.cpu),
                recorded_at_secs: now_secs(),
                audio_duration_ms: observed.timing.audio_duration_ms,
                warm_inference_ms: observed.timing.warm_inference_ms,
                cold_load_ms: observed.timing.cold_load_ms,
            },
            execution: ExecutionDetails {
                fallback_reason: None,
                backend,
                adapter: observed.candidate.probe.adapter,
                offloaded: backend != BackendId::Cpu,
                offload_evidence: evidence,
            },
        };
        result.validate()?;
        Ok(result)
    }
}

fn execution_evidence(
    backend: BackendId,
    native: &str,
    logs: &str,
) -> Result<Option<String>, BackendError> {
    if backend == BackendId::Cpu {
        return Ok(None);
    }
    let selected = format!("whisper_backend_init_gpu: using {native} backend");
    let executed = match backend {
        BackendId::Vulkan => {
            logs.contains("Vulkan Timings:")
                && logs.contains("MUL_MAT")
                && logs.lines().any(|line| {
                    line.strip_prefix("Total time: ")
                        .and_then(|s| s.split_whitespace().next())
                        .and_then(|n| n.parse::<f64>().ok())
                        .is_some_and(|n| n.is_finite() && n > 0.0)
                })
        }
        // The pinned CUDA/Metal integrations expose selection/allocation logs,
        // not completed GPU dispatch counters. Those also appear on CPU fallback.
        // Refuse measurements until those runtimes supply execution instrumentation.
        BackendId::Cuda | BackendId::Metal => false,
        BackendId::Cpu => false,
    };
    if !logs.contains(&selected) || !executed {
        return Err(BackendError::InferenceFailed("GPU execution was not evidenced by the native runtime; no GPU measurement saved. Try CPU.".into()));
    }
    Ok(Some(format!(
        "{}; {selected}; native compute{}",
        crate::dictation::BuildManifest::current().whisper_cpp_pinned,
        if backend == BackendId::Vulkan {
            " kernel timestamps"
        } else {
            " buffer and completed inference"
        }
    )))
}

/// Entry point used before starting Tauri, without opening devices or networking.
pub fn worker_main() {
    worker_main_with(|backend, adapter| {
        let candidate = match backend {
            BackendId::Cpu if adapter.is_none() => BackendCandidate::cpu(),
            BackendId::Metal => {
                let probe = MetalRuntime.probe();
                if probe.adapter != adapter {
                    return Err(BackendError::Unavailable(
                        CapabilityState::NoCompatibleDevice,
                    ));
                }
                BackendCandidate {
                    adapter_id: probe.adapter.clone(),
                    probe,
                    driver_version: sysinfo::System::kernel_version(),
                    runtime_version: runtime_version(BackendId::Metal),
                }
            }
            _ => return Err(BackendError::Unavailable(CapabilityState::OmittedFromBuild)),
        };
        Ok(NativeDevice {
            candidate,
            native_index: 0,
            native_backend: if backend == BackendId::Cpu {
                "CPU"
            } else {
                "Metal"
            }
            .into(),
        })
    });
}

pub fn worker_main_with(
    resolve: impl FnOnce(BackendId, Option<String>) -> Result<NativeDevice, BackendError>,
) {
    let mut output = std::io::stdout().lock();
    let run = || -> Result<Observation, BackendError> {
        let job: Job = read_frame(std::io::stdin().lock())
            .map_err(|_| BackendError::InitializationFailed("Invalid benchmark request".into()))?;
        let models = crate::dictation::models::ModelManager::default();
        let _lease = models
            .acquire(&job.home, job.model)
            .map_err(|_| BackendError::ModelUnavailable)?;
        // Hashing can be lengthy. Refresh the device budget after verification,
        // immediately before the combined memory check and context allocation.
        let device = resolve(job.backend, job.adapter_id)?;
        let resources = capture(&job.home.join("models"));
        assess_load(&resources, &device.candidate.probe, job.model, now_secs())
            .map_err(|r| r.backend_error())?;
        let request = crate::dictation::TranscriptionRequest {
            cancelled: Default::default(),
            model_path: crate::dictation::models::model_path(&job.home, job.model),
            language: Some("en".into()),
            samples: include_bytes!("../../../tests/fixtures/jfk.pcm")
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect(),
            sample_rate: 16000,
            threads: resources.cpu.usable_cores.clamp(1, 8),
        };
        let timing = crate::dictation::runtime::benchmark_on_device(
            &request,
            job.backend,
            device.native_index,
            |phase| {
                let _ = write_frame(&mut output, &Event::Progress(phase));
            },
        )?;
        Ok(Observation {
            candidate: device.candidate,
            native_backend: device.native_backend,
            timing,
            cpu: resources.cpu,
        })
    };
    let result = run();
    let _ = write_frame(&mut output, &Event::Finished(result.map(Box::new)));
}
