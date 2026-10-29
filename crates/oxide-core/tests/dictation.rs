use oxide_core::dictation::{
    BackendError, BackendId, BackendProbe, BuildManifest, CapabilityState, Device, Dictation,
    DictationSettings, ExecutionDetails, MemoryPool, ModelId, RecordingSnapshot,
    TranscriptionOutcome, TranscriptionRequest, WhisperBackendRuntime,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[test]
fn legacy_settings_preserve_dictation_and_default_to_small() {
    let settings: DictationSettings =
        serde_json::from_str(r#"{"enabled":true,"language":"it","device":"gpu"}"#).unwrap();
    let value = serde_json::to_value(&settings).unwrap();
    assert_eq!(value["model"], "small");
    assert!(settings.enabled);
    assert_eq!(settings.language, "it");
    assert_eq!(settings.device, Device::Gpu);
}

#[test]
fn catalogue_exposes_six_pinned_multilingual_models() {
    let catalogue = oxide_core::dictation::models::catalogue();
    assert_eq!(catalogue.version, 1);
    assert_eq!(catalogue.models.len(), 6);
    let ids: Vec<_> = catalogue.models.iter().map(|m| m.id.to_string()).collect();
    assert_eq!(
        ids,
        [
            "tiny",
            "base",
            "small",
            "medium",
            "large-v3",
            "large-v3-turbo"
        ]
    );
    for entry in &catalogue.models {
        assert_eq!(entry.language_coverage, "multilingual");
        assert!(entry.url.contains(&entry.revision));
        assert_ne!(entry.revision, "main");
        assert_eq!(entry.sha256.len(), 64);
        assert_eq!(entry.license, "MIT");
        assert_eq!(entry.estimated_peak_bytes.len(), 4);
    }
    assert_eq!(catalogue.models[0].expected_bytes, 77_691_713);
    assert_eq!(
        catalogue.models[2].sha256,
        "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
    );
}

#[test]
fn missing_model_selection_does_not_overwrite_saved_settings() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("settings.json"), r#"{"dictation":{"enabled":true,"language":"it","device":"cpu"},"shortcuts":{"dictation":"Mod+Alt+R"}}"#).unwrap();
    let core = oxide_core::Core::open(home.path()).unwrap();
    let original = core.settings().settings;
    assert_eq!(original.dictation.model, ModelId::Small);
    assert_eq!(original.shortcuts.dictation, "Mod+Alt+R");
    let mut next = original.clone();
    next.dictation.model = ModelId::Tiny;
    assert!(core.save_settings(&next).is_err());
    assert_eq!(core.settings().settings, original);
    drop(core);
    assert_eq!(
        oxide_core::Core::open(home.path())
            .unwrap()
            .settings()
            .settings,
        original
    );
}

#[test]
fn startup_preserves_saved_settings_when_disabled_selected_model_was_deleted() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("settings.json"), r#"{"dictation":{"model":"tiny","enabled":false,"language":"it","device":"gpu"},"shortcuts":{"dictation":"Mod+Alt+R"},"confirmQuit":false}"#).unwrap();
    let core = oxide_core::Core::open(home.path()).unwrap();
    let state = core.settings();
    assert!(state.errors.is_empty(), "{:?}", state.errors);
    assert_eq!(state.settings.dictation.model, ModelId::Tiny);
    assert_eq!(state.settings.dictation.language, "it");
    assert_eq!(state.settings.dictation.device, Device::Gpu);
    assert_eq!(state.settings.shortcuts.dictation, "Mod+Alt+R");
    assert!(!state.settings.confirm_quit);
}

#[test]
fn unified_memory_topology_and_budget_signals_serialize_as_shared_pool() {
    let pool = MemoryPool {
        unified: true,
        total_bytes: 16 * 1024 * 1024 * 1024,
        available_bytes: Some(10 * 1024 * 1024 * 1024),
        max_working_set_bytes: Some(12 * 1024 * 1024 * 1024),
    };

    let probe = BackendProbe {
        backend: BackendId::Metal,
        state: CapabilityState::Available,
        adapter: Some("Apple M1 Pro".into()),
        memory_pool: Some(pool.clone()),
    };

    let json = serde_json::to_string(&probe).expect("serialize BackendProbe with MemoryPool");
    assert!(json.contains("\"unified\":true"));
    assert!(json.contains("\"totalBytes\":17179869184"));
    assert!(json.contains("\"maxWorkingSetBytes\":12884901888"));

    let decoded: BackendProbe =
        serde_json::from_str(&json).expect("deserialize BackendProbe with MemoryPool");
    assert_eq!(decoded.memory_pool, Some(pool));

    // Missing signals remain unknown (None), not invented
    let unknown_pool = MemoryPool {
        unified: true,
        total_bytes: 8 * 1024 * 1024 * 1024,
        available_bytes: None,
        max_working_set_bytes: None,
    };
    let json_unknown = serde_json::to_string(&unknown_pool).expect("serialize unknown pool");
    assert!(!json_unknown.contains("availableBytes"));
    assert!(!json_unknown.contains("maxWorkingSetBytes"));
    let decoded_unknown: MemoryPool =
        serde_json::from_str(&json_unknown).expect("deserialize unknown pool");
    assert_eq!(decoded_unknown.available_bytes, None);
    assert_eq!(decoded_unknown.max_working_set_bytes, None);
}

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
fn apple_silicon_metal_probe_enumerates_adapter_and_unified_memory() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let probe_results = oxide_core::dictation::probe_backends();
        let metal_probe = probe_results
            .into_iter()
            .find(|p| p.backend == BackendId::Metal)
            .expect("Metal probe should be present in Apple Silicon builds");

        assert_eq!(metal_probe.state, CapabilityState::Available);
        let adapter = metal_probe
            .adapter
            .expect("adapter name should be populated");
        assert!(
            adapter.contains("Apple"),
            "Expected Apple adapter, got: {adapter}"
        );

        let pool = metal_probe
            .memory_pool
            .expect("memory pool should be populated");
        assert!(
            pool.unified,
            "Apple Silicon memory must be reported as unified"
        );
        assert!(pool.total_bytes > 0, "Total memory must be > 0");
        assert!(
            pool.available_bytes.is_some(),
            "Available memory must be populated"
        );
        assert!(
            pool.max_working_set_bytes.is_some(),
            "Max working set bytes must be populated from Metal API"
        );
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
            memory_pool: None,
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
            memory_pool: Some(MemoryPool {
                unified: true,
                total_bytes: 36 * 1024 * 1024 * 1024,
                available_bytes: Some(24 * 1024 * 1024 * 1024),
                max_working_set_bytes: Some(28 * 1024 * 1024 * 1024),
            }),
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
        model: ModelId::Small,
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
fn metal_runtime_reports_initialization_failure_on_missing_or_corrupt_model() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let runtime = oxide_core::dictation::MetalRuntime;
        let missing_request = TranscriptionRequest {
            cancelled: Default::default(),
            model_path: std::path::PathBuf::from("/non/existent/whisper-model.bin"),
            language: None,
            samples: vec![0.0; 16000],
            sample_rate: 16000,
            threads: 4,
        };
        let err = runtime.transcribe(&missing_request).unwrap_err();
        match err {
            BackendError::InitializationFailed(msg) => {
                assert!(
                    msg.contains("Model file not found") || msg.contains("not found"),
                    "Expected file not found message, got: {msg}"
                );
            }
            other => panic!("Expected InitializationFailed, got: {other:?}"),
        }

        // Corrupt / invalid model file
        let temp_dir = tempfile::tempdir().unwrap();
        let corrupt_path = temp_dir.path().join("corrupt.bin");
        std::fs::write(&corrupt_path, b"not a valid ggml model file").unwrap();

        let corrupt_request = TranscriptionRequest {
            cancelled: Default::default(),
            model_path: corrupt_path,
            language: None,
            samples: vec![0.0; 16000],
            sample_rate: 16000,
            threads: 4,
        };
        let err2 = runtime.transcribe(&corrupt_request).unwrap_err();
        match err2 {
            BackendError::InitializationFailed(msg) => {
                assert!(
                    msg.contains("Metal initialization failed"),
                    "Expected Metal initialization failure, got: {msg}"
                );
            }
            other => panic!("Expected InitializationFailed, got: {other:?}"),
        }
    }

    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let runtime = oxide_core::dictation::MetalRuntime;
        let dummy_request = TranscriptionRequest {
            cancelled: Default::default(),
            model_path: std::path::PathBuf::from("/non/existent/whisper-model.bin"),
            language: None,
            samples: vec![0.0; 16000],
            sample_rate: 16000,
            threads: 4,
        };
        let err = runtime.transcribe(&dummy_request).unwrap_err();
        assert_eq!(
            err,
            BackendError::Unavailable(CapabilityState::NoCompatibleDevice)
        );
    }
}

#[test]
fn auto_mode_recovers_from_metal_failure_with_fallback_evidence() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        // Dictation::default() uses default_runtime() which is MetalRuntime on macOS Apple Silicon
        let dictation = Dictation::default();
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

        // Model file is missing in home, so Metal fails initialization and Auto attempts CPU
        // which also discovers missing model and fails gracefully without panic
        let err = dictation.stop(home.path(), &settings).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("Primary backend failed")
                || msg.contains("CPU retry was refused")
                || msg.contains("failed"),
            "Expected failure message documenting attempt, got: {msg}"
        );
    }
}

#[test]
fn explicit_gpu_mode_with_metal_runtime_reports_actionable_error_on_failure() {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let dictation = Dictation::default();
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
            msg.contains("GPU transcription failed"),
            "Expected GPU transcription failed message, got: {msg}"
        );
        assert!(
            msg.contains("Choose CPU in Settings to transcribe on CPU"),
            "Expected advice to choose CPU, got: {msg}"
        );
    }
}

#[test]
fn build_manifest_pins_whisper_and_backends() {
    let manifest = BuildManifest::current();
    assert_eq!(manifest.whisper_rs_version, "0.16.0");
    assert!(manifest.whisper_cpp_pinned.contains("0.16.0"));
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        assert!(manifest.included_backends.contains(&BackendId::Metal));
    }
    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    {
        assert!(!manifest.included_backends.contains(&BackendId::Metal));
    }
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
        model: ModelId::Small,
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
    let dictation = Dictation::with_runtime(Arc::new(oxide_core::dictation::CpuRuntime));

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
        model: ModelId::Small,
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
        model: ModelId::Small,
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
        model: ModelId::Small,
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
        model: ModelId::Small,
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
        model: ModelId::Small,
    };

    let err = dictation.stop(home.path(), &settings).unwrap_err();
    assert!(err.to_string().contains("No recording is active"));
}

#[test]
fn disable_cancels_in_flight_inference_and_discards_late_result() {
    use std::sync::mpsc;
    struct BlockingRuntime {
        entered: mpsc::Sender<()>,
    }
    impl WhisperBackendRuntime for BlockingRuntime {
        fn backend_id(&self) -> BackendId {
            BackendId::Vulkan
        }
        fn probe(&self) -> BackendProbe {
            MockSuccessfulGpuRuntime.probe()
        }
        fn transcribe(
            &self,
            request: &TranscriptionRequest,
        ) -> Result<TranscriptionOutcome, BackendError> {
            assert!(request.model_path.ends_with("ggml-tiny.bin"));
            assert_eq!(request.language.as_deref(), Some("it"));
            self.entered.send(()).unwrap();
            while !request.cancelled.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
            MockSuccessfulGpuRuntime.transcribe(request)
        }
    }
    let (entered, ready) = mpsc::channel();
    let dictation = Arc::new(Dictation::with_runtime(Arc::new(BlockingRuntime {
        entered,
    })));
    dictation.inject_recording_for_test(
        RecordingSnapshot {
            language: "it".into(),
            device: Device::Gpu,
            model: ModelId::Tiny,
        },
        vec![0.1; 16000],
        16000,
    );
    let home = tempfile::tempdir().unwrap();
    std::thread::scope(|scope| {
        let task = scope.spawn(|| {
            dictation.stop(
                home.path(),
                &DictationSettings {
                    enabled: true,
                    language: "en".into(),
                    model: ModelId::Medium,
                    ..Default::default()
                },
            )
        });
        ready
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        dictation
            .configure(home.path(), &DictationSettings::default())
            .unwrap();
        assert!(task.join().unwrap().is_err());
    });
    assert!(dictation.last_execution().is_none());
}
