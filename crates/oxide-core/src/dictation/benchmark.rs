//! Explicit, offline performance checks. The process boundary owns native resources.
use super::{BackendError, BackendId, ExecutionDetails, ModelId, resources::*};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

mod process;
pub use process::{NativeDevice, ProcessWorker, worker_main, worker_main_with};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckRequest {
    pub model: ModelId,
    pub backend: BackendId,
    pub adapter_id: Option<String>,
    pub include_conservative_candidate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub model: ModelId,
    pub backend: BackendId,
    pub adapter_id: Option<String>,
    pub phase: Phase,
}

/// External native process boundary. Implementations must terminate and reap on
/// cancellation/timeout and report only observed execution, never requested GPU mode.
pub trait PerformanceWorker: Send + Sync {
    fn run(
        &self,
        home: &Path,
        model: ModelId,
        candidate: &BackendCandidate,
        cancelled: Arc<AtomicBool>,
        progress: &mut dyn FnMut(Phase),
    ) -> Result<BenchmarkResult, BackendError>;
}

impl super::Dictation {
    pub fn cancel_performance(&self) {
        if let Some(cancelled) = self.benchmark_cancellation.lock().unwrap().as_ref() {
            cancelled.store(true, Ordering::SeqCst);
        }
    }
    /// Does not enable dictation, access the microphone, change Settings or download.
    pub fn check_performance(
        &self,
        home: &Path,
        request: &CheckRequest,
        worker: &dyn PerformanceWorker,
        mut progress: impl FnMut(Progress),
    ) -> crate::Result<Vec<BenchmarkResult>> {
        // Same lock order as recording start/stop. Own the busy flag through every exit.
        let recording = self.recording.lock().unwrap();
        let mut busy = self.busy.lock().unwrap();
        if recording.is_some() || *busy {
            return Err(super::err(
                "Dictation is already active. Stop recording or wait before checking performance.",
            ));
        }
        *busy = true;
        let cancelled = Arc::new(AtomicBool::new(false));
        *self.benchmark_cancellation.lock().unwrap() = Some(cancelled.clone());
        drop(busy);
        drop(recording);
        struct Release<'a>(&'a super::Dictation);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                self.0.benchmark_cancellation.lock().unwrap().take();
                *self.0.busy.lock().unwrap() = false;
            }
        }
        let _release = Release(self);
        let candidates = if request.backend == BackendId::Cpu {
            vec![BackendCandidate::cpu()]
        } else {
            backend_candidates()
        };
        let candidate = candidates
            .into_iter()
            .find(|c| c.probe.backend == request.backend && c.adapter_id == request.adapter_id)
            .ok_or_else(|| {
                super::err("Selected backend/device unavailable. Refresh devices or choose CPU.")
            })?;
        let mut plan = vec![request.model];
        if request.include_conservative_candidate {
            let smaller = match request.model {
                ModelId::Tiny => None,
                ModelId::Base => Some(ModelId::Tiny),
                _ => Some(ModelId::Base),
            };
            if let Some(id) = smaller
                && self
                    .models
                    .status(home, id)
                    .is_ok_and(|s| matches!(s.state, super::models::ModelState::Installed))
            {
                plan.push(id);
            }
        }
        let mut results = Vec::new();
        for model in plan {
            if cancelled.load(Ordering::SeqCst) {
                return Err(super::err(BackendError::Cancelled));
            }
            let _lease = self.models.acquire(home, model)?;
            let resources = self
                .resource_provider
                .as_ref()
                .map_or_else(|| capture(&home.join("models")), |read| read());
            assess_load(&resources, &candidate.probe, model, now_secs())
                .map_err(|e| super::err(e.reason))?;
            let result = worker
                .run(home, model, &candidate, cancelled.clone(), &mut |phase| {
                    progress(Progress {
                        model,
                        backend: candidate.probe.backend,
                        adapter_id: candidate.adapter_id.clone(),
                        phase,
                    })
                })
                .map_err(super::err)?;
            if cancelled.load(Ordering::SeqCst) {
                return Err(super::err(BackendError::Cancelled));
            }
            if result.model != model
                || result.measurement.key
                    != PerformanceKey::for_candidate(model, &candidate, &resources.cpu)
            {
                return Err(super::err(
                    "Device, driver or CPU identity changed during the check. Refresh and retry.",
                ));
            }
            result.validate().map_err(super::err)?;
            results.push(result);
        }
        // Publish only complete checks; cancelling the candidate cannot publish a partial check.
        for result in &results {
            store_result(home, result)?;
        }
        Ok(results)
    }
}

pub const FIXTURE_VERSION: &str = "jfk-16khz-pcm-v1";
pub const FIXTURE_DURATION_MS: u64 = 11_000;
pub const MAX_RUNTIME: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkResult {
    pub fixture_version: String,
    pub model: ModelId,
    pub measurement: MeasuredPerformance,
    pub execution: ExecutionDetails,
}

impl BenchmarkResult {
    pub fn validate(&self) -> Result<(), BackendError> {
        let key = &self.measurement.key;
        let gpu = key.backend != BackendId::Cpu;
        if self.fixture_version != FIXTURE_VERSION
            || self.measurement.audio_duration_ms != FIXTURE_DURATION_MS
            || self.measurement.warm_inference_ms.contains(&0)
            || self.execution.backend != key.backend
            || self.execution.offloaded != gpu
            || (gpu
                && (key.adapter_id.as_ref().is_none_or(|s| s.is_empty())
                    || key.driver_version.as_ref().is_none_or(|s| s.is_empty())
                    || self
                        .execution
                        .offload_evidence
                        .as_ref()
                        .is_none_or(|s| s.is_empty())))
        {
            return Err(BackendError::InferenceFailed("Performance result has incompatible fixture or unverified execution; no measurement saved.".into()));
        }
        Ok(())
    }
}

/// Bounded, local metadata only; corrupt or obsolete caches are disposable.
pub fn read_cache(home: &Path) -> Vec<BenchmarkResult> {
    let read = || -> Option<Vec<BenchmarkResult>> {
        let file = fs::File::open(home.join("dictation-performance.json")).ok()?;
        if file.metadata().ok()?.len() > 256 * 1024 {
            return None;
        }
        let mut data = String::new();
        file.take(256 * 1024).read_to_string(&mut data).ok()?;
        serde_json::from_str(&data).ok()
    };
    read()
        .unwrap_or_default()
        .into_iter()
        .filter(|r| r.validate().is_ok())
        .take(32)
        .collect()
}

pub fn store_result(home: &Path, result: &BenchmarkResult) -> crate::Result<()> {
    result.validate().map_err(super::err)?;
    let mut results = read_cache(home);
    results.retain(|r| r.measurement.key != result.measurement.key);
    results.insert(0, result.clone());
    results.truncate(32);
    fs::create_dir_all(home).map_err(super::err)?;
    let mut temporary = tempfile::NamedTempFile::new_in(home).map_err(super::err)?;
    temporary
        .write_all(&serde_json::to_vec(&results).map_err(super::err)?)
        .map_err(super::err)?;
    temporary
        .persist(home.join("dictation-performance.json"))
        .map_err(super::err)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Phase {
    Loading,
    Warmup,
    Measuring { run: u8 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub audio_duration_ms: u64,
    pub cold_load_ms: u64,
    pub warm_inference_ms: [u64; 3],
}

impl Timing {
    pub fn median_rtf_milli(&self) -> u64 {
        let mut times = self.warm_inference_ms;
        times.sort_unstable();
        ((times[1] as u128 * 1000).div_ceil(self.audio_duration_ms.max(1) as u128))
            .min(u64::MAX as u128) as u64
    }
}

/// Inference and its monotonic timer are an injectable native boundary.
pub fn measure(
    audio_duration_ms: u64,
    cold_load_ms: u64,
    mut inference: impl FnMut() -> Result<Duration, BackendError>,
    mut progress: impl FnMut(Phase),
) -> Result<Timing, BackendError> {
    progress(Phase::Warmup);
    inference()?;
    let mut warm_inference_ms = [0; 3];
    for (index, time) in warm_inference_ms.iter_mut().enumerate() {
        progress(Phase::Measuring {
            run: index as u8 + 1,
        });
        *time = inference()?
            .as_nanos()
            .div_ceil(1_000_000)
            .clamp(1, u64::MAX as u128) as u64;
    }
    Ok(Timing {
        audio_duration_ms,
        cold_load_ms,
        warm_inference_ms,
    })
}
