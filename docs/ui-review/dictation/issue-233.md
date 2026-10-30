# Settings evidence — #233

Automated browser run on macOS, Chromium, deterministic IPC fixtures (no real
microphone, downloads or user settings):

```sh
OXIDE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/scripts/dictation-review.mjs
```

The script renders the real app at 1280 × 800, 1064 × 700 and 600 × 800.
It asserts no page overflow, advanced adapter focus, keyboard mode selection
(ArrowDown/Home/Enter), Escape focus restoration, shortcut capture and insertion
without `send_prompt`. No browser page errors. Screenshots: `settings.png`,
`settings-1064.png`, `settings-600.png`, `models-600.png`, `performance-600.png`.

Component tests use the IPC boundary and real controls. They cover legacy Small
and Italian preservation, all six multilingual catalogue entries, unknown resources,
AMD/Vulkan, NVIDIA/CUDA, Apple/Metal, available vs actual CPU fallback, actionable
capability failures, explicit advice, missing models, duplicate downloads, retry,
cancellation and late benchmark completion. Dictation target tests cover Escape,
closed targets, focus changes, exactly-once insertion, disable during transcription,
CPU fallback announcement and terminal control-character/newline sanitization.
Native tests retain language validation, settings migration, one CPU retry and
recording configuration snapshots; new backend/adapter settings round-trip coverage
protects the persisted stable identity.

## Final release validation (one consolidated manual pass)

Keep the hardware/distributed acceptance matrix in #235 open. At the final release
pass on PC and Mac, validate the distributed build with physical CPU, AMD/NVIDIA
and Apple Silicon hardware: real microphone/permissions, driver and adapter removal,
OOM and recovery, installed-model offline operation, all model sizes, download
cancel/retry/delete, runtime vs actual execution, shortcut rebinding, chat and
terminal insertion without execution. Check screen-reader announcements, focus
visibility and long settings scrolling at desktop/minimum window sizes. Include
any iOS review client used to inspect release evidence; Oxide itself is a desktop
app and this change makes no iOS runtime claim. CUDA/Metal performance checks
remain explicitly unavailable until #258 supplies dispatch evidence.

No audio/transcripts are logged or exported by these changes. No telemetry or
new diagnostics export flow is introduced.
