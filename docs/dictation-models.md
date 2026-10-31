# Dictation model catalogue and lifecycle

Catalogue version 1 lives in `crates/oxide-core/src/dictation/catalogue.json`.
Core loads this embedded catalogue; the webview receives the same data through
`dictationModelCatalogue()`. URLs, filenames, hashes and limits cannot be supplied
by the webview or settings. Model IDs are `tiny`, `base`, `small`, `medium`,
`large-v3`, and `large-v3-turbo`. All six are multilingual GGML F16 artifacts;
none is an English-only or quantized substitute.

Artifacts are pinned to Hugging Face's official whisper.cpp conversion repository,
revision `5359861c739e955e79d9a303bcbc70fb988958b1`. The byte sizes and SHA-256 values
are the **artifact LFS metadata**, not Git blob IDs or SHA-1 values:
https://huggingface.co/api/models/ggerganov/whisper.cpp/revision/5359861c739e955e79d9a303bcbc70fb988958b1?blobs=true

The supported native distribution is whisper-rs 0.16.0 / whisper-rs-sys 0.15.0,
whose bundled whisper.cpp identifies itself as 1.8.3. Each entry records these
versions and the sys distribution's source revision. MIT attribution is retained
in `docs/licenses/whisper.txt`.

## Application API

Generated bindings expose these explicit operations:

| Command | Behavior |
| --- | --- |
| `dictationModelCatalogue()` | Catalogue version, metadata and provisional memory estimates |
| `dictationModels()` | Verified status of every catalogue model |
| `dictationModelStatus(model)` | Verified status of one model |
| `dictationModelInstall(model)` | Explicit install; reuse a verified cached file |
| `dictationModelCancel(model)` | Interrupt a download, including a stalled request/body |
| `dictationModelRetry(model)` | Explicit fresh attempt after cancellation or error |
| `dictationModelDelete(model)` | Delete an inactive artifact; reject conflicting operations |

`dictation-model-download` events carry `{ id, state }`. The discriminated state
is `missing`, `installed`, `installing` (received/total bytes), `cancelled`, or
`error` (message). Query status after subscribing to reconcile missed events.
The old Small-only install command and `dictation-download` event remain available
for the current settings interface. Detailed model-selection UI belongs to #233.

Downloads check free space before opening the URL, enforce the exact catalogue
size even without a Content-Length header, stream SHA-256 verification into a
temporary file on the destination filesystem, sync it, then rename atomically.
Unknown free space fails closed. A cancelled, partial, wrong-size or corrupt file
never counts as installed. Retry is explicit; nothing starts an automatic download.

OS file locks serialize conflicting operations, including across application
processes. Shared leases protect selected and recording models; an exclusive lock
is required for installation or deletion. Cached files are verified before use.
The existing `~/.oxide/models/ggml-small.bin` keeps its path and checksum and is
reused without downloading another copy.

`dictation.model` defaults to `small` when absent. Existing enable/language/device
settings and shortcuts are preserved. Saving or externally editing settings to
select a missing/corrupt model retains the last valid settings. Install first,
then explicitly select it. Installing alone does not change the selection.
Startup restores saved preferences even if their selected artifact has since been
deleted; model status reports its absence and recording requires installation.

Recording start snapshots model/language/device and leases its artifact. Changing
settings affects the next recording. Disable cancels capture/inference and
discards late results. A cancellation generation captured before reading settings
also invalidates startup work still verifying a model. Native inference runs on a blocking worker, with one
inference at a time per coordinator. Native contexts are scoped to that inference:
**zero contexts are retained between recordings**, so switches and disabling
cannot leave a previous model resident. This conservative lifetime trades cold
load cost for bounded residency. The pinned binding's closure-based abort helper
has an incompatible pointer cast; Core uses a lifetime-bound atomic C callback.

## Memory estimates and hardware handoff

Each backend has an explicit estimate in bytes. Version 1 uses the following
conservative provisional working-set estimates on CPU/CUDA/Vulkan/Metal:

| Model | Estimate per backend |
| --- | --- |
| Tiny | 512 MiB |
| Base | 768 MiB |
| Small | 2 GiB |
| Medium | 5 GiB |
| Large v3 | 10 GiB |
| Large v3 Turbo | 6 GiB |

Every estimate has `measured: false`. These are not measured VRAM requirements or
claims of GPU support. Native loading and Auto's CPU retry refresh resources and
apply model-specific estimates with RAM reserves and GPU budget headroom. Shared
memory accounting, advice confidence and examples are documented in
[resource policy v1](dictation-resources.md).

Windows x64 CPU smoke validation on 2026-10-29 verified Tiny/Base/Small downloads
against their catalogue hashes and transcribed the bundled 11-second JFK sample
using four threads. Small reused the existing cached artifact. Base completed
in approximately 1.28 s and Small in 3.67 s including loading; these single runs
are smoke evidence, not benchmarks. Inference after installation uses local paths
only, with no network access in the native runtime.

The opt-in smoke test installs only when explicitly run. Set
`OXIDE_DICTATION_SMOKE_HOME` to an Oxide-style home directory (its `models/`
subdirectory contains artifacts), then run:

```sh
cargo test -p oxide-core --test dictation_smoke -- --ignored --nocapture
```

The normal suite uses tiny local artifact fixtures and a local HTTP server to
cover lifecycle failures without downloading weights. The speech fixture's source,
public-domain provenance and encoding are in `tests/fixtures/jfk.md` in oxide-core.

**#235 hardware validation must still execute Medium/Large v3/Large v3 Turbo,
exercise each supported GPU backend, and measure peak RAM/VRAM and loading/staging
budgets for every model/backend before marking estimates measured or claiming
support.** Confirm offline execution on physically disconnected packaged builds,
then apply #231 reserves and #232 benchmark rules. This slice does not complete
the parent issue's platform acceptance matrix.

The [#235 acceptance record](dictation-acceptance/issue-235.md) maps each model to
real-artifact tests, installed measurements and remaining peak-memory work. Sampled
process/GPU counters are lower bounds; they do not by themselves change any
catalogue entry to `measured: true`.
