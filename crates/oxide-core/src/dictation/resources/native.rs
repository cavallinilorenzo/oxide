//! OS collection and native discovery adapters for the pure resource policy.
use super::*;
use crate::dictation;

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
    // Disk enumeration may block; RAM must be the last OS measurement before load.
    system.refresh_memory();
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

/// Recheck immediately before a native context allocation; no artifact-size fallback.
pub fn check_before_load(
    path: &std::path::Path,
    probe: &BackendProbe,
) -> Result<(), dictation::BackendError> {
    let entry = models::catalogue().entry_for_path(path).ok_or_else(|| {
        dictation::BackendError::InitializationFailed(
            "Unknown model memory estimate. Select a catalogue model.".into(),
        )
    })?;
    let snapshot = capture(path.parent().unwrap_or_else(|| std::path::Path::new(".")));
    assess_load(&snapshot, probe, entry.id, now_secs()).map_err(|e| e.backend_error())
}

/// Host-facing read-only entry point. Run on the existing Settings worker.
pub fn inspect(home: &std::path::Path, preference: Preference) -> ResourceAdvice {
    let started = now_secs();
    let backends = backend_candidates();
    let installed: Vec<_> = dictation::models::ModelManager::default()
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
    let version = dictation::BuildManifest::current().whisper_cpp_pinned;
    let mut candidates = Vec::new();
    for probe in dictation::probe_backends() {
        // Native workers enumerate stable identities and driver versions. Never merge
        // CUDA and Vulkan memory budgets, even when they refer to the same physical GPU.
        if matches!(
            probe.state,
            CapabilityState::Available | CapabilityState::VerifiedByInference
        ) {
            if probe.backend == BackendId::Vulkan {
                if let Ok(devices) = dictation::vulkan::VulkanRuntime::default().adapters() {
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
                && let Ok(devices) = dictation::cuda::CudaRuntime::default().adapters()
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
