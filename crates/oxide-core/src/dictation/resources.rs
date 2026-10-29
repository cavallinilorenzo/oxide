//! Resource policy v1. Pure decisions share the same boundary as pre-load checks.
use super::{BackendId, BackendProbe, CapabilityState, ModelId, WhisperBackendRuntime, models};
use serde::{Deserialize, Serialize};

pub const POLICY_VERSION: u32 = 1;
pub const SNAPSHOT_MAX_AGE_SECS: u64 = 30;
pub const PERFORMANCE_MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;
const GIB: u64 = 1 << 30;

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Read current OS resources on a worker thread. No GPU initialization or downloads.
pub fn capture(model_directory: &std::path::Path) -> ResourceSnapshot {
    use sysinfo::{CpuRefreshKind, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_memory();
    system.refresh_cpu_list(CpuRefreshKind::nothing());
    let baseline_bytes = sysinfo::get_current_pid().ok().and_then(|pid| {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        system.process(pid).map(|p| p.memory())
    });
    let directory = model_directory
        .ancestors()
        .find_map(|path| dunce::canonicalize(path).ok());
    let free_disk_bytes = directory.and_then(|path| {
        sysinfo::Disks::new_with_refreshed_list()
            .iter()
            .filter(|disk| path.starts_with(disk.mount_point()))
            .max_by_key(|disk| disk.mount_point().as_os_str().len())
            .map(|disk| disk.available_space())
    });
    ResourceSnapshot {
        captured_at_secs: now_secs(),
        cpu: CpuResources {
            architecture: std::env::consts::ARCH.into(),
            model: system
                .cpus()
                .first()
                .map_or_else(String::new, |cpu| cpu.brand().to_owned()),
            usable_cores: std::thread::available_parallelism().map_or(0, usize::from),
            instruction_compatible: native_instruction_compatibility(),
        },
        total_ram_bytes: Some(system.total_memory()).filter(|v| *v > 0),
        available_ram_bytes: (system.total_memory() > 0).then_some(system.available_memory()),
        baseline_bytes,
        free_disk_bytes,
    }
}

fn native_instruction_compatibility() -> Option<bool> {
    #[cfg(target_arch = "x86_64")]
    {
        use whisper_rs::whisper_rs_sys::*;
        // SAFETY: pinned GGML feature getters read compile-time constants, with no pointers
        // or native context. Compare those requirements with OS-aware CPUID detection.
        let compatible = unsafe {
            (ggml_cpu_has_sse3() == 0 || std::is_x86_feature_detected!("sse3"))
                && (ggml_cpu_has_ssse3() == 0 || std::is_x86_feature_detected!("ssse3"))
                && (ggml_cpu_has_avx() == 0 || std::is_x86_feature_detected!("avx"))
                && (ggml_cpu_has_avx2() == 0 || std::is_x86_feature_detected!("avx2"))
                && (ggml_cpu_has_avx_vnni() == 0 || std::is_x86_feature_detected!("avxvnni"))
                && (ggml_cpu_has_fma() == 0 || std::is_x86_feature_detected!("fma"))
                && (ggml_cpu_has_f16c() == 0 || std::is_x86_feature_detected!("f16c"))
                && (ggml_cpu_has_bmi2() == 0 || std::is_x86_feature_detected!("bmi2"))
                && (ggml_cpu_has_avx512() == 0
                    || (std::is_x86_feature_detected!("avx512f")
                        && std::is_x86_feature_detected!("avx512bw")
                        && std::is_x86_feature_detected!("avx512dq")
                        && std::is_x86_feature_detected!("avx512vl")))
                && (ggml_cpu_has_avx512_vbmi() == 0 || std::is_x86_feature_detected!("avx512vbmi"))
                && (ggml_cpu_has_avx512_vnni() == 0 || std::is_x86_feature_detected!("avx512vnni"))
                && (ggml_cpu_has_avx512_bf16() == 0 || std::is_x86_feature_detected!("avx512bf16"))
        };
        // AMX needs OS permission beyond CPUID; do not assume it is usable.
        if unsafe { ggml_cpu_has_amx_int8() } != 0 {
            return None;
        }
        Some(compatible)
    }
    #[cfg(target_arch = "aarch64")]
    {
        use whisper_rs::whisper_rs_sys::*;
        // SAFETY: pinned native getters return compile-time feature flags.
        Some(unsafe {
            (ggml_cpu_has_neon() == 0 || std::arch::is_aarch64_feature_detected!("neon"))
                && (ggml_cpu_has_fp16_va() == 0 || std::arch::is_aarch64_feature_detected!("fp16"))
                && (ggml_cpu_has_dotprod() == 0
                    || std::arch::is_aarch64_feature_detected!("dotprod"))
                && (ggml_cpu_has_matmul_int8() == 0
                    || std::arch::is_aarch64_feature_detected!("i8mm"))
                && (ggml_cpu_has_sve() == 0 || std::arch::is_aarch64_feature_detected!("sve"))
                && (ggml_cpu_has_sme() == 0 || std::arch::is_aarch64_feature_detected!("sme"))
        })
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        None
    }
}

impl LoadRefusal {
    pub fn backend_error(&self) -> super::BackendError {
        match self.required_bytes {
            Some(required_bytes) => super::BackendError::InsufficientMemory {
                required_bytes,
                available_bytes: self.available_bytes,
            },
            None => super::BackendError::InitializationFailed(self.reason.clone()),
        }
    }
}

/// Recheck immediately before a native context allocation; no artifact-size fallback.
pub fn check_before_load(
    path: &std::path::Path,
    probe: &BackendProbe,
) -> Result<(), super::BackendError> {
    let entry = models::catalogue().entry_for_path(path).ok_or_else(|| {
        super::BackendError::InitializationFailed(
            "Unknown model memory estimate. Select a catalogue model.".into(),
        )
    })?;
    let snapshot = capture(path.parent().unwrap_or_else(|| std::path::Path::new(".")));
    assess_load(&snapshot, probe, entry.id, now_secs()).map_err(|e| e.backend_error())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuResources {
    pub architecture: String,
    pub model: String,
    pub usable_cores: usize,
    pub instruction_compatible: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub captured_at_secs: u64,
    pub cpu: CpuResources,
    pub total_ram_bytes: Option<u64>,
    /// OS available memory already excludes Oxide's resident baseline.
    pub available_ram_bytes: Option<u64>,
    pub baseline_bytes: Option<u64>,
    pub free_disk_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRefusal {
    pub insufficient_data: bool,
    pub reason: String,
    pub required_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

fn unknown(reason: &str) -> LoadRefusal {
    LoadRefusal {
        insufficient_data: true,
        reason: reason.into(),
        required_bytes: None,
        available_bytes: None,
    }
}

fn memory_refusal(required: u64, available: u64, pool: &str) -> LoadRefusal {
    LoadRefusal {
        insufficient_data: false,
        reason: format!(
            "Free memory or choose a smaller model: {pool} needs {required} bytes including safety headroom; {available} bytes available."
        ),
        required_bytes: Some(required),
        available_bytes: Some(available),
    }
}

/// Checks memory for an already installed model, without allocating a native context.
/// Discrete GPU estimates reserve a full CPU peak for host staging as well as VRAM.
/// Unified estimates represent one combined peak, never two independent pools.
pub fn assess_load(
    snapshot: &ResourceSnapshot,
    probe: &BackendProbe,
    model: ModelId,
    now_secs: u64,
) -> Result<(), LoadRefusal> {
    if snapshot.cpu.instruction_compatible == Some(false) {
        return Err(LoadRefusal {
            insufficient_data: false,
            reason:
                "CPU instructions are incompatible with this native build. Use a compatible build."
                    .into(),
            required_bytes: None,
            available_bytes: None,
        });
    }
    if !matches!(
        probe.state,
        CapabilityState::Available | CapabilityState::VerifiedByInference
    ) {
        return Err(LoadRefusal {
            insufficient_data: false,
            reason: format!(
                "Backend {} is unavailable ({:?}). Choose an available backend or repair its driver/runtime.",
                probe.backend, probe.state
            ),
            required_bytes: None,
            available_bytes: None,
        });
    }
    if now_secs < snapshot.captured_at_secs
        || now_secs - snapshot.captured_at_secs > SNAPSHOT_MAX_AGE_SECS
    {
        return Err(unknown(
            "Resource snapshot is stale. Refresh resources before loading.",
        ));
    }
    let entry = models::catalogue().entry(model).expect("catalogue model");
    let host_peak = entry
        .estimated_peak(BackendId::Cpu)
        .expect("CPU peak estimate");
    let peak = entry
        .estimated_peak(probe.backend)
        .ok_or_else(|| unknown("Backend memory estimate unavailable."))?;
    let total = snapshot.total_ram_bytes.filter(|v| *v > 0);
    let mut available = snapshot.available_ram_bytes;
    if probe.backend != BackendId::Cpu {
        if let Some(pool) = &probe.memory_pool {
            if let Some(reported) = pool.available_bytes
                && pool.total_bytes > 0
                && reported > pool.total_bytes
            {
                return Err(unknown(
                    "Inconsistent GPU memory report. Refresh resources.",
                ));
            }
            if pool.unified {
                available = available
                    .zip(pool.available_bytes)
                    .map(|(host, shared)| host.min(shared));
            }
            // A working-set ceiling is a cap, never additional available memory.
            let budget = match (pool.available_bytes, pool.max_working_set_bytes) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            if let Some(budget) = budget {
                let required = if pool.unified {
                    peak
                } else {
                    peak.saturating_add(peak.div_ceil(4))
                };
                if budget < required {
                    return Err(memory_refusal(required, budget, "GPU budget"));
                }
            }
            if pool.available_bytes.is_none() || pool.total_bytes == 0 {
                return Err(unknown(
                    "GPU available memory is unknown. Refresh the driver budget before loading.",
                ));
            }
        } else {
            return Err(unknown(
                "GPU memory topology/budget is unknown. Refresh resources or choose CPU.",
            ));
        }
    }
    if let (Some(total), Some(available)) = (total, available) {
        if available > total {
            return Err(unknown("Inconsistent RAM report. Refresh resources."));
        }
        let required = host_peak.max(peak).saturating_add(GIB.max(total / 5));
        if available < required {
            return Err(memory_refusal(required, available, "RAM"));
        }
    }
    if total.is_none()
        || available.is_none()
        || snapshot.cpu.instruction_compatible.is_none()
        || snapshot.cpu.usable_cores == 0
    {
        return Err(unknown(
            "CPU compatibility or RAM budget is unknown. Refresh resources before loading.",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendCandidate {
    pub probe: BackendProbe,
    pub adapter_id: Option<String>,
    pub driver_version: Option<String>,
    pub runtime_version: String,
}

impl BackendCandidate {
    pub fn cpu() -> Self {
        Self {
            probe: super::CpuRuntime.probe(),
            adapter_id: None,
            driver_version: None,
            runtime_version: super::BuildManifest::current().whisper_cpp_pinned,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceAdvice {
    pub resources: ResourceSnapshot,
    pub backends: Vec<BackendCandidate>,
    pub recommendation: Recommendation,
}

/// Host-facing read-only entry point. Run on the existing Settings worker.
pub fn inspect(home: &std::path::Path, preference: Preference) -> ResourceAdvice {
    let started = now_secs();
    let backends = backend_candidates();
    let installed: Vec<_> = super::models::ModelManager::default()
        .list(home)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| matches!(m.state, models::ModelState::Installed))
        .map(|m| m.id)
        .collect();
    // Capture after probes/hashing so a slow driver or a large model cannot age RAM data.
    let mut resources = capture(&home.join("models"));
    // The timestamp bounds the age of the oldest input, including slow GPU probes.
    resources.captured_at_secs = started.min(resources.captured_at_secs);
    let recommendation = recommend(
        &resources,
        &backends,
        &installed,
        preference,
        &[],
        now_secs(),
    );
    ResourceAdvice {
        resources,
        backends,
        recommendation,
    }
}

pub fn backend_candidates() -> Vec<BackendCandidate> {
    let version = super::BuildManifest::current().whisper_cpp_pinned;
    let mut candidates = Vec::new();
    for probe in super::probe_backends() {
        // Native workers enumerate stable identities and driver versions. Never merge
        // CUDA and Vulkan memory budgets, even when they refer to the same physical GPU.
        if matches!(
            probe.state,
            CapabilityState::Available | CapabilityState::VerifiedByInference
        ) {
            if probe.backend == BackendId::Vulkan {
                if let Ok(devices) = super::vulkan::VulkanRuntime::default().adapters() {
                    candidates.extend(devices.into_iter().map(|device| BackendCandidate {
                        probe: BackendProbe {
                            backend: BackendId::Vulkan,
                            state: device.capability,
                            adapter: Some(device.name),
                            memory_pool: device.memory,
                        },
                        adapter_id: Some(device.id),
                        driver_version: device.driver,
                        runtime_version: version.clone(),
                    }));
                    continue;
                }
            } else if probe.backend == BackendId::Cuda
                && let Ok(devices) = super::cuda::CudaRuntime::default().adapters()
            {
                candidates.extend(devices.into_iter().map(|device| BackendCandidate {
                    probe: BackendProbe {
                        backend: BackendId::Cuda,
                        state: device.capability,
                        adapter: Some(device.name),
                        memory_pool: device.memory,
                    },
                    adapter_id: Some(device.id),
                    driver_version: device.driver,
                    runtime_version: version.clone(),
                }));
                continue;
            }
        }
        let adapter_id = if probe.backend == BackendId::Metal {
            probe.adapter.clone()
        } else {
            None
        };
        let driver_version = if probe.backend == BackendId::Metal {
            sysinfo::System::kernel_version()
        } else {
            None
        };
        candidates.push(BackendCandidate {
            probe,
            adapter_id,
            driver_version,
            runtime_version: version.clone(),
        });
    }
    candidates.sort_by_key(|c| {
        (
            c.probe.backend.to_string(),
            c.adapter_id.clone(),
            c.probe.adapter.clone(),
        )
    });
    candidates
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Preference {
    Balanced,
    Quality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdviceStatus {
    Recommended,
    UsableSlower,
    NotRecommended,
    InsufficientData,
}

impl std::fmt::Display for AdviceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Recommended => "Recommended",
            Self::UsableSlower => "Usable, slower",
            Self::NotRecommended => "Not recommended with current resources",
            Self::InsufficientData => "Insufficient data",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub model: ModelId,
    pub backend: BackendId,
    pub adapter: Option<String>,
    pub adapter_id: Option<String>,
    pub status: AdviceStatus,
    pub confidence: Confidence,
    pub provisional: bool,
    pub safe_to_load: bool,
    pub reason: String,
    pub median_rtf_milli: Option<u64>,
    pub cold_load_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub policy_version: u32,
    pub catalogue_version: u32,
    pub preference: Preference,
    pub decisions: Vec<Decision>,
    pub selected: Option<usize>,
}

/// Cache identity consumed by #232; changing policy/catalogue invalidates advice too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceKey {
    pub model_sha256: String,
    pub backend: BackendId,
    pub adapter_id: Option<String>,
    pub driver_version: Option<String>,
    pub runtime_version: String,
    pub policy_version: u32,
    pub catalogue_version: u32,
}

impl PerformanceKey {
    pub fn for_candidate(model: ModelId, candidate: &BackendCandidate) -> Self {
        Self {
            model_sha256: models::catalogue()
                .entry(model)
                .expect("catalogue model")
                .sha256
                .clone(),
            backend: candidate.probe.backend,
            adapter_id: candidate.adapter_id.clone(),
            driver_version: candidate.driver_version.clone(),
            runtime_version: candidate.runtime_version.clone(),
            policy_version: POLICY_VERSION,
            catalogue_version: models::catalogue().version,
        }
    }
}

/// Producer must warm up first, then time three runs of the same licensed fixture.
/// Cold model load is separate and does not enter RTF. No audio/transcript is stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredPerformance {
    pub key: PerformanceKey,
    pub recorded_at_secs: u64,
    pub audio_duration_ms: u64,
    pub warm_inference_ms: [u64; 3],
    pub cold_load_ms: u64,
}

fn measured_rtf(sample: &MeasuredPerformance) -> u64 {
    let mut runs = sample.warm_inference_ms;
    runs.sort_unstable();
    // Round upward: 0.5001 must not qualify for the <= 0.5 target.
    ((runs[1] as u128 * 1000).div_ceil(sample.audio_duration_ms as u128)).min(u64::MAX as u128)
        as u64
}

/// Read-only policy: never selects a model in Settings or starts a download.
pub fn recommend(
    snapshot: &ResourceSnapshot,
    candidates: &[BackendCandidate],
    installed: &[ModelId],
    preference: Preference,
    measurements: &[MeasuredPerformance],
    now_secs: u64,
) -> Recommendation {
    let mut decisions = Vec::new();
    for candidate in candidates {
        for entry in &models::catalogue().models {
            let load = assess_load(snapshot, &candidate.probe, entry.id, now_secs);
            let mut decision = Decision { model: entry.id, backend: candidate.probe.backend,
                adapter: candidate.probe.adapter.clone(), adapter_id: candidate.adapter_id.clone(),
                status: AdviceStatus::Recommended, confidence: Confidence::Low, provisional: true,
                safe_to_load: load.is_ok(),
                median_rtf_milli: None,
                cold_load_ms: None,
                reason: "Provisional estimate; run Check performance. Speed and transcription quality are unmeasured; GPU execution is unverified by this advice.".into() };
            if let Err(refusal) = load {
                decision.status = if refusal.insufficient_data {
                    AdviceStatus::InsufficientData
                } else {
                    AdviceStatus::NotRecommended
                };
                decision.reason = refusal.reason;
            } else if !installed.contains(&entry.id) {
                match snapshot.free_disk_bytes {
                    Some(bytes)
                        if bytes < entry.expected_bytes.saturating_add(64 * 1024 * 1024) =>
                    {
                        decision.status = AdviceStatus::NotRecommended;
                        decision.reason = "Free disk space or choose an installed model; the artifact plus 64 MiB download margin does not fit.".into();
                    }
                    None => {
                        decision.status = AdviceStatus::InsufficientData;
                        decision.reason = "Free disk space is unknown. Refresh storage information before downloading.".into();
                    }
                    _ => {}
                }
            }
            // A fitting large model is not a latency recommendation without measurements.
            if decision.status == AdviceStatus::Recommended
                && !matches!(entry.id, ModelId::Tiny | ModelId::Base | ModelId::Small)
            {
                decision.status = AdviceStatus::InsufficientData;
                decision.reason = "Provisional memory fit only. Explicit performance check required for this larger model; quality improvement is not guaranteed.".into();
            }
            if decision.safe_to_load
                && matches!(
                    decision.status,
                    AdviceStatus::Recommended | AdviceStatus::InsufficientData
                )
                && (installed.contains(&entry.id)
                    || snapshot.free_disk_bytes.is_some_and(|b| {
                        b >= entry.expected_bytes.saturating_add(64 * 1024 * 1024)
                    }))
            {
                let key = PerformanceKey::for_candidate(entry.id, candidate);
                let identity_known = candidate.probe.backend == BackendId::Cpu
                    || (candidate.adapter_id.is_some() && candidate.driver_version.is_some());
                if let Some(sample) = measurements
                    .iter()
                    .filter(|m| {
                        identity_known
                            && m.key == key
                            && m.audio_duration_ms > 0
                            && m.warm_inference_ms.iter().all(|t| *t > 0)
                            && m.recorded_at_secs <= now_secs
                            && now_secs - m.recorded_at_secs <= PERFORMANCE_MAX_AGE_SECS
                    })
                    .max_by_key(|m| {
                        (
                            m.recorded_at_secs,
                            m.warm_inference_ms,
                            m.audio_duration_ms,
                            m.cold_load_ms,
                        )
                    })
                {
                    let rtf = measured_rtf(sample);
                    decision.status = if rtf <= 500 {
                        AdviceStatus::Recommended
                    } else if rtf <= 1000 {
                        AdviceStatus::UsableSlower
                    } else {
                        AdviceStatus::NotRecommended
                    };
                    decision.confidence = Confidence::Medium;
                    decision.provisional = false;
                    decision.median_rtf_milli = Some(rtf);
                    decision.cold_load_ms = Some(sample.cold_load_ms);
                    decision.reason = format!(
                        "Measured median RTF {}.{:03} from three warm runs; cold load {} ms separately. Memory peaks remain estimates; quality is not guaranteed.{}",
                        rtf / 1000,
                        rtf % 1000,
                        sample.cold_load_ms,
                        if rtf > 1000 {
                            " Choose a faster measured combination or a smaller model."
                        } else {
                            ""
                        }
                    );
                }
            }
            decisions.push(decision);
        }
    }
    let target = if snapshot.cpu.usable_cores < 4 {
        ModelId::Tiny
    } else if preference == Preference::Quality {
        ModelId::Small
    } else {
        ModelId::Base
    };
    let rank = |decision: &Decision| {
        let model_rank = match (target, decision.model) {
            (a, b) if a == b => 0,
            (_, ModelId::Base) => 1,
            (_, ModelId::Tiny) => 2,
            (_, ModelId::Small) => 3,
            _ => 4,
        };
        // No unmeasured GPU speed advantage is assumed; stable identity breaks ties.
        let quality_rank = match decision.model {
            ModelId::LargeV3 => 0,
            ModelId::LargeV3Turbo => 1,
            ModelId::Medium => 2,
            ModelId::Small => 3,
            ModelId::Base => 4,
            ModelId::Tiny => 5,
        };
        let performance_rank = if !decision.provisional && preference == Preference::Quality {
            quality_rank
        } else if !decision.provisional {
            decision.median_rtf_milli.unwrap_or(u64::MAX)
        } else {
            model_rank
        };
        (
            decision.status != AdviceStatus::Recommended,
            decision.provisional,
            performance_rank,
            decision.backend != BackendId::Cpu,
            decision.backend.to_string(),
            decision.adapter_id.clone(),
            decision.adapter.clone(),
        )
    };
    let selected = decisions
        .iter()
        .enumerate()
        .filter(|(_, d)| {
            matches!(
                d.status,
                AdviceStatus::Recommended | AdviceStatus::UsableSlower
            )
        })
        .min_by_key(|(_, d)| rank(d))
        .map(|(i, _)| i);
    Recommendation {
        policy_version: POLICY_VERSION,
        catalogue_version: models::catalogue().version,
        preference,
        decisions,
        selected,
    }
}
