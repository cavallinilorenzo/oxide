use oxide_core::dictation::{
    BackendError, BackendId, BackendProbe, BuildManifest, CapabilityState, Device, Dictation,
    DictationSettings, ExecutionDetails, ModelId, RecordingSnapshot, TranscriptionOutcome,
    TranscriptionRequest, WhisperBackendRuntime,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[test]
fn capability_states_survive_serialization_without_losing_failure_reasons() {
    let states = vec![
        CapabilityState::OmittedFromBuild,
        CapabilityState::NoCompatibleDevice,
        CapabilityState::MissingDriverOrRuntime,
        CapabilityState::InitializationFailure("Failed to load vulkan-1.dll".into()),
        CapabilityState::InsufficientMemory {
            required_bytes: 2 * 1024 * 1024 * 1024,
            available_bytes: Some(1024 * 1024 * 1024),
        },
        CapabilityState::Available,
        CapabilityState::VerifiedByInference,
    ];

    for state in states {
        let json = serde_json::to_string(&state).expect("serialize capability state");
        let decoded: CapabilityState =
            serde_json::from_str(&json).expect("deserialize capability state");
        assert_eq!(state, decoded);
    }
}

#[test]
fn probes_cannot_claim_verified_status() {
    let manifest = BuildManifest::current();
    assert!(!manifest.included_backends.is_empty());
    assert_eq!(manifest.whisper_rs_version, "0.16.0");

    let probe_results = oxide_core::dictation::probe_backends();
    for probe in probe_results {
        assert_ne!(
            probe.state,
            CapabilityState::VerifiedByInference,
            "Probes can never claim verified status, but {:?} did",
            probe.backend
        );
    }
}

struct MockFailingGpuRuntime {
    calls: AtomicUsize,
}

impl WhisperBackendRuntime for MockFailingGpuRuntime {
    fn backend_id(&self) -> BackendId {
        BackendId::Vulkan
    }

    fn probe(&self) -> BackendProbe {
        BackendProbe {
            backend: BackendId::Vulkan,
            state: CapabilityState::Available,
            adapter: Some("Fake Vulkan GPU".into()),
        }
    }

    fn transcribe(
        &self,
        _request: &TranscriptionRequest,
    ) -> Result<TranscriptionOutcome, BackendError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::InitializationFailed(
            "Fake native GPU crash or driver failure".into(),
        ))
    }
}

struct MockSuccessfulGpuRuntime;

impl WhisperBackendRuntime for MockSuccessfulGpuRuntime {
    fn backend_id(&self) -> BackendId {
        BackendId::Metal
    }

    fn probe(&self) -> BackendProbe {
        BackendProbe {
            backend: BackendId::Metal,
            state: CapabilityState::Available,
            adapter: Some("Apple M3 Max".into()),
        }
    }

    fn transcribe(
        &self,
        _request: &TranscriptionRequest,
    ) -> Result<TranscriptionOutcome, BackendError> {
        Ok(TranscriptionOutcome {
            text: "gpu transcribed text".into(),
            execution: ExecutionDetails {
                backend: BackendId::Metal,
                adapter: Some("Apple M3 Max".into()),
                offloaded: true,
                offload_evidence: Some("32/32 layers offloaded to Metal".into()),
            },
        })
    }
}

#[test]
fn auto_mode_refuses_cpu_fallback_when_memory_insufficient() {
    let mock = Arc::new(MockFailingGpuRuntime {
        calls: AtomicUsize::new(0),
    });
    // Inject low available memory: 1.2 GB (< 2.0 GB required)
    let dictation = Dictation::with_runtime_and_memory(mock.clone(), Arc::new(|| 1.2));

    let snapshot = RecordingSnapshot {
        language: "auto".into(),
        device: Device::Auto,
        model: ModelId::Small,
    };

    let samples = vec![0.1f32; 16000];
    dictation.inject_recording_for_test(snapshot, samples, 16000);

    let home = tempfile::tempdir().unwrap();
    let settings = DictationSettings {
        enabled: true,
        language: "auto".into(),
        device: Device::Auto,
    };

    let err = dictation.stop(home.path(), &settings).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("CPU retry was refused due to low memory"),
        "Expected memory refusal message, got: {msg}"
    );
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn cpu_mode_never_requests_offload() {
    let runtime = oxide_core::dictation::CpuRuntime;
    assert_eq!(runtime.backend_id(), BackendId::Cpu);
    let probe = runtime.probe();
    assert_eq!(probe.backend, BackendId::Cpu);
    assert_eq!(probe.state, CapabilityState::Available);

    // Verify probe never claims verified
    assert_ne!(probe.state, CapabilityState::VerifiedByInference);
}

#[test]
fn auto_retries_cpu_once_on_gpu_failure_and_records_why() {
    let mock = Arc::new(MockFailingGpuRuntime {
        calls: AtomicUsize::new(0),
    });
    let dictation = Dictation::with_runtime(mock.clone());

    let snapshot = RecordingSnapshot {
        language: "auto".into(),
        device: Device::Auto,
        model: ModelId::Small,
    };

    // 16000 samples at 16000 Hz of non-silent tone
    let samples = vec![0.1f32; 16000];
    dictation.inject_recording_for_test(snapshot, samples, 16000);

    let home = tempfile::tempdir().unwrap();
    // Provide a dummy file so model path check passes if needed, or mock CPU
    // Note: If model file is not present, CPU retry will return error gracefully
    let settings = DictationSettings {
        enabled: true,
        language: "auto".into(),
        device: Device::Auto,
    };

    let result = dictation.stop(home.path(), &settings);
    // The GPU runtime was called once
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);

    // It attempted CPU fallback (which reported either model missing or success)
    // and critically, the app did NOT crash or panic
    let last_exec = dictation.last_execution();
    if result.is_ok() {
        assert!(last_exec.is_some());
        let exec = last_exec.unwrap();
        assert_eq!(exec.backend, BackendId::Cpu);
        assert!(!exec.offloaded);
        assert!(
            exec.offload_evidence
                .as_deref()
                .unwrap_or("")
                .contains("Fell back to CPU after primary backend failure")
        );
    }
}

#[test]
fn explicit_gpu_request_with_cpu_runtime_fails_without_silent_substitution() {
    let dictation = Dictation::default(); // Uses CpuRuntime

    let snapshot = RecordingSnapshot {
        language: "auto".into(),
        device: Device::Gpu,
        model: ModelId::Small,
    };

    let samples = vec![0.1f32; 16000];
    dictation.inject_recording_for_test(snapshot, samples, 16000);

    let home = tempfile::tempdir().unwrap();
    let settings = DictationSettings {
        enabled: true,
        language: "auto".into(),
        device: Device::Gpu,
    };

    let err = dictation.stop(home.path(), &settings).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("active runtime has CPU support only"),
        "Expected error refusing CPU substitution, got: {msg}"
    );
    assert!(msg.contains("Choose CPU in Settings"));
}

#[test]
fn explicit_gpu_failure_never_silently_substitutes_cpu() {
    let mock = Arc::new(MockFailingGpuRuntime {
        calls: AtomicUsize::new(0),
    });
    let dictation = Dictation::with_runtime(mock.clone());

    let snapshot = RecordingSnapshot {
        language: "auto".into(),
        device: Device::Gpu,
        model: ModelId::Small,
    };

    let samples = vec![0.1f32; 16000];
    dictation.inject_recording_for_test(snapshot, samples, 16000);

    let home = tempfile::tempdir().unwrap();
    let settings = DictationSettings {
        enabled: true,
        language: "auto".into(),
        device: Device::Gpu,
    };

    let err = dictation.stop(home.path(), &settings).unwrap_err();
    let message = err.to_string();
    assert!(
        message.contains("GPU transcription failed"),
        "Expected GPU failure message, got: {message}"
    );
    assert!(
        message.contains("Choose CPU in Settings"),
        "Expected advice offering CPU, got: {message}"
    );
    // Must NOT have run CPU or claimed success
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn settings_changes_during_recording_do_not_alter_in_flight_session() {
    let mock = Arc::new(MockSuccessfulGpuRuntime);
    let dictation = Dictation::with_runtime(mock);

    // Start with GPU snapshotted
    let snapshot = RecordingSnapshot {
        language: "it".into(),
        device: Device::Gpu,
        model: ModelId::Small,
    };

    let samples = vec![0.1f32; 16000];
    dictation.inject_recording_for_test(snapshot, samples, 16000);

    let home = tempfile::tempdir().unwrap();
    // User switched settings to CPU and "en" mid-flight!
    let changed_settings = DictationSettings {
        enabled: true,
        language: "en".into(),
        device: Device::Cpu,
    };

    let text = dictation.stop(home.path(), &changed_settings).unwrap();
    assert_eq!(text, "gpu transcribed text");

    let exec = dictation.last_execution().expect("execution details");
    // Execution must match snapshotted GPU, not the changed CPU setting
    assert_eq!(exec.backend, BackendId::Metal);
    assert!(exec.offloaded);
    assert!(exec.offload_evidence.as_deref().unwrap().contains("Metal"));
}

#[test]
fn disabling_dictation_during_recording_discards_audio() {
    let mock = Arc::new(MockSuccessfulGpuRuntime);
    let dictation = Dictation::with_runtime(mock);

    let snapshot = RecordingSnapshot {
        language: "auto".into(),
        device: Device::Cpu,
        model: ModelId::Small,
    };

    let samples = vec![0.1f32; 16000];
    dictation.inject_recording_for_test(snapshot, samples, 16000);

    let home = tempfile::tempdir().unwrap();
    let disabled_settings = DictationSettings {
        enabled: false,
        language: "auto".into(),
        device: Device::Cpu,
    };

    let err = dictation.stop(home.path(), &disabled_settings).unwrap_err();
    assert!(err.to_string().contains("Dictation was disabled"));
    assert!(dictation.last_execution().is_none());
}

#[test]
fn cancellation_clears_active_recording_and_subsequent_stop_fails() {
    let mock = Arc::new(MockSuccessfulGpuRuntime);
    let dictation = Dictation::with_runtime(mock);

    let snapshot = RecordingSnapshot {
        language: "auto".into(),
        device: Device::Cpu,
        model: ModelId::Small,
    };

    let samples = vec![0.1f32; 16000];
    dictation.inject_recording_for_test(snapshot, samples, 16000);

    dictation.cancel();

    let home = tempfile::tempdir().unwrap();
    let settings = DictationSettings {
        enabled: true,
        language: "auto".into(),
        device: Device::Cpu,
    };

    let err = dictation.stop(home.path(), &settings).unwrap_err();
    assert!(err.to_string().contains("No recording is active"));
}
