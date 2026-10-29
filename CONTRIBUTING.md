# Contributing to Oxide

Thanks for your interest! This guide covers how changes flow into the repo, how to get CI green locally, and how releases are cut. Build prerequisites are in the [README](README.md#build-from-source). The domain language (Project, Thread, Turn, Provider…) is in [GLOSSARY.md](GLOSSARY.md): please use it in code, issues and PRs.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Branch model

The full rules are in [docs/agents/git-workflow.md](docs/agents/git-workflow.md). In short:

- `main` is the only long-lived branch and the default. Nobody pushes to it directly.
- **Branch from `main`**: `git fetch origin && git switch -c <type>/<slug> origin/main`. Here `<type>` is `feat`, `fix`, `docs`, `chore`, `refactor`, `test` or `research`. Include the issue number when there is one, e.g. `feat/42-terminal-surface`.
- **Open PRs against `main`** (`gh pr create --base main`). PRs are squash-merged.
- Put `Closes #<id>` in the PR body. `main` is the default branch, so the issue closes when the PR merges.

Dependabot branches (`dependabot/...`) are the one exception to the `<type>/<slug>` naming rule.

## Local checks

These are the checks CI runs on every PR. Get them green locally before pushing. The ruleset on `main` lists which jobs are required to merge (see [docs/agents/git-workflow.md](docs/agents/git-workflow.md)).

| CI job | Run locally |
| --- | --- |
| `rust` | `pnpm --dir web install && pnpm --dir web build` (Tauri embeds `web/dist`), then `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `git diff --exit-code web/src/bindings.ts` |
| `web` | `pnpm --dir web typecheck`, `pnpm --dir web lint`, `pnpm --dir web test` |
| `supply-chain` | `node .github/scripts/tauri-alignment.mjs`, `cargo deny --locked check bans licenses sources` ([cargo-deny](https://github.com/EmbarkStudios/cargo-deny)). On PRs, GitHub's dependency review also rejects newly added dependencies with high or critical advisories. |
| `repo-config` | `actionlint`, `zizmor .`, `node --test .github/scripts/*.test.mjs`, and schema validation with [check-jsonschema](https://github.com/python-jsonschema/check-jsonschema) (`uvx check-jsonschema==0.38.2 …`; the exact invocations are in the `repo-config` job of [ci.yml](.github/workflows/ci.yml)) |

PRs into `main` also run the `bundle` job of the [Release workflow](.github/workflows/release.yml), which builds the real app bundle. Run a local app build with `pnpm --dir web build:app` from the repo root; it preserves final outputs and cleans its compiler cache automatically.

`cargo deny check advisories` runs daily in the [Advisories workflow](.github/workflows/advisories.yml), not on PRs, so a new advisory against an untouched crate doesn't block unrelated work.

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

The local check runner (`node tools/checks/run.mjs pr`) checks the build-artifact
budget before and after each Rust compilation or Tauri bundle. It stops further
checks above 12 GiB. `OXIDE_BUILD_BUDGET_GIB` sets a different positive budget.
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

Running the app in development mode regenerates it too. CI fails if the committed file is stale.

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

## Dependencies and Dependabot

[Dependabot](.github/dependabot.yml) watches Cargo, the pnpm web app (`web/`), GitHub Actions and the Rust toolchain:

- **Version updates** open weekly, on Monday morning (Europe/Rome), against `main`. They only open after a cooldown (3 days for patch, 7 for minor, 14 for major releases; 7 days flat for GitHub Actions and the Rust toolchain), so a compromised or broken release is usually pulled before it reaches us. Minor and patch updates share one grouped PR per ecosystem. Related packages move together in named groups: `tauri`, `specta`, `react`, `lint`, `build-test`, `xterm` and `actions`. Every other major update gets its own PR.
- **Security updates** open as soon as an advisory affects us, without the cooldown, against the default branch (`main`).
- PRs are labelled `dependencies` plus `rust`, `javascript` or `github-actions`, with commit messages prefixed `chore(deps)` (`chore(deps-dev)` for dev dependencies).

The [auto-merge workflow](.github/workflows/dependabot-auto-merge.yml) applies this policy:

- **Auto-merges (squash) once required checks pass:** patch updates, and minor updates of packages at 1.0 or later. This also applies to grouped and GitHub Actions PRs.
- **Waits for the maintainer, labelled `manual-review`:** major updates, minor updates of 0.x packages (and patch updates of 0.0.x packages), anything in the `tauri` or `specta` groups, and any update whose versions Dependabot can't report.

A `specta` bump usually changes the generated bindings, so the `rust` job fails until someone regenerates them. That's intended. The Rust and web `tauri` groups open separately on the same day. The `supply-chain` job fails until both halves are on the same `major.minor`, so check out one branch, merge the other into it, and land them together.

Some versions are not managed by Dependabot and stay manual:

- the Node.js version used in CI (`node-version` in the workflows)
- the pnpm version (`packageManager` in `web/package.json`). Dependabot officially supports pnpm up to v10, while we pin pnpm 11, whose lockfile format is the same v9 format. If Dependabot fails to parse `web/pnpm-lock.yaml`, its security alerts still work from the lockfile.
- the tool versions pinned in `.github/workflows/` (actionlint, zizmor, cargo-deny, check-jsonschema)

Third-party actions are pinned to full commit SHAs, with the version as a trailing comment. Dependabot updates both.

## Releasing

Releases are tagged on `main` by the maintainer:

1. **Bump the version** in a normal PR into `main`. Three places must agree: `version` in `[workspace.package]` of `Cargo.toml`, `version` in `crates/oxide-app/tauri.conf.json`, and `version` in `web/package.json`. Run `cargo check` so `Cargo.lock` picks up the new version.
2. **Wait for the `bundle` job** to pass on the merged commit.
3. **Tag** that commit on `main` and push the tag:
   ```sh
   git fetch origin && git tag -a vX.Y.Z origin/main -m "Oxide vX.Y.Z" && git push origin vX.Y.Z
   ```
   A tag with a pre-release suffix (`vX.Y.Z-rc.1`) creates a pre-release. The release workflow refuses a tag that doesn't match the three declared versions.
4. **Review and publish** the draft release. It contains the macOS `.dmg` and `.app` archive, Windows x64 NSIS installer, updater signatures, `latest.json`, `SHA256SUMS.txt`, build-provenance attestations and generated notes. Publishing a stable release makes its signed packages available to **Settings → Updates → Check for updates**. Drafts and prereleases do not become the stable feed.

To test the pipeline without tagging, run the Release workflow manually (**Actions → Release → Run workflow**). It builds the bundle and uploads it as a workflow artifact only.

### Application updater signing

The updater's public key and stable feed URL are in `crates/oxide-app/tauri.conf.json`.
The release build merges `tauri.updater.conf.json` to produce signed packages.
Normal PR and local builds do not need the private key. Native commands own the
updater; the webview has no generic updater, process or filesystem permissions.

| Repository secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater private key corresponding to the committed public key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional password, only for a password-protected key |

The initial key is configured in the repository secret. Its local backup is
outside the checkout, in the user's `.oxide/release-keys/oxide-updater.key`, with
access restricted to that user. Keep a secure backup: future updates must use
the same key. Never commit the private key or replace the public key casually.

For a local updater package build, point `TAURI_SIGNING_PRIVATE_KEY` at that key
and run Tauri with `--config crates/oxide-app/tauri.updater.conf.json`.
The release pipeline requires the secret, builds both supported packages, and
generates a feed only when each package has a signature. An unpublished/missing
feed or a network failure is reported as a check failure, never as “up to date”.
The first published stable release from this pipeline enables the feed; there
is no update to download until a newer version is published. macOS Intel and
Linux packages are not currently built by the release workflow.

The package/feed format follows [Tauri's updater contract](https://v2.tauri.app/plugin/updater/).

### Signing and notarization

The release build signs and notarizes the app automatically when these repository secrets exist. Without them, it produces an ad-hoc-signed build and the release says it is unsigned.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the exported Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID (notarization) |
| `APPLE_API_KEY` | App Store Connect API key ID (notarization) |
| `APPLE_API_PRIVATE_KEY` | Contents of the `AuthKey_<id>.p8` file (notarization) |

See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) for how to create them.
