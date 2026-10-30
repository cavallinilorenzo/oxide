use super::{BackendError, BackendId, NativeDevice};
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString, c_char};

pub const DISPATCH_REVISION: &str = "whisper-1.8.3-ggml-abi2-dispatch-v1";

/// Graph dispatches with nonempty matrix operations, counted only after the
/// executing CUDA/Metal stream successfully synchronizes. Runs are warmup, 1–3.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchEvidence {
    pub revision: String,
    pub backend: BackendId,
    pub adapter_id: String,
    pub native_backend: String,
    pub device_id: Option<String>,
    pub runs: [DispatchRun; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRun {
    pub native_backend: String,
    pub adapter: String,
    pub device_id: Option<String>,
    pub completed_graphs: u64,
    pub matrix_ops: u64,
    pub failures: u64,
}

pub(super) fn unproven() -> BackendError {
    BackendError::InferenceFailed(
        "Completed GPU dispatch was not proven for warmup and every measured run on the selected device; no measurement saved. Try CPU.".into(),
    )
}

impl DispatchEvidence {
    pub(super) fn validate(
        &self,
        backend: BackendId,
        adapter_id: Option<&str>,
        adapter: Option<&str>,
    ) -> Result<(), BackendError> {
        let native_matches = match backend {
            BackendId::Cuda => {
                self.native_backend
                    .strip_prefix("CUDA")
                    .is_some_and(|index| {
                        !index.is_empty() && index.bytes().all(|c| c.is_ascii_digit())
                    })
                    && self.device_id.as_ref().is_some_and(|id| !id.is_empty())
            }
            BackendId::Metal => self.native_backend == "Metal" && self.device_id.is_none(),
            _ => false,
        };
        if self.revision != DISPATCH_REVISION
            || self.backend != backend
            || self.adapter_id.is_empty()
            || Some(self.adapter_id.as_str()) != adapter_id
            || !native_matches
            || self.runs.iter().any(|run| {
                run.completed_graphs == 0
                    || run.matrix_ops < run.completed_graphs
                    || run.failures != 0
                    || run.native_backend != self.native_backend
                    || run.adapter.is_empty()
                    || Some(run.adapter.as_str()) != adapter
                    || run.device_id != self.device_id
            })
        {
            return Err(unproven());
        }
        Ok(())
    }
}

#[repr(C)]
struct Snapshot {
    completed_graphs: u64,
    matrix_ops: u64,
    failures: u64,
    native_backend: [c_char; 128],
    adapter: [c_char; 256],
    device_id: [c_char; 128],
}

unsafe extern "C" {
    fn oxide_dispatch_install(
        name: *const c_char,
        adapter: *const c_char,
        device_id: *const c_char,
    ) -> bool;
    fn oxide_dispatch_reset();
    fn oxide_dispatch_read(snapshot: *mut Snapshot);
}

/// Only constructed in the disposable benchmark worker, before creating any
/// Whisper contexts. The native hook is process-global and never enters the host.
pub(crate) struct Recorder {
    device: NativeDevice,
    runs: Vec<DispatchRun>,
}

impl Recorder {
    pub fn install(device: &NativeDevice) -> Result<Option<Self>, BackendError> {
        let candidate = &device.candidate;
        let backend = candidate.probe.backend;
        if !matches!(backend, BackendId::Cuda | BackendId::Metal) {
            return Ok(None);
        }
        candidate
            .adapter_id
            .as_ref()
            .filter(|id| !id.is_empty())
            .ok_or_else(unproven)?;
        let adapter = candidate.probe.adapter.as_deref().ok_or_else(unproven)?;
        if backend == BackendId::Cuda
            && device
                .native_device_id
                .as_ref()
                .is_none_or(|id| id.is_empty())
        {
            return Err(unproven());
        }
        let name = CString::new(device.native_backend.as_str()).map_err(|_| unproven())?;
        let description = CString::new(adapter).map_err(|_| unproven())?;
        let id = device
            .native_device_id
            .as_deref()
            .map(CString::new)
            .transpose()
            .map_err(|_| unproven())?;
        // SAFETY: strings live through this synchronous call. It validates the
        // pinned ABI and unique native device before changing its init callback.
        if !unsafe {
            oxide_dispatch_install(
                name.as_ptr(),
                description.as_ptr(),
                id.as_ref().map_or(std::ptr::null(), |id| id.as_ptr()),
            )
        } {
            return Err(BackendError::InitializationFailed(
                "Cannot instrument the selected native GPU device".into(),
            ));
        }
        Ok(Some(Self {
            device: device.clone(),
            runs: Vec::with_capacity(4),
        }))
    }

    pub fn begin_run(&self) {
        // SAFETY: all prior inference is complete; no callbacks remain in flight.
        unsafe { oxide_dispatch_reset() };
    }

    pub fn end_run(&mut self) {
        // SAFETY: Snapshot is a C-compatible all-zero-valid layout. Native read
        // copies counters and bounded, zero-terminated identity strings under a mutex.
        let snapshot = unsafe {
            let mut snapshot: Snapshot = std::mem::zeroed();
            oxide_dispatch_read(&mut snapshot);
            snapshot
        };
        let string = |chars: &[c_char]| {
            // SAFETY: the native fixed arrays always include a trailing zero.
            unsafe { CStr::from_ptr(chars.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        };
        let id = string(&snapshot.device_id);
        self.runs.push(DispatchRun {
            native_backend: string(&snapshot.native_backend),
            adapter: string(&snapshot.adapter),
            device_id: (!id.is_empty()).then_some(id),
            completed_graphs: snapshot.completed_graphs,
            matrix_ops: snapshot.matrix_ops,
            failures: snapshot.failures,
        });
    }

    pub fn finish(self) -> Result<DispatchEvidence, BackendError> {
        let candidate = self.device.candidate;
        let evidence = DispatchEvidence {
            revision: DISPATCH_REVISION.into(),
            backend: candidate.probe.backend,
            adapter_id: candidate.adapter_id.ok_or_else(unproven)?,
            native_backend: self.device.native_backend,
            device_id: self.device.native_device_id,
            runs: self.runs.try_into().map_err(|_| unproven())?,
        };
        evidence.validate(
            evidence.backend,
            Some(&evidence.adapter_id),
            candidate.probe.adapter.as_deref(),
        )?;
        Ok(evidence)
    }
}
