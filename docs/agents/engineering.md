# Engineering config

Read by `/verify`, `/judge`, `/build`, `/ship`, `/ui` and `/release`.

## Risk

- floor: medium
- sensitive: no
- high-risk paths:
  - `.github/workflows/**`, `tools/ci/**`, `deny.toml`: CI gate, supply chain and release pipeline (read `docs/devops.md` first)
  - `crates/oxide-app/capabilities/**`, `crates/oxide-app/tauri.conf.json`: Tauri permissions and the app's security surface
  - `crates/oxide-provider/**`: spawns provider CLIs and carries permission modes (ADR 0004)
  - `crates/oxide-core/**`: the transcript Oxide owns (ADR 0002) and thread deletion (ADR 0005)
  - `Cargo.lock`, `web/pnpm-lock.yaml`: dependency changes

## Recipe

- setup: `pnpm --dir web install --frozen-lockfile` (Rust needs CMake, a C/C++ compiler and libclang, see `docs/dictation.md`; install `cargo-nextest` with `cargo install --locked cargo-nextest`; two `oxide-core` tests (`deleting_a_board_thread_preserves_unsaved_buffers_and_stops_editor_processes_after_save` and `language_server_transports_unsaved_diagnostics_and_completion`) run a fixture language server with the command `python`, so a modern `python` must be on the PATH, not only `python3` (macOS ships only `python3`: symlink it into a directory on the PATH). Without it `rust-test` fails with "Pyright is not installed", which is misleading)
- checks:
  - `node tools/check.mjs fast` (rustfmt, ESLint, TypeScript)
  - `node tools/check.mjs` (everything the PR lanes run on this OS: Vitest, web build, Clippy, Rust tests, bindings check, app bundle)
- run: `web/node_modules/.bin/tauri dev`, a native desktop window (no URL)
- exercise: Provider adapters against fake CLIs and fixtures through the Rust tests; the UI by running the app, and Vitest for web-only behaviour. `cargo test -p oxide-provider --test codex_live_smoke -- --ignored` hits a real Codex and needs the user's login
- screenshots: none automated; capture the app window by hand (see `/ship` for upload)
- test data: fixtures in the test suites; use synthetic threads, never real ones

## Review

- second_opinion: none

## Release

- release: only a human tags releases; the runbook is in `docs/devops.md` (ADR 0008)
