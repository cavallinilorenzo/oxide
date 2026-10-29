//! Local, bounded microphone capture and whisper.cpp inference. Audio never touches disk.
pub mod metal;
pub mod models;
pub mod runtime;
pub mod types;

use crate::{Error, Result};
use cpal::{
    Sample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

pub use metal::MetalRuntime;
pub use runtime::{
    BackendError, CpuRuntime, TranscriptionOutcome, TranscriptionRequest, WhisperBackendRuntime,
    probe_backends,
};
pub use types::{
    BackendId, BackendProbe, BuildManifest, CapabilityState, ExecutionDetails, MemoryPool, ModelId,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    #[default]
    Cpu,
    Gpu,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationSettings {
    pub enabled: bool,
    pub language: String,
    pub device: Device,
    pub model: ModelId,
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            language: "auto".into(),
            device: Device::Cpu,
            model: ModelId::Small,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub gpu_compiled: bool,
    pub available_memory_gb: f64,
    pub cpu_threads: usize,
    pub recommendation: String,
    pub manifest: BuildManifest,
    pub probes: Vec<BackendProbe>,
    pub last_execution: Option<ExecutionDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_pool: Option<MemoryPool>,
}

pub fn status(home: &Path) -> Status {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let available = system.available_memory() as f64 / 1_073_741_824.0;
    let threads = std::thread::available_parallelism().map_or(1, usize::from);
    let probes = probe_backends();
    let memory_pool = probes.iter().find_map(|p| p.memory_pool.clone());

    Status {
        installed: models::ModelManager::default()
            .status(home, ModelId::Small)
            .is_ok_and(|s| matches!(s.state, models::ModelState::Installed)),
        gpu_compiled: gpu_compiled(),
        available_memory_gb: available,
        cpu_threads: threads,
        recommendation: recommendation(available, threads).into(),
        manifest: BuildManifest::current(),
        probes,
        last_execution: None,
        memory_pool,
    }
}

pub fn recommendation(available: f64, threads: usize) -> &'static str {
    if available < 2.0 {
        "Not recommended now: less than 2 GB of RAM is available. Free memory before enabling Whisper small."
    } else if threads < 4 {
        "Usable, but CPU transcription may be slow. Keep recordings short or use a supported GPU."
    } else {
        "Recommended for short dictation on CPU. Whisper small uses roughly 1 GB of memory; speed depends on your processor. GPU acceleration may reduce the wait."
    }
}

pub fn gpu_compiled() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        true
    }
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    {
        // Intel Mac GPU support remains unadvertised until separately validated
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        cfg!(feature = "dictation-vulkan")
    }
}

pub fn model(home: &Path) -> PathBuf {
    home.join("models/ggml-small.bin")
}

fn err(e: impl std::fmt::Display) -> Error {
    Error::Dictation(e.to_string())
}

/// Compatibility entry point for the existing explicit Small download action.
pub fn install(home: &Path, progress: impl Fn(u64, u64)) -> Result<()> {
    models::ModelManager::default().install(home, ModelId::Small, |status| {
        if let models::ModelState::Installing { received, total } = status.state {
            progress(received, total);
        }
    })
}

/// Snapshot of the configuration taken at the instant recording begins.
/// Prevents changes to Settings during a recording from corrupting or switching the in-flight inference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingSnapshot {
    pub language: String,
    pub device: Device,
    pub model: ModelId,
}

struct Recording {
    stop: mpsc::Sender<()>,
    result: mpsc::Receiver<Result<(Vec<f32>, u32)>>,
    snapshot: RecordingSnapshot,
    cancelled: Arc<AtomicBool>,
    _lease: Option<models::ModelLease>,
}

pub struct Dictation {
    pub models: Arc<models::ModelManager>,
    selected: Mutex<Option<(ModelId, models::ModelLease)>>,
    cancellation: Mutex<Option<Arc<AtomicBool>>>,
    recording: Mutex<Option<Recording>>,
    busy: Mutex<bool>,
    last_execution: Mutex<Option<ExecutionDetails>>,
    runtime: Arc<dyn WhisperBackendRuntime>,
    memory_checker: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
}

pub fn default_runtime() -> Arc<dyn WhisperBackendRuntime> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let metal = MetalRuntime;
        if matches!(metal.probe().state, CapabilityState::Available) {
            return Arc::new(metal);
        }
    }
    Arc::new(CpuRuntime)
}

impl Default for Dictation {
    fn default() -> Self {
        Self {
            models: Arc::new(models::ModelManager::default()),
            selected: Mutex::new(None),
            cancellation: Mutex::new(None),
            recording: Mutex::new(None),
            busy: Mutex::new(false),
            last_execution: Mutex::new(None),
            runtime: default_runtime(),
            memory_checker: None,
        }
    }
}

impl Dictation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_runtime(runtime: Arc<dyn WhisperBackendRuntime>) -> Self {
        Self {
            models: Arc::new(models::ModelManager::default()),
            selected: Mutex::new(None),
            cancellation: Mutex::new(None),
            recording: Mutex::new(None),
            busy: Mutex::new(false),
            last_execution: Mutex::new(None),
            runtime,
            memory_checker: None,
        }
    }

    pub fn with_runtime_and_memory(
        runtime: Arc<dyn WhisperBackendRuntime>,
        memory_checker: Arc<dyn Fn() -> f64 + Send + Sync>,
    ) -> Self {
        Self {
            models: Arc::new(models::ModelManager::default()),
            selected: Mutex::new(None),
            cancellation: Mutex::new(None),
            recording: Mutex::new(None),
            busy: Mutex::new(false),
            last_execution: Mutex::new(None),
            runtime,
            memory_checker: Some(memory_checker),
        }
    }

    pub fn with_models(mut self, models: Arc<models::ModelManager>) -> Self {
        self.models = models;
        self
    }

    /// Apply on the settings worker. Missing selections leave the current lease intact.
    pub fn configure(&self, home: &Path, settings: &DictationSettings) -> Result<()> {
        let mut selected = self.selected.lock().unwrap();
        if !settings.enabled {
            self.cancel();
            *selected = None;
        } else if selected.as_ref().map(|s| s.0) != Some(settings.model) {
            let lease = self.models.acquire(home, settings.model)?;
            *selected = Some((settings.model, lease));
        }
        Ok(())
    }

    pub fn last_execution(&self) -> Option<ExecutionDetails> {
        self.last_execution.lock().unwrap().clone()
    }

    pub fn status(&self, home: &Path) -> Status {
        let mut s = status(home);
        s.last_execution = self.last_execution();
        s
    }

    #[doc(hidden)]
    pub fn inject_recording_for_test(
        &self,
        snapshot: RecordingSnapshot,
        samples: Vec<f32>,
        rate: u32,
    ) {
        let (stop, _) = mpsc::channel();
        let (result_tx, result) = mpsc::channel();
        let _ = result_tx.send(Ok((samples, rate)));
        let cancelled = Arc::new(AtomicBool::new(false));
        *self.cancellation.lock().unwrap() = Some(cancelled.clone());
        *self.recording.lock().unwrap() = Some(Recording {
            stop,
            result,
            snapshot,
            cancelled,
            _lease: None,
        });
    }

    pub fn start(&self, home: &Path, settings: &DictationSettings) -> Result<()> {
        if !settings.enabled {
            return Err(err("Enable dictation in Settings first."));
        }
        self.configure(home, settings)?;
        let lease = self.models.acquire(home, settings.model)?;
        if settings.device == Device::Gpu && !gpu_compiled() {
            return Err(err(
                "This build has CPU support only. Choose CPU in Settings.",
            ));
        }
        let mut recording = self.recording.lock().unwrap();
        if recording.is_some() || *self.busy.lock().unwrap() {
            return Err(err("Dictation is already active."));
        }

        // Snapshot settings at recording start
        let snapshot = RecordingSnapshot {
            language: settings.language.clone(),
            device: settings.device,
            model: settings.model,
        };

        let (stop, stopped) = mpsc::channel();
        let (result_tx, result) = mpsc::channel();
        let (ready_tx, ready) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = capture(stopped, ready_tx);
            let _ = result_tx.send(outcome);
        });
        ready.recv().map_err(err)??;
        let cancelled = Arc::new(AtomicBool::new(false));
        *self.cancellation.lock().unwrap() = Some(cancelled.clone());
        *recording = Some(Recording {
            stop,
            result,
            snapshot,
            cancelled,
            _lease: Some(lease),
        });
        Ok(())
    }

    pub fn cancel(&self) {
        let recording = self.recording.lock().unwrap().take();
        if let Some(cancelled) = self.cancellation.lock().unwrap().take() {
            cancelled.store(true, Ordering::SeqCst);
        }
        if let Some(recording) = recording {
            let _ = recording.stop.send(());
        }
    }

    pub fn stop(&self, home: &Path, settings: &DictationSettings) -> Result<String> {
        let mut slot = self.recording.lock().unwrap();
        let recording = slot.take().ok_or_else(|| err("No recording is active."))?;
        *self.busy.lock().unwrap() = true;
        drop(slot);

        let result = (|| {
            let _ = recording.stop.send(());
            let (samples, rate) = recording
                .result
                .recv_timeout(Duration::from_secs(5))
                .map_err(err)??;

            if !settings.enabled {
                return Err(err("Dictation was disabled. Recording discarded."));
            }

            // Execute using the snapshotted parameters taken at start
            let text = self.transcribe_snapshot(
                home,
                &recording.snapshot,
                &samples,
                rate,
                recording.cancelled.clone(),
            )?;
            if recording.cancelled.load(Ordering::SeqCst) {
                return Err(err("Dictation cancelled. Recording discarded."));
            }
            Ok(text)
        })();

        *self.busy.lock().unwrap() = false;
        result
    }

    fn record_execution(
        &self,
        request: &TranscriptionRequest,
        execution: ExecutionDetails,
    ) -> Result<()> {
        if request.cancelled.load(Ordering::SeqCst) {
            return Err(err("Dictation cancelled. Recording discarded."));
        }
        *self.last_execution.lock().unwrap() = Some(execution);
        Ok(())
    }

    fn transcribe_snapshot(
        &self,
        home: &Path,
        snapshot: &RecordingSnapshot,
        samples: &[f32],
        rate: u32,
        cancelled: Arc<AtomicBool>,
    ) -> Result<String> {
        if samples.len() < rate as usize / 4
            || samples.iter().map(|s| s * s).sum::<f32>() / (samples.len().max(1) as f32) < 0.00001
        {
            return Ok(String::new());
        }

        let model_path = models::model_path(home, snapshot.model);
        let language = if snapshot.language == "auto" {
            None
        } else {
            Some(snapshot.language.clone())
        };

        let threads = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 8));

        let request = TranscriptionRequest {
            cancelled,
            model_path,
            language,
            samples: samples.to_vec(),
            sample_rate: rate,
            threads,
        };

        // Execution logic based on mode:
        // - Auto: attempts preferred backend; on failure retries CPU once if memory permits (>= 2GB available RAM)
        // - Gpu: explicit GPU request. If it fails or runtime is CPU-only, report failure and offer CPU; NEVER silently substitute CPU for GPU.
        // - Cpu: executes directly on CPU, never requests offload.
        match snapshot.device {
            Device::Cpu => {
                let cpu = CpuRuntime;
                let outcome = cpu
                    .transcribe(&request)
                    .map_err(|e| err(format!("CPU transcription failed: {e}")))?;
                self.record_execution(&request, outcome.execution)?;
                Ok(outcome.text)
            }
            Device::Gpu => {
                if self.runtime.backend_id() == BackendId::Cpu {
                    return Err(err(
                        "GPU transcription failed: active runtime has CPU support only. Choose CPU in Settings to transcribe on CPU.",
                    ));
                }
                let outcome = self
                    .runtime
                    .transcribe(&request)
                    .map_err(|e| err(format!("GPU transcription failed: {e}. Choose CPU in Settings to transcribe on CPU.")))?;
                self.record_execution(&request, outcome.execution)?;
                Ok(outcome.text)
            }
            Device::Auto => {
                if self.runtime.backend_id() == BackendId::Cpu {
                    let outcome = self
                        .runtime
                        .transcribe(&request)
                        .map_err(|e| err(format!("Auto transcription failed on CPU: {e}")))?;
                    self.record_execution(&request, outcome.execution)?;
                    Ok(outcome.text)
                } else {
                    match self.runtime.transcribe(&request) {
                        Ok(outcome) => {
                            self.record_execution(&request, outcome.execution)?;
                            Ok(outcome.text)
                        }
                        Err(gpu_err) => {
                            if request.cancelled.load(Ordering::SeqCst) {
                                return Err(err("Dictation cancelled. Recording discarded."));
                            }
                            // Check memory budget before retrying on CPU
                            let available_gb = match &self.memory_checker {
                                Some(checker) => checker(),
                                None => {
                                    let mut system = sysinfo::System::new();
                                    system.refresh_memory();
                                    system.available_memory() as f64 / 1_073_741_824.0
                                }
                            };
                            let required_gb = models::catalogue()
                                .models
                                .iter()
                                .find(|m| m.id == snapshot.model)
                                .unwrap()
                                .estimated_peak_bytes
                                .iter()
                                .find(|m| m.backend == BackendId::Cpu)
                                .unwrap()
                                .bytes as f64
                                / 1_073_741_824.0;
                            if available_gb < required_gb {
                                return Err(err(format!(
                                    "Auto execution failed on primary backend ({gpu_err}) and CPU retry was refused due to low memory ({available_gb:.1} GB available, {required_gb:.1} GB required)."
                                )));
                            }

                            // Retry once on CPU
                            let cpu = CpuRuntime;
                            let outcome = cpu.transcribe(&request).map_err(|e| {
                                err(format!(
                                    "Primary backend failed ({gpu_err}) and CPU fallback also failed: {e}"
                                ))
                            })?;
                            let mut exec = outcome.execution;
                            exec.offload_evidence = Some(format!(
                                "Fell back to CPU after primary backend failure: {gpu_err}"
                            ));
                            self.record_execution(&request, exec)?;
                            Ok(outcome.text)
                        }
                    }
                }
            }
        }
    }
}

impl Drop for Dictation {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn capture(stop: mpsc::Receiver<()>, ready: mpsc::Sender<Result<()>>) -> Result<(Vec<f32>, u32)> {
    let result = (|| {
        let device = cpal::default_host()
            .default_input_device()
            .ok_or_else(|| err("No microphone found. Check system microphone permissions."))?;
        let supported = device.default_input_config().map_err(err)?;
        let rate = supported.sample_rate().0;
        let channels = supported.channels() as usize;
        let samples = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::new(Mutex::new(None));
        let error_buffer = errors.clone();
        let on_error = move |e: cpal::StreamError| {
            *error_buffer.lock().unwrap() = Some(e.to_string());
        };
        let config: cpal::StreamConfig = supported.clone().into();
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => {
                input::<f32>(&device, &config, samples.clone(), channels, on_error)
            }
            cpal::SampleFormat::I16 => {
                input::<i16>(&device, &config, samples.clone(), channels, on_error)
            }
            cpal::SampleFormat::U16 => {
                input::<u16>(&device, &config, samples.clone(), channels, on_error)
            }
            _ => {
                return Err(err(
                    "Unsupported microphone format. Choose another default microphone in system settings.",
                ));
            }
        }?;
        stream.play().map_err(err)?;
        let _ = ready.send(Ok(()));
        // The native deadline closes the microphone even if the webview disappears.
        let _ = stop.recv_timeout(Duration::from_secs(120));
        drop(stream);
        if let Some(error) = errors.lock().unwrap().take() {
            return Err(err(error));
        }
        let captured = std::mem::take(&mut *samples.lock().unwrap());
        Ok((captured, rate))
    })();
    if let Err(error) = &result {
        let _ = ready.send(Err(err(error)));
    }
    result
}

fn input<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    samples: Arc<Mutex<Vec<f32>>>,
    channels: usize,
    on_error: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let max = config.sample_rate.0 as usize * 120;
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mut out = samples.lock().unwrap();
                for frame in data
                    .chunks_exact(channels)
                    .take(max.saturating_sub(out.len()))
                {
                    out.push(
                        frame.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / channels as f32,
                    );
                }
            },
            on_error,
            None,
        )
        .map_err(err)
}

pub fn resample(samples: &[f32], rate: u32) -> Vec<f32> {
    // Windowed sinc low-pass conversion prevents high-frequency aliasing at 16 kHz.
    let ratio = rate as f64 / 16000.0;
    let cutoff = (1.0 / ratio).min(1.0) * 0.9;
    (0..(samples.len() as f64 / ratio) as usize)
        .map(|i| {
            let at = i as f64 * ratio;
            let center = at as isize;
            let mut sum = 0.0;
            let mut weight = 0.0;
            for j in center - 24..=center + 24 {
                if j < 0 || j as usize >= samples.len() {
                    continue;
                }
                let x = j as f64 - at;
                let z = std::f64::consts::PI * x * cutoff;
                let sinc = if z.abs() < 1e-8 { 1.0 } else { z.sin() / z };
                let w = sinc * (0.5 + 0.5 * (std::f64::consts::PI * x / 25.0).cos());
                sum += samples[j as usize] as f64 * w;
                weight += w;
            }
            (sum / weight) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_advice_covers_low_memory_and_slow_cpu() {
        assert!(recommendation(1.0, 8).starts_with("Not recommended"));
        assert!(recommendation(4.0, 2).contains("slow"));
        assert!(recommendation(4.0, 8).starts_with("Recommended"));
    }

    #[test]
    fn resampling_preserves_duration_and_dc() {
        let result = resample(&vec![0.25; 48000], 48000);
        assert_eq!(result.len(), 16000);
        assert!(result.iter().all(|v| (v - 0.25).abs() < 0.001));
    }

    #[test]
    fn disabled_does_not_open_microphone() {
        assert!(
            Dictation::default()
                .start(Path::new("."), &DictationSettings::default())
                .unwrap_err()
                .to_string()
                .contains("Enable")
        );
    }
}
