//! Reproducible offline CUDA GPU diagnostic; never opens the microphone.
use oxide_core::dictation::{
    CpuRuntime, TranscriptionRequest, WhisperBackendRuntime, cuda::CudaRuntime,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let path = args
        .first()
        .ok_or("Usage: cuda_diagnostic WORKER|cpu [MODEL WAV [ADAPTER_ID]]")?;
    let runtime: Box<dyn WhisperBackendRuntime> = if path == "cpu" {
        println!("{}", serde_json::to_string_pretty(&CpuRuntime.probe())?);
        Box::new(CpuRuntime)
    } else {
        let runtime = CudaRuntime::new(path.into(), args.get(3).cloned());
        println!("{}", serde_json::to_string_pretty(&runtime.adapters()?)?);
        Box::new(runtime)
    };
    if args.len() >= 3 {
        let mut wav = hound::WavReader::open(&args[2])?;
        let spec = wav.spec();
        if spec.channels != 1
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
        {
            return Err("Diagnostic fixture must be mono PCM16 WAV".into());
        }
        if wav.duration() > spec.sample_rate.saturating_mul(120) {
            return Err("Diagnostic fixture exceeds two minutes".into());
        }
        let samples = wav
            .samples::<i16>()
            .map(|s| s.map(|s| s as f32 / 32768.0))
            .collect::<Result<Vec<_>, _>>()?;
        let started = std::time::Instant::now();
        let outcome = runtime.transcribe(&TranscriptionRequest {
            cancelled: Default::default(),
            model_path: args[1].clone().into(),
            language: Some("en".into()),
            samples,
            sample_rate: spec.sample_rate,
            threads: 4,
        })?;
        println!(
            "Cold transcription wall time (including model load): {:.3} s",
            started.elapsed().as_secs_f64()
        );
        println!("{}", serde_json::to_string_pretty(&outcome.execution)?);
        println!("{}", outcome.text);
    }
    Ok(())
}
