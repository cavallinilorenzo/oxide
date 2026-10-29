//! This executable alone links the Vulkan loader. A crash cannot take down Oxide.
use ash::{Entry, vk};
use oxide_core::dictation::{
    BackendError, CapabilityState, MemoryPool,
    runtime::run_whisper_on_device,
    vulkan::{
        ENGINE_VERSION, VulkanAdapter, WorkerRequest, WorkerResponse, WorkerResult, read_frame,
        write_frame,
    },
};
use std::ffi::CStr;
use whisper_rs_sys as sys;

fn initialization(e: impl std::fmt::Display) -> BackendError {
    BackendError::InitializationFailed(e.to_string())
}

// All native pointers below are owned by the live Vulkan instance or GGML's
// process-lifetime registry. Strings are copied before destroying the instance.
unsafe fn enumerate(instance: &ash::Instance) -> Result<Vec<VulkanAdapter>, BackendError> {
    let physical = unsafe { instance.enumerate_physical_devices() }.map_err(initialization)?;
    let mut native = Vec::new();
    let mut gpu_index = 0;
    for i in 0..unsafe { sys::ggml_backend_dev_count() } {
        let dev = unsafe { sys::ggml_backend_dev_get(i) };
        let name = unsafe { CStr::from_ptr(sys::ggml_backend_dev_name(dev)) }
            .to_string_lossy()
            .into_owned();
        if !name.starts_with("Vulkan") {
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
    for dev in physical {
        let props = unsafe { instance.get_physical_device_properties(dev) };
        if props.api_version < vk::API_VERSION_1_2 {
            continue;
        }
        let extensions = unsafe { instance.enumerate_device_extension_properties(dev) }
            .map_err(initialization)?;
        let has_extension = |name: &CStr| {
            extensions
                .iter()
                .any(|e| unsafe { CStr::from_ptr(e.extension_name.as_ptr()) } == name)
        };
        let mut identity = vk::PhysicalDeviceIDProperties::default();
        let mut driver = vk::PhysicalDeviceDriverProperties::default();
        let mut pci = vk::PhysicalDevicePCIBusInfoPropertiesEXT::default();
        let mut properties = vk::PhysicalDeviceProperties2::default()
            .push_next(&mut identity)
            .push_next(&mut driver);
        let has_pci = has_extension(ash::ext::pci_bus_info::NAME);
        if has_pci {
            properties = properties.push_next(&mut pci);
        }
        unsafe { instance.get_physical_device_properties2(dev, &mut properties) };
        let name = unsafe { CStr::from_ptr(props.device_name.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        let pci_id = format!(
            "{:04x}:{:02x}:{:02x}.{}",
            pci.pci_domain, pci.pci_bus, pci.pci_device, pci.pci_function
        );
        let matching: Vec<_> = native
            .iter()
            .filter(|(_, _, description, native_pci)| {
                if let Some(native_pci) = native_pci {
                    has_pci && native_pci == &pci_id
                } else {
                    description == &name
                }
            })
            .collect();
        let unique_name = physical_name_count(instance, &name)? == 1;
        let selected = matching
            .first()
            .filter(|m| matching.len() == 1 && (m.3.is_some() || unique_name));
        let mut vk11 = vk::PhysicalDeviceVulkan11Features::default();
        let mut features = vk::PhysicalDeviceFeatures2::default().push_next(&mut vk11);
        unsafe { instance.get_physical_device_features2(dev, &mut features) };
        let timestamp_supported =
            unsafe { instance.get_physical_device_queue_family_properties(dev) }
                .iter()
                .any(|q| {
                    q.queue_flags.contains(vk::QueueFlags::COMPUTE) && q.timestamp_valid_bits > 0
                });
        let capability = if vk11.storage_buffer16_bit_access == 0 || !timestamp_supported {
            CapabilityState::InitializationFailure(
                "Requires storageBuffer16BitAccess and compute timestamps".into(),
            )
        } else if selected.is_none() || identity.device_uuid.iter().all(|b| *b == 0) {
            CapabilityState::InitializationFailure(
                "Native Vulkan adapter cannot be identified unambiguously".into(),
            )
        } else {
            CapabilityState::Available
        };
        let id = format!(
            "vulkan:{}",
            identity
                .device_uuid
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let mut budget = vk::PhysicalDeviceMemoryBudgetPropertiesEXT::default();
        let mut memory = vk::PhysicalDeviceMemoryProperties2::default();
        let has_budget = has_extension(ash::ext::memory_budget::NAME);
        if has_budget {
            memory = memory.push_next(&mut budget);
        }
        unsafe { instance.get_physical_device_memory_properties2(dev, &mut memory) };
        let heap = memory.memory_properties.memory_heaps
            [..memory.memory_properties.memory_heap_count as usize]
            .iter()
            .enumerate()
            .filter(|(_, h)| h.flags.contains(vk::MemoryHeapFlags::DEVICE_LOCAL))
            .max_by_key(|(_, h)| h.size);
        let memory = heap.map(|(i, h)| MemoryPool {
            unified: props.device_type == vk::PhysicalDeviceType::INTEGRATED_GPU,
            total_bytes: h.size,
            available_bytes: has_budget
                .then(|| budget.heap_budget[i].saturating_sub(budget.heap_usage[i])),
            max_working_set_bytes: has_budget.then_some(budget.heap_budget[i]),
        });
        let driver_name = unsafe { CStr::from_ptr(driver.driver_name.as_ptr()) }.to_string_lossy();
        let driver_info = unsafe { CStr::from_ptr(driver.driver_info.as_ptr()) }.to_string_lossy();
        devices.push(VulkanAdapter {
            id,
            name,
            driver: (!driver_name.is_empty()).then(|| {
                format!(
                    "{driver_name}: {driver_info} (raw {})",
                    props.driver_version
                )
            }),
            api_version: format!(
                "{}.{}.{}",
                vk::api_version_major(props.api_version),
                vk::api_version_minor(props.api_version),
                vk::api_version_patch(props.api_version)
            ),
            native_index: selected.map_or(-1, |d| d.0),
            native_backend: selected.map_or_else(String::new, |d| d.1.clone()),
            memory,
            capability,
        });
    }
    Ok(devices)
}

fn physical_name_count(instance: &ash::Instance, name: &str) -> Result<usize, BackendError> {
    let devices = unsafe { instance.enumerate_physical_devices() }.map_err(initialization)?;
    Ok(devices
        .iter()
        .filter(|d| {
            let props = unsafe { instance.get_physical_device_properties(**d) };
            unsafe { CStr::from_ptr(props.device_name.as_ptr()) }.to_string_lossy() == name
        })
        .count())
}

fn adapters() -> Result<Vec<VulkanAdapter>, BackendError> {
    let entry = unsafe { Entry::load() }
        .map_err(|_| BackendError::Unavailable(CapabilityState::MissingDriverOrRuntime))?;
    let info = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_2);
    let create = vk::InstanceCreateInfo::default().application_info(&info);
    let instance = unsafe { entry.create_instance(&create, None) }.map_err(|e| {
        if e == vk::Result::ERROR_INCOMPATIBLE_DRIVER {
            BackendError::Unavailable(CapabilityState::MissingDriverOrRuntime)
        } else {
            initialization(e)
        }
    })?;
    let result = unsafe { enumerate(&instance) };
    unsafe { instance.destroy_instance(None) };
    result
}

fn execute(message: WorkerRequest) -> Result<WorkerResult, BackendError> {
    match message {
        WorkerRequest::Probe => Ok(WorkerResult::Adapters(adapters()?)),
        WorkerRequest::Transcribe {
            request,
            adapter_id,
        } => {
            let device = adapters()?.into_iter().find(|d| d.id == adapter_id).ok_or(
                BackendError::Unavailable(CapabilityState::NoCompatibleDevice),
            )?;
            if device.capability != CapabilityState::Available {
                return Err(BackendError::Unavailable(device.capability));
            }
            oxide_core::dictation::vulkan::check_memory(&device, &request.model_path)?;
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
            if backend != BackendId::Vulkan {
                return Err(BackendError::Unavailable(CapabilityState::OmittedFromBuild));
            }
            let device = adapters()?
                .into_iter()
                .find(|d| Some(&d.id) == adapter_id.as_ref())
                .ok_or(BackendError::Unavailable(
                    CapabilityState::NoCompatibleDevice,
                ))?;
            Ok(NativeDevice {
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
