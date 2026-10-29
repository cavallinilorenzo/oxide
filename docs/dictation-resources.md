# Dictation resource policy v1

Issue #231 implements advice; #232 adds an explicit local performance check.
Neither changes the user's model selection or enables dictation automatically.
`oxide_core::dictation::resources::recommend` is the deterministic seam:
resource snapshot + backend/device candidates + installed model IDs + preference
+ optional measurements + explicit current time -> decisions and an optional
selected decision index. All six catalogue entries are evaluated per backend/device.
The function has no I/O and cannot change Settings, enable dictation or download.

`inspect(home, preference)` collects real resources on the existing blocking
Settings worker. `Status.resourceAdvice` exposes its structured balanced advice,
resources and candidates through the generated app bindings. The existing
`Status.recommendation` text comes from the same policy. The later Settings slice
can use `Preference::Quality` and display each decision's reason, confidence,
provisional flag and `safeToLoad` separately from its recommendation status.

## Sources and freshness

- CPU architecture comes from the Rust target; brand from sysinfo; usable logical
  cores from OS-aware `available_parallelism`. Cores only bound the provisional
candidate, never imply a latency or prove Small is recommended. Unmeasured
Small/CPU decisions below four usable cores require a performance check.
- Native CPU instruction requirements come from the pinned GGML compile-time
  feature getters, compared with Rust's OS-aware feature detection. Unverifiable
  AMX permissions, SME detection on stable Rust, or architectures remain unknown
  and require a compatible build.
  Each isolated worker checks its own native build before allocation as well.
- RAM total/available and the current process resident memory (the Oxide baseline)
  come from sysinfo. OS available memory already excludes the running app and
  other resident processes: **do not subtract the baseline a second time**.
  Its measured value is reported for explanation, not added as free capacity.
- Disk comes from the longest matching mount for the model directory or its
  nearest existing ancestor; inspecting a new home creates no files/directories.
- CUDA/Vulkan workers supply stable adapter IDs, capability, driver and memory
  budgets. Metal supplies the unified pool and recommended working-set ceiling;
  its driver identity uses the OS kernel version. A missing budget remains null.
  CUDA and Vulkan on one card are alternative choices, never additive capacity.
- A combined resource snapshot is usable for 30 seconds. Future or older inputs
  return Insufficient data. Callers must refresh backend/device data along with
  RAM. No available budget is inferred from total VRAM alone.

## Estimates and reserves

Catalogue v1 stores explicit per-model/per-backend peak estimates, independently
of artifact download bytes. They are conservative engineering envelopes, **not
measured hardware support claims**. All currently have `measured: false`.

| Model | CPU peak | CUDA/Vulkan device peak | Metal combined peak |
| --- | ---: | ---: | ---: |
| Tiny | 0.5 GiB | 0.5 GiB | 0.5 GiB |
| Base | 0.75 GiB | 0.75 GiB | 0.75 GiB |
| Small | 2 GiB | 2 GiB | 2 GiB |
| Medium | 5 GiB | 5 GiB | 5 GiB |
| Large v3 | 10 GiB | 10 GiB | 10 GiB |
| Large v3 Turbo | 6 GiB | 6 GiB | 6 GiB |

These envelopes include native contexts, inference buffers, bounded audio and
model staging/duplication. For a discrete GPU, reserve at least a full CPU peak
on the host (or the backend peak if larger) **and** the device peak in VRAM.
This intentionally conservative staging allowance is not the artifact file size.
For unified/shared memory, take the maximum host/backend combined envelope
once, not their sum, and the minimum of host and shared available memory.
The native working-set cap limits the peak; it is never extra free RAM.

On top of the peak, leave `max(1 GiB, total RAM / 5)` OS RAM free, beyond the
already resident Oxide baseline. For discrete GPU memory, the peak may consume
at most 80% of the minimum reported available budget and working-set ceiling.
Known zero means exhausted; null means unknown. Unknown budgets lower confidence
to Insufficient data and refuse native loading until refreshed, rather than
allowing an unbounded allocation. Inconsistent reports are also unknown.

The estimates require calibration with controlled measured resident/native peaks
on the hardware matrix in #235. Change the catalogue version for estimate changes
and the policy version for reserve/accounting changes. Neither download hashes
nor a successful probe are memory/performance/offload measurements.

`check_before_load` refreshes host resources before native allocation on CPU,
Vulkan, CUDA and Metal; GPU adapters refresh their native budget too. Auto's one
CPU retry refreshes resources after the primary failure and runs `assess_load`
for the snapshotted model. It then performs the native pre-load check again.
Resource checks cannot eliminate concurrent OS pressure; allocation errors still
follow the existing recoverable runtime error path. Unknown catalogue paths are
refused instead of receiving a small default allocation budget.

Missing models need artifact bytes plus 64 MiB free disk to be eligible for
advice. Installed, verified models work offline even with no free disk. This
check never initiates a download; explicit installation retains its own checks.

## Advice and examples for Settings

Without a valid measurement, eligible Tiny/Base/Small suggestions are Low
confidence and explicitly Provisional. Balanced prefers Tiny below four usable
cores and Base otherwise. Quality prefers Small with sufficient resources and
four usable cores, falling back to Base/Tiny. Unmeasured backends get no assumed
GPU speed advantage; CPU wins equal provisional choices. Larger fitting models
need an explicit performance check; fitting alone does not rank them first.
The UI must not treat a larger model as guaranteed better transcription quality.

Example snapshot (bytes; timestamp supplied by the caller):

```json
{
  "capturedAtSecs": 100,
  "cpu": { "architecture": "x86_64", "model": "Example CPU", "usableCores": 8, "instructionCompatible": true },
  "totalRamBytes": 17179869184,
  "availableRamBytes": 8589934592,
  "baselineBytes": 536870912,
  "freeDiskBytes": 21474836480
}
```

| Resources (all fresh; compatible CPU) | Policy decision |
| --- | --- |
| Snapshot above, CPU only, no measurements | Balanced: Base/CPU; Quality: Small/CPU; provisional, Low confidence |
| Same, 2 usable cores | Tiny/CPU provisional; no measured latency claim |
| Same, only 4 GiB available RAM | Small refused: needs 5.2 GiB including 3.2 GiB reserve; Base still fits |
| Same, AMD Vulkan with 6 GiB dedicated VRAM, 2 GiB available | Small/GPU refused: 2.5 GiB needed including device headroom |
| Same, NVIDIA CUDA with 6 GiB VRAM, 3 GiB available | Small/GPU fits provisionally; no offload or latency proof |
| 16 GiB unified total, 6 GiB host/shared available, 8 GiB working-set cap | Small fits once at 5.2 GiB including RAM reserve |
| Same unified machine, only 4 GiB shared available | Small refused even if host RAM reports 6 GiB available |
| GPU memory null, backend omitted, or CPU instructions incompatible | Insufficient data for unknown memory; unavailable/incompatible choices Not recommended |
| Snapshot at 100, evaluation at 131 | Insufficient data; refresh resources |
| No free disk, Small already verified installed | Small still eligible offline; missing model choices advise freeing disk |

The selected index is absent when nothing can be advised. Show the per-choice
actionable reasons and offer freeing resources or keeping dictation disabled.
Safe manual choices remain possible; advice does not write persisted settings.

## Explicit local performance check (#232)

`Dictation::check_performance` runs only on explicit request. It accepts a
catalogue model ID, backend, stable adapter ID, and whether to include a
conservative candidate. The selected model must already be verified installed.
The optional candidate uses the same backend/device: Base for Small or larger,
Tiny for Base, none for Tiny. It is skipped when not installed. No other models
are explored; a larger model requires another explicit request.

The worker uses `jfk-16khz-pcm-v1`, the bundled 11-second public-domain speech
excerpt attributed in `docs/licenses/dictation-fixture.txt`. It never opens the
microphone or starts downloads. CPU/Metal run in the app's
`--dictation-benchmark-worker` mode, before Tauri starts; Vulkan/CUDA use their
isolated native workers with the same protocol. Each combination has a
120-second process limit, including worker-side verification, device probing,
context loading, warmup and inference. At most two combinations run serially.
The host terminates and reaps the child on timeout/cancellation/error. Native
contexts and inference buffers belong to that process and are released at exit.

The coordinator shares dictation's busy gate, refuses checks during recording
or transcription and prevents recording start during a check. Disabling
dictation cancels the check. The separate performance-cancel command does not
cancel ordinary dictation. Host RAM is refreshed before each worker; native
RAM/device budgets are checked again before loading. Models remain leased
against deletion throughout their check. No Settings value is changed.

The worker times one cold context/state load, discards one warmup, then measures
three runs on the same context/state. Warm milliseconds and RTF round upward
so a result just above a product target cannot qualify by truncation. CPU uses
no offload; GPU measurements require observed device/driver identity to match
and native backend selection plus completed compute evidence (Vulkan additionally
requires positive GPU kernel timestamps). Missing evidence refuses the result;
there is no benchmark GPU-to-CPU fallback. CUDA/Metal hardware acceptance remains
with #235; absence of local hardware is not a measured success.

Settings IPC is `dictationCheckPerformance(request, progressChannel)` and
`dictationCancelPerformance()`. The typed channel reports Loading, Warmup and
Measuring runs 1–3 with model/backend/adapter identity. Results include fixture
version, observed execution, key, cold load, three warm times, median inference
milliseconds and median RTF in thousandths. Call `dictationStatus` afterward to
refresh advice. The full UI is the #233 slice.

Only metadata is stored in `dictation-performance.json`: at most 32 results in a
bounded atomic JSON cache. Fixture version and execution evidence are validated
on read; corrupt/oversized caches are ignored. Cancelled/failed checks do not
publish results. No audio, transcript, user paths, native logs or telemetry are
persisted; the operation has no network path.

### Measurement identity and advice

`MeasuredPerformance` contains a `PerformanceKey`, recording time, fixture audio
duration, three warm inference durations and separate cold-load milliseconds.
The producer must warm up first and time the same licensed fixture without
opening the microphone. Store no audio or transcript in this input.

The key includes model SHA-256, backend, stable adapter ID, driver version,
runtime version, catalogue version, policy version and host CPU configuration
(architecture, model, usable cores and instruction compatibility). CPU or
parallelism changes invalidate measurements as well. Unknown GPU identity or
driver cannot establish a cache match. Results older than 30 days, future-dated,
zero duration or with a mismatched key are ignored. Current resource safety
always takes precedence over a cached result.

Median warm inference time / audio duration (RTF) gives Recommended at <= 0.5,
Usable, slower at > 0.5 through 1, and Not recommended above 1. Cold loading
does not enter RTF. Balanced ranks measured recommended choices by RTF; Quality
can favor a larger measured choice meeting the same interactive target. Memory
estimates still limit confidence to Medium. These are product targets and local
observations, not guaranteed latency, quality or GPU execution evidence.

Deterministic coverage lives at `tests/dictation_resources.rs`; the coordinator
test in `tests/dictation.rs` exercises refusal after a primary GPU failure.
Worker protocol tests inject the host OS resource snapshot independently of the
fake GPU's reported budget, including a 3 GiB available-RAM pressure case. They
do not depend on the runner's RAM or concurrent compilation. Production defaults
still capture real resources, and native workers retain their own fresh guards.

### Local smoke evidence

On 2026-10-29, Small with whisper.cpp 1.8.3 / whisper-rs-sys 0.15.0 on
Windows x64, AMD Ryzen 7 5700X (16 usable logical cores, 8 inference threads),
using the existing verified artifact and `jfk-16khz-pcm-v1`:

| Actual backend | Cold context/state | Three warm runs | Median inference | RTF |
| --- | ---: | --- | ---: | ---: |
| CPU, no offload | 437 ms | 2229 / 2240 / 2230 ms | 2230 ms | 0.203 |
| Vulkan, RX 5600 XT, AMD 26.10.1 | 700 ms | 501 / 496 / 498 ms | 498 ms | 0.046 |

The Vulkan run observed `whisper_backend_init_gpu: using Vulkan0 backend`
and positive native GPU kernel timestamps with `MUL_MAT`. The stable adapter
identity and driver version are retained with the measurement. No CPU fallback
was used. These are development workers, not distributed-package sign-off.

This is a local observation, not a hardware guarantee or a measured memory peak.
Reproduce offline with an installed Small model:

```sh
cargo run --locked -p oxide-core --example dictation_benchmark -- HOME cpu
```

For Vulkan/CUDA, set the documented worker-path environment override for device
discovery, then pass `HOME vulkan WORKER STABLE_ADAPTER_ID` (or `cuda`). On
Apple Silicon, use `HOME metal UNUSED_PATH DEVICE_NAME`. This developer smoke
prints only measurement metadata and progress, never audio/transcripts, and
shares the production coordinator/process path. The app executable implements
the same CPU/Metal child entry point.
