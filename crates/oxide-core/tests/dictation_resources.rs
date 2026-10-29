use oxide_core::dictation::resources::*;
use oxide_core::dictation::{BackendId, BackendProbe, CapabilityState, ModelId};

const GIB: u64 = 1 << 30;

fn cpu() -> BackendProbe {
    BackendProbe {
        backend: BackendId::Cpu,
        state: CapabilityState::Available,
        adapter: Some("CPU".into()),
        memory_pool: None,
    }
}

fn resources() -> ResourceSnapshot {
    ResourceSnapshot {
        captured_at_secs: 100,
        cpu: CpuResources {
            architecture: "x86_64".into(),
            model: "Test CPU".into(),
            usable_cores: 8,
            instruction_compatible: Some(true),
        },
        total_ram_bytes: Some(16 * GIB),
        available_ram_bytes: Some(8 * GIB),
        baseline_bytes: Some(GIB / 2),
        free_disk_bytes: Some(20 * GIB),
    }
}

#[test]
fn refreshed_memory_refuses_small_while_leaving_base_safe() {
    let mut snapshot = resources();
    assert!(assess_load(&snapshot, &cpu(), ModelId::Small, 100).is_ok());
    snapshot.available_ram_bytes = Some(4 * GIB);
    let refusal = assess_load(&snapshot, &cpu(), ModelId::Small, 100).unwrap_err();
    assert!(refusal.reason.contains("Free memory"));
    assert!(assess_load(&snapshot, &cpu(), ModelId::Base, 100).is_ok());
}

#[test]
fn dedicated_budgets_keep_twenty_percent_free_and_unified_memory_is_one_pool() {
    use oxide_core::dictation::MemoryPool;
    let mut snapshot = resources();
    let mut gpu = BackendProbe {
        backend: BackendId::Vulkan,
        state: CapabilityState::Available,
        adapter: Some("AMD RX 5600 XT".into()),
        memory_pool: Some(MemoryPool {
            unified: false,
            total_bytes: 6 * GIB,
            available_bytes: Some(2 * GIB),
            max_working_set_bytes: None,
        }),
    };
    assert!(assess_load(&snapshot, &gpu, ModelId::Small, 100).is_err());
    gpu.backend = BackendId::Cuda;
    gpu.adapter = Some("NVIDIA".into());
    gpu.memory_pool.as_mut().unwrap().available_bytes = Some(3 * GIB);
    assert!(assess_load(&snapshot, &gpu, ModelId::Small, 100).is_ok());
    gpu.backend = BackendId::Metal;
    gpu.memory_pool.as_mut().unwrap().unified = true;
    gpu.memory_pool.as_mut().unwrap().total_bytes = 16 * GIB;
    gpu.memory_pool.as_mut().unwrap().available_bytes = Some(8 * GIB);
    snapshot.available_ram_bytes = Some(4 * GIB);
    assert!(assess_load(&snapshot, &gpu, ModelId::Small, 100).is_err());
    snapshot.available_ram_bytes = Some(6 * GIB);
    assert!(assess_load(&snapshot, &gpu, ModelId::Small, 100).is_ok());
    gpu.memory_pool.as_mut().unwrap().available_bytes = Some(4 * GIB);
    assert!(assess_load(&snapshot, &gpu, ModelId::Small, 100).is_err());
}

#[test]
fn advice_is_conservative_provisional_and_quality_is_explicit() {
    let snapshot = resources();
    let candidates = vec![BackendCandidate::cpu()];
    let balanced = recommend(&snapshot, &candidates, &[], Preference::Balanced, &[], 100);
    let choice = &balanced.decisions[balanced.selected.unwrap()];
    assert_eq!(choice.model, ModelId::Base);
    assert_eq!(choice.confidence, Confidence::Low);
    assert!(choice.provisional);
    assert!(choice.reason.contains("Provisional"));
    let quality = recommend(&snapshot, &candidates, &[], Preference::Quality, &[], 100);
    assert_eq!(
        quality.decisions[quality.selected.unwrap()].model,
        ModelId::Small
    );
    assert_eq!(
        serde_json::to_value(&balanced).unwrap(),
        serde_json::to_value(recommend(
            &snapshot,
            &candidates,
            &[],
            Preference::Balanced,
            &[],
            100
        ))
        .unwrap()
    );
}

#[test]
fn unknown_stale_unsupported_and_disk_constrained_options_explain_the_next_action() {
    let mut snapshot = resources();
    let candidates = vec![BackendCandidate::cpu()];
    snapshot.available_ram_bytes = None;
    let report = recommend(&snapshot, &candidates, &[], Preference::Balanced, &[], 100);
    assert!(report.selected.is_none());
    assert!(
        report
            .decisions
            .iter()
            .all(|d| d.status == AdviceStatus::InsufficientData)
    );
    snapshot = resources();
    assert!(
        assess_load(&snapshot, &cpu(), ModelId::Base, 131)
            .unwrap_err()
            .reason
            .contains("stale")
    );
    snapshot.cpu.instruction_compatible = Some(false);
    assert!(
        !assess_load(&snapshot, &cpu(), ModelId::Tiny, 100)
            .unwrap_err()
            .insufficient_data
    );
    snapshot = resources();
    let mut unsupported = cpu();
    unsupported.backend = BackendId::Cuda;
    unsupported.state = CapabilityState::OmittedFromBuild;
    assert!(
        assess_load(&snapshot, &unsupported, ModelId::Tiny, 100)
            .unwrap_err()
            .reason
            .contains("unavailable")
    );
    snapshot.free_disk_bytes = Some(0);
    assert!(
        recommend(&snapshot, &candidates, &[], Preference::Balanced, &[], 100)
            .selected
            .is_none()
    );
    let offline = recommend(
        &snapshot,
        &candidates,
        &[ModelId::Small],
        Preference::Quality,
        &[],
        100,
    );
    assert_eq!(
        offline.decisions[offline.selected.unwrap()].model,
        ModelId::Small
    );
    snapshot.cpu.usable_cores = 2;
    snapshot.free_disk_bytes = Some(GIB);
    let limited = recommend(&snapshot, &candidates, &[], Preference::Quality, &[], 100);
    assert_eq!(
        limited.decisions[limited.selected.unwrap()].model,
        ModelId::Tiny
    );
}

#[test]
fn measured_advice_uses_three_warm_runs_and_rejects_stale_or_mismatched_identity() {
    let snapshot = resources();
    let candidates = vec![BackendCandidate::cpu()];
    let sample = MeasuredPerformance {
        key: PerformanceKey::for_candidate(ModelId::Small, &candidates[0]),
        recorded_at_secs: 100,
        audio_duration_ms: 10_000,
        warm_inference_ms: [9_000, 4_000, 3_000],
        cold_load_ms: 12_000,
    };
    let measured = recommend(
        &snapshot,
        &candidates,
        &[],
        Preference::Balanced,
        std::slice::from_ref(&sample),
        100,
    );
    let choice = &measured.decisions[measured.selected.unwrap()];
    assert_eq!(choice.model, ModelId::Small);
    assert!(!choice.provisional);
    assert_eq!(choice.confidence, Confidence::Medium);
    assert!(choice.reason.contains("0.400"));
    for change in ["driver", "hash", "runtime", "adapter", "stale"] {
        let mut stale = sample.clone();
        match change {
            "driver" => stale.key.driver_version = Some("old".into()),
            "hash" => stale.key.model_sha256 = "old".into(),
            "runtime" => stale.key.runtime_version = "old".into(),
            "adapter" => stale.key.adapter_id = Some("removed".into()),
            _ => stale.recorded_at_secs = 0,
        }
        let now = if change == "stale" {
            PERFORMANCE_MAX_AGE_SECS + 1
        } else {
            100
        };
        let mut fresh_resources = snapshot.clone();
        fresh_resources.captured_at_secs = now;
        let result = recommend(
            &fresh_resources,
            &candidates,
            &[],
            Preference::Balanced,
            &[stale],
            now,
        );
        assert!(result.decisions.iter().all(|d| d.provisional), "{change}");
    }
}

#[test]
fn gpu_unknown_budgets_and_unified_working_set_caps_block_native_loads() {
    use oxide_core::dictation::MemoryPool;
    let mut gpu = cpu();
    gpu.backend = BackendId::Metal;
    gpu.memory_pool = Some(MemoryPool {
        unified: true,
        total_bytes: 16 * GIB,
        available_bytes: None,
        max_working_set_bytes: Some(8 * GIB),
    });
    assert!(
        assess_load(&resources(), &gpu, ModelId::Small, 100)
            .unwrap_err()
            .insufficient_data
    );
    gpu.memory_pool.as_mut().unwrap().available_bytes = Some(8 * GIB);
    gpu.memory_pool.as_mut().unwrap().max_working_set_bytes = Some(GIB);
    assert!(
        !assess_load(&resources(), &gpu, ModelId::Small, 100)
            .unwrap_err()
            .insufficient_data
    );
}

#[test]
fn inspecting_resources_is_read_only_and_replaces_the_legacy_latency_claim() {
    let home = tempfile::tempdir().unwrap();
    let advice = inspect(home.path(), Preference::Balanced);
    assert!(!advice.resources.cpu.architecture.is_empty());
    assert!(
        advice
            .backends
            .iter()
            .any(|b| b.probe.backend == BackendId::Cpu)
    );
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    let status = oxide_core::dictation::status(home.path());
    assert!(
        status.recommendation.contains("Provisional")
            || status.recommendation.contains("Free")
            || status.recommendation.contains("Refresh")
    );
}
