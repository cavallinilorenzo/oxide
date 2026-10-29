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
download script; its LFS SHA-256 is pinned in Core. Library and GPU dependencies
remain subject to the repository's cargo-deny license checks.
