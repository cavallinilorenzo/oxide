//! Typed Settings contract; workers receive only catalogue IDs and stable devices.
use crate::{AppError, BackendId, DictationModelId, ExecutionDetails, convert};
use oxide_core::{
    Core,
    dictation::{Dictation, benchmark::ProcessWorker},
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::{State, ipc::Channel};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DictationBenchmarkRequest {
    model: DictationModelId,
    backend: BackendId,
    adapter_id: Option<String>,
    include_conservative_candidate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum BenchmarkPhase {
    Loading,
    Warmup,
    Measuring { run: u8 },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkProgress {
    model: DictationModelId,
    backend: BackendId,
    adapter_id: Option<String>,
    phase: BenchmarkPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceIdentity {
    model_sha256: String,
    backend: BackendId,
    adapter_id: Option<String>,
    driver_version: Option<String>,
    runtime_version: String,
    policy_version: u32,
    catalogue_version: u32,
    cpu: crate::dictation_advice::CpuResources,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceMeasurement {
    key: PerformanceIdentity,
    #[specta(type = f64)]
    recorded_at_secs: u64,
    #[specta(type = f64)]
    audio_duration_ms: u64,
    #[specta(type = [f64; 3])]
    warm_inference_ms: [u64; 3],
    #[specta(type = f64)]
    cold_load_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DictationBenchmarkResult {
    fixture_version: String,
    model: DictationModelId,
    measurement: PerformanceMeasurement,
    execution: ExecutionDetails,
    #[specta(type = f64)]
    median_inference_ms: u64,
    #[specta(type = f64)]
    median_rtf_milli: u64,
}

impl From<&oxide_core::dictation::benchmark::BenchmarkResult> for DictationBenchmarkResult {
    fn from(result: &oxide_core::dictation::benchmark::BenchmarkResult) -> Self {
        let timing = oxide_core::dictation::benchmark::Timing {
            audio_duration_ms: result.measurement.audio_duration_ms,
            cold_load_ms: result.measurement.cold_load_ms,
            warm_inference_ms: result.measurement.warm_inference_ms,
        };
        let mut runs = timing.warm_inference_ms;
        runs.sort_unstable();
        Self {
            fixture_version: result.fixture_version.clone(),
            model: convert(&result.model),
            measurement: convert(&result.measurement),
            execution: convert(&result.execution),
            median_inference_ms: runs[1],
            median_rtf_milli: timing.median_rtf_milli(),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn dictation_check_performance(
    core: State<'_, Arc<Core>>,
    dictation: State<'_, Arc<Dictation>>,
    request: DictationBenchmarkRequest,
    progress: Channel<DictationBenchmarkProgress>,
) -> Result<Vec<DictationBenchmarkResult>, AppError> {
    let core = core.inner().clone();
    let dictation = dictation.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        dictation
            .check_performance(
                core.home(),
                &convert(&request),
                &ProcessWorker::default(),
                |p| {
                    let _ = progress.send(convert(&p));
                },
            )
            .map(|results| results.iter().map(DictationBenchmarkResult::from).collect())
    })
    .await
    .map_err(|_| oxide_core::Error::Dictation("Performance worker failed".into()))??)
}

#[tauri::command]
#[specta::specta]
pub fn dictation_cancel_performance(dictation: State<'_, Arc<Dictation>>) {
    dictation.cancel_performance();
}
