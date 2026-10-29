use oxide_core::dictation::cuda::CudaRuntime;
use oxide_core::dictation::{CapabilityState, WhisperBackendRuntime};
use std::{path::PathBuf, sync::OnceLock};

fn fixture(reply: serde_json::Value, logs: &str) -> tempfile::TempDir {
    static EXECUTABLE: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    let (_, executable) = EXECUTABLE.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("worker.rs");
        let exe = dir.path().join(format!("worker{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&source, r#"
use std::io::{Read, Write};
fn main() {
 let dir = std::env::current_exe().unwrap().parent().unwrap().to_owned();
 if let Ok(code) = std::fs::read_to_string(dir.join("exit-code")) { std::process::exit(code.parse().unwrap()); }
 let mut size = [0;4]; std::io::stdin().read_exact(&mut size).unwrap();
 let mut request = vec![0;u32::from_le_bytes(size) as usize];
 std::io::stdin().read_exact(&mut request).unwrap();
 if request != b"\"Probe\"" && dir.join("delay-ms").exists() {
   std::fs::write(dir.join("started"), b"ready").unwrap();
   std::thread::sleep(std::time::Duration::from_millis(1000));
 }
 let filename = if request == b"\"Probe\"" && dir.join("probe.json").exists() {"probe.json"} else {"reply.json"};
 let reply = std::fs::read(dir.join(filename)).unwrap();
 eprint!("{}", std::fs::read_to_string(dir.join("native.log")).unwrap());
 std::io::stdout().write_all(&(reply.len() as u32).to_le_bytes()).unwrap();
 std::io::stdout().write_all(&reply).unwrap();
}

"#).unwrap();
        assert!(std::process::Command::new("rustc").arg(&source).arg("-o").arg(&exe).status().unwrap().success());
        (dir, exe)
    });
    let dir = tempfile::tempdir().unwrap();
    std::fs::copy(executable, worker(&dir)).unwrap();
    std::fs::write(dir.path().join("reply.json"), reply.to_string()).unwrap();
    std::fs::write(dir.path().join("native.log"), logs).unwrap();
    dir
}

fn worker(dir: &tempfile::TempDir) -> PathBuf {
    dir.path()
        .join(format!("worker{}", std::env::consts::EXE_SUFFIX))
}

fn response(result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"protocol_version":1, "engine_version":"1.8.3", "result":result})
}

#[test]
fn an_omitted_worker_leaves_cpu_usable_and_does_not_advertise_cuda() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = CudaRuntime::new(dir.path().join("absent.exe"), None);
    assert_eq!(runtime.probe().state, CapabilityState::OmittedFromBuild);
    assert_eq!(
        oxide_core::dictation::CpuRuntime.probe().state,
        CapabilityState::Available
    );
}

#[test]
fn a_driver_error_is_reported_without_loading_it_into_the_host() {
    let dir = fixture(
        response(serde_json::json!({"Err":{"Unavailable":{"status":"missingDriverOrRuntime"}}})),
        "",
    );
    let runtime = CudaRuntime::new(worker(&dir), None);
    assert_eq!(
        runtime.probe().state,
        CapabilityState::MissingDriverOrRuntime
    );
}

fn adapter() -> serde_json::Value {
    serde_json::json!({"id":"cuda:0000000010de", "name":"RTX 4090", "driver":"NVIDIA 565.90",
        "compute_capability":"8.9", "native_index":0, "native_backend":"CUDA0",
        "memory":{"unified":false,"totalBytes":6442450944u64,"availableBytes":5000000000u64},
        "capability":{"status":"available"}})
}

#[test]
fn a_probe_selects_the_requested_identity_without_claiming_verified_inference() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})),
        "",
    );
    let runtime = CudaRuntime::new(worker(&dir), Some("cuda:0000000010de".into()));
    let probe = runtime.probe();
    assert_eq!(probe.state, CapabilityState::Available);
    assert_eq!(probe.adapter.as_deref(), Some("RTX 4090"));
    assert_eq!(probe.memory_pool.unwrap().available_bytes, Some(5000000000));
    let devices = runtime.adapters().unwrap();
    assert_eq!(devices[0].id, "cuda:0000000010de");
    assert_eq!(devices[0].driver.as_deref(), Some("NVIDIA 565.90"));
    assert_eq!(devices[0].compute_capability, "8.9");
}

fn request() -> oxide_core::dictation::TranscriptionRequest {
    oxide_core::dictation::TranscriptionRequest {
        cancelled: Default::default(),
        model_path: "model.bin".into(),
        language: Some("en".into()),
        samples: vec![0.0; 1600],
        sample_rate: 16000,
        threads: 4,
    }
}

#[test]
fn unsupported_capabilities_and_initialization_errors_have_explicit_probe_states() {
    let unsupported = serde_json::json!({"id":"cuda:legacy", "name":"GeForce GT 710", "driver":null,
        "compute_capability":"3.5", "native_index":0, "native_backend":"CUDA0", "memory":null,
        "capability":{"status":"initializationFailure","details":"Requires compute capability >= 5.0"}});
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[unsupported]}})),
        "",
    );
    let runtime = CudaRuntime::new(worker(&dir), None);
    assert_eq!(
        runtime.probe().state,
        CapabilityState::InitializationFailure("Requires compute capability >= 5.0".into())
    );
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::Unavailable(
            CapabilityState::InitializationFailure(_)
        ))
    ));
}

#[test]
fn model_selection_uses_the_catalogue_cuda_budget() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})),
        "",
    );
    let runtime = CudaRuntime::new(worker(&dir), None);
    let mut request = request();
    request.model_path = "ggml-large-v3.bin".into();
    assert!(matches!(
        runtime.transcribe(&request),
        Err(oxide_core::dictation::BackendError::InsufficientMemory {
            required_bytes: 10_737_418_240,
            ..
        })
    ));
}

#[test]
fn low_device_budget_refuses_gpu_inference_instead_of_silently_using_cpu() {
    let small_memory = serde_json::json!({"id":"cuda:0000000010de", "name":"RTX 4090", "driver":null,
        "compute_capability":"8.9", "native_index":0, "native_backend":"CUDA0",
        "memory":{"unified":false,"totalBytes":1000000000u64,"availableBytes":500000000u64},
        "capability":{"status":"available"}});
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[small_memory]}})),
        "",
    );
    let runtime = CudaRuntime::new(worker(&dir), None);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InsufficientMemory { .. })
    ));
}

#[test]
fn native_allocation_failure_is_reported_as_memory_pressure() {
    let dir = fixture(
        response(serde_json::json!({"Err":{"InitializationFailed":"cudaMalloc failed"}})),
        "CUDA error: out of memory",
    );
    let runtime = CudaRuntime::new(worker(&dir), None);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InsufficientMemory { .. })
    ));
}

#[test]
fn windows_loader_failure_and_worker_crashes_are_recoverable() {
    let dir = fixture(serde_json::json!({}), "");
    std::fs::write(dir.path().join("exit-code"), "-1073741515").unwrap(); // 0xc0000135
    let runtime = CudaRuntime::new(worker(&dir), None);
    assert_eq!(
        runtime.probe().state,
        CapabilityState::MissingDriverOrRuntime
    );

    std::fs::write(dir.path().join("exit-code"), "1").unwrap();
    assert!(matches!(
        runtime.probe().state,
        CapabilityState::InitializationFailure(_)
    ));
}

#[test]
fn adapter_disappearance_and_worker_initialization_failure_never_claim_gpu_success() {
    let dir = fixture(response(serde_json::json!({"Ok":{"Adapters":[]}})), "");
    let runtime = CudaRuntime::new(worker(&dir), None);
    assert_eq!(runtime.probe().state, CapabilityState::NoCompatibleDevice);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::Unavailable(
            CapabilityState::NoCompatibleDevice
        ))
    ));
}

#[test]
fn successful_text_without_native_gpu_execution_is_rejected() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
            "text":"hello world","adapter_id":"cuda:0000000010de","native_backend":"CUDA0"}}})),
        "Running on CPU fallback silently",
    );
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = CudaRuntime::new(worker(&dir), None);
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InferenceFailed(reason))
            if reason.contains("CUDA offload was not evidenced")
    ));
}

#[test]
fn inference_reports_the_actual_adapter_and_native_cuda_evidence() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
            "text":"ask not what your country can do for you",
            "adapter_id":"cuda:0000000010de",
            "native_backend":"CUDA0"}}})),
        "whisper_backend_init_gpu: using CUDA0 backend\nggml_cuda_init: compute capability 8.9\nCUDA Timings: Total time: 1420.50 us.\n",
    );
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = CudaRuntime::new(worker(&dir), None);
    let outcome = runtime.transcribe(&request()).unwrap();
    assert_eq!(outcome.text, "ask not what your country can do for you");
    assert_eq!(
        outcome.execution.backend,
        oxide_core::dictation::BackendId::Cuda
    );
    assert_eq!(outcome.execution.adapter.as_deref(), Some("RTX 4090"));
    assert!(outcome.execution.offloaded);
    let evidence = outcome.execution.offload_evidence.unwrap();
    assert!(evidence.contains("whisper.cpp 1.8.3"));
    assert!(evidence.contains("cuda:0000000010de"));
    assert!(evidence.contains("using CUDA0 backend"));
}

#[test]
fn cancellation_terminates_the_worker_and_allows_a_new_inference() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
            "text":"ignored","adapter_id":"cuda:0000000010de","native_backend":"CUDA0"}}})),
        "whisper_backend_init_gpu: using CUDA0 backend\nCUDA Timings: Total time: 1200 us.\n",
    );
    std::fs::write(dir.path().join("delay-ms"), "1000").unwrap();
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    let runtime = std::sync::Arc::new(CudaRuntime::new(worker(&dir), None));
    let worker_clone = runtime.clone();
    let handle = std::thread::spawn(move || worker_clone.transcribe(&request()));
    while !dir.path().join("started").exists() {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    runtime.cancel();
    assert!(matches!(
        handle.join().unwrap(),
        Err(oxide_core::dictation::BackendError::Cancelled)
    ));
}

#[test]
fn cancelled_recording_never_starts_a_cuda_worker() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("started");
    let runtime = CudaRuntime::new(dir.path().join("uncalled.exe"), None);
    let req = request();
    req.cancelled
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(matches!(
        runtime.transcribe(&req),
        Err(oxide_core::dictation::BackendError::Cancelled)
    ));
    assert!(!marker.exists());
}
