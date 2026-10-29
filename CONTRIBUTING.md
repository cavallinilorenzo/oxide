# Contributing to Oxide

Thanks for your interest! This guide covers how changes flow into the repo, and how to run the checks locally. Build prerequisites are in the [README](README.md#build-from-source). The domain language (Project, Thread, Turn, Provider…) is in [GLOSSARY.md](GLOSSARY.md): please use it in code, issues and PRs.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Branch model

The full rules are in [docs/agents/git-workflow.md](docs/agents/git-workflow.md). In short:

- `main` is the only long-lived branch and the default. Nobody pushes to it directly.
- **Branch from `main`**: `git fetch origin && git switch -c <type>/<slug> origin/main`. Here `<type>` is `feat`, `fix`, `docs`, `chore`, `refactor`, `test` or `research`. Include the issue number when there is one, e.g. `feat/42-terminal-surface`.
- **Open PRs against `main`** (`gh pr create --base main`). PRs are squash-merged.
- Put `Closes #<id>` in the PR body. `main` is the default branch, so the issue closes when the PR merges.

## Local checks

There is no CI. Run these locally before pushing:

- Rust: `pnpm --dir web install && pnpm --dir web build` (Tauri embeds `web/dist`), then `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `git diff --exit-code web/src/bindings.ts`
- Web: `pnpm --dir web typecheck`, `pnpm --dir web lint`, `pnpm --dir web test`
- App bundle: `pnpm --dir web build:app` from the repo root (keeps final outputs, cleans its compiler cache)

### Local build disk usage

Development builds and tests use line-table debug information and disable
incremental compilation to keep `target/` manageable. Backtraces retain file and
line information; inspecting local variables in a native debugger requires full
debug information. Dependency builds remain cached, while rebuilding a changed
workspace crate can take longer. Release settings are unchanged.

Use `cargo clean` to remove accumulated build artifacts. Close a locally built
Oxide first if Windows reports that its release executable is in use. For a
debugging session, `CARGO_PROFILE_DEV_DEBUG=2` restores full debug information;
`CARGO_INCREMENTAL=1` opts back into incremental compilation.

The local build (`pnpm --dir web build:app`) checks the build-artifact
budget before and after each Rust compilation or Tauri bundle. It stops further
builds above 12 GiB. `OXIDE_BUILD_BUDGET_GIB` sets a different positive budget.
This is a checkpoint between commands, not a filesystem quota: one command can
exceed the budget before returning.

Both the check runner and `pnpm --dir web build:app` use a temporary target
directory for Rust compilation. Extra Tauri build flags can follow `build:app`.
All checks in one run share it; it is automatically deleted when the run finishes, including
test failures and budget errors. An explicit `CARGO_TARGET_DIR` is used as the
parent of this scratch directory, leaving existing outputs intact. The runner
never stops an app or cleans another build's files. Separate runs rebuild their
dependencies and can take longer, in exchange for leaving no compiler cache.

Successful Tauri builds retain the final app binary and bundles under
`target/check-artifacts/run-<id>/` (or the configured Cargo target), and print the
exact location. If saving an output fails, the scratch directory is retained
with an error instead of losing the only copy. A forced process kill or power
loss can also leave scratch files; `cargo clean` removes those leftovers.
Direct Cargo/Tauri invocations bypass this automatic cleanup.

### Regenerating the TypeScript bindings

`web/src/bindings.ts` is generated from the Rust command signatures by [tauri-specta](https://github.com/specta-rs/tauri-specta). After changing a Tauri command or a type it exposes, regenerate and commit the file:

```sh
cargo test -p oxide-app --test bindings_and_capabilities
```

Running the app in development mode regenerates it too. Commit it whenever it changes.

### Live Provider smoke tests

The Provider contract suite runs against fake Providers, so CI needs no real CLIs, logins or secrets. The live smoke tests drive the real installed CLIs and are `#[ignore]`d. Run them by hand when you touch a Provider adapter, with that Provider installed and logged in:

```sh
cargo test -p oxide-provider --test claude_live_smoke -- --ignored
cargo test -p oxide-provider --test codex_live_smoke -- --ignored
cargo test -p oxide-provider --test agy_live_smoke -- --ignored
```

## Issues and triage

Use the issue forms ([bug report](https://github.com/cavallinilorenzo/oxide/issues/new?template=bug_report.yml), [feature request](https://github.com/cavallinilorenzo/oxide/issues/new?template=feature_request.yml)). New issues get `needs-triage`, and the maintainer moves them on to `needs-info`, `ready-for-agent`, `ready-for-human` or `wontfix` (see [docs/agents/triage-labels.md](docs/agents/triage-labels.md)). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## Coding agents

Oxide is developed with coding agents. [AGENTS.md](AGENTS.md) is the single source of instructions for them (Claude Code, Codex, Antigravity). `CLAUDE.md` and `GEMINI.md` just point to it. The agent docs live in [docs/agents/](docs/agents/), and the skills agents use are in `.agents/skills/`. Human contributors follow the same branch model and checks.


## Publishing application updates manually

Settings → Updates checks the latest published stable GitHub release. Publishing
stays a human action; this repository has no CI/CD release workflows.

The updater public key and feed URL are in `crates/oxide-app/tauri.conf.json`.
The corresponding private key is kept outside the checkout in the user's
`.oxide/release-keys/oxide-updater.key`, with access restricted to that user.
Keep a secure backup: installed versions need future packages signed by that
same key. Never commit it or replace the public key casually.

1. Bump the version in `Cargo.toml`, the Tauri config and `web/package.json` through
   a PR into `main`. Only a human tags a release.
2. Build on the platform being released. Set `TAURI_SIGNING_PRIVATE_KEY` to the
   private-key file path, then run Tauri from the repository root with
   `--config crates/oxide-app/tauri.updater.conf.json`. For example, on Windows:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $env:USERPROFILE '.oxide/release-keys/oxide-updater.key'
   web/node_modules/.bin/tauri.cmd build --ci --bundles nsis --config crates/oxide-app/tauri.updater.conf.json
   Remove-Item Env:/TAURI_SIGNING_PRIVATE_KEY
   ```

   On macOS Apple Silicon, use `--target aarch64-apple-darwin --bundles app,dmg`.
   Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if the key has a password.
   Normal local builds do not need the signing key or the extra config.
3. Collect the updater packages and their `.sig` files in a release directory:
   Windows `Oxide_X.Y.Z_x64-setup.exe`, macOS `Oxide.app.tar.gz`. Each included
   package must have a signature; platforms can be released independently.
4. Generate the feed locally, for example:

   ```sh
   node tools/releases/update-manifest.mjs release-artifacts v0.2.0
   node --test tools/releases/update-manifest.test.mjs
   ```

   An optional fourth argument overrides `cavallinilorenzo/oxide` for a fork.
5. Upload the packages, signatures and generated `latest.json` to the matching
   draft GitHub release, then review and publish it. The human-created tag must
   match the package version. Do not upload debug builds as releases.

Drafts and prereleases do not become the stable feed. The first published signed
stable release enables the feed; an update appears only when it is newer than
an installed app. A missing feed or connection failure is reported as a failed
check, never as “up to date”. The local manifest helper supports Windows x64 and
macOS Apple Silicon packages. OS signing/notarization is separate from the
updater signature; see [Tauri's updater guide](https://v2.tauri.app/plugin/updater/).
