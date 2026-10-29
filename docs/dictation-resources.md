# Dictation resource policy v1

Issue #231 implements advice, not a benchmark or automatic model selection.
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
  candidate, never imply a latency or prove Small is recommended.
- Native CPU instruction requirements come from the pinned GGML compile-time
  feature getters, compared with Rust's OS-aware feature detection. Unverifiable
  AMX permissions or architectures remain unknown and require a compatible build.
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

## Measured-performance input for #232

`MeasuredPerformance` contains a `PerformanceKey`, recording time, fixture audio
duration, three warm inference durations and separate cold-load milliseconds.
The producer must warm up first and time the same licensed fixture without
opening the microphone. Store no audio or transcript in this input.

The key includes model SHA-256, backend, stable adapter ID, driver version,
runtime version, catalogue version and policy version. Unknown GPU identity or
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
