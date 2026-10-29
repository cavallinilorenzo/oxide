//! Explicit offline smoke: cargo run -p oxide-core --example dictation_benchmark -- HOME [cpu|vulkan|cuda|metal] [WORKER] [ADAPTER_ID]
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
            .expect("provide a home containing an installed Small model; no downloads"),
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
    let process = ProcessWorker::new(std::env::current_exe().unwrap(), worker.clone(), worker);
    let result = Dictation::default()
        .check_performance(
            &home,
            &CheckRequest {
                model: ModelId::Small,
                backend,
                adapter_id: args.get(3).cloned(),
                include_conservative_candidate: false,
            },
            &process,
            |p| eprintln!("{} · {} · {:?}", p.model, p.backend, p.phase),
        )
        .expect("local performance check");
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
