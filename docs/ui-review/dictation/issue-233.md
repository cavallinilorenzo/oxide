# Settings evidence — #233

Automated browser runs on macOS, Chromium and WebKit, deterministic IPC fixtures (no real
microphone, downloads or user settings):

```sh
OXIDE_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node web/scripts/dictation-review.mjs
```

The script renders the real app at 1280 × 800, 1064 × 700 and 600 × 800.
It asserts no page overflow, advanced adapter focus, keyboard mode selection
(ArrowDown/Home/Enter), Escape focus restoration, shortcut capture and insertion
without `send_prompt`. No browser page errors. Screenshots: `settings.png`,
`settings-1064.png`, `settings-600.png`, `models-600.png`, `performance-600.png`.
The `webkit/` directory contains the equivalent WebKit captures; both engines
passed the same assertions.

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

## Review fixes and verification

The two-axis review against `origin/main` has no remaining Standards or Spec
blockers. Review regressions cover stale preference after download completion and
recording-token cancellation of independently selected CUDA/Vulkan workers. The
adapter control reuses the shared keyboard-accessible Dropdown. CPU fallback uses
typed `fallbackReason` metadata, preserving native evidence separately.

The first full local runner completed all checks: 398 Rust tests passed, but the
web suite exposed a broad status selector in SettingsView and DMG decoration hit
macOS Finder Automation denial (-1743). The selector/IPC fixture is corrected;
the complete web suite then passed 475 tests. The final runner uses `CI=true`
with `CARGO_TARGET_DIR=/tmp/oxide-233-checks`, keeping the user's existing build
cache intact. Tauri's [pinned DMG bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs)
uses this headless path to skip Finder decoration; it does not skip compilation
or installer creation. The pre-existing ThreadView virtualizer lint warning
remains; there are no new lint warnings.

### Standards

The backend/adapter picker uses the shared Dropdown, satisfying the documented
control-reuse rule. Typed `fallbackReason` replaces parsing human-readable native
evidence. Re-review found no consequential standards concerns.

### Spec

Re-review found no blockers: selected-worker cancellation, stale preference/status
responses, and Auto benchmark/execution consistency are resolved. Direct testing
of Auto decision ranking is an optional future coverage improvement; deterministic
resource-policy decisions remain covered by the existing resource suite.

Remaining findings: Standards **0** (worst: none); Spec **0 blockers** (worst: none).

## Final local results

`CI=true CARGO_TARGET_DIR=/tmp/oxide-233-checks node tools/check.mjs` completed:
**12 passed, 0 failed, 7 CI/platform checks skipped, 0 not run**.
Includes 475 web tests, 400 Rust tests (7 intentionally ignored tests), 79 tooling
tests, formatting, ESLint, TypeScript, production web build, Tauri alignment,
Clippy, generated bindings and macOS app/DMG creation. The headless DMG build
passed; no Finder permission change was required. The unsigned local app and DMG
are retained under `/tmp/oxide-233-checks/check-artifacts/run-sOZJgU/release`.
GitHub CI is left for the maintainer to monitor.
