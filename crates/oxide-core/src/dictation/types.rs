use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelId {
    #[default]
    Small,
}

impl std::fmt::Display for ModelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Small => write!(f, "small"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendId {
    Cpu,
    Cuda,
    Vulkan,
    Metal,
}

impl std::fmt::Display for BackendId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cpu => write!(f, "cpu"),
            Self::Cuda => write!(f, "cuda"),
            Self::Vulkan => write!(f, "vulkan"),
            Self::Metal => write!(f, "metal"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", content = "details", rename_all = "camelCase")]
pub enum CapabilityState {
    OmittedFromBuild,
    NoCompatibleDevice,
    MissingDriverOrRuntime,
    InitializationFailure(String),
    InsufficientMemory {
        required_bytes: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        available_bytes: Option<u64>,
    },
    Available,
    VerifiedByInference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendProbe {
    pub backend: BackendId,
    pub state: CapabilityState,
    pub adapter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDetails {
    pub backend: BackendId,
    pub adapter: Option<String>,
    pub offloaded: bool,
    pub offload_evidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildManifest {
    pub whisper_rs_version: String,
    pub whisper_cpp_pinned: String,
    pub included_backends: Vec<BackendId>,
}

impl BuildManifest {
    pub fn current() -> Self {
        let mut included_backends = vec![BackendId::Cpu];
        #[cfg(target_os = "macos")]
        included_backends.push(BackendId::Metal);
        #[cfg(feature = "dictation-vulkan")]
        included_backends.push(BackendId::Vulkan);

        Self {
            whisper_rs_version: "0.16.0".into(),
            whisper_cpp_pinned: "whisper.cpp (whisper-rs 0.16.0)".into(),
            included_backends,
        }
    }
}
