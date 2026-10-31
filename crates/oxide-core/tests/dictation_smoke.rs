//! Opt-in network installation followed by offline CPU inference, never microphone capture.
use oxide_core::dictation::{
    CpuRuntime, ModelId, TranscriptionRequest, WhisperBackendRuntime,
    models::{ModelManager, model_path},
};

#[test]
#[ignore = "explicitly installs Tiny/Base/Small; set OXIDE_DICTATION_SMOKE_HOME to a reusable model cache"]
fn tiny_base_small_real_artifacts_transcribe_offline_across_model_switches() {
    let home = std::path::PathBuf::from(
        std::env::var_os("OXIDE_DICTATION_SMOKE_HOME").expect("set OXIDE_DICTATION_SMOKE_HOME"),
    );
    let models = ModelManager::default();
    let ids = [ModelId::Tiny, ModelId::Base, ModelId::Small];
    for id in ids {
        models.install(&home, id, |_| {}).unwrap();
    }
    // Inference only uses verified local paths after all explicit installations finish.
    let samples: Vec<f32> = include_bytes!("fixtures/jfk.pcm")
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect();
    for id in ids {
        let _lease = models.acquire(&home, id).unwrap();
        let started = std::time::Instant::now();
        let result = CpuRuntime
            .transcribe(&TranscriptionRequest {
                cancelled: Default::default(),
                model_path: model_path(&home, id),
                language: Some("en".into()),
                samples: samples.clone(),
                sample_rate: 16000,
                threads: 4,
            })
            .unwrap();
        eprintln!("{id}: {:.2}s", started.elapsed().as_secs_f64());
        let text = result.text.to_lowercase();
        assert!(text.contains("ask not"), "{id}: fixture phrase missing");
        assert!(text.contains("country"), "{id}: fixture word missing");
        assert!(!result.execution.offloaded);
    }
}
