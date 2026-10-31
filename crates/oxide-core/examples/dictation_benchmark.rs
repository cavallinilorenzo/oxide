//! Explicit offline check: HOME [cpu|vulkan|cuda|metal] [WORKER] [ADAPTER_ID|-] [MODEL] [INSTALLED_HOST]
//! Use a release build with GGML_NATIVE=OFF when checking installed release binaries.
use oxide_core::dictation::{
    BackendId, Dictation, ModelId,
    benchmark::{CheckRequest, ProcessWorker},
};

fn main() {
    if std::env::args().any(|arg| arg == "--dictation-benchmark-worker") {
        oxide_core::dictation::benchmark::worker_main();
        return;
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    let home = std::path::PathBuf::from(
        args.first()
            .expect("provide a home containing installed models; no downloads"),
    );
    let backend = match args.get(1).map(String::as_str).unwrap_or("cpu") {
        "cpu" => BackendId::Cpu,
        "vulkan" => BackendId::Vulkan,
        "cuda" => BackendId::Cuda,
        "metal" => BackendId::Metal,
        _ => panic!("unknown backend"),
    };
    let worker = args
        .get(2)
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    let model = args
        .get(4)
        .map(|id| {
            serde_json::from_value::<ModelId>(serde_json::json!(id)).expect("catalogue model ID")
        })
        .unwrap_or(ModelId::Small);
    let host = args
        .get(5)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::current_exe().unwrap());
    let process = ProcessWorker::new(host, worker.clone(), worker);
    let adapter_id = args
        .get(3)
        .filter(|id| id.as_str() != "-")
        .cloned()
        .or_else(|| {
            if backend == BackendId::Metal {
                #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                {
                    oxide_core::dictation::WhisperBackendRuntime::probe(
                        &oxide_core::dictation::MetalRuntime,
                    )
                    .adapter
                }
                #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
                {
                    None
                }
            } else {
                None
            }
        });
    let result = Dictation::default()
        .check_performance(
            &home,
            &CheckRequest {
                model,
                backend,
                adapter_id,
                include_conservative_candidate: false,
            },
            &process,
            |p| eprintln!("{} · {} · {:?}", p.model, p.backend, p.phase),
        )
        .expect("local performance check");
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
