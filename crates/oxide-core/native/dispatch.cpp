// MIT; see whisper-1.8.3/LICENSE for the pinned ggml headers.
// Installed only in a disposable benchmark process, before context creation.
#include "ggml-backend-impl.h"
#include <cstring>
#include <mutex>
#include <unordered_map>

struct oxide_dispatch_snapshot {
    uint64_t completed_graphs;
    uint64_t matrix_ops;
    uint64_t failures;
    char native_backend[128];
    char adapter[256];
    char device_id[128];
};

static std::mutex guard;
static std::unordered_map<ggml_backend_t, ggml_backend_i> streams;
static ggml_backend_dev_t selected = nullptr;
static ggml_backend_t (*initialize)(ggml_backend_dev_t, const char *) = nullptr;
static oxide_dispatch_snapshot counters = {};

static ggml_status compute(ggml_backend_t backend, ggml_cgraph * graph) {
    ggml_backend_i original;
    {
        std::lock_guard<std::mutex> lock(guard);
        original = streams.at(backend);
    }
    // Count nonempty matrix operations in the graph actually sent to the GPU
    // implementation. Metadata-only graphs and buffer copies do not qualify.
    uint64_t matrix_ops = 0;
    for (int i = 0; i < ggml_graph_n_nodes(graph); ++i) {
        const ggml_tensor * node = ggml_graph_node(graph, i);
        if (!ggml_is_empty(node) && (node->op == GGML_OP_MUL_MAT || node->op == GGML_OP_MUL_MAT_ID)) {
            ++matrix_ops;
        }
    }
    const ggml_status status = original.graph_compute(backend, graph);
    if (status == GGML_STATUS_SUCCESS) {
        // CUDA checks cudaStreamSynchronize; Metal waits and checks every command
        // buffer status. A driver failure aborts this worker before any result.
        original.synchronize(backend);
    }
    std::lock_guard<std::mutex> lock(guard);
    if (status != GGML_STATUS_SUCCESS || backend->device != selected) {
        ++counters.failures;
    } else if (matrix_ops > 0) {
        ggml_backend_dev_props props = {};
        ggml_backend_dev_get_props(backend->device, &props);
        // Copy identity from the executing stream's device, not the request.
        const auto copy = [](auto & dst, const char * src) {
            if (src && std::strlen(src) < sizeof(dst)) {
                std::strcpy(dst, src);
            }
        };
        copy(counters.native_backend, props.name);
        copy(counters.adapter, props.description);
        copy(counters.device_id, props.device_id);
        ++counters.completed_graphs;
        counters.matrix_ops += matrix_ops;
    }
    return status;
}

static void release(ggml_backend_t backend) {
    ggml_backend_i original;
    {
        std::lock_guard<std::mutex> lock(guard);
        original = streams.at(backend);
        streams.erase(backend);
    }
    backend->iface = original;
    original.free(backend);
}

static ggml_backend_t init(ggml_backend_dev_t device, const char * params) {
    ggml_backend_t backend = initialize(device, params);
    if (!backend) {
        return nullptr;
    }
    if (backend->device != selected || !backend->iface.graph_compute || !backend->iface.synchronize) {
        backend->iface.free(backend);
        return nullptr;
    }
    std::lock_guard<std::mutex> lock(guard);
    streams.emplace(backend, backend->iface);
    backend->iface.graph_compute = compute;
    backend->iface.free = release;
    return backend;
}

extern "C" bool oxide_dispatch_install(const char * name, const char * adapter, const char * device_id) {
    if (selected) {
        return false;
    }
    ggml_backend_dev_t match = nullptr;
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t device = ggml_backend_dev_get(i);
        ggml_backend_dev_props props = {};
        ggml_backend_dev_get_props(device, &props);
        if (std::strcmp(props.name, name) != 0 || std::strcmp(props.description, adapter) != 0) {
            continue;
        }
        const auto type = ggml_backend_dev_type(device);
        if ((type != GGML_BACKEND_DEVICE_TYPE_GPU && type != GGML_BACKEND_DEVICE_TYPE_IGPU) ||
            device->reg->api_version != GGML_BACKEND_API_VERSION ||
            (device_id && (!props.device_id || std::strcmp(props.device_id, device_id) != 0)) || match) {
            return false;
        }
        match = device;
    }
    if (!match || !match->iface.init_backend) {
        return false;
    }
    selected = match;
    initialize = match->iface.init_backend;
    match->iface.init_backend = init;
    return true;
}

extern "C" void oxide_dispatch_reset() {
    std::lock_guard<std::mutex> lock(guard);
    counters = {};
}

extern "C" void oxide_dispatch_read(oxide_dispatch_snapshot * result) {
    std::lock_guard<std::mutex> lock(guard);
    *result = counters;
}
