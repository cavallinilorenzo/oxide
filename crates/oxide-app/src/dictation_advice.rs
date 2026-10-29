//! Typed read-only resource advice for the later Settings UI.
use crate::{BackendId, BackendProbe, DictationModelId};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DictationResourceAdvice {
    resources: ResourceSnapshot,
    backends: Vec<BackendCandidate>,
    recommendation: ResourceRecommendation,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct ResourceSnapshot {
    #[specta(type = f64)]
    captured_at_secs: u64,
    cpu: CpuResources,
    #[specta(type = Option<f64>)]
    total_ram_bytes: Option<u64>,
    #[specta(type = Option<f64>)]
    available_ram_bytes: Option<u64>,
    #[specta(type = Option<f64>)]
    baseline_bytes: Option<u64>,
    #[specta(type = Option<f64>)]
    free_disk_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CpuResources {
    architecture: String,
    model: String,
    usable_cores: u32,
    instruction_compatible: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct BackendCandidate {
    probe: BackendProbe,
    adapter_id: Option<String>,
    driver_version: Option<String>,
    runtime_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AdvicePreference {
    Balanced,
    Quality,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
enum AdviceStatus {
    Recommended,
    UsableSlower,
    NotRecommended,
    InsufficientData,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
enum AdviceConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct ResourceDecision {
    model: DictationModelId,
    backend: BackendId,
    adapter: Option<String>,
    adapter_id: Option<String>,
    status: AdviceStatus,
    confidence: AdviceConfidence,
    provisional: bool,
    safe_to_load: bool,
    reason: String,
    #[specta(type = Option<f64>)]
    median_rtf_milli: Option<u64>,
    #[specta(type = Option<f64>)]
    cold_load_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
struct ResourceRecommendation {
    policy_version: u32,
    catalogue_version: u32,
    preference: AdvicePreference,
    decisions: Vec<ResourceDecision>,
    selected: Option<u32>,
}
