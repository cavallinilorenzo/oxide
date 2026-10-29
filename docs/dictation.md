# Local dictation

In Settings, download Whisper small (466 MiB), enable dictation, choose a language
(`auto`, `it`, `en`, or another Whisper language code), and save. CPU is the default.
The shortcut is Ctrl+Shift+R on Windows/Linux or Cmd+Shift+R on macOS, rebindable
in Settings. Focus a chat composer or terminal, press once to speak and again to
insert. The chat microphone button does the same. Escape cancels. Recordings stop
after two minutes. Text is inserted without submitting; terminal control characters
and newlines become spaces. Closing an input discards its pending result.

Audio is captured from the system default microphone in memory and never uploaded
or saved. The model is kept at `~/.oxide/models/ggml-small.bin`; it is downloaded only
when Download is pressed, with progress, SHA-256 verification and atomic publication.
No provider credentials, Python runtime, transcription subscription or API key is needed.
Silence and very short recordings are ignored. As with other speech recognition,
review names, paths and commands before submitting.

The resource advice uses current available RAM and logical CPU count, not a speed
benchmark. Below 2 GiB free RAM it recommends freeing memory. Below four CPU threads
it warns that transcription may be slow. Whisper small inference needs roughly 1 GiB;
other programs and GPU backend allocations require additional headroom.

## GPU and building

CPU works on all supported desktop platforms. macOS builds include Metal. For Vulkan
on Windows/Linux, install the Vulkan SDK (including glslc) and build with
`cargo build -p oxide-app --features dictation-vulkan`, or pass
`--features dictation-vulkan` to `tauri build`. The selected GPU must support the
backend and have a working driver. Settings reports whether GPU support was compiled;
it does not claim to have benchmarked or measured GPU VRAM. CPU-only builds report
an actionable error if GPU is selected. whisper.cpp may fall back to CPU if its GPU
backend cannot initialize.

Windows GPU inference has not been validated with this integration, and the local
Vulkan build encountered native CMake configuration failures. A compiled backend
does not prove GPU execution. Runtime verification, packaged GPU backends and
additional models are tracked in [spec #225](https://github.com/cavallinilorenzo/oxide/issues/225).

## Recoverable runtime architecture and extension points

The dictation architecture separates microphone capture and lifecycle coordination
from native model inference behind the `WhisperBackendRuntime` boundary:

- **Runtime ownership**: The `Dictation` coordinator in `oxide_core::dictation`
  owns the in-flight recording session and delegates inference to a backend
  runtime (`Arc<dyn WhisperBackendRuntime>`). Host application startup does not
  load or initialize GPU libraries; backend discovery is non-blocking and isolated
  so driver or runtime failures cannot crash Oxide or disable CPU dictation.
- **Build manifest and pinned versions**: `BuildManifest::current()` exposes
  pinned binding/native versions (`whisper-rs 0.16.0` and its bundled `whisper.cpp`)
  and the list of included backends (`cpu`, `metal`, `vulkan`, `cuda`). Compile-time
  flags specify packaged capability, never proof of runtime GPU use.
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
    available memory is at least 2.0 GB, attaching the fallback reason to the
    execution details. If memory is insufficient, the retry is refused.
  - In explicit `GPU` mode: failures are reported immediately with an offer to
    switch to CPU. CPU is never silently substituted for GPU.
- **Backend extension points and worker protocol**:
  - Direct native backends implement the `WhisperBackendRuntime` trait (`backend_id`, `probe`,
    `transcribe`).
  - Where GPU drivers or runtimes risk process instability, runtimes can execute as isolated
    worker child processes. Worker processes communicate over standard I/O using length-prefixed
    JSON messages corresponding to `TranscriptionRequest` and `TranscriptionOutcome`.
    At startup, workers exchange a versioned handshake (`protocolVersion: 1`, pinned binding
    and engine version) and must shut down immediately when stdin closes or on cancel.
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

## Licenses

Oxide is MIT. whisper.cpp and the original OpenAI model weights are MIT; whisper-rs
is Unlicense; CPAL is Apache-2.0; sysinfo is MIT. Their licenses permit commercial
redistribution. The MIT notices for whisper.cpp and the model are retained in
`docs/licenses/whisper.txt`. The model download URL follows whisper.cpp's official
download script; its LFS SHA-256 is pinned in Core. Review license terms when
adding or redistributing native GPU dependencies. The CI removal on main also
removed the cargo-deny configuration; restoring automated license checks is
tracked separately in issue #224.
