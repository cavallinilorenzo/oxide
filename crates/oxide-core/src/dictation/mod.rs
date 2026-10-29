//! Local, bounded microphone capture and whisper.cpp inference. Audio never touches disk.
pub mod runtime;
pub mod types;

use crate::{Error, Result};
use cpal::{
    Sample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

pub use runtime::{
    BackendError, CpuRuntime, TranscriptionOutcome, TranscriptionRequest, WhisperBackendRuntime,
    probe_backends,
};
pub use types::{
    BackendId, BackendProbe, BuildManifest, CapabilityState, ExecutionDetails, ModelId,
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
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            language: "auto".into(),
            device: Device::Cpu,
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
}

pub fn status(home: &Path) -> Status {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let available = system.available_memory() as f64 / 1_073_741_824.0;
    let threads = std::thread::available_parallelism().map_or(1, usize::from);
    Status {
        installed: model(home).is_file(),
        gpu_compiled: gpu_compiled(),
        available_memory_gb: available,
        cpu_threads: threads,
        recommendation: recommendation(available, threads).into(),
        manifest: BuildManifest::current(),
        probes: probe_backends(),
        last_execution: None,
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
    cfg!(any(target_os = "macos", feature = "dictation-vulkan"))
}

pub fn model(home: &Path) -> PathBuf {
    home.join("models/ggml-small.bin")
}

fn err(e: impl std::fmt::Display) -> Error {
    Error::Dictation(e.to_string())
}

/// Only called by the explicit Download button. Publish atomically, never accept partial files.
pub fn install(home: &Path, progress: impl Fn(u64, u64)) -> Result<()> {
    use sha2::{Digest, Sha256};
    let path = model(home);
    fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    if path.is_file() {
        return Ok(());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(err)?;
    let mut response = client
        .get("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin")
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(err)?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(err)?;
    let total = response.content_length().unwrap_or(487601967);
    let mut hash = Sha256::new();
    let mut received = 0;
    let mut buffer = [0; 262144];
    loop {
        let n = response.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > 500_000_000 {
            return Err(err("Unexpected model size"));
        }
        hash.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(err)?;
        progress(received, total);
    }
    // Official ggml-small artifact (Hugging Face LFS SHA-256), pinned to avoid accepting corrupt downloads.
    if format!("{:x}", hash.finalize()) != MODEL_SHA256 {
        return Err(err("Model checksum mismatch. Download again."));
    }
    file.persist(&path).map_err(err)?;
    Ok(())
}

const MODEL_SHA256: &str = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";

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
}

pub struct Dictation {
    recording: Mutex<Option<Recording>>,
    busy: Mutex<bool>,
    last_execution: Mutex<Option<ExecutionDetails>>,
    runtime: Arc<dyn WhisperBackendRuntime>,
    memory_checker: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
}

impl Default for Dictation {
    fn default() -> Self {
        Self {
            recording: Mutex::new(None),
            busy: Mutex::new(false),
            last_execution: Mutex::new(None),
            runtime: Arc::new(CpuRuntime),
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
            recording: Mutex::new(None),
            busy: Mutex::new(false),
            last_execution: Mutex::new(None),
            runtime,
            memory_checker: Some(memory_checker),
        }
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
        *self.recording.lock().unwrap() = Some(Recording {
            stop,
            result,
            snapshot,
        });
    }

    pub fn start(&self, home: &Path, settings: &DictationSettings) -> Result<()> {
        if !settings.enabled {
            return Err(err("Enable dictation in Settings first."));
        }
        if !model(home).is_file() {
            return Err(err("Download Whisper small in Settings first."));
        }
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
            model: ModelId::Small,
        };

        let (stop, stopped) = mpsc::channel();
        let (result_tx, result) = mpsc::channel();
        let (ready_tx, ready) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = capture(stopped, ready_tx);
            let _ = result_tx.send(outcome);
        });
        ready.recv().map_err(err)??;
        *recording = Some(Recording {
            stop,
            result,
            snapshot,
        });
        Ok(())
    }

    pub fn cancel(&self) {
        if let Some(recording) = self.recording.lock().unwrap().take() {
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
            self.transcribe_snapshot(home, &recording.snapshot, &samples, rate)
        })();

        *self.busy.lock().unwrap() = false;
        result
    }

    fn transcribe_snapshot(
        &self,
        home: &Path,
        snapshot: &RecordingSnapshot,
        samples: &[f32],
        rate: u32,
    ) -> Result<String> {
        if samples.len() < rate as usize / 4
            || samples.iter().map(|s| s * s).sum::<f32>() / (samples.len().max(1) as f32) < 0.00001
        {
            return Ok(String::new());
        }

        let model_path = match snapshot.model {
            ModelId::Small => model(home),
        };
        let language = if snapshot.language == "auto" {
            None
        } else {
            Some(snapshot.language.clone())
        };

        let threads = std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 8));

        let request = TranscriptionRequest {
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
                *self.last_execution.lock().unwrap() = Some(outcome.execution);
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
                *self.last_execution.lock().unwrap() = Some(outcome.execution);
                Ok(outcome.text)
            }
            Device::Auto => {
                if self.runtime.backend_id() == BackendId::Cpu {
                    let outcome = self
                        .runtime
                        .transcribe(&request)
                        .map_err(|e| err(format!("Auto transcription failed on CPU: {e}")))?;
                    *self.last_execution.lock().unwrap() = Some(outcome.execution);
                    Ok(outcome.text)
                } else {
                    match self.runtime.transcribe(&request) {
                        Ok(outcome) => {
                            *self.last_execution.lock().unwrap() = Some(outcome.execution);
                            Ok(outcome.text)
                        }
                        Err(gpu_err) => {
                            // Check memory budget before retrying on CPU
                            let available_gb = match &self.memory_checker {
                                Some(checker) => checker(),
                                None => {
                                    let mut system = sysinfo::System::new();
                                    system.refresh_memory();
                                    system.available_memory() as f64 / 1_073_741_824.0
                                }
                            };
                            if available_gb < 2.0 {
                                return Err(err(format!(
                                    "Auto execution failed on primary backend ({gpu_err}) and CPU retry was refused due to low memory ({available_gb:.1} GB available, 2.0 GB required)."
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
                            *self.last_execution.lock().unwrap() = Some(exec);
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
