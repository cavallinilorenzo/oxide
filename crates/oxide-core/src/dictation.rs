//! Local, bounded microphone capture and whisper.cpp inference. Audio never touches disk.
use crate::{Error, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    #[default]
    Cpu,
    Gpu,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub installed: bool,
    pub gpu_compiled: bool,
    pub available_memory_gb: f64,
    pub cpu_threads: usize,
    pub recommendation: String,
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
    }
}
fn recommendation(available: f64, threads: usize) -> &'static str {
    if available < 2.0 {
        "Not recommended now: less than 2 GB of RAM is available. Free memory before enabling Whisper small."
    } else if threads < 4 {
        "Usable, but CPU transcription may be slow. Keep recordings short or use a supported GPU."
    } else {
        "Recommended for short dictation on CPU. Whisper small uses roughly 1 GB of memory; speed depends on your processor. GPU acceleration may reduce the wait."
    }
}
fn gpu_compiled() -> bool {
    cfg!(any(target_os = "macos", feature = "dictation-vulkan"))
}
fn model(home: &Path) -> std::path::PathBuf {
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

struct Recording {
    stop: mpsc::Sender<()>,
    result: mpsc::Receiver<Result<(Vec<f32>, u32)>>,
}
#[derive(Default)]
pub struct Dictation {
    recording: Mutex<Option<Recording>>,
    busy: Mutex<bool>,
}
impl Dictation {
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
        let (stop, stopped) = mpsc::channel();
        let (result_tx, result) = mpsc::channel();
        let (ready_tx, ready) = mpsc::channel();
        std::thread::spawn(move || {
            let outcome = capture(stopped, ready_tx);
            let _ = result_tx.send(outcome);
        });
        ready.recv().map_err(err)??;
        *recording = Some(Recording { stop, result });
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
            transcribe(home, settings, &samples, rate)
        })();
        *self.busy.lock().unwrap() = false;
        result
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
                use cpal::Sample;
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
fn resample(samples: &[f32], rate: u32) -> Vec<f32> {
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
fn transcribe(
    home: &Path,
    settings: &DictationSettings,
    samples: &[f32],
    rate: u32,
) -> Result<String> {
    if samples.len() < rate as usize / 4
        || samples.iter().map(|s| s * s).sum::<f32>() / (samples.len().max(1) as f32) < 0.00001
    {
        return Ok(String::new());
    }
    let mut context = WhisperContextParameters::default();
    context.use_gpu(settings.device == Device::Gpu);
    let model = model(home);
    let path = model.to_str().ok_or_else(|| err("Invalid model path"))?;
    let context = WhisperContext::new_with_params(path, context).map_err(err)?;
    let mut state = context.create_state().map_err(err)?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(if settings.language == "auto" {
        None
    } else {
        Some(&settings.language)
    });
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_print_special(false);
    params.set_n_threads(
        std::thread::available_parallelism().map_or(2, |n| n.get().clamp(1, 8)) as i32,
    );
    state.full(params, &resample(samples, rate)).map_err(err)?;
    Ok(state
        .as_iter()
        .map(|s| s.to_string())
        .collect::<String>()
        .trim()
        .to_string())
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
