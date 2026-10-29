// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--dictation-benchmark-worker") {
        oxide_core::dictation::benchmark::worker_main();
        return;
    }
    oxide_app_lib::run()
}
