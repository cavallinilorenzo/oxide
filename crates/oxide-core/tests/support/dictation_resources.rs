use oxide_core::dictation::resources::{
    CpuResources, ResourceProvider, ResourceSnapshot, now_secs,
};
use std::sync::Arc;

// Fake workers do not allocate Whisper contexts. Keep their host budget independent
// of concurrent builds or the machine running the protocol/evidence contract tests.
pub fn host_resources(available_ram_bytes: u64) -> ResourceProvider {
    Arc::new(move |_| ResourceSnapshot {
        captured_at_secs: now_secs(),
        cpu: CpuResources {
            architecture: "aarch64".into(),
            model: "Fixture CPU".into(),
            usable_cores: 4,
            instruction_compatible: Some(true),
        },
        total_ram_bytes: Some(8 << 30),
        available_ram_bytes: Some(available_ram_bytes),
        baseline_bytes: Some(1 << 29),
        free_disk_bytes: None,
    })
}
