use oxide_core::dictation::benchmark::{BenchmarkResult, read_cache, store_result};
use oxide_core::dictation::benchmark::{Phase, measure};
use oxide_core::dictation::resources::*;
use oxide_core::dictation::{BackendId, ExecutionDetails, ModelId};
use std::time::Duration;

fn sample() -> BenchmarkResult {
    BenchmarkResult {
        dispatch: None,
        fixture_version: oxide_core::dictation::benchmark::FIXTURE_VERSION.into(),
        model: ModelId::Small,
        measurement: MeasuredPerformance {
            key: PerformanceKey::for_candidate(
                ModelId::Small,
                &BackendCandidate::cpu(),
                &CpuResources {
                    architecture: "x86_64".into(),
                    model: "Test CPU".into(),
                    usable_cores: 8,
                    instruction_compatible: Some(true),
                },
            ),
            recorded_at_secs: 100,
            audio_duration_ms: 11_000,
            warm_inference_ms: [3000, 4000, 5000],
            cold_load_ms: 9000,
        },
        execution: ExecutionDetails {
            fallback_reason: None,
            backend: BackendId::Cpu,
            adapter: Some("CPU".into()),
            offloaded: false,
            offload_evidence: None,
        },
    }
}

#[test]
fn cache_retains_only_current_fixture_and_proven_execution() {
    let home = tempfile::tempdir().unwrap();
    let good = sample();
    store_result(home.path(), &good).unwrap();
    assert_eq!(read_cache(home.path()).len(), 1);
    let mut fallback = sample();
    fallback.measurement.key.backend = BackendId::Vulkan;
    assert!(store_result(home.path(), &fallback).is_err());
    let mut old_fixture = sample();
    old_fixture.fixture_version = "old".into();
    assert!(store_result(home.path(), &old_fixture).is_err());
    assert_eq!(read_cache(home.path()).len(), 1);
    let mut gpu = sample();
    gpu.measurement.key.backend = BackendId::Vulkan;
    gpu.measurement.key.adapter_id = Some("gpu-1".into());
    gpu.measurement.key.driver_version = Some("driver-1".into());
    gpu.execution.backend = BackendId::Vulkan;
    gpu.execution.offloaded = true;
    assert!(store_result(home.path(), &gpu).is_err());
    gpu.execution.offload_evidence = Some("native kernel timestamps".into());
    store_result(home.path(), &gpu).unwrap();
    assert_eq!(read_cache(home.path()).len(), 2);
}

#[test]
fn a_failed_batch_does_not_publish_its_successful_first_combination() {
    let home = tempfile::tempdir().unwrap();
    let good = sample();
    let mut invalid = sample();
    invalid.fixture_version = "obsolete".into();
    assert!(
        oxide_core::dictation::benchmark::store_results(home.path(), &[good.clone(), invalid])
            .is_err()
    );
    assert!(read_cache(home.path()).is_empty());
    oxide_core::dictation::benchmark::store_results(home.path(), &[good]).unwrap();
    assert_eq!(read_cache(home.path()).len(), 1);
}

#[test]
fn corrupt_optional_artifact_is_skipped_without_discarding_the_selected_measurement() {
    struct VerifyingWorker;
    impl PerformanceWorker for VerifyingWorker {
        fn run(
            &self,
            home: &Path,
            model: ModelId,
            candidate: &BackendCandidate,
            cancelled: Arc<AtomicBool>,
            progress: &mut dyn FnMut(Phase),
        ) -> Result<BenchmarkResult, BackendError> {
            if std::fs::read(model_path(home, model)).unwrap() != b"abc" {
                return Err(BackendError::ModelUnavailable);
            }
            Worker {
                fail: false,
                cancel: false,
            }
            .run(home, model, candidate, cancelled, progress)
        }
    }
    let home = tempfile::tempdir().unwrap();
    let dictation = dictation(home.path());
    std::fs::write(model_path(home.path(), ModelId::Base), b"bad").unwrap();
    let results = dictation
        .check_performance(home.path(), &request(), &VerifyingWorker, |_| {})
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].model, ModelId::Small);
    assert_eq!(read_cache(home.path()).len(), 1);
}

#[test]
fn warmup_is_excluded_and_three_runs_report_the_median() {
    let mut times = [90_000, 9_000, 4_000, 3_000].into_iter();
    let mut phases = Vec::new();
    let timing = measure(
        10_000,
        12_000,
        || Ok(Duration::from_millis(times.next().unwrap())),
        |p| phases.push(p),
    )
    .unwrap();
    assert_eq!(timing.warm_inference_ms, [9_000, 4_000, 3_000]);
    assert_eq!(timing.median_rtf_milli(), 400);
    assert_eq!(timing.cold_load_ms, 12_000);
    assert_eq!(
        phases,
        [
            Phase::Warmup,
            Phase::Measuring { run: 1 },
            Phase::Measuring { run: 2 },
            Phase::Measuring { run: 3 }
        ]
    );
}

#[test]
fn fractional_milliseconds_do_not_cross_the_interactive_target() {
    let timing = measure(11_000, 0, || Ok(Duration::from_micros(5_500_100)), |_| {}).unwrap();
    assert_eq!(timing.median_rtf_milli(), 501);
}

use oxide_core::dictation::benchmark::{CheckRequest, PerformanceWorker, Progress};
use oxide_core::dictation::{
    BackendError, Dictation, DictationSettings, RecordingSnapshot, models::*,
};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

struct NoNetwork;
impl ModelSource for NoNetwork {
    fn available_space(&self, _: &Path) -> oxide_core::Result<u64> {
        panic!("no downloads")
    }
    fn open(
        &self,
        _: &ModelEntry,
        _: Arc<AtomicBool>,
    ) -> oxide_core::Result<Box<dyn std::io::Read + Send>> {
        panic!("no downloads")
    }
}
fn dictation(home: &Path) -> Dictation {
    let mut catalogue = catalogue().clone();
    for entry in &mut catalogue.models {
        entry.expected_bytes = 3;
        entry.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
    }
    std::fs::create_dir(home.join("models")).unwrap();
    for id in [ModelId::Small, ModelId::Base, ModelId::Medium] {
        std::fs::write(model_path(home, id), b"abc").unwrap();
    }
    Dictation::default()
        .with_models(Arc::new(ModelManager::with_source(
            catalogue,
            Arc::new(NoNetwork),
        )))
        .with_resources(Arc::new(|| ResourceSnapshot {
            captured_at_secs: now_secs(),
            cpu: sample().measurement.key.cpu,
            total_ram_bytes: Some(16 << 30),
            available_ram_bytes: Some(12 << 30),
            baseline_bytes: Some(1 << 29),
            free_disk_bytes: None,
        }))
}
struct Worker {
    fail: bool,
    cancel: bool,
}
impl PerformanceWorker for Worker {
    fn run(
        &self,
        _: &Path,
        model: ModelId,
        candidate: &BackendCandidate,
        cancelled: Arc<AtomicBool>,
        progress: &mut dyn FnMut(Phase),
    ) -> Result<BenchmarkResult, BackendError> {
        progress(Phase::Loading);
        if self.cancel {
            cancelled.store(true, Ordering::SeqCst);
            return Err(BackendError::Cancelled);
        }
        if self.fail {
            return Err(BackendError::InferenceFailed("backend failure".into()));
        }
        let mut result = sample();
        result.model = model;
        result.measurement.key =
            PerformanceKey::for_candidate(model, candidate, &result.measurement.key.cpu);
        result.measurement.recorded_at_secs = now_secs();
        Ok(result)
    }
}
fn request() -> CheckRequest {
    CheckRequest {
        model: ModelId::Small,
        backend: BackendId::Cpu,
        adapter_id: None,
        include_conservative_candidate: true,
    }
}

#[test]
fn explicit_check_is_bounded_to_selected_and_one_smaller_installed_model() {
    let home = tempfile::tempdir().unwrap();
    let dictation = dictation(home.path());
    let mut progress = Vec::<Progress>::new();
    let result = dictation
        .check_performance(
            home.path(),
            &request(),
            &Worker {
                fail: false,
                cancel: false,
            },
            |p| progress.push(p),
        )
        .unwrap();
    assert_eq!(
        result.iter().map(|r| r.model).collect::<Vec<_>>(),
        [ModelId::Small, ModelId::Base]
    );
    assert_eq!(progress.len(), 2);
    assert_eq!(read_cache(home.path()).len(), 2);
    assert!(dictation.last_execution().is_none());
}

#[test]
fn cancellation_and_busy_gate_do_not_leak_into_the_next_operation() {
    let home = tempfile::tempdir().unwrap();
    let dictation = dictation(home.path());
    let worker = Worker {
        fail: false,
        cancel: false,
    };
    let settings = DictationSettings {
        enabled: true,
        ..Default::default()
    };
    let prepared = dictation
        .prepare_recording(home.path(), || settings.clone())
        .unwrap();
    let mut prepared = Some(prepared);
    let result = dictation.check_performance(home.path(), &request(), &worker, |_| {
        assert!(
            dictation
                .check_performance(home.path(), &request(), &worker, |_| {})
                .is_err()
        );
        assert!(dictation.start_prepared(prepared.take().unwrap()).is_err());
        dictation.cancel_performance();
    });
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert!(read_cache(home.path()).is_empty());
    assert!(
        dictation
            .check_performance(home.path(), &request(), &worker, |_| {})
            .is_ok()
    );
    dictation.inject_recording_for_test(
        RecordingSnapshot {
            language: "en".into(),
            device: Default::default(),
            model: ModelId::Small,
            backend: None,
            adapter_id: None,
        },
        vec![],
        16000,
    );
    dictation.cancel_performance();
    assert_eq!(dictation.stop(home.path(), &settings).unwrap(), "");
}

#[test]
fn fixture_metadata_and_cache_corruption_never_produce_advice_from_invalid_data() {
    use sha2::{Digest, Sha256};
    let fixture = include_bytes!("fixtures/jfk.pcm");
    assert_eq!(fixture.len(), 352000);
    assert_eq!(
        format!("{:x}", Sha256::digest(fixture)),
        "a29462b8ebd467318000e683b9117ade46230d3255ed2024e7db894abd9b38c9"
    );
    let home = tempfile::tempdir().unwrap();
    for data in [b"not json".to_vec(), vec![b' '; 262145]] {
        std::fs::write(home.path().join("dictation-performance.json"), data).unwrap();
        assert!(read_cache(home.path()).is_empty());
    }
    let mut obsolete = sample();
    obsolete.fixture_version = "obsolete fixture".into();
    std::fs::write(
        home.path().join("dictation-performance.json"),
        serde_json::to_vec(&vec![obsolete]).unwrap(),
    )
    .unwrap();
    assert!(read_cache(home.path()).is_empty());
}

#[test]
fn failures_cancellation_missing_models_and_memory_pressure_leave_dictation_recoverable() {
    for failure in ["backend", "cancel", "missing", "memory", "recording"] {
        let home = tempfile::tempdir().unwrap();
        let mut dictation = dictation(home.path());
        if failure == "missing" {
            std::fs::remove_file(model_path(home.path(), ModelId::Small)).unwrap();
        }
        if failure == "memory" {
            dictation = dictation.with_resources(Arc::new(|| ResourceSnapshot {
                captured_at_secs: now_secs(),
                cpu: sample().measurement.key.cpu,
                total_ram_bytes: Some(16 << 30),
                available_ram_bytes: Some(1 << 30),
                baseline_bytes: None,
                free_disk_bytes: None,
            }));
        }
        if failure == "recording" {
            dictation.inject_recording_for_test(
                RecordingSnapshot {
                    language: "en".into(),
                    device: Default::default(),
                    model: ModelId::Small,
                    backend: None,
                    adapter_id: None,
                },
                vec![],
                16000,
            );
        }
        assert!(
            dictation
                .check_performance(
                    home.path(),
                    &request(),
                    &Worker {
                        fail: true,
                        cancel: failure == "cancel"
                    },
                    |_| {}
                )
                .is_err(),
            "{failure}"
        );
        assert!(read_cache(home.path()).is_empty());
        dictation.cancel();
        let settings = DictationSettings {
            enabled: true,
            model: ModelId::Base,
            ..Default::default()
        };
        dictation.configure(home.path(), &settings).unwrap();
        assert!(
            dictation
                .prepare_recording(home.path(), || settings.clone())
                .is_ok(),
            "{failure}"
        );
    }
}

fn process_fixture(
    candidate: &BackendCandidate,
    logs: &str,
    delay: bool,
) -> (
    tempfile::TempDir,
    oxide_core::dictation::benchmark::ProcessWorker,
) {
    use std::{path::PathBuf, sync::OnceLock};
    static EXECUTABLE: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    let (_, executable) = EXECUTABLE.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("worker.rs");
        let exe = dir.path().join(format!("worker{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&source, r##"
use std::io::{Read, Write};
fn main() {
    let dir = std::env::current_exe().unwrap().parent().unwrap().to_owned();
    let mut size = [0; 4]; std::io::stdin().read_exact(&mut size).unwrap();
    let mut request = vec![0; u32::from_le_bytes(size) as usize]; std::io::stdin().read_exact(&mut request).unwrap();
    let progress = br#"{"Progress":{"phase":"loading"}}"#;
    std::io::stdout().write_all(&(progress.len() as u32).to_le_bytes()).unwrap();
    std::io::stdout().write_all(progress).unwrap(); std::io::stdout().flush().unwrap();
    if dir.join("delay").exists() {
        std::thread::sleep(std::time::Duration::from_secs(3));
        std::fs::write(dir.join("survived"), b"leaked worker").unwrap();
    }
    eprint!("{}", std::fs::read_to_string(dir.join("native.log")).unwrap());
    let reply = std::fs::read(dir.join("reply.json")).unwrap();
    std::io::stdout().write_all(&(reply.len() as u32).to_le_bytes()).unwrap();
    std::io::stdout().write_all(&reply).unwrap();
}
"##).unwrap();
        assert!(std::process::Command::new("rustc").arg(&source).arg("-o").arg(&exe).status().unwrap().success());
        (dir, exe)
    });
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join(executable.file_name().unwrap());
    std::fs::copy(executable, &exe).unwrap();
    let reply = serde_json::json!({"Finished":{"Ok":{
        "candidate":candidate, "native_backend":match candidate.probe.backend { BackendId::Cuda => "CUDA0", BackendId::Metal => "Metal", _ => "Vulkan0" }, "cpu":sample().measurement.key.cpu,
        "timing":{"audioDurationMs":11000,"coldLoadMs":12000,"warmInferenceMs":[9000,4000,3000]}
    }}});
    std::fs::write(dir.path().join("reply.json"), reply.to_string()).unwrap();
    std::fs::write(dir.path().join("native.log"), logs).unwrap();
    if delay {
        std::fs::write(dir.path().join("delay"), b"").unwrap();
    }
    let worker =
        oxide_core::dictation::benchmark::ProcessWorker::new(exe.clone(), exe.clone(), exe);
    (dir, worker)
}

#[test]
fn gpu_process_measurements_require_actual_native_execution_and_matching_driver() {
    let mut candidate = BackendCandidate::cpu();
    candidate.probe.backend = BackendId::Vulkan;
    candidate.adapter_id = Some("uuid:amd".into());
    candidate.driver_version = Some("driver-1".into());
    for (logs, accepted) in [
        ("", false),
        ("whisper_backend_init_gpu: using Vulkan0 backend", false),
        (
            "whisper_backend_init_gpu: using Vulkan0 backend\nVulkan Timings:\nMUL_MAT\nTotal time: 2000 us.",
            true,
        ),
    ] {
        let (dir, worker) = process_fixture(&candidate, logs, false);
        let result = worker.run(
            dir.path(),
            ModelId::Small,
            &candidate,
            Default::default(),
            &mut |_| {},
        );
        assert_eq!(result.is_ok(), accepted, "{result:?}");
        if let Ok(result) = result {
            assert_eq!(result.measurement.warm_inference_ms, [9000, 4000, 3000]);
            assert_eq!(result.execution.backend, BackendId::Vulkan);
            assert!(result.execution.offloaded);
        }
        let mut changed = candidate.clone();
        changed.driver_version = Some("driver-2".into());
        assert!(
            worker
                .run(
                    dir.path(),
                    ModelId::Small,
                    &changed,
                    Default::default(),
                    &mut |_| {}
                )
                .is_err()
        );
    }
}

#[test]
fn cuda_and_metal_initialization_and_allocation_never_prove_gpu_execution() {
    for (backend, native) in [(BackendId::Cuda, "CUDA0"), (BackendId::Metal, "Metal")] {
        let mut candidate = BackendCandidate::cpu();
        candidate.probe.backend = backend;
        candidate.adapter_id = Some("gpu".into());
        candidate.driver_version = Some("driver".into());
        let logs = format!(
            "whisper_backend_init_gpu: using {native} backend\ncompute buffer (encode) = 100 MB\n"
        );
        let (dir, worker) = process_fixture(&candidate, &logs, false);
        assert!(
            worker
                .run(
                    dir.path(),
                    ModelId::Small,
                    &candidate,
                    Default::default(),
                    &mut |_| {}
                )
                .is_err()
        );
    }
}

#[test]
fn process_timeout_and_cancellation_reap_native_worker() {
    let candidate = BackendCandidate::cpu();
    for cancel in [false, true] {
        let (dir, worker) = process_fixture(&candidate, "", true);
        let worker = worker.with_timeout(if cancel {
            Duration::from_secs(2)
        } else {
            Duration::from_millis(200)
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let started = std::time::Instant::now();
        let result = worker.run(
            dir.path(),
            ModelId::Small,
            &candidate,
            cancelled.clone(),
            &mut |_| {
                if cancel {
                    cancelled.store(true, Ordering::SeqCst);
                }
            },
        );
        if cancel {
            assert_eq!(result.unwrap_err(), BackendError::Cancelled);
        } else {
            assert!(result.unwrap_err().to_string().contains("timed out"));
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!dir.path().join("survived").exists());
    }
}

#[test]
fn cuda_and_metal_completed_dispatches_enable_keyed_measurements() {
    for (backend, native) in [(BackendId::Cuda, "CUDA0"), (BackendId::Metal, "Metal")] {
        let mut candidate = BackendCandidate::cpu();
        candidate.probe.backend = backend;
        candidate.probe.adapter = Some("Test GPU".into());
        candidate.adapter_id = Some("stable-gpu".into());
        candidate.driver_version = Some("driver-1".into());
        candidate.runtime_version = runtime_version(backend);
        let (dir, worker) = process_fixture(&candidate, "", false);
        add_dispatch_reply(dir.path(), backend, native);
        let result = worker
            .run(
                dir.path(),
                ModelId::Small,
                &candidate,
                Default::default(),
                &mut |_| {},
            )
            .unwrap();
        assert_eq!(
            result.measurement.key,
            PerformanceKey::for_candidate(
                ModelId::Small,
                &candidate,
                &sample().measurement.key.cpu
            )
        );
        assert!(result.execution.offloaded);
        store_result(dir.path(), &result).unwrap();
        let cached = read_cache(dir.path());
        assert_eq!(cached.len(), 1);
        let mut candidate = candidate.clone();
        candidate.probe.memory_pool = Some(oxide_core::dictation::MemoryPool {
            unified: backend == BackendId::Metal,
            total_bytes: 16 << 30,
            available_bytes: Some(12 << 30),
            max_working_set_bytes: Some(12 << 30),
        });
        let resources = ResourceSnapshot {
            captured_at_secs: now_secs(),
            cpu: sample().measurement.key.cpu,
            total_ram_bytes: Some(16 << 30),
            available_ram_bytes: Some(12 << 30),
            baseline_bytes: Some(1 << 29),
            free_disk_bytes: None,
        };
        let advice = recommend(
            &resources,
            &[candidate],
            &[ModelId::Small],
            Preference::Balanced,
            &[cached[0].measurement.clone()],
            now_secs(),
        );
        let small = advice
            .decisions
            .iter()
            .find(|d| d.model == ModelId::Small)
            .unwrap();
        assert!(!small.provisional);
        assert_eq!(small.median_rtf_milli, Some(364));
        // Cache reads revalidate typed evidence; a human-readable proof alone
        // cannot turn an old or damaged CUDA/Metal entry into measured advice.
        for run in 0..4 {
            let mut damaged = cached[0].clone();
            damaged.dispatch.as_mut().unwrap().runs[run].completed_graphs = 0;
            assert!(store_result(dir.path(), &damaged).is_err());
            std::fs::write(
                dir.path().join("dictation-performance.json"),
                serde_json::to_vec(&[damaged]).unwrap(),
            )
            .unwrap();
            assert!(read_cache(dir.path()).is_empty());
        }
    }
}

fn add_dispatch_reply(dir: &Path, backend: BackendId, native: &str) {
    let path = dir.join("reply.json");
    let mut reply: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    reply["Finished"]["Ok"]["dispatch"] = serde_json::json!({
        "revision": "whisper-1.8.3-ggml-abi2-dispatch-v1",
        "backend": backend,
        "adapterId": "stable-gpu",
        "nativeBackend": native,
        "deviceId": if backend == BackendId::Cuda { Some("0000:01:00.0") } else { None },
        "runs": ([0, 1, 2, 3].map(|_| serde_json::json!({
            "nativeBackend": native, "adapter": "Test GPU",
            "deviceId": if backend == BackendId::Cuda { Some("0000:01:00.0") } else { None },
            "completedGraphs": 12, "matrixOps": 40, "failures": 0
        })))
    });
    std::fs::write(path, reply.to_string()).unwrap();
}

#[test]
fn cached_gpu_evidence_cannot_describe_a_cpu_fallback() {
    use oxide_core::dictation::benchmark::{DISPATCH_REVISION, DispatchEvidence, DispatchRun};
    let mut result = sample();
    result.measurement.key.backend = BackendId::Metal;
    result.measurement.key.adapter_id = Some("gpu".into());
    result.measurement.key.driver_version = Some("driver".into());
    result.execution.backend = BackendId::Metal;
    result.execution.adapter = Some("Test GPU".into());
    result.execution.offloaded = true;
    result.execution.offload_evidence = Some("completed native dispatches".into());
    result.dispatch = Some(DispatchEvidence {
        revision: DISPATCH_REVISION.into(),
        backend: BackendId::Metal,
        adapter_id: "gpu".into(),
        native_backend: "Metal".into(),
        device_id: None,
        runs: std::array::from_fn(|_| DispatchRun {
            native_backend: "Metal".into(),
            adapter: "Test GPU".into(),
            device_id: None,
            completed_graphs: 1,
            matrix_ops: 1,
            failures: 0,
        }),
    });
    assert!(result.validate().is_ok());
    result.execution.fallback_reason = Some("GPU initialization failed; using CPU".into());
    assert!(result.validate().is_err());
}

#[test]
fn every_gpu_run_requires_completed_dispatch_and_matching_native_identity() {
    for (backend, native) in [(BackendId::Cuda, "CUDA0"), (BackendId::Metal, "Metal")] {
        let mut candidate = BackendCandidate::cpu();
        candidate.probe.backend = backend;
        candidate.probe.adapter = Some("Test GPU".into());
        candidate.adapter_id = Some("stable-gpu".into());
        candidate.driver_version = Some("driver-1".into());
        candidate.runtime_version = runtime_version(backend);
        for run in 0..4 {
            for (field, value) in [
                ("completedGraphs", serde_json::json!(0)),
                ("matrixOps", serde_json::json!(0)),
                ("failures", serde_json::json!(1)),
                ("nativeBackend", serde_json::json!("CPU")),
                ("adapter", serde_json::json!("another GPU")),
                ("deviceId", serde_json::json!("0000:ff:00.0")),
            ] {
                let (dir, worker) = process_fixture(&candidate, "", false);
                add_dispatch_reply(dir.path(), backend, native);
                let path = dir.path().join("reply.json");
                let mut reply: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                reply["Finished"]["Ok"]["dispatch"]["runs"][run][field] = value;
                std::fs::write(path, reply.to_string()).unwrap();
                assert!(
                    worker
                        .run(
                            dir.path(),
                            ModelId::Small,
                            &candidate,
                            Default::default(),
                            &mut |_| {}
                        )
                        .is_err(),
                    "{backend} run {run}: {field}"
                );
                assert!(read_cache(dir.path()).is_empty());
            }
        }
        for invalid in [
            "initialization",
            "fallback",
            "adapter",
            "native",
            "revision",
            "missingRun",
        ] {
            let (dir, worker) = process_fixture(&candidate, "", false);
            add_dispatch_reply(dir.path(), backend, native);
            let path = dir.path().join("reply.json");
            let mut reply: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let observed = &mut reply["Finished"]["Ok"];
            match invalid {
                "initialization" => {
                    reply = serde_json::json!({"Finished":{"Err":{"InitializationFailed":"GPU initialization failed"}}})
                }
                "fallback" => observed["candidate"]["probe"]["backend"] = serde_json::json!("cpu"),
                "adapter" => observed["dispatch"]["adapterId"] = serde_json::json!("another-uuid"),
                "native" => observed["native_backend"] = serde_json::json!("CPU"),
                "revision" => observed["dispatch"]["revision"] = serde_json::json!("obsolete"),
                "missingRun" => {
                    observed["dispatch"]["runs"].as_array_mut().unwrap().pop();
                }
                _ => unreachable!(),
            }
            std::fs::write(path, reply.to_string()).unwrap();
            assert!(
                worker
                    .run(
                        dir.path(),
                        ModelId::Small,
                        &candidate,
                        Default::default(),
                        &mut |_| {}
                    )
                    .is_err(),
                "{backend}: {invalid}"
            );
        }
    }
}
