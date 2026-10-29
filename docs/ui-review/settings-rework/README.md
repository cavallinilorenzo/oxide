# Settings, command blocks and GitHub setup

The existing dark palette, blue actions and Octicons remain the visual system.
Settings use a section navigation bar and aligned typography rows. Each area
has an installed-font dropdown, weight, size and preview. The main Save button
saves both appearance and defaults; invalid theme JSON stops the save before
Provider defaults are written. The active navigation item follows the Settings
scroller using the same square, underlined tabs as the GitHub Surfaces.
Theme JSON uses an explicit Edit JSON / Close JSON editor button.
General, Provider defaults and keyboard shortcuts retain
their existing controls and persistence.

## Evidence

- `appearance-wide.png`, `appearance-900.png`, `appearance-narrow.png`: real
  Settings components at 1280×900, 900×700 and 540×760; family/size/weight selection
  and Save exercised before capture.
- `providers-wide.png`: Provider navigation, permission dropdown and Save.
- `theme-editor.png`: the explicit JSON editor toggle and active Appearance item.
- `updates-available.png`, `updates-progress.png`: available release, download
  progress and Updates navigation; native service fixtures never install an app.
- `github-missing.png`, `github-ready.png`: deterministic native-service fixtures
  for the two install steps, disabled controls during installation and recheck.
- `../terminal-refinement/native-blocks.png`: real Rust PTY output, with separators,
  command/output alignment and frozen elapsed time. The terminal regression also
  exercises an interactive fullscreen app, history and shell completion.
- `../terminal-refinement/appearance.png`: system font enumeration through Core
  on Windows, selection of Consolas and JSON theme import/apply against a live PTY.

Reproduce with a Vite dev server and Playwright available to Node:

```powershell
cargo build -p oxide-core --example terminal_harness
node web/scripts/settings-regression.cjs
node web/scripts/terminal-regression.cjs --appearance
node web/scripts/terminal-regression.cjs
```

Set `OXIDE_PLAYWRIGHT_PATH` when Playwright is outside the normal module path.
`OXIDE_TEST_URL` and `OXIDE_TEST_OUTPUT` override the server and capture directory.

## Native behavior and limits

Font enumeration uses Windows installed font families, macOS System Profiler,
or Linux Fontconfig. Older saved appearance settings keep their default sizes
and weights. Font files are not downloaded.

Git/GitHub CLI installation uses fixed package IDs with WinGet on Windows or
Homebrew on macOS, only after clicking Install. Without a supported package
manager, the wizard opens the official installation guide. Core and newly
started terminals also search the standard installation paths, so a stale
GUI PATH need not force a restart for the usual Windows installations.

The installer UI and recovery states use deterministic fixtures in browser QA;
no real packages were installed or accounts authenticated on the developer's
computer. macOS/Linux native enumeration and installation require their own
platform validation.

The Updates section checks the latest published stable release on request.
Core blocks installation while files are unsaved or Threads are active, including
pending approvals; the Tauri updater verifies the package signature. Windows
installs through NSIS; macOS replaces the app bundle and restarts. Release
publishing remains a human action. See CONTRIBUTING.md for signing and feed setup.
