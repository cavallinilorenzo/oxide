# Distributed dictation acceptance — #235

Status: **incomplete; release hardware gate remains open**. This record distinguishes
installed-package observations, development evidence and automated contracts.
A build, probe, successful transcript or compiled backend is not GPU execution proof.
No release, tag, merge or parent closure is authorized by this record.

## Reproduction baseline

- Validation date: 2026-10-30.
- Source baseline: `482ce2f73dfc87df02fc8d61521bcde0595edbf3` (`main`, includes #233,
  #234 and #258). Issue #235 is the evidence slice of parent #225.
- Local hardware: AMD Ryzen 7 5700X, 16 logical processors; AMD Radeon RX 5600 XT;
  Windows 11 Pro x64, build 26300.9818; display driver
  `32.0.21045.16010` (AMD 26.10.1 in the earlier #227 observation).
- Host RAM: 25,688,866,816 bytes as reported by Windows; do not use WMI's 32-bit
  `AdapterRAM` value as the GPU's VRAM budget. Runtime enumeration is authoritative.
- Native versions: whisper-rs 0.16.0, whisper-rs-sys 0.15.0, whisper.cpp 1.8.3.
- Licensed fixture: `jfk-16khz-pcm-v1`, 11 seconds, 16 kHz mono PCM16;
  SHA-256 `a29462b8ebd467318000e683b9117ade46230d3255ed2024e7db894abd9b38c9`.
  [Attribution and source hash](../licenses/dictation-fixture.txt).

## Physical platform matrix

| Required target | Installed package + actual offload | Comparison / memory | Exact remaining dependency |
| --- | --- | --- | --- |
| Windows NVIDIA, CUDA | **Verified offload** for Tiny/Base/Small in the installed #234 CUDA worker (RTX 2060 SUPER) | CPU comparison and sampled memory in the [NVIDIA record](#windows-nvidia-installed-record) | Missing/incompatible driver and OOM flows, physical microphone/shortcut, larger-model calibration |
| Windows NVIDIA, Vulkan | **Verified offload** for Tiny/Base/Small, independent of CUDA (separate worker, `Vulkan0`, native kernel timestamps) | Same record | Same as above |
| Windows AMD, Vulkan; RX 5600 XT regression | **Verified offload** for Tiny/Base/Small in the installed #234 worker | CPU comparison and sampled memory below | Physical microphone, offline/disconnected lifecycle, failure flows and larger-model calibration remain open |
| macOS Apple Silicon, Metal | **Verified offload (dev build)** for Tiny/Base/Small; installed package remains open | CPU vs Metal comparisons and completed dispatch evidence in [macOS record](#macos-apple-silicon-development-record) | Package-level verification from an installed `.app` from a traceable `.dmg`; physical microphone/shortcut/offline lifecycle |
| CPU-only / no usable GPU runtime | **Unverified on physical runtime-free host** | Automated isolation/recovery coverage only | Physical or controlled clean Windows environment without usable Vulkan/NVIDIA runtime; installed app launch **and CPU inference**, not launch alone |
| Intel Mac GPU / other platforms | **Not advertised** | No measurements | Separate platform validation; Apple Silicon cannot establish Intel Mac support |

The RX 5600 XT's earlier nested CMake failure is a build/toolchain observation,
not GPU incompatibility. #227's native timestamps and #232's development RTFs are
historical evidence only; [resource notes](../dictation-resources.md#local-smoke-evidence)
retain their original conditions.

## Installed artifact and measurements

The installer is artifact `oxide-windows-x64-ci`, ID `12995664697`, from the
[completed #234 build](https://github.com/cavallinilorenzo/oxide/actions/runs/41094709855),
source commit `6d47fad594ed86f72588d29a2c8235fa9b27f881`. It was downloaded using
`gh run download 41094709855 --name oxide-windows-x64-ci`, then installed silently
into a fresh scratch folder (`/S /D=INSTALL_DIR`, exit 0). No developer-built worker
was copied into this installation. `git diff` between that commit and the source
baseline shows no dictation-core/worker/build/package-script changes.

| File | SHA-256 |
| --- | --- |
| `Oxide_0.1.0_x64-setup.exe` (610,034,185 bytes) | `3e3d6823a97892508b61f04b2023a8f2cf34707cdf3fee8fcb0e1ac65f94d0ca` |
| `oxide-app.exe` | `b564c49708c7643314761eed59d06ab52f12faa685af4efff7e52fca62ab0e3c` |
| `oxide-vulkan-worker.exe` | `2fa837be0af3fbb6e911442f8dc23b0856a5a2fa468b15e406f4647a27e80215` |
| `oxide-cuda-worker.exe` | `c30f90c80611dfd988b860027549a8fbba81ac671eb2b9578ba289753fd943e7` |
| `dictation-runtime.json` | `9a1d802e10f8e190a5c51bec8ef33fcdb1541efdab00d2c29fbc8033be4ba203` |

The installed manifest reports `ggmlNative: OFF`, CUDA Toolkit `v12.9`, Vulkan SDK
`1.4.363.0` and the native versions above. `verify windows-x64 INSTALL_DIR` passed
every file/import/hash/notice check. `smoke INSTALL_DIR`, with SDK variables and
developer PATH removed, reported RX 5600 XT Vulkan **available**, CUDA
**missingDriverOrRuntime**. The AMD driver is present; this does not establish
startup on a host without both usable runtimes. No signed/published release or
clean local build is claimed.

Installed Vulkan enumeration reported stable ID
`vulkan:00000000290000000000000000000000`, native `Vulkan0`, API `1.4.315`, driver
`AMD proprietary driver: 26.10.1 (AMD proprietary shader compiler) (raw 8388961)`.
Its device-local heap was 5,351,931,904 bytes, with 4,658,616,832 available and a
4,659,796,480-byte working-set budget at the probe. These are runtime-reported
budget signals, not the advertised card capacity or a peak-memory measurement.

The [sanitized JSON results](results-2026-10-30/) retain fixture/model hashes,
driver/adapter/runtime identity, actual execution proof, timings and memory counters.
All combinations ran serially after local builds stopped. The installed CPU app
or GPU worker executed the fixture; the locally built release example only drove
the public production coordinator/process protocol. Inference uses eight threads.

| Model / actual backend | Cold context/state (ms) | Three warm runs (ms) | Median (ms) | Median RTF, rounded up |
| --- | ---: | --- | ---: | ---: |
| Tiny / CPU | 166 | 4297 / 4292 / 4268 | 4292 | 0.391 |
| Base / CPU | 223 | 9429 / 9132 / 9010 | 9132 | 0.831 |
| Small / CPU | Not published | **120-second check timed out** | Unavailable | Unavailable |
| Tiny / Vulkan | 283 | 229 / 243 / 298 | 243 | 0.023 |
| Base / Vulkan | 246 | 281 / 280 / 282 | 281 | 0.026 |
| Small / Vulkan | 620 | 476 / 461 / 488 | 476 | 0.044 |

All three Vulkan results required `whisper_backend_init_gpu: using Vulkan0 backend`
and positive native compute kernel timestamps with `MUL_MAT`, validated by
`ProcessWorker`. `offloaded: true` and the exact device/driver identity are retained;
no CPU fallback qualified. CPU results explicitly report `offloaded: false`.

Small/CPU failed twice; the repeat classified **timeout** at 120,442 ms including
host/sampler overhead. The normal 120-second worker deadline was retained. No
partial timing or cached result qualified; do not copy the old development RTF
into this row. During that bounded attempt the worker reached 831,361,024 bytes
working set and 1,342,926,848 bytes private commit (546 observations, max gap 388 ms).
These are incomplete-run lower bounds. The next installed Vulkan/Tiny check
succeeded (168 ms cold; 226/222/223 ms warm, median RTF 0.021), demonstrating a new
diagnostic can run after termination. This is not a same-recording UI retry test.
The subsequent installed CUDA/Tiny check failed without accepting a measurement,
consistent with its missing-driver probe; [fixed-category failure metadata and
the repeat](results-2026-10-30/recheck/) contain no native stderr.

| Model / backend | Peak worker working set (bytes) | Peak private commit (bytes) | Sampled dedicated GPU (bytes) | Sampled shared GPU (bytes) |
| --- | ---: | ---: | ---: | ---: |
| Tiny / CPU | 271446016 | 763092992 | Unknown / not sampled | Unknown / not sampled |
| Base / CPU | 371740672 | 881340416 | Unknown / not sampled | Unknown / not sampled |
| Tiny / Vulkan | 197324800 | 873857024 | 281133056 | 56782848 |
| Base / Vulkan | 139272192 | 923086848 | 395325440 | 59011072 |
| Small / Vulkan | 248012800 | 1380732928 | 730279936 | 180367360 |

The PowerShell 7 sampler uses Windows process `PeakWorkingSet64` /
`PeakPagedMemorySize64` high-water marks and raw GPU Process Memory byte gauges,
matched to the diagnostic child's PID. Requested interval: 100 ms; maximum observed
gaps: 305–587 ms (exact counts/gaps in each JSON). These are worker observations,
not whole-app peaks or allocator instrumentation. GPU sampling can miss short
peaks; missing CPU GPU counters are **unknown**, not zero. Hashing/staging and
residency/commit differ, as the columns show. Results are local observations with
instrumentation overhead, not catalogue calibration or universal latency promises.

## Windows NVIDIA installed record

Run on 2026-10-31 on a second physical machine: AMD Ryzen 5 3600 (12 logical
processors), NVIDIA GeForce RTX 2060 SUPER (8 GB), NVIDIA driver 617.14 (CUDA
13.4), Windows 11 Home build 26200. The package is the same #234 installer as above
(`Oxide_0.1.0_x64-setup.exe`, SHA-256
`3e3d6823a97892508b61f04b2023a8f2cf34707cdf3fee8fcb0e1ac65f94d0ca`, artifact
`oxide-windows-x64-ci` from run 41094709855, downloaded with `gh run download` and
hash-checked), installed silently into a scratch folder. `verify windows-x64` passed and
`smoke` found the RTX 2060 SUPER **available** through both `oxide-vulkan-worker.exe`
and `oxide-cuda-worker.exe`. The release `dictation_benchmark` example (built with
`GGML_NATIVE=OFF`) only drove the installed worker; models were Tiny/Base/Small, each
SHA-256-checked against the catalogue. Stable IDs came from the installed workers:
`vulkan:8e75221ccf0d162efaff030f2eec89ef` (driver `NVIDIA: 617.14`, Vulkan API
1.4.351) and `cuda:8e75221ccf0d162efaff030f2eec89ef` (compute capability 7.5).
Runs were serial through `tools/dictation-acceptance.ps1`. Sanitized reports:
[results-2026-10-31/nvidia](results-2026-10-31/nvidia/).

| Model / backend | Cold load (ms) | Three warm runs (ms) | Median (ms) | Median RTF | Actual offload evidence |
| --- | ---: | --- | ---: | ---: | --- |
| Tiny / CPU | 179 | 4514 / 4511 / 4526 | 4514 | 0.410 | none (CPU) |
| Base / CPU | 265 | 9548 / 9571 / 9758 | 9571 | 0.870 | none (CPU) |
| Small / CPU | n/a | timed out | n/a | n/a | the unchanged 120 s deadline; no measurement accepted |
| Tiny / Vulkan | 202 | 255 / 259 / 259 | 259 | 0.0235 | `Vulkan0` init + native kernel timestamps |
| Base / Vulkan | 238 | 291 / 287 / 288 | 288 | 0.0262 | same |
| Small / Vulkan | 604 | 373 / 364 / 364 | 364 | 0.0331 | same |
| Tiny / CUDA | 138 | 255 / 255 / 273 | 255 | 0.0232 | `CUDA0` dispatch snapshots: 30 graphs, 1365 matrix ops, 0 failures in warmup and all three runs |
| Base / CUDA | 175 | 402 / 310 / 298 | 310 | 0.0282 | same mechanism |
| Small / CUDA | 514 | 387 / 392 / 393 | 392 | 0.0356 | same mechanism |

Sampled memory (lower bounds from 100 ms polling, not calibration, so no model is marked
`measured: true`): Small/Vulkan peak working set 273 MB, private commit 1.52 GB, sampled
dedicated GPU memory 903 MB; Small/CUDA peak working set 444 MB, private commit
1.95 GB, dedicated 976 MB; Small/CPU timed out at peak working set 832 MB.

Larger models on the same host (16 GB RAM, 8 GB VRAM), Vulkan and CUDA, same procedure:

| Model / backend | Cold load (ms) | Three warm runs (ms) | Median (ms) | Median RTF | Result |
| --- | ---: | --- | ---: | ---: | --- |
| Medium / Vulkan | 1813 | 597 / 607 / 620 | 607 | 0.0552 | offload verified; sampled dedicated GPU 2.16 GB, private commit 2.84 GB |
| Medium / CUDA | 1384 | 673 / 670 / 648 | 670 | 0.0609 | offload verified (31 graphs, 0 failures in every run); sampled dedicated GPU 2.22 GB, private commit 3.19 GB |
| Large v3 Turbo / Vulkan, CUDA | n/a | n/a | n/a | n/a | **refused before loading** by the unchanged RAM guard: 9,862,819,021 bytes needed including headroom, 9,292,505,088 available. Not a performance result |
| Large v3 / Vulkan, CUDA | n/a | n/a | n/a | n/a | same category (recorded as `worker-or-resource-failure`); catalogue peak estimate 10 GiB exceeds what 16 GB leaves free. Not a performance result |

The Turbo and Large v3 rows stay **unverified for performance**; the guard was not
lowered, and a run with more free RAM could still be attempted. Catalogue peak
estimates keep `measured: false`.

Manual pass on the same host, **development build** (`tauri dev`, Small, Italian,
using the installed CUDA/Vulkan workers; not an installed package): dictation starts,
transcribes and inserts text. Accuracy with the PC's microphone was poor on short
phrases (Tiny: wrong language and words; Small: partly understood). The tester
could not separate model quality from microphone quality, so this records that
dictation functions but is **not** an accuracy or CPU-versus-GPU comparison.
The earlier installed build flashed a console window on every CUDA worker call;
that was fixed in the source (the CUDA worker now uses `CREATE_NO_WINDOW`, as the
Vulkan one did) and checked only in the development run, not in a rebuilt package.
Still open: missing/incompatible driver and OOM flows, offline use, Esc/disable
during recording, terminal insertion, model switching/corrupt download passes.

Observed gaps: the Vulkan Tiny run's maximum sampling gap was 5.6 s (the first run,
likely driver shader compilation), so its memory numbers are especially unreliable.
Vulkan reports carry native timestamps but not the CUDA-style per-run dispatch
snapshot. Both are recorded exactly as emitted. Not covered by this record: the
missing/incompatible NVIDIA driver and OOM flows, the physical microphone, shortcut,
offline and insertion passes, and Medium/Large v3/Turbo.

## macOS Apple Silicon development record

Run on 2026-10-30 from a development tree (`cargo build --release`, not an installed
`.dmg`), so it is **not** distributed-package evidence. Hardware: Apple M1 Pro (10 cores,
Metal 4), 16 GB unified memory, macOS 27.2 (26B123). Isolated model home; Tiny/Base/Small
installed and verified through the app's installer; fixture and native versions as in the baseline above.

| Model | Backend | Cold load | Warm inference (3 runs, ms) | Median warm | Median RTF | Offload evidence | Completed graphs / matrix ops |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tiny` | CPU | 8232 ms | 213, 205, 209 | 209 ms | 0.0190 | CPU (offloaded: false) | n/a |
| `tiny` | Metal | 74 ms | 181, 180, 181 | 181 ms | 0.0165 | Metal verified (offloaded: true) | 30 graphs, 1365 matrix ops / run (0 failures) |
| `base` | CPU | 112 ms | 309, 324, 320 | 320 ms | 0.0291 | CPU (offloaded: false) | n/a |
| `base` | Metal | 99 ms | 235, 239, 243 | 239 ms | 0.0217 | Metal verified (offloaded: true) | 30 graphs, 2033 matrix ops / run (0 failures) |
| `small` | CPU | 209 ms | 772, 769, 788 | 772 ms | 0.0702 | CPU (offloaded: false) | n/a |
| `small` | Metal | 215 ms | 483, 473, 475 | 475 ms | 0.0432 | Metal verified (offloaded: true) | 30 graphs, 4037 matrix ops / run (0 failures) |

`cargo test --release -p oxide-core --test dictation_smoke -- --ignored` passed
(Tiny/Base/Small CPU inference across model switches).

Metal offload was verified across all three models with hardware dispatch execution:
every measured run plus warmup completed all 30 GGML execution graphs with zero failures,
executing 1,365 matrix operations per run on Tiny, 2,033 on Base, and 4,037 on Small.
Inference speedups over CPU were 15.5% on Tiny, 33.9% on Base, and 62.5% on Small
(median warm RTF dropped from 0.0702 down to 0.0432).

*Note on earlier run:* The earlier `NoCompatibleDevice` error when running the benchmark CLI
with `metal - -` was caused by `-` setting `adapter_id: None`, whereas Metal expects
`probe.adapter` (`Apple M1 Pro`). `dictation_benchmark.rs` has been updated to automatically
default `adapter_id` to the probe adapter for Metal when `-` is passed. Raw outputs are
preserved in `docs/dictation-acceptance/results-2026-10-30/macos/`.

To repeat:

```sh
cargo build --release --locked -p oxide-core --example dictation_benchmark
./target/release/examples/dictation_benchmark MODEL_HOME metal - - small
```

## Model matrix and calibration

| Model ID | Automated real-artifact integration | Installed CPU | Installed GPU | Measured peak RAM / dedicated / shared memory |
| --- | --- | --- | --- | --- |
| `tiny` | **Pass**, actual verified artifact | **Pass**, RTF 0.391 | **Pass**, Vulkan RTF 0.023 | Sampled counters below; calibration open |
| `base` | **Pass**, actual verified artifact | **Pass**, RTF 0.831 | **Pass**, Vulkan RTF 0.026 | Sampled counters below; calibration open |
| `small` | **Pass**, verified legacy cache reused | **Timeout**, no accepted measurement | **Pass**, Vulkan RTF 0.044 | Sampled counters below; calibration open |
| `medium` | Lifecycle/hash contract only | Unverified | Unverified | Unknown |
| `large-v3` | Lifecycle/hash contract only | Unverified | Unverified | Unknown |
| `large-v3-turbo` | Lifecycle/hash contract only | Unverified | Unverified | Unknown |

The larger GPU estimates cannot fit the currently reported RX 5600 XT budget
with policy headroom. The host had about 9.5 GiB available during the pass;
larger CPU load/staging plus the RAM reserve and the bounded benchmark need
validation on a more suitable configuration. No large artifact was downloaded
merely to force an unsafe run. Their exact external dependency is a machine with
sufficient **fresh policy-checked RAM/GPU budget** for each selected model and
enough performance to complete the bounded check.

Catalogue v1 estimates remain **provisional**, with `measured: false` for every
model/backend. Do not turn a sampled RSS observation or a single card's allocated
VRAM into a universal peak estimate. Retain the existing RAM reserve
`max(1 GiB, 20% of total RAM)` and discrete GPU 20% headroom. A measured calibration
must include load/staging, inference buffers, app baseline, repeated peaks and
concurrent pressure; unified memory is one pool. Change the versioned policy only
with the measurements attached and matching regression tests.

RTF <= 0.5 (interactive target), 0.5–1 (usable with a wait) and >1 (slow) are product
targets, not measured universal thresholds. Their provenance is parent #225 §4;
local observations can qualify a combination but cannot establish a universal
speed/quality promise. No thresholds or estimates were relaxed to make a row pass.

## Commands for the next hardware operator

Run from a checkout matching the artifact. Replace uppercase placeholders; do
not export user paths, audio, transcripts or raw native stderr. Download models
only through an explicit action; all commands below reuse installed artifacts.

```powershell
# Build/check the local source. Never substitute hosted results for this run.
node tools/check.mjs fast
node tools/check.mjs

# Validate files, hashes, imports and notices in the installed folder.
node tools/dictation-package.mjs verify windows-x64 INSTALL_DIR
node tools/dictation-package.mjs smoke INSTALL_DIR
# On a clean runtime-free host, separately check startup and CPU inference.
node tools/dictation-package.mjs smoke INSTALL_DIR --launch

# Real Tiny/Base/Small integration: explicit install, then local-only inference.
$env:OXIDE_DICTATION_SMOKE_HOME = 'MODEL_HOME'
cargo test --locked -p oxide-core --test dictation_smoke -- --ignored

# Match the package's release profile and portable CPU flags; no identity bypass.
$env:GGML_NATIVE = 'OFF'
cargo build --release --locked -p oxide-core --example dictation_benchmark
# CPU: worker and adapter placeholders are ignored; host is the installed app.
.\target\release\examples\dictation_benchmark.exe MODEL_HOME cpu - - small INSTALL_DIR\oxide-app.exe
# Use the exact adapter ID from Settings runtime discovery (not the GPU name).
.\target\release\examples\dictation_benchmark.exe MODEL_HOME vulkan INSTALL_DIR\oxide-vulkan-worker.exe STABLE_ADAPTER_ID small INSTALL_DIR\oxide-app.exe
# CUDA is independent; requires physical NVIDIA and native dispatch proof.
.\target\release\examples\dictation_benchmark.exe MODEL_HOME cuda INSTALL_DIR\oxide-cuda-worker.exe STABLE_CUDA_UUID small INSTALL_DIR\oxide-app.exe

# PowerShell 7: repeat the installed run and attach aggregate memory metadata too.
# The sampler removes SDK/development PATH and worker overrides for each child.
.\tools\dictation-acceptance.ps1 -InstallDir INSTALL_DIR -ModelHome MODEL_HOME -Backend cpu -Models tiny,base,small -OutputDir FRESH_RESULTS_DIR
.\tools\dictation-acceptance.ps1 -InstallDir INSTALL_DIR -ModelHome MODEL_HOME -Backend vulkan -AdapterId STABLE_ADAPTER_ID -Models tiny,base,small -OutputDir FRESH_RESULTS_DIR
```

The example's last two optional arguments select any catalogue model and an
installed CPU/Metal host; omitting them preserves the Small/development behavior.
Repeat with `tiny`, `base`, `medium`, `large-v3`, `large-v3-turbo` only after
explicit installation and a fresh resource check. It never downloads, opens the
microphone or changes Settings. It writes only the production metadata cache in
MODEL_HOME; use an isolated acceptance home if preserving the user's benchmark
cache. Native errors are captured by `ProcessWorker`, not exported. Keep build
variant identity checks enabled: a mismatched host is a failure, not a reason to
rewrite its version field.

The sampler saves only a successful typed result or a fixed failure category
(`timeout` / `worker-or-resource-failure`) plus counters and executable hashes.
Failure returns a nonzero exit and has no accepted performance result. It never
persists raw child stdout/stderr on failure, refuses to overwrite an existing
report and kills its diagnostic process tree if sampling is interrupted.

On Apple Silicon use a release example built on that Mac, `metal - 'EXACT_ADAPTER_NAME'
MODEL_ID /Applications/Oxide.app/Contents/MacOS/oxide-app` (verify the installed
executable name). Verify the `.app` using `verify macos-aarch64` first. Disable
network access externally for the offline pass; local paths alone do not prove
physical disconnection.

For each combination, run serially with other builds stopped. Capture a separate
cold load, discard one warmup, retain three warm durations and median RTF. Keep
fixture version, model SHA, adapter ID, driver, runtime/build flags and actual
execution evidence with the result. Vulkan requires native backend selection plus
positive GPU kernel timestamps; CUDA/Metal require matching completed matrix
graph dispatches in warmup and all three measured runs. Never accept fallback as
a GPU measurement. Hash the exact installed executable/worker and installer with
`Get-FileHash -Algorithm SHA256` (macOS: `shasum -a 256`).

Record OS process **peak working set and private commit** for the actual worker
including loading, and GPU **dedicated and shared** process-memory counters over
its entire lifetime. On Windows use Performance Monitor's Process and GPU Process
Memory counters matched by worker PID; on macOS use Instruments/Metal tools and
record unified-pool accounting. Record sampler interval and tool/version; a sampled
maximum is a lower bound, not an allocator high-water mark. Missing or unsupported
counters stay **unknown**, never zero. Keep raw traces local if they contain paths;
attach only aggregate counters. RAM/VRAM headroom must be assessed independently
of artifact download size.

## Failure, recovery and privacy matrix

Automated fixtures emulate the OS/native boundary; they are not physical driver
removal, real OOM or installed UI results.

| Scenario | Repeatable automated evidence | Physical / installed action still required |
| --- | --- | --- |
| Backend omitted, missing driver/runtime, incompatible capabilities | `vulkan_runtime`, `cuda_runtime`: omitted-worker, driver-error and capability-state tests | Installed launch/CPU inference without GPU runtimes; unavailable option and next action in Settings |
| Initialization failure, allocation/OOM, adapter removed, worker exit | Same suites: initialization, memory pressure, disappearance, loader/crash tests | Exercise on target machines or isolate a disposable installed worker; do not remove the host's display driver |
| Auto retries once only when safe | `dictation`: Auto fallback, low-memory/reserve refusal; `dictation_resources`: fresh budgets | Installed GPU failure with both safe and unsafe CPU budgets; one insertion only |
| Explicit GPU never silently falls back | `dictation`, `vulkan_runtime`, `cuda_runtime`: explicit-GPU and unproven-offload rejection | Installed UI error + Use CPU; no false GPU-active status |
| Failure/cancel leaves next check usable | `dictation_benchmark`: cancellation/busy gate, timeouts, failures and child reaping | Cancel each installed backend; repeat without app restart |
| Legacy enabled/language/shortcut, Small reuse | `dictation`, `dictation_models`, `settings`: migration/roundtrip and verified-cache reuse | Upgrade a disposable legacy profile without changing the real user's settings |
| Corrupt/cancelled download, switching and deletion | `dictation_models`: hash/size/partial/cancel/lease tests; real `dictation_smoke` switches | Offline installed selection/deletion/reinstall, no automatic multi-GB download |
| Disable during recording/inference | `dictation`, `dictation_models`: generation/cancellation and late-result discard | Installed microphone/shortcut session, Escape and disable |
| Original chat/terminal insertion, no submit, sanitization, destroyed target | `web/src/dictation.test.tsx` and Settings tests | Installed microphone + global shortcut; switch/destroy original target; verify no execution or duplicate insertion |
| Audio/transcript privacy and diagnostic export | Benchmark returns metadata only; cache tests reject invalid fixture/execution/model identity | Inspect an explicit export and local disk/logs after all installed flows; exclude paths, raw stderr and unrelated system details |

**Unresolved behavior found by inspection:** `Dictation::stop` consumes the recording
and `transcribe_snapshot` owns the samples until return. A failed explicit GPU
request offers switching to CPU but has no retained-recording retry API. Parent
#225 §2 requires preserving bounded audio until retry/cancel. Existing recovery
tests prove a new operation can start, not retry of that same recording. This
requirement remains open; do not represent “record again” as preserved-audio retry.

**Observed development privacy gap:** the real-artifact smoke emits native
`whisper_full_with_state` token-level messages on stderr, including recognized
fixture words, despite disabling print-progress/realtime/timestamps. The explicit
Rust smoke output was changed to timing/phrase-presence assertions only, but this
does not suppress the pinned native logger. No raw native log or transcript is
attached here. Production GPU/benchmark workers capture stderr in memory; ordinary
embedded CPU/Metal logging and native failure strings require a dedicated privacy
fix and installed verification before this parent requirement can be closed.

## Parent #225 acceptance traceability

| Parent acceptance item (in original order) | Evidence / result | Remaining gap |
| --- | --- | --- |
| Clean Windows CUDA/Vulkan + CPU startup, macOS Metal packages | #234 package verification; local check results below | Clean local GPU build/toolchain and runtime-free host; physical Metal bundle |
| Physical NVIDIA CUDA and Vulkan | Platform matrix | Both unverified; no NVIDIA hardware |
| Physical AMD Vulkan, RX 5600 XT | Platform matrix and installed measurements | Tiny/Base/Small offload verified; this card cannot establish NVIDIA support |
| Physical Apple Silicon Metal | Platform matrix | Unverified; no Mac access |
| Driver/backend/init/OOM/removal and safe mode behavior | Failure/recovery matrix | Physical installed failure flows and preserved-audio retry gap |
| Six models, real Tiny/Base/Small and controlled larger runs | Model matrix | Larger-model inference/peaks, all-platform offline/lifecycle sign-off |
| Deterministic resource advice | `dictation_resources`; #231 | Measured peak calibration still open |
| Explicit bounded, keyed local performance check | `dictation_benchmark`; #232/#258; new model-identity regression | Physical CUDA/Metal runs and installed cancellation |
| Migration, cancellation, switching, disable and original target insertion | Failure/recovery matrix; #230/#233 | Installed physical microphone/shortcut pass |
| Settings exposes model/backend/resources/performance | #233 evidence; `DictationSettings.test.tsx` | Current installed physical pass |
| Current local checks and hardware release gate | Commands/results below; [release checklist](../devops.md#release-runbook) | Failed/unavailable local commands must remain visible |
| User/build/troubleshooting/license documentation | [Dictation guide](../dictation.md#packaging-and-distribution), model/resource notes, retained package notices | Minimum tested platform claims limited to verified rows; CUDA/Metal unknown |

## Local verification results

| Command | Result |
| --- | --- |
| `node tools/check.mjs fast` | **Pass**, 3 commands; pre-existing ThreadView virtualizer lint warning, no lint errors |
| `cargo test --locked -p oxide-core --test dictation_benchmark` | **Pass**, 16 tests; model/hash mismatch regression observed red first, then green |
| `cargo test --locked -p oxide-core --test dictation_smoke -- --ignored` with isolated acceptance home | **Pass**, actual Tiny/Base/Small verified installation and CPU inference across switches; Small reused by hard link, original settings/cache unchanged |
| `node tools/check.mjs` | **11 passed, 4 failed, 9 skipped, 0 not run**. 361 Rust tests passed (7 intentionally skipped), 507 web tests, 125 tooling tests; Clippy, bindings, alignment, production web build, formatting, lint/typecheck passed |
| `node tools/dictation-package.mjs stage` (runner) | **Blocked**: `CUDA_PATH is not set`; CUDA Toolkit 12.9.1 is not installed locally |
| `web/node_modules/.bin/tauri.cmd build --ci --bundles nsis --config crates/oxide-app/tauri.windows-gpu.conf.json` (runner) | **Failed consequence of staging**: `target/dictation-runtime/windows-x64` resource does not exist |
| `node tools/dictation-package.mjs verify windows-x64` (runner, local build tree) | **Failed consequence of staging**: workers, CUDA DLLs, manifest and extra notices missing |
| `node tools/dictation-package.mjs smoke` (runner, local build tree) | **Failed consequence of staging**: no runtime manifest |
| `msvcEnv()` toolchain check | **Blocked**: cannot load MSVC 14.44; install the VS 2022 v143 x64 toolset side by side (the older development validation used 14.51) |
| `verify windows-x64 INSTALL_DIR` and `smoke INSTALL_DIR` on downloaded/installed artifact | **Pass**, independent of the local build-tree failures |
| `tools/dictation-acceptance.ps1` (PowerShell 7) | Syntax validated; five successful installed CPU/Vulkan combinations, repeat GPU success after CPU timeout, timeout and missing-driver failure reports exercised; no raw error output published |

The required local packaging dependency is CUDA Toolkit 12.9.1 **plus MSVC 14.44
x64**, in addition to the installed Vulkan SDK/libclang. The supported setup command
is `node tools/dictation-package.mjs setup` from an elevated prompt; the toolset is
installed through Visual Studio Installer. No SDK/toolchain was silently installed
or replaced during acceptance. The hosted artifact does not turn these failed
local commands into passes. macOS checks and CI-only supply-chain/automation checks
remain skipped for the runner's stated platform/tool reasons.

## Two-axis review

Reviewed against the fixed source baseline
`482ce2f73dfc87df02fc8d61521bcde0595edbf3`, with independent Standards and Spec
reviewers, before publishing the draft.

### Standards

No findings. The change follows the documented branch, local-check and
release-ownership rules. Production validation is small, the regression uses the
public cache boundary, and diagnostic tooling reuses the existing
coordinator/worker interface. Evidence distinguishes installed results,
provisional estimates and unresolved acceptance gaps.

### Spec

No introduced implementation defect or material scope creep. The model/hash
validation, diagnostic options and sampler support the requested evidence work.
Three acceptance groups remain open:

1. Platform/model coverage and packaging: NVIDIA, distributed Metal,
   runtime-free startup/inference, larger models and clean local GPU packaging.
2. Calibration: sampled worker counters do not establish final per-model/backend
   estimates; catalogue estimates remain provisional.
3. Safety and recovery: native development token logging, preserved-audio retry
   and installed microphone/shortcut/failure/offline/original-target passes.

Totals: **Standards 0** (worst: none); **Spec 0 introduced defects, 3 open acceptance
groups** (worst: privacy and preserved-audio recovery). #235 and #225 remain open.


