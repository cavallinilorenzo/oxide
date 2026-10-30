# Local dictation

The backend now supports six multilingual models through a versioned catalogue
and explicit lifecycle APIs. See [model catalogue and lifecycle](dictation-models.md)
for migration, API usage, verification evidence and the hardware-validation handoff.
Settings exposes all six exact model IDs, per-model download size, provisional memory
estimates and speed/quality tradeoffs. Download, cancel, retry and delete are explicit.
A download never selects a model: select it only once installed, then save Settings.
The selected enabled model cannot be deleted; the backend also protects saved/leased models.

An explicit offline performance-check API now measures an installed combination
using bundled speech, with no microphone or automatic downloads. It reports
cold loading separately from the median of three warm runs and improves resource
advice using local measurements. See [performance checks and smoke evidence](dictation-resources.md#explicit-local-performance-check-232)
for bounds, cancellation, cache invalidation and troubleshooting. Use **Check performance** in Settings to see loading, warmup and three measured
runs, cancel, or read cold-load/median/RTF results. A check never changes Settings.
Choose CPU or an explicit available backend/adapter for an unambiguous check.
CUDA/Metal checks require completed native GPU graph dispatch counters for warmup
and all three measured runs. See the [instrumentation ABI/build notes](../crates/oxide-core/native/README.md).
Physical CUDA/Metal measurement sign-off remains with #235.

In Settings, explicitly download a model (the existing Small cache is reused), enable dictation, choose a language
(`auto`, `it`, `en`, or another Whisper language code), and save. Existing CPU/GPU and language settings are preserved, with Small for legacy settings.
New installations remain disabled; Auto, CPU and GPU are offered.
The shortcut is Ctrl+Shift+R on Windows/Linux or Cmd+Shift+R on macOS, rebindable
in Settings. Focus a chat composer or terminal, press once to speak and again to
insert. The chat microphone button does the same. Escape cancels. Recordings stop
after two minutes. Text is inserted without submitting; terminal control characters
and newlines become spaces. Closing an input discards its pending result.

Audio is captured from the system default microphone in memory and never uploaded
or saved. Models are kept in `~/.oxide/models/` (including the existing `ggml-small.bin`); each is downloaded only
when Download is pressed, with progress, SHA-256 verification and atomic publication.
No provider credentials, Python runtime, transcription subscription or API key is needed.
Silence and very short recordings are ignored. As with other speech recognition,
review names, paths and commands before submitting.

Resource advice uses current CPU compatibility, RAM, GPU budgets/topology and disk.
Small has a provisional 2 GiB peak estimate, plus a RAM reserve of at least 1 GiB
or 20% of total RAM. Discrete GPUs keep 20% budget headroom. Advice without a local
benchmark remains provisional; it never changes the selected model or starts a
download. See [resource policy and examples](dictation-resources.md).

## GPU and building

CPU works on all supported desktop platforms. macOS builds include Metal.
Windows x64 uses an optional `oxide-vulkan-worker.exe` for Vulkan, the shared
AMD/NVIDIA path without ROCm/HIP. RX 5600 XT inference is physically validated;
NVIDIA inference remains unvalidated. The application itself links CPU Whisper only:
a missing Vulkan loader, incompatible driver or worker crash leaves CPU usable.
Explicit GPU mode rejects inference without native GPU execution evidence.
Auto retains its single CPU retry policy. Linux GPU expansion is outside this slice.
`dumpbin /dependents` on the locally built executables confirmed that the host
does not import `vulkan-1.dll`, while the isolated worker does.

## Recoverable runtime architecture and extension points

### Windows native-build diagnostic path

Install Visual Studio Build Tools with the Desktop development with C++ workload,
Windows SDK and CMake/Ninja tools; LLVM/libclang 18.1.1; and Vulkan SDK 1.4.363.0
(including glslc). The validated native toolchain is MSVC 14.51.36231 from Build
Tools 18.10.2, CMake 4.3.1-msvc1 and shaderc 2026.4. Binding/native versions are
pinned by the committed lockfiles: whisper-rs 0.16.0, whisper-rs-sys 0.15.0,
bundled whisper.cpp 1.8.3. These are the tested versions, not a claim that other
toolchains or every Vulkan GPU work.

From the repository root in an **x64 Native Tools Command Prompt**:

```bat
set LIBCLANG_PATH=C:\path\to\directory-containing-libclang
set PATH=%VULKAN_SDK%\Bin;%PATH%
set CARGO_TARGET_DIR=C:\oxide-build
pnpm --dir web install --frozen-lockfile
pnpm --dir web build
node tools/dictation-build.mjs cpu
node tools/dictation-build.mjs vulkan
C:\oxide-build\dv\debug\oxide-app.exe
```

The command selects MSVC (`cl.exe`) and Ninja for both the outer native build
and the nested Vulkan shader compiler build. It removes inherited `CMAKE_*`
settings, including Visual Studio instance, platform, toolset and toolchain
selections, which cannot be reused with Ninja. It uses separate
`target/dc` (CPU app), `target/dv` (Vulkan-enabled host) and `target/vw`
(native Vulkan worker) directories (under
`CARGO_TARGET_DIR` when set). These direct diagnostic builds retain compiler
caches; use `cargo clean --target-dir <directory>` to remove each. The command
copies the worker beside the Vulkan-enabled host. The normal one-shot app build and local
check runner keep their existing temporary-build behavior.

The worker has an independent Cargo workspace/lockfile so its Vulkan feature
cannot unify into the CPU host during a workspace build. The legacy
`dictation-vulkan` app feature is a compatibility marker; enabling it alone
does not build or package the worker. Installer integration belongs to the
packaging ticket in #225. End users of a packaged worker need a compatible
graphics driver, not a developer SDK or shader compiler.

Use a short `CARGO_TARGET_DIR` as shown: the shader generator's deeply nested
compiler checks can exceed MSVC's object/PDB path limit, producing misleading
`C1041` or `C1083` compiler-detection failures even with a working compiler.

Workers are discovered beside the application executable, or through the explicit
development override `OXIDE_VULKAN_WORKER`. `BuildManifest::current()` lists Vulkan
when this worker is present; probes separately report its runtime availability.
Use `OXIDE_VULKAN_ADAPTER=<stable id>` to request a particular enumerated adapter;
an absent ID fails instead of selecting a different card. The public runtime
also accepts an adapter ID directly. GUI selection/persistence is a separate
settings slice. With no requested ID, the runtime chooses the first compatible
adapter. This is a provisional choice, not a measured performance recommendation.

Enumeration reports device UUID, API/driver version and the largest device-local
heap. `VK_EXT_memory_budget`, when supported, supplies budget minus current-process
usage; missing budgets remain unknown. Integrated GPU memory is marked unified.
Before loading Small, the worker refreshes this data and requires a provisional
2 GiB working set plus 20% budget headroom. This estimate is conservative and has
not been calibrated as a general performance or peak-memory guarantee.

The pinned native backend requires Vulkan 1.2 and storageBuffer16BitAccess. Oxide
also requires compute timestamps to verify execution. Ambiguous native-to-physical
adapter mappings are rejected rather than guessed. Multiple identical cards need
native PCI identity support for an unambiguous mapping.

Diagnostic observation (2026-10-29, Windows 11 Pro x64, build 26300.9818): Visual Studio Build Tools
18.10.2, MSVC 14.51.36231, CMake 4.3.1-msvc1, Vulkan SDK 1.4.363.0 and
shaderc 2026.4 reproduced the nested compiler failure at a 272-character
object path in the normal checkout. `vulkaninfoSDK.exe --summary` from that
SDK detected an AMD Radeon RX 5600 XT, vendor/device `1002:731f`, Vulkan
1.4.315, AMD driver 26.10.1 (Windows driver 32.0.21045.16010).
The saved Small model loaded and transcribed whisper.cpp v1.8.3's
[`samples/jfk.wav`](https://github.com/ggml-org/whisper.cpp/blob/v1.8.3/samples/jfk.wav)
(SHA-256 `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e`).
The result included "And so my fellow Americans, ask not what your country can do
for you, ask what you can do for your country."

Native evidence: `whisper_backend_init_gpu: using Vulkan0 backend`, followed by
`Vulkan Timings: Total time: 2252.44 us.` for a submitted GPU graph, with timed
MUL_MAT operations. This timestamp is one graph's GPU time, not end-to-end latency
or a benchmark. The device ID was `vulkan:00000000290000000000000000000000`.
No NVIDIA card was available; NVIDIA inference and final cross-vendor hardware
sign-off remain unvalidated and tracked by #235. A single cold-process comparison
on the same fixture returned identical text: CPU 6.262 s, Vulkan 4.884 s including
model loading. Other native builds were running concurrently; these observations
are not a benchmark or a latency guarantee. Distributed-package validation remains
with #234/#235.

Reproduce loader diagnostics with:

```bat
"%VULKAN_SDK%\Bin\vulkaninfoSDK.exe" --summary
```

For the actual isolated runtime, without opening a microphone, run:

```bat
cargo run --locked -p oxide-core --example vulkan_diagnostic -- C:\oxide-build\vw\debug\oxide-vulkan-worker.exe
cargo run --locked -p oxide-core --example vulkan_diagnostic -- C:\oxide-build\vw\debug\oxide-vulkan-worker.exe C:\Users\YOU\.oxide\models\ggml-small.bin C:\fixtures\jfk.wav vulkan:00000000290000000000000000000000
```

The first command enumerates adapters. The second takes an existing model, a mono
PCM16 WAV (at most two minutes), and an optional adapter ID from enumeration.
It prints transcription plus actual execution details, and fails if offload is
not evidenced. Fixtures are explicitly supplied; the diagnostic downloads nothing.
Do not replace your adapter ID with the example ID unless enumeration matches it.
For a CPU comparison, replace the worker path with `cpu` and omit the adapter ID.
The reported wall time includes model loading and runtime initialization.

Run worker checks separately from the CPU workspace (in the same native-tools
environment, with a short `CARGO_TARGET_DIR`):

```bat
cargo fmt --manifest-path crates/oxide-vulkan-worker/Cargo.toml --check
cargo clippy --locked --manifest-path crates/oxide-vulkan-worker/Cargo.toml --all-targets -- -D warnings
```

The dictation architecture separates microphone capture and lifecycle coordination
from native model inference behind the `WhisperBackendRuntime` boundary:

- **Runtime ownership**: The `Dictation` coordinator in `oxide_core::dictation`
  owns the in-flight recording session and delegates inference to a backend
  runtime (`Arc<dyn WhisperBackendRuntime>`). Host application startup does not
  load or initialize GPU libraries; backend discovery is non-blocking and isolated
  so driver or runtime failures cannot crash Oxide or disable CPU dictation.
- **Build manifest and pinned versions**: `BuildManifest::current()` exposes
  pinned binding/native versions (`whisper-rs 0.16.0` and its bundled `whisper.cpp`)
  and the list of included backends. Vulkan is discovered as an optional worker;
  build inclusion never proves runtime GPU use.
- **Capability states vs. verified execution**: Probes return typed capability
  states (`omittedFromBuild`, `noCompatibleDevice`, `missingDriverOrRuntime`,
  `initializationFailure`, `insufficientMemory`, `available`). Probes can **never**
  claim `verifiedByInference`; that status is only attained after a successful
  inference run returns concrete offload evidence (`ExecutionDetails`: backend,
  adapter name, offloaded boolean, and evidence string). CPU mode never requests
  offload.
- **Snapshotting and recovery policy**:
  - Parameters (`language`, `model`, `device`) are snapshotted at recording start.
    Settings changes during an active recording do not mutate the in-flight session.
  - In `Auto` mode: if the primary backend fails, Oxide retries once on CPU if
    a fresh model-specific RAM check preserves the policy reserve, attaching the
    fallback reason to execution details. Unsafe or unknown budgets refuse retry.
    See [resource policy v1](dictation-resources.md) for estimates, accounting,
    confidence, benchmark inputs and example decisions for Settings.
  - In explicit `GPU` mode: failures are reported immediately with an offer to
    switch to CPU. CPU is never silently substituted for GPU.
- **Backend extension points and worker protocol**:
  - Direct native backends implement the `WhisperBackendRuntime` trait (`backend_id`, `probe`,
    `transcribe`).
  - Where GPU drivers or runtimes risk process instability, runtimes can execute as isolated
    worker child processes. Worker processes communicate over standard I/O using length-prefixed
    JSON messages corresponding to `TranscriptionRequest` and `TranscriptionOutcome`.
    Vulkan uses one request/response per worker, four-byte little-endian JSON frame
    lengths and a 64 MiB frame limit. Responses include `protocol_version: 1` and
    `engine_version: "1.8.3"`; mismatches fail. Closing stdin before a complete
    request fails. Cancellation kills/reaps the worker, discarding the pending result;
    probes time out after 15 seconds and inference after 180 seconds.
  - Vulkan enables the pinned engine's `GGML_VK_PERF_LOGGER` and requires positive
    GPU graph timestamps and MUL_MAT timings from the requested native backend.
    This instrumentation waits for GPU fences and adds overhead. It provides real
    execution evidence rather than inferring offload from a flag or model allocation.
  - Every backend implementation returns concrete `ExecutionDetails` providing actual
    device name and offload proof. A successful transcription alone is never accepted
    as GPU evidence.

### macOS Apple Silicon Metal validation

- **Architecture filtering**: Metal acceleration is enabled exclusively for Apple Silicon
  Macs (`aarch64`). Intel Mac GPU support remains unadvertised until separately validated on
  supported x86_64 hardware.
- **Device enumeration and unified memory**: Probes query the physical Metal device via
  the Metal framework (`MTLCreateSystemDefaultDevice`). Topology is reported as a single shared
  unified pool (`MemoryPool: { unified: true, totalBytes, availableBytes, maxWorkingSetBytes }`),
  derived from Metal's `recommendedMaxWorkingSetSize` without inventing separate dedicated VRAM.
  Missing signals remain `None` (unknown).
- **Embedded shaders**: Shaders are compiled and embedded into native binaries via
  `GGML_METAL_EMBED_LIBRARY`, guaranteeing zero external developer tool dependencies on the
  end-user machine in both development and packaged distributed bundles.
- **Tested environment**:
  - Operating System: macOS 27.2 (Darwin 26B123, arm64)
  - Processor: Apple M1 Pro (10 cores, Metal GPU Family Apple7, Metal4)
  - Working set budget: 12.71 GB recommended working set
  - Native runtime: `whisper-rs 0.16.0` (bundled `whisper.cpp`) with embedded Metal library

Building whisper-rs requires CMake, a C/C++ compiler, and libclang for bindgen. Set
`LIBCLANG_PATH` to the directory containing libclang when it is outside the search
path. Linux also needs ALSA development headers. macOS uses the system microphone
permission and the bundled NSMicrophoneUsageDescription. Windows needs microphone
access for desktop applications enabled in system privacy settings.

### Windows NVIDIA CUDA inference

CUDA acceleration on Windows runs as an isolated worker process (`oxide-cuda-worker.exe`),
mirroring the Vulkan worker design. The host application never links or loads CUDA DLLs
directly, ensuring machines without an NVIDIA GPU or driver launch Oxide safely and fall
back to CPU or Vulkan dictation without crashing.

- **Build and setup**:
  - `tools/dictation-build.mjs cuda` builds `oxide-app` with `--features dictation-cuda`
    and compiles `oxide-cuda-worker` with `CARGO_TARGET_DIR=target/cw`.
  - Requires Visual Studio Build Tools (MSVC `cl.exe`), CMake, Ninja, and the NVIDIA CUDA
    Toolkit (with `CUDA_PATH` and `nvcc.exe` in `PATH`).
  - Worker binaries are discovered alongside the application or via `OXIDE_CUDA_WORKER`.
- **Architecture and driver requirements**:
  - Requires an NVIDIA GPU with compute capability >= 5.0 (Maxwell, Pascal, Turing,
    Ampere, Ada Lovelace, Blackwell). Older architectures (e.g. Kepler, Fermi) report
    `CapabilityState::InitializationFailure`.
  - Probes query `nvcuda.dll` via the CUDA Driver API (`cuInit`, `cuDeviceGetUuid`,
    `cuDeviceTotalMem`, `cuMemGetInfo`, `cuDeviceGetAttribute`). If `nvcuda.dll` is
    absent or the driver is missing, the worker exits or reports
    `CapabilityState::MissingDriverOrRuntime`.
  - Stable adapter IDs follow `cuda:<device_uuid_hex>`, aligning with physical UUIDs
    reported by Vulkan for the same physical card.
- **Diagnostics**:
  Run diagnostic enumeration and test inference with:
  ```bat
  cargo run --locked -p oxide-core --example cuda_diagnostic -- C:\oxide-build\cw\debug\oxide-cuda-worker.exe
  cargo run --locked -p oxide-core --example cuda_diagnostic -- C:\oxide-build\cw\debug\oxide-cuda-worker.exe C:\Users\YOU\.oxide\models\ggml-small.bin C:\fixtures\jfk.wav cuda:0000000010de00000000000000000000
  ```
- **Physical hardware validation gap**:
  Physical NVIDIA hardware was unavailable on the development machine. Automated contract
  and failure tests (13/13 passing in `crates/oxide-core/tests/cuda_runtime.rs`) verify
  missing runtime, worker crashes, OOM pressure, budget limits, cancellation, and evidence
  checks. Verification on physical NVIDIA hardware remains an explicit validation gap
  carried to the final acceptance ticket #235.
- **Redistribution and packaging**:
  End users must not be required to install the CUDA Toolkit. The packaging ticket (#234)
  owns bundling the required runtime libraries (`cudart64_*.dll`, `cublas64_*.dll`,
  `cublasLt64_*.dll`) alongside `oxide-cuda-worker.exe` with retained NVIDIA redistribution
  notices.

## Licenses

Oxide is MIT. whisper.cpp and the original OpenAI model weights are MIT; whisper-rs
is Unlicense; CPAL is Apache-2.0; sysinfo is MIT. Their licenses permit commercial
redistribution. The MIT notices for whisper.cpp and the model are retained in
`docs/licenses/whisper.txt`. The model download URL follows whisper.cpp's official
download script; its LFS SHA-256 is pinned in Core. Review license terms when
adding or redistributing native GPU dependencies. The CI removal on main also
removed the cargo-deny configuration; restoring automated license checks is
tracked separately in issue #224.

The worker's ash binding is MIT/Apache-2.0. The diagnostic WAV reader (hound) is
Apache-2.0. The local build does not redistribute the Vulkan SDK or a driver;
packaged runtime dependencies and their retained notices are owned by #234.

## Settings status and recovery

Requested mode/backend/stable adapter and **Latest execution** are separate. Available
means the runtime can initialize; only inference evidence can establish GPU offload.
Auto may retry once on CPU when fresh memory checks permit, with the failure reason
shown in Latest execution after refreshing. Explicit GPU reports failure: use **Use CPU**
and save to switch. CPU performs no GPU offload. Changes apply to the next recording;
unchecking Enable discards any current audio/result immediately, even before Save.

Advanced controls list backend/device pairs from fresh runtime discovery. A missing
saved adapter remains visible as unavailable; reconnect it or choose another and save.
Missing build support requires a compatible package; missing driver/runtime requires
a driver update; initialization failure offers refresh/CPU; low memory suggests
closing apps or selecting a smaller model. Unknown budgets remain **Unknown**.

Refresh resources to see CPU, RAM, disk and per-adapter dedicated or shared memory.
Balanced/Quality advice shows its reason, provisional/measured status and confidence.
**Apply recommendation** is explicit and available only once its model is installed
and the policy marks the combination safe. It preserves enable and language; save
Settings afterward. Advice never starts downloads or enables dictation.

Automated Settings/keyboard/layout evidence and the remaining single release-validation
pass are recorded in [the #233 evidence](ui-review/dictation/issue-233.md).

### CUDA/Metal performance instrumentation (#258)

The benchmark child observes the actual native GPU stream's graph-compute callback,
waits for completion, then records matrix-bearing graph dispatches and device
identity. Loading/initialization/allocation logs never qualify. The typed result
and cache require matching evidence in warmup and every measured run. CPU/Vulkan
retain their existing paths; failed checks release the dictation gate.

The shim compiles with the existing C++ build tools and adds no GPU imports to
CPU-only builds. It pins whisper-rs-sys 0.15.0 / whisper.cpp 1.8.3 / ggml ABI 2;
headers, retained MIT notice, source hashes and upgrade instructions are in the
[native build notes](../crates/oxide-core/native/README.md). No new redistributable
GPU dependency is introduced. Physical measurements were unavailable in this
environment (no installed model or CUDA Toolkit); #235 owns the final hardware
validation, alongside cancellation/failure recovery and packaged runtime checks.
