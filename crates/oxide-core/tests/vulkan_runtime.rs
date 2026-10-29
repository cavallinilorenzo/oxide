use oxide_core::dictation::vulkan::VulkanRuntime;
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
fn an_omitted_worker_leaves_cpu_usable_and_does_not_advertise_vulkan() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = VulkanRuntime::new(dir.path().join("absent.exe"), None);
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
    let runtime = VulkanRuntime::new(worker(&dir), None);
    assert_eq!(
        runtime.probe().state,
        CapabilityState::MissingDriverOrRuntime
    );
}

fn adapter() -> serde_json::Value {
    serde_json::json!({"id":"uuid:amd", "name":"RX 5600 XT", "driver":"AMD 26.10.1",
        "api_version":"1.4.315", "native_index":0, "native_backend":"Vulkan0",
        "memory":{"unified":false,"totalBytes":6442450944u64,"availableBytes":5000000000u64},
        "capability":{"status":"available"}})
}

#[test]
fn a_probe_selects_the_requested_identity_without_claiming_verified_inference() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})),
        "",
    );
    let runtime = VulkanRuntime::new(worker(&dir), Some("uuid:amd".into()));
    let probe = runtime.probe();
    assert_eq!(probe.state, CapabilityState::Available);
    assert_eq!(probe.adapter.as_deref(), Some("RX 5600 XT"));
    assert_eq!(probe.memory_pool.unwrap().available_bytes, Some(5000000000));
    let devices = runtime.adapters().unwrap();
    assert_eq!(devices[0].id, "uuid:amd");
    assert_eq!(devices[0].driver.as_deref(), Some("AMD 26.10.1"));
}

fn request() -> oxide_core::dictation::TranscriptionRequest {
    oxide_core::dictation::TranscriptionRequest {
        model_path: "model.bin".into(),
        language: None,
        samples: vec![0.1; 16000],
        sample_rate: 16000,
        threads: 2,
    }
}

#[test]
fn low_device_budget_refuses_gpu_inference_instead_of_silently_using_cpu() {
    let mut device = adapter();
    device["memory"]["availableBytes"] = serde_json::json!(1000000);
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[device]}})),
        "",
    );
    let runtime = VulkanRuntime::new(worker(&dir), Some("uuid:amd".into()));
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::InsufficientMemory { .. })
    ));
}

fn inference_fixture(logs: &str) -> tempfile::TempDir {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Transcription":{
        "text":"Hello world", "adapter_id":"uuid:amd", "native_backend":"Vulkan0"}}})),
        logs,
    );
    std::fs::write(
        dir.path().join("probe.json"),
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})).to_string(),
    )
    .unwrap();
    dir
}

#[test]
fn inference_reports_the_actual_adapter_and_native_gpu_timestamps() {
    let dir = inference_fixture(
        "whisper_backend_init_gpu: using Vulkan0 backend\nVulkan Timings:\nMUL_MAT: 1 x 500 us = 500 us\nTotal time: 500 us.\n",
    );
    let outcome = VulkanRuntime::new(worker(&dir), Some("uuid:amd".into()))
        .transcribe(&request())
        .unwrap();
    assert_eq!(outcome.text, "Hello world");
    assert!(outcome.execution.offloaded);
    assert_eq!(outcome.execution.adapter.as_deref(), Some("RX 5600 XT"));
    assert!(
        outcome
            .execution
            .offload_evidence
            .unwrap()
            .contains("Vulkan Timings")
    );
}

#[test]
fn successful_text_without_native_gpu_execution_is_rejected() {
    let dir = inference_fixture(
        "whisper_backend_init_gpu: using Vulkan0 backend\nwhisper_model_load: Vulkan0 total size = 486 MB\n",
    );
    let result = VulkanRuntime::new(worker(&dir), None).transcribe(&request());
    assert!(matches!(
        result,
        Err(oxide_core::dictation::BackendError::InferenceFailed(_))
    ));
}

#[test]
fn cancellation_terminates_the_worker_and_allows_a_new_inference() {
    let dir = inference_fixture(
        "whisper_backend_init_gpu: using Vulkan0 backend\nVulkan Timings:\nMUL_MAT: 1 x 500 us = 500 us\nTotal time: 500 us.\n",
    );
    std::fs::write(dir.path().join("delay-ms"), "1000").unwrap();
    let runtime = std::sync::Arc::new(VulkanRuntime::new(worker(&dir), None));
    let running = runtime.clone();
    let job = std::thread::spawn(move || running.transcribe(&request()));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !dir.path().join("started").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    runtime.cancel();
    assert!(matches!(
        job.join().unwrap(),
        Err(oxide_core::dictation::BackendError::Cancelled)
    ));
    std::fs::remove_file(dir.path().join("delay-ms")).unwrap();
    assert!(runtime.transcribe(&request()).unwrap().execution.offloaded);
}

#[test]
fn unsupported_capabilities_and_initialization_errors_have_explicit_probe_states() {
    let mut device = adapter();
    device["capability"] = serde_json::json!({"status":"initializationFailure","details":"Requires storageBuffer16BitAccess"});
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[device]}})),
        "",
    );
    let runtime = VulkanRuntime::new(worker(&dir), None);
    assert!(
        matches!(runtime.probe().state, CapabilityState::InitializationFailure(message) if message.contains("storageBuffer16BitAccess"))
    );
    assert!(runtime.transcribe(&request()).is_err());
}

#[test]
fn adapter_disappearance_and_worker_initialization_failure_never_claim_gpu_success() {
    let dir = inference_fixture("");
    std::fs::write(
        dir.path().join("reply.json"),
        response(serde_json::json!({"Err":{"Unavailable":{"status":"noCompatibleDevice"}}}))
            .to_string(),
    )
    .unwrap();
    let runtime = VulkanRuntime::new(worker(&dir), Some("uuid:amd".into()));
    assert!(matches!(
        runtime.transcribe(&request()),
        Err(oxide_core::dictation::BackendError::Unavailable(
            CapabilityState::NoCompatibleDevice
        ))
    ));
    std::fs::write(
        dir.path().join("reply.json"),
        response(serde_json::json!({"Err":{"InitializationFailed":"vkCreateDevice failed"}}))
            .to_string(),
    )
    .unwrap();
    assert!(
        matches!(runtime.transcribe(&request()), Err(oxide_core::dictation::BackendError::InitializationFailed(message)) if message.contains("vkCreateDevice"))
    );
    let removed = VulkanRuntime::new(worker(&dir), Some("uuid:removed".into()));
    assert_eq!(removed.probe().state, CapabilityState::NoCompatibleDevice);
}

#[cfg(windows)]
#[test]
fn windows_loader_failure_and_worker_crashes_are_recoverable() {
    let dir = fixture(
        response(serde_json::json!({"Ok":{"Adapters":[adapter()]}})),
        "",
    );
    let runtime = VulkanRuntime::new(worker(&dir), None);
    std::fs::write(dir.path().join("exit-code"), "-1073741515").unwrap();
    assert_eq!(
        runtime.probe().state,
        CapabilityState::MissingDriverOrRuntime
    );
    assert_eq!(
        oxide_core::dictation::CpuRuntime.probe().state,
        CapabilityState::Available
    );
    std::fs::write(dir.path().join("exit-code"), "3").unwrap();
    assert!(matches!(
        runtime.probe().state,
        CapabilityState::InitializationFailure(_)
    ));
    std::fs::remove_file(dir.path().join("exit-code")).unwrap();
    assert_eq!(runtime.probe().state, CapabilityState::Available);
}
