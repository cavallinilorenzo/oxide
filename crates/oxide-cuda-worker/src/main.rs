//! This executable alone links CUDA libraries. A crash cannot take down Oxide.
use oxide_core::dictation::{
    BackendError, CapabilityState, MemoryPool,
    cuda::{
        CudaAdapter, ENGINE_VERSION, WorkerRequest, WorkerResponse, WorkerResult, read_frame,
        write_frame,
    },
    runtime::run_whisper_on_device,
};
use std::ffi::{CStr, c_char, c_void};
use whisper_rs_sys as sys;

fn initialization(e: impl std::fmt::Display) -> BackendError {
    BackendError::InitializationFailed(e.to_string())
}

const CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR: i32 = 75;
const CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MINOR: i32 = 76;
const CU_DEVICE_ATTRIBUTE_INTEGRATED: i32 = 18;
const CU_DEVICE_ATTRIBUTE_PCI_BUS_ID: i32 = 33;
const CU_DEVICE_ATTRIBUTE_PCI_DEVICE_ID: i32 = 34;
const CU_DEVICE_ATTRIBUTE_PCI_DOMAIN_ID: i32 = 50;

type CuInit = unsafe extern "system" fn(flags: u32) -> i32;
type CuDriverGetVersion = unsafe extern "system" fn(driver_version: *mut i32) -> i32;
type CuDeviceGetCount = unsafe extern "system" fn(count: *mut i32) -> i32;
type CuDeviceGet = unsafe extern "system" fn(device: *mut i32, ordinal: i32) -> i32;
type CuDeviceGetName = unsafe extern "system" fn(name: *mut c_char, len: i32, dev: i32) -> i32;
type CuDeviceTotalMem = unsafe extern "system" fn(bytes: *mut usize, dev: i32) -> i32;
type CuDeviceGetUuid = unsafe extern "system" fn(uuid: *mut [u8; 16], dev: i32) -> i32;
type CuDeviceGetAttribute = unsafe extern "system" fn(pi: *mut i32, attrib: i32, dev: i32) -> i32;
type CuDevicePrimaryCtxRetain =
    unsafe extern "system" fn(context: *mut *mut c_void, dev: i32) -> i32;
type CuDevicePrimaryCtxRelease = unsafe extern "system" fn(dev: i32) -> i32;
type CuCtxPushCurrent = unsafe extern "system" fn(context: *mut c_void) -> i32;
type CuCtxPopCurrent = unsafe extern "system" fn(context: *mut *mut c_void) -> i32;
type CuMemGetInfo = unsafe extern "system" fn(free: *mut usize, total: *mut usize) -> i32;

struct CudaDriver {
    _module: *mut c_void,
    cu_driver_get_version: CuDriverGetVersion,
    cu_device_get_count: CuDeviceGetCount,
    cu_device_get: CuDeviceGet,
    cu_device_get_name: CuDeviceGetName,
    cu_device_total_mem: CuDeviceTotalMem,
    cu_device_get_uuid: CuDeviceGetUuid,
    cu_device_get_attribute: CuDeviceGetAttribute,
    cu_mem_get_info: Option<CuMemGetInfo>,
    cu_primary_retain: CuDevicePrimaryCtxRetain,
    cu_primary_release: CuDevicePrimaryCtxRelease,
    cu_push_current: CuCtxPushCurrent,
    cu_pop_current: CuCtxPopCurrent,
}

unsafe fn load_cuda_driver() -> Result<CudaDriver, BackendError> {
    #[cfg(windows)]
    let module = {
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryA;
        let handle = unsafe { LoadLibraryA(b"nvcuda.dll\0".as_ptr()) };
        if handle.is_null() {
            return Err(BackendError::Unavailable(
                CapabilityState::MissingDriverOrRuntime,
            ));
        }
        handle as *mut c_void
    };

    #[cfg(not(windows))]
    let module = std::ptr::null_mut();

    macro_rules! get_sym {
        ($name:literal, $t:ty) => {{
            #[cfg(windows)]
            {
                use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
                let addr = unsafe { GetProcAddress(module as _, $name.as_ptr()) };
                if addr.is_none() {
                    return Err(BackendError::Unavailable(
                        CapabilityState::MissingDriverOrRuntime,
                    ));
                }
                unsafe { std::mem::transmute::<_, $t>(addr) }
            }
            #[cfg(not(windows))]
            return Err(BackendError::Unavailable(
                CapabilityState::MissingDriverOrRuntime,
            ));
        }};
    }

    let cu_init: CuInit = get_sym!(b"cuInit\0", CuInit);
    if unsafe { cu_init(0) } != 0 {
        return Err(BackendError::Unavailable(
            CapabilityState::MissingDriverOrRuntime,
        ));
    }

    let cu_mem_get_info: Option<CuMemGetInfo> = {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
            let addr = unsafe { GetProcAddress(module as _, b"cuMemGetInfo_v2\0".as_ptr()) }
                .or_else(|| unsafe { GetProcAddress(module as _, b"cuMemGetInfo\0".as_ptr()) });
            addr.map(|a| unsafe { std::mem::transmute::<_, CuMemGetInfo>(a) })
        }
        #[cfg(not(windows))]
        None
    };

    Ok(CudaDriver {
        _module: module,
        cu_driver_get_version: get_sym!(b"cuDriverGetVersion\0", CuDriverGetVersion),
        cu_device_get_count: get_sym!(b"cuDeviceGetCount\0", CuDeviceGetCount),
        cu_device_get: get_sym!(b"cuDeviceGet\0", CuDeviceGet),
        cu_device_get_name: get_sym!(b"cuDeviceGetName\0", CuDeviceGetName),
        cu_device_total_mem: get_sym!(b"cuDeviceTotalMem_v2\0", CuDeviceTotalMem),
        cu_device_get_uuid: get_sym!(b"cuDeviceGetUuid\0", CuDeviceGetUuid),
        cu_device_get_attribute: get_sym!(b"cuDeviceGetAttribute\0", CuDeviceGetAttribute),
        cu_mem_get_info,
        cu_primary_retain: get_sym!(b"cuDevicePrimaryCtxRetain\0", CuDevicePrimaryCtxRetain),
        cu_primary_release: get_sym!(b"cuDevicePrimaryCtxRelease_v2\0", CuDevicePrimaryCtxRelease),
        cu_push_current: get_sym!(b"cuCtxPushCurrent_v2\0", CuCtxPushCurrent),
        cu_pop_current: get_sym!(b"cuCtxPopCurrent_v2\0", CuCtxPopCurrent),
    })
}

impl CudaDriver {
    // cuMemGetInfo describes the current context, not a device ordinal. Query
    // each device's primary context and restore/release it on every exit.
    fn memory(&self, device: i32) -> Option<(usize, usize)> {
        let mem_info = self.cu_mem_get_info?;
        let mut context = std::ptr::null_mut();
        // SAFETY: driver function pointers came from the loaded CUDA driver;
        // output pointers are valid and primary-context ownership is balanced.
        unsafe {
            if (self.cu_primary_retain)(&mut context, device) != 0 {
                return None;
            }
            if (self.cu_push_current)(context) != 0 {
                (self.cu_primary_release)(device);
                return None;
            }
            let mut free = 0;
            let mut total = 0;
            let measured = mem_info(&mut free, &mut total);
            let mut popped = std::ptr::null_mut();
            let restored = (self.cu_pop_current)(&mut popped);
            let released = (self.cu_primary_release)(device);
            (measured == 0 && restored == 0 && released == 0 && popped == context)
                .then_some((free, total))
        }
    }
}

fn adapters(require_native_identity: bool) -> Result<Vec<CudaAdapter>, BackendError> {
    let driver = unsafe { load_cuda_driver() }?;
    let mut driver_version = 0;
    let _ = unsafe { (driver.cu_driver_get_version)(&mut driver_version) };

    let mut count = 0;
    if unsafe { (driver.cu_device_get_count)(&mut count) } != 0 || count <= 0 {
        return Ok(Vec::new());
    }

    let mut native = Vec::new();
    let mut gpu_index = 0;
    for i in 0..unsafe { sys::ggml_backend_dev_count() } {
        let dev = unsafe { sys::ggml_backend_dev_get(i) };
        let name = unsafe { CStr::from_ptr(sys::ggml_backend_dev_name(dev)) }
            .to_string_lossy()
            .into_owned();
        if !name.starts_with("CUDA") {
            continue;
        }
        let description = unsafe { CStr::from_ptr(sys::ggml_backend_dev_description(dev)) }
            .to_string_lossy()
            .into_owned();
        let mut props = unsafe { std::mem::zeroed::<sys::ggml_backend_dev_props>() };
        unsafe { sys::ggml_backend_dev_get_props(dev, &mut props) };
        let pci = if props.device_id.is_null() {
            None
        } else {
            Some(
                unsafe { CStr::from_ptr(props.device_id) }
                    .to_string_lossy()
                    .into_owned(),
            )
        };
        native.push((gpu_index, name, description, pci));
        gpu_index += 1;
    }

    let mut devices = Vec::new();
    for i in 0..count {
        let mut dev = 0;
        if unsafe { (driver.cu_device_get)(&mut dev, i) } != 0 {
            continue;
        }

        let mut name_buf = [0 as c_char; 256];
        let name = if unsafe { (driver.cu_device_get_name)(name_buf.as_mut_ptr(), 256, dev) } == 0 {
            unsafe { CStr::from_ptr(name_buf.as_ptr()) }
                .to_string_lossy()
                .into_owned()
        } else {
            format!("NVIDIA CUDA Device {i}")
        };

        let mut major = 0;
        let mut minor = 0;
        let _ = unsafe {
            (driver.cu_device_get_attribute)(
                &mut major,
                CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MAJOR,
                dev,
            )
        };
        let _ = unsafe {
            (driver.cu_device_get_attribute)(
                &mut minor,
                CU_DEVICE_ATTRIBUTE_COMPUTE_CAPABILITY_MINOR,
                dev,
            )
        };
        let compute_capability = format!("{major}.{minor}");

        let mut is_integrated = 0;
        let _ = unsafe {
            (driver.cu_device_get_attribute)(
                &mut is_integrated,
                CU_DEVICE_ATTRIBUTE_INTEGRATED,
                dev,
            )
        };

        let mut uuid_bytes = [0u8; 16];
        let has_uuid = unsafe { (driver.cu_device_get_uuid)(&mut uuid_bytes, dev) } == 0;
        let id = if has_uuid {
            format!(
                "cuda:{}",
                uuid_bytes
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            )
        } else {
            format!("cuda:{i:04x}")
        };

        let mut total_bytes = 0usize;
        let _ = unsafe { (driver.cu_device_total_mem)(&mut total_bytes, dev) };

        let budget = driver.memory(dev);

        let memory = Some(MemoryPool {
            unified: is_integrated != 0,
            total_bytes: total_bytes as u64,
            available_bytes: budget.map(|(free, _)| free as u64),
            max_working_set_bytes: budget.map(|(_, total)| total as u64),
        });

        // GGML CUDA requires compute capability >= 5.0 (sm_50)
        let capability = if major < 5 {
            CapabilityState::InitializationFailure(format!(
                "Requires compute capability >= 5.0; found {compute_capability}"
            ))
        } else {
            CapabilityState::Available
        };

        let mut pci_bus = 0;
        let mut pci_device = 0;
        let mut pci_domain = 0;
        let has_pci = unsafe {
            (driver.cu_device_get_attribute)(&mut pci_bus, CU_DEVICE_ATTRIBUTE_PCI_BUS_ID, dev) == 0
                && (driver.cu_device_get_attribute)(
                    &mut pci_device,
                    CU_DEVICE_ATTRIBUTE_PCI_DEVICE_ID,
                    dev,
                ) == 0
                && (driver.cu_device_get_attribute)(
                    &mut pci_domain,
                    CU_DEVICE_ATTRIBUTE_PCI_DOMAIN_ID,
                    dev,
                ) == 0
        };
        let pci_id = format!("{pci_domain:04x}:{pci_bus:02x}:{pci_device:02x}.0");

        let matches: Vec<_> = native
            .iter()
            .filter(|(_, _, description, native_pci)| {
                if let Some(native_pci) = native_pci {
                    has_pci && native_pci == &pci_id
                } else {
                    !require_native_identity && description == &name
                }
            })
            .collect();
        if require_native_identity && (!has_uuid || !has_pci || matches.len() != 1) {
            continue;
        }
        let matching = matches.first();
        let native_index = matching.map_or(i, |d| d.0);
        let native_backend = matching.map_or_else(|| format!("CUDA{i}"), |d| d.1.clone());

        devices.push(CudaAdapter {
            id,
            name,
            driver: (driver_version > 0).then(|| {
                format!(
                    "NVIDIA {}.{}",
                    driver_version / 1000,
                    (driver_version % 1000) / 10
                )
            }),
            compute_capability,
            native_index,
            native_backend,
            memory,
            capability,
        });
    }

    Ok(devices)
}

fn native_pci_id(name: &str) -> Result<String, BackendError> {
    for i in 0..unsafe { sys::ggml_backend_dev_count() } {
        let dev = unsafe { sys::ggml_backend_dev_get(i) };
        let native = unsafe { CStr::from_ptr(sys::ggml_backend_dev_name(dev)) };
        if native.to_bytes() == name.as_bytes() {
            let mut props = unsafe { std::mem::zeroed::<sys::ggml_backend_dev_props>() };
            unsafe { sys::ggml_backend_dev_get_props(dev, &mut props) };
            if !props.device_id.is_null() {
                return Ok(unsafe { CStr::from_ptr(props.device_id) }
                    .to_string_lossy()
                    .into_owned());
            }
        }
    }
    Err(initialization(
        "CUDA benchmark requires native PCI identity",
    ))
}

fn execute(message: WorkerRequest) -> Result<WorkerResult, BackendError> {
    match message {
        WorkerRequest::Probe => Ok(WorkerResult::Adapters(adapters(false)?)),
        WorkerRequest::Transcribe {
            request,
            adapter_id,
        } => {
            let device = adapters(false)?
                .into_iter()
                .find(|d| d.id == adapter_id)
                .ok_or(BackendError::Unavailable(
                    CapabilityState::NoCompatibleDevice,
                ))?;
            if device.capability != CapabilityState::Available {
                return Err(BackendError::Unavailable(device.capability));
            }
            oxide_core::dictation::cuda::check_memory(&device, &request.model_path)?;
            let (text, _, _) = run_whisper_on_device(&request, true, device.native_index)?;
            Ok(WorkerResult::Transcription {
                text,
                adapter_id: device.id,
                native_backend: device.native_backend,
            })
        }
    }
}

fn main() {
    if std::env::args().any(|arg| arg == "--dictation-benchmark-worker") {
        use oxide_core::dictation::{
            BackendId, BackendProbe,
            benchmark::{NativeDevice, worker_main_with},
            resources::BackendCandidate,
        };
        worker_main_with(|backend, adapter_id| {
            if backend != BackendId::Cuda {
                return Err(BackendError::Unavailable(CapabilityState::OmittedFromBuild));
            }
            let device = adapters(true)?
                .into_iter()
                .find(|d| Some(&d.id) == adapter_id.as_ref())
                .ok_or(BackendError::Unavailable(
                    CapabilityState::NoCompatibleDevice,
                ))?;
            Ok(NativeDevice {
                native_device_id: Some(native_pci_id(&device.native_backend)?),
                candidate: BackendCandidate {
                    probe: BackendProbe {
                        backend,
                        state: device.capability,
                        adapter: Some(device.name),
                        memory_pool: device.memory,
                    },
                    adapter_id: Some(device.id),
                    driver_version: device.driver,
                    runtime_version: oxide_core::dictation::resources::runtime_version(backend),
                },
                native_index: device.native_index,
                native_backend: device.native_backend,
            })
        });
        return;
    }
    let response = WorkerResponse {
        protocol_version: 1,
        engine_version: ENGINE_VERSION.into(),
        result: read_frame(std::io::stdin().lock())
            .map_err(initialization)
            .and_then(execute),
    };
    if let Err(e) = write_frame(std::io::stdout().lock(), &response) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
