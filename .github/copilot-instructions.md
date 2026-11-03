# Copilot instructions for Oxide

## Repository shape and architecture

Oxide is a Rust/Tauri desktop application with a React/Vite webview. The Rust workspace contains:

- `crates/oxide-core`: headless application and domain logic. It owns Projects, Threads, Turns, persistence, Git/GitHub integration, terminals, language servers, settings, dictation, and background actors. Keep this crate independent of Tauri so its behavior can be tested headlessly.
- `crates/oxide-provider`: the Provider contract and adapters for Claude Code, Codex, and Antigravity (`agy`). Core depends on the trait/contract, not on provider-specific CLI details. The contract suite uses fake providers; live CLI smoke tests are explicitly ignored.
- `crates/oxide-app`: the thin Tauri shell. Tauri commands adapt `oxide_core::Core` types to the webview, and `tauri-specta` generates the typed TypeScript command API.
- `web`: the React frontend. It calls Rust only through `web/src/bindings.ts` and renders the workspace surfaces (Projects, Threads, files/diffs, terminal, pull requests, issues, board, and settings).
- `crates/oxide-vulkan-worker` and `crates/oxide-cuda-worker`: standalone native dictation workers excluded from the Cargo workspace; Windows packaging builds and stages them separately.

The normal flow is `web` UI -> generated Tauri bindings -> `oxide-app` command -> `oxide-core` -> provider/Git/filesystem/process services. Long-running or blocking work is moved off the Tauri/UI thread; per-Thread work is coordinated by Core thread actors, and external processes are tracked by the provider process registry. Core persists application state in SQLite under the Oxide home directory.

Use the vocabulary in `GLOSSARY.md` (especially Project, Thread, Turn, Provider, and Worktree) and check relevant decisions in `docs/adr/` before changing cross-cutting behavior.

## Commands

Prerequisites are the pinned Rust toolchain from `rust-toolchain.toml`, Node.js 22, and pnpm from `web/package.json` (enable Corepack). Install frontend dependencies with:

```sh
pnpm --dir web install
```

Preferred CI-equivalent checks:

```sh
node tools/check.mjs       # all PR-lane checks available on this OS
node tools/check.mjs fast  # rustfmt, ESLint, and TypeScript
```

The full runner uses `cargo-nextest`; install it once if needed:

```sh
cargo install --locked cargo-nextest
```

Individual checks:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --workspace
cargo nextest run --locked --workspace --profile ci
pnpm --dir web typecheck
pnpm --dir web lint
pnpm --dir web test
pnpm --dir web build
node --test "tools/**/*.test.mjs"
```

Run a single Rust test by package/test target and name:

```sh
cargo test -p oxide-core test_name
cargo nextest run -p oxide-core -E 'test(test_name)'
```

Run a single frontend test file or test name:

```sh
pnpm --dir web exec vitest run src/path/to/file.test.tsx
pnpm --dir web exec vitest run -t "test name"
```

When a Tauri command or exposed type changes, regenerate the committed bindings and verify them:

```sh
cargo test -p oxide-app --test bindings_and_capabilities
```

Run live provider tests only when the corresponding CLI is installed and logged in:

```sh
cargo test -p oxide-provider --test claude_live_smoke -- --ignored
cargo test -p oxide-provider --test codex_live_smoke -- --ignored
cargo test -p oxide-provider --test agy_live_smoke -- --ignored
```

Run the app from the repository root so Tauri finds `crates/oxide-app/tauri.conf.json`:

```sh
pnpm --dir web build:app
web/node_modules/.bin/tauri dev
```

On Windows, use `.\web\node_modules\.bin\tauri.cmd` for the Tauri CLI. GPU dictation packaging has additional SDK setup documented in `docs/dictation.md`.

## Codebase conventions

- Treat `oxide-core` as the source of application behavior. Add Tauri-specific serialization or `specta::Type` derives in `oxide-app` rather than coupling Core to Tauri.
- Tauri commands are collected in `crates/oxide-app/src/lib.rs`; update the command registration and regenerate `web/src/bindings.ts` in the same change. The bindings diff is checked in CI.
- Preserve the Provider seam: provider adapters translate CLI-specific events and tool names into shared enums/types. UI code should consume normalized `ItemKind`, `ActivityCategory`, approval, and turn-status values rather than matching provider strings.
- Use fake providers and Core’s headless tests for deterministic behavior. Do not make ordinary tests depend on installed CLIs, logins, network access, or secrets; live smoke tests remain `#[ignore]`.
- Keep blocking filesystem, Git, process, and native-worker work off the Tauri/UI thread. Follow existing actor/process-registry patterns for work that spans events or needs cancellation.
- Keep frontend state and surface behavior in `web/src`; call backend operations through the generated `commands` API and handle its typed `{ status: "ok" | "error" }` results consistently.
- `tools/ci/policy.mjs` is the source of truth for CI lane selection, gate evaluation, PR-title validation, release version alignment, and related pipeline policy. Change its pure functions and tests together rather than encoding policy only in workflow YAML.
- `web/pnpm-workspace.yaml` enforces a seven-day package release age and currently allows no install scripts. Review dependency changes against that policy; keep Tauri Rust and JavaScript major/minor versions aligned.
- Use the repository branch model: branch from `main` with a type such as `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, or `research`; open PRs against `main`; use Conventional Commit PR titles; include `Closes #<id>` when a change addresses an issue. Do not push directly to `main` or create release tags.

For CI, workflow changes, release work, or changes to checks, read `docs/devops.md` and the relevant files under `docs/agents/` before editing.
