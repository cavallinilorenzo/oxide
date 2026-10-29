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

One cross-platform command runs what the pull request lanes of CI run on your OS, with the same commands (it works in PowerShell too). The CI workflow (`.github/workflows/ci.yml`) runs these lanes on every pull request, and its `gate` job is the one required check. The Rust jobs need no Node and no `web/dist`.

```sh
node tools/check.mjs        # everything the PR lanes run on this OS
node tools/check.mjs fast   # rustfmt, ESLint and TypeScript, in seconds
```

The full tier installs the web dependencies from the lockfile, then runs formatting, ESLint, TypeScript, Vitest, the production web build, the tooling tests, the Tauri alignment check, Clippy, the Rust tests, the committed-bindings check and this OS's app bundle. It prints what it can't run here and why (for example the macOS bundle on Windows, or cargo-deny, which CI installs), and lists every failed command at the end so you can rerun it directly.

The Rust tests run with [cargo-nextest](https://nexte.st), as in CI. Install it once with `cargo install --locked cargo-nextest`. Every Rust check also builds the dictation engine, which needs CMake, a C/C++ compiler and libclang (see [docs/dictation.md](docs/dictation.md)).

Before every commit, `node tools/check.mjs fast` is enough. To run it automatically, add it to `.git/hooks/pre-commit` yourself; the repository doesn't install hooks, and CI is the authority.

The pipeline's decisions (which lanes a change needs, the merge gate, PR titles, release versions, release notes, Dependabot auto-merge, the updater feed) live as pure functions in `tools/ci/policy.mjs`, with a command-line wrapper in `tools/ci/cli.mjs`. `node --test "tools/**/*.test.mjs"` runs all the tooling tests.

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

The local check runner (`node tools/check.mjs`) and the local build
(`pnpm --dir web build:app`) check the build-artifact budget before and after
each Rust compilation or Tauri bundle. They stop further builds above 12 GiB. `OXIDE_BUILD_BUDGET_GIB` sets a different positive budget.
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

## Dependencies and supply-chain policy

**Dependabot** (`.github/dependabot.yml`) watches Cargo, the pnpm web app, GitHub Actions and the Rust toolchain every Monday at 07:00 (Europe/Rome). Version updates wait out a cooldown first, so a broken or hijacked release is usually pulled before it reaches us: 3 days for patches, 7 for minors and 14 for majors (7 flat for Actions and the toolchain, and 7 for npm patches to match pnpm's `minimumReleaseAge`). Security updates skip the cooldown. Related packages move together in groups (`tauri`, `specta`, `react`, `lint`, `build-test`, `xterm`, `monaco`, `actions`), and the remaining minor and patch updates share one group per ecosystem. Titles are `chore(deps): …` or `chore(deps-dev): …`, with the `dependencies` label. The `references/` submodules are ignored.

**Auto-merge.** The *Dependabot auto-merge* workflow acts only on PRs authored by `dependabot[bot]`. `dependabotDecision` in `tools/ci/policy.mjs` decides: patches, and minors of packages at 1.0 or later, may auto-merge (squash) once `gate` is green. Majors, 0.x minors, 0.0.x patches, the `tauri` and `specta` groups, and anything unreadable get the `manual-review` label and a comment. Auto-merge needs a GitHub App installed only on this repository (Contents, Pull requests and Workflows: read and write), whose ID and private key are the **Dependabot** secrets `AUTOMERGE_APP_ID` and `AUTOMERGE_APP_PRIVATE_KEY`. The App token is needed because a merge made with `GITHUB_TOKEN` triggers no `main` run, so the commit would never get a `gate` result. Without those secrets the workflow only labels and comments, and you merge by hand.

**Licences, sources and advisories.** `deny.toml` is the policy: a licence allowlist (MPL-2.0 and Unlicense are allowed with a stated reason), wildcard versions denied, crates.io as the only source. The `supply-chain` CI job runs `cargo deny check bans licenses sources`, and dependency review applies the same licences to npm and rejects new high or critical advisories. The daily *Advisories* workflow runs `cargo deny check advisories` over the whole tree and opens, or comments on, one `needs-triage` issue when it fails. It is not a PR check, so a new advisory against an untouched crate never blocks unrelated work. Run `cargo deny check` locally (`cargo install --locked cargo-deny`).

**pnpm.** `web/pnpm-workspace.yaml` sets `minimumReleaseAge` to 7 days, so `pnpm add` and `pnpm update` refuse fresher versions, and keeps `allowBuilds` as the explicit list of packages allowed to run install scripts (empty today). A dependency that gains an install script fails `pnpm install` until you review it and add it.

## Coding agents

Oxide is developed with coding agents. [AGENTS.md](AGENTS.md) is the single source of instructions for them (Claude Code, Codex, Antigravity). `CLAUDE.md` and `GEMINI.md` just point to it. The agent docs live in [docs/agents/](docs/agents/), and the skills agents use are in `.agents/skills/`. Human contributors follow the same branch model and checks.


## Releasing Oxide

Only the two Release Managers, `cavallinilorenzo` and `itsmrma`, turn a `main`
commit into an official release. The binding control is the `release`
environment: its required reviewers are exactly those two, and the signing
secrets are unreadable until one of them approves. A `v*` tag ruleset makes tags
immutable (no update, no deletion) for everyone but the repository admin.
Publishing stays a human click.

1. Bump the version through a PR into `main` titled `chore(release): vX.Y.Z`.
   `node tools/ci/cli.mjs bump X.Y.Z` writes it to `Cargo.toml`, the Tauri config
   and `web/package.json`, and updates the workspace entries of `Cargo.lock`.
   Use `vX.Y.Z-rc.N` for a release candidate: it is published as a pre-release
   and never reaches the update feed.
2. Wait for `gate` to succeed on the `main` run of the merge commit. That run
   also builds both bundles, so the commit is proven packageable.
3. Tag that commit and push the tag:

   ```sh
   git tag -a vX.Y.Z <sha> -m "Oxide vX.Y.Z"
   git push origin vX.Y.Z
   ```

   The Release workflow's `verify` job fails with an actionable message unless
   the tag is on `main` (or `release/*`), matches the three manifests, and has
   a successful `gate` on that commit's push run.
4. Approve the `release` deployment in the Release run (Actions → Release →
   Review deployments). Either Release Manager may approve, including the one
   who pushed the tag.
5. The `publish` job creates a **draft** release with the `.dmg`, the
   `.app.tar.gz` and `-setup.exe` updater packages with their `.sig` files,
   `latest.json`, `SHA256SUMS.txt`, the SPDX SBOM, build provenance
   attestations, and draft notes with per-platform signing notices. Each build
   is a clean, cache-free rebuild of the tagged commit.
6. Download the draft's builds and run the live Provider smoke tests on each
   platform you can. Edit the notes, then Publish.
7. Watch the "Verify release" run. It re-downloads every asset, checks the
   checksums and attestations (`gh attestation verify <file> --repo
   cavallinilorenzo/oxide`) and, for a stable release, that
   `releases/latest/download/latest.json` serves this version with resolving URLs
   and non-empty signatures. On failure it opens a `needs-triage` issue.

**Rollback is rolling forward.** Published releases are immutable and installed
apps only update forward: ship a patch release.

### Secrets and signing

The `release` environment holds `TAURI_SIGNING_PRIVATE_KEY` (and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key has one). The release build fails
if the key is missing. Keep an encrypted offline backup: installed apps accept
only packages signed by that key, and the matching public key is in
`crates/oxide-app/tauri.conf.json`. Never commit the key or replace the public
key casually.

When the Apple secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`,
`APPLE_API_PRIVATE_KEY`) are present in the same environment, the macOS build is
signed and notarized. Without them it is ad-hoc signed, and the release notes
say so. The Windows installer is not Authenticode-signed; the notes mention
SmartScreen.

### Rehearsing a release

Normal local builds need neither the signing key nor the updater config. To
rehearse the pipeline, tag a release candidate (`vX.Y.Z-rc.1`) after the bump
merged; it produces a draft pre-release. Afterwards the repository admin deletes
the draft and the tag.

Drafts and pre-releases never become the stable feed. The first published signed
stable release enables the feed; an update appears only when it is newer than
an installed app. A missing feed or connection failure is reported as a failed
check, never as "up to date". See [Tauri's updater
guide](https://v2.tauri.app/plugin/updater/) for the signing model.
