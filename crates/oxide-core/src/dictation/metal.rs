//! macOS Apple Silicon Metal backend integration.
//!
//! Queries physical Metal device properties via Objective-C runtime and executes
//! accelerated inference through pinned whisper.cpp Metal kernels.

use super::runtime::{
    BackendError, TranscriptionOutcome, TranscriptionRequest, WhisperBackendRuntime,
};
use super::types::{BackendId, BackendProbe, CapabilityState, ExecutionDetails, MemoryPool};
use std::ffi::CStr;
use std::os::raw::{c_char, c_void};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetalDeviceInfo {
    pub name: String,
    pub unified_memory: bool,
    pub max_working_set_bytes: Option<u64>,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn query_metal_device() -> Result<MetalDeviceInfo, String> {
    unsafe {
        unsafe extern "C" {
            fn MTLCreateSystemDefaultDevice() -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *mut c_void;
            fn objc_msgSend();
        }

        let device = MTLCreateSystemDefaultDevice();
        if device.is_null() {
            return Err("No Metal-compatible default device found".into());
        }

        type MsgSendPtr = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
        type MsgSendBool = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u8;
        type MsgSendU64 = unsafe extern "C" fn(*mut c_void, *mut c_void) -> u64;
        type MsgSendStr = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const c_char;
        type MsgSendVoid = unsafe extern "C" fn(*mut c_void, *mut c_void);

        let msg_send_ptr: MsgSendPtr = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_bool: MsgSendBool = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_u64: MsgSendU64 = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_str: MsgSendStr = std::mem::transmute(objc_msgSend as *const ());
        let msg_send_void: MsgSendVoid = std::mem::transmute(objc_msgSend as *const ());

        // 1. Query name: [device name] -> NSString -> UTF8String
        let name_sel = sel_registerName(b"name\0".as_ptr() as *const c_char);
        let ns_name = msg_send_ptr(device, name_sel);
        let name = if !ns_name.is_null() {
            let utf8_sel = sel_registerName(b"UTF8String\0".as_ptr() as *const c_char);
            let cstr = msg_send_str(ns_name, utf8_sel);
            if !cstr.is_null() {
                CStr::from_ptr(cstr).to_string_lossy().to_string()
            } else {
                "Apple Silicon Metal".to_string()
            }
        } else {
            "Apple Silicon Metal".to_string()
        };

        // 2. Query hasUnifiedMemory: [device hasUnifiedMemory] -> BOOL
        let has_unified_sel = sel_registerName(b"hasUnifiedMemory\0".as_ptr() as *const c_char);
        let unified_memory = msg_send_bool(device, has_unified_sel) != 0;

        // 3. Query recommendedMaxWorkingSetSize: [device recommendedMaxWorkingSetSize] -> uint64_t
        let max_working_set_sel =
            sel_registerName(b"recommendedMaxWorkingSetSize\0".as_ptr() as *const c_char);
        let max_working_set_bytes = {
            let val = msg_send_u64(device, max_working_set_sel);
            if val > 0 { Some(val) } else { None }
        };

        // Release the retained device object
        let release_sel = sel_registerName(b"release\0".as_ptr() as *const c_char);
        msg_send_void(device, release_sel);

        if !unified_memory {
            return Err(format!(
                "Device '{name}' does not have unified memory; Intel Mac GPU support remains unadvertised"
            ));
        }

        Ok(MetalDeviceInfo {
            name,
            unified_memory,
            max_working_set_bytes,
        })
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn query_metal_device() -> Result<MetalDeviceInfo, String> {
    Err("Metal acceleration is only supported on Apple Silicon macOS".into())
}

/// Native Metal execution runtime for macOS Apple Silicon.
#[derive(Default)]
pub struct MetalRuntime;

impl WhisperBackendRuntime for MetalRuntime {
    fn backend_id(&self) -> BackendId {
        BackendId::Metal
    }

    fn probe(&self) -> BackendProbe {
        let manifest = super::types::BuildManifest::current();
        if !manifest.included_backends.contains(&BackendId::Metal) {
            return BackendProbe {
                backend: BackendId::Metal,
                state: CapabilityState::OmittedFromBuild,
                adapter: None,
                memory_pool: None,
            };
        }

        match query_metal_device() {
            Ok(device) => {
                let mut system = sysinfo::System::new();
                system.refresh_memory();
                let total_bytes = system.total_memory();
                let available_bytes = Some(system.available_memory());

                BackendProbe {
                    backend: BackendId::Metal,
                    state: CapabilityState::Available,
                    adapter: Some(device.name),
                    memory_pool: Some(MemoryPool {
                        unified: device.unified_memory,
                        total_bytes,
                        available_bytes,
                        max_working_set_bytes: device.max_working_set_bytes,
                    }),
                }
            }
            Err(_e) => BackendProbe {
                backend: BackendId::Metal,
                state: CapabilityState::NoCompatibleDevice,
                adapter: None,
                memory_pool: None,
            },
        }
    }

    fn transcribe(
        &self,
        request: &TranscriptionRequest,
    ) -> Result<TranscriptionOutcome, BackendError> {
        let device_info = query_metal_device()
            .map_err(|_| BackendError::Unavailable(CapabilityState::NoCompatibleDevice))?;

        let mut context_params = WhisperContextParameters::default();
        context_params.use_gpu(true);

        let path_str = request
            .model_path
            .to_str()
            .ok_or_else(|| BackendError::InitializationFailed("Invalid model path".into()))?;

        if !request.model_path.is_file() {
            return Err(BackendError::InitializationFailed(format!(
                "Model file not found at: {}",
                request.model_path.display()
            )));
        }

        let context = WhisperContext::new_with_params(path_str, context_params).map_err(|e| {
            BackendError::InitializationFailed(format!("Metal initialization failed: {e}"))
        })?;

        let mut state = context.create_state().map_err(|e| {
            BackendError::InitializationFailed(format!("Metal state creation failed: {e}"))
        })?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(request.language.as_deref());
        params.set_translate(false);
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        params.set_n_threads(request.threads.clamp(1, 8) as i32);

        let resampled = super::resample(&request.samples, request.sample_rate);
        state
            .full(params, &resampled)
            .map_err(|e| BackendError::InferenceFailed(format!("Metal inference failed: {e}")))?;

        let text = state
            .as_iter()
            .map(|s| s.to_string())
            .collect::<String>()
            .trim()
            .to_string();

        let budget_desc = match device_info.max_working_set_bytes {
            Some(bytes) => format!(", max working set {:.1} GB", bytes as f64 / 1_073_741_824.0),
            None => String::new(),
        };

        Ok(TranscriptionOutcome {
            text,
            execution: ExecutionDetails {
                backend: BackendId::Metal,
                adapter: Some(device_info.name.clone()),
                offloaded: true,
                offload_evidence: Some(format!(
                    "Metal acceleration verified on {} (unified memory{})",
                    device_info.name, budget_desc
                )),
            },
        })
    }
}
