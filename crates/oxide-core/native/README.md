# Benchmark GPU execution instrumentation

`dispatch.cpp` uses the exact headers bundled with the crates.io release
`whisper-rs-sys = 0.15.0` (whisper.cpp 1.8.3, ggml backend ABI 2).
The crate archive SHA-256 is
`6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f`.
Core pins this native dependency explicitly. Header hashes:

```text
3793a2175be355619cc426982706b7fa94ad801b66d2aeef4b95e68c434ba0ef  ggml-alloc.h
470f4ede95a1a66edb7259981c1e8c98e2827de765323fe1672badf8f99f4546  ggml-backend-impl.h
3774c77515070f40f7dfb0aefdcb36f940537730e5891431dfeea338723923d5  ggml-backend.h
70c93e25d18b661ef982ee3cab8dd75734d9cd20b59bca5deb7073a5e6f338e1  ggml.h
```

The headers are copied unchanged from that archive: `ggml/include/{ggml.h,
ggml-alloc.h,ggml-backend.h}` and `ggml/src/ggml-backend-impl.h`.
Their MIT notice is retained in `whisper-1.8.3/LICENSE`. Oxide's shim is MIT.
`build.rs` compiles it with the existing C++ toolchain through `cc`; it needs no
CUDA Toolkit or Metal headers, and adds no GPU library to the CPU host.

The shim is installed only by a disposable CUDA/Metal benchmark child, before
Whisper context creation. It validates a unique native GPU device and ABI 2,
wraps that device's stream initialization, then wraps its actual `graph_compute`
callback. It observes the graph sent to the native GPU implementation and counts
nonempty `MUL_MAT`/`MUL_MAT_ID` operations only after successful graph execution
and synchronization. CUDA's pinned synchronize callback checks
`cudaStreamSynchronize`; Metal's waits and checks command-buffer completion.
Those backend implementations do not execute these matrix operations on CPU.
An initialization failure, asynchronous driver error or CPU fallback cannot
supply completed graph counters. The count is completed matrix-bearing graph
dispatches, not an individual kernel count or GPU elapsed time; fusion can map
multiple matrix operations to one kernel. Synchronization adds benchmark overhead.

Counters reset after loading and immediately before each inference. Native
backend, adapter description and (CUDA) PCI identity are copied from the executing
stream's device. CUDA resolves the physical UUID to exactly one native PCI device;
missing/ambiguous mappings fail. Metal retains the existing single Apple Silicon
device-name identity (Intel/multiple-device support is not advertised).

The Rust result retains revision `whisper-1.8.3-ggml-abi2-dispatch-v1`, stable
adapter ID, native identity and four snapshots (warmup, measured 1–3).
Every snapshot needs positive completed matrix-graph dispatches with matching
identity and no failures. Parent-process and cache validation both enforce this;
old CUDA/Metal caches without typed evidence are discarded. Runtime keys include
the instrumentation revision, separating these timings from older builds.

When upgrading the native dependency, re-audit both backend implementations,
replace all four headers from the same archive, update their hashes and the exact
Cargo pin, and bump the evidence revision. ABI 2 alone is not a revision pin.
Keep the ordinary dictation, CPU and Vulkan paths free of these hooks.

CUDA memory queries briefly retain/push the enumerated device's primary context,
then pop/release it after `cuMemGetInfo`; the current context determines the memory
report. See NVIDIA's [context management](https://docs.nvidia.com/cuda/cuda-driver-api/cuda_driver_api/group__CUDA__CTX.html)
and [primary context contract](https://docs.nvidia.com/cuda/archive/12.4.1/cuda-driver-api/group__CUDA__PRIMARY__CTX.html).
Missing symbols or budgets remain unavailable, never invented.

Deterministic process/cache tests run without GPU hardware. No installed model
or CUDA Toolkit was available in this task environment, so no physical CUDA/Metal
measurement is claimed. The single final release validation in #235 must capture
real CUDA and Metal runs (one warmup plus all three measured snapshots), driver /
adapter / runtime keys, cancellation and timeout recovery, and ordinary dictation
after a failed check. Package/library redistribution sign-off remains with #234.
