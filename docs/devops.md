# DevOps guide

How Oxide is checked, built and released, and why each piece exists. The structural decisions are recorded in [ADR-0008](adr/0008-continuous-delivery-with-human-published-releases.md); this guide is the operating manual.

Oxide has **CI** (every pull request and every `main` commit is verified) and **continuous delivery**: every `main` commit is proven releasable, but only a Release Manager turns one into an official release, and publishing stays a human click. There is no continuous deployment.

- [The pipeline](#the-pipeline)
- [Roles and how they are enforced](#roles-and-how-they-are-enforced)
- [CI jobs](#ci-jobs)
- [Lanes](#lanes)
- [Test layers](#test-layers)
- [Release workflows](#release-workflows)
- [Scheduled and automatic workflows](#scheduled-and-automatic-workflows)
- [Release runbook](#release-runbook)
- [Secrets and the fork/PR threat model](#secrets-and-the-forkpr-threat-model)
- [Pinned versions Dependabot can't bump](#pinned-versions-dependabot-cant-bump)
- [What to do with a flaky test](#what-to-do-with-a-flaky-test)
- [GitHub settings](#github-settings)

## The pipeline

```
pull_request ──► CI ─ changes ─┬─ web ─────────────── (Linux)
                               ├─ rust-fmt ────────── (Linux)
                               ├─ rust (macos)        Clippy + nextest + bindings
                               ├─ rust (windows)      Clippy + nextest + bindings
                               ├─ supply-chain ────── (Linux) deny, alignment, dependency review
                               ├─ automation ──────── (Linux) actionlint, zizmor, schemas, tooling tests
                               ├─ pr-title ────────── (Linux)
                               ├─ bundle (macos)      only when packaging inputs change
                               ├─ bundle (windows)    only when packaging inputs change
                               └─► gate   ◄── the ONE required check

push main / release/** ──► CI, every lane forced on (incl. both bundles) ──► gate on that commit

tag vX.Y.Z  (immutable once pushed)
   └─► Release ─ verify ─► [approval: environment `release`] ─► build macOS + Windows, signed ─► publish DRAFT
                                                                                    (checksums, attestations, SBOM, latest.json, notes)
Release Manager reviews and clicks Publish ──► immutable release ──► updater feed live ──► Verify release

daily  ──► Advisories (RustSec) ──► one tracking issue on failure
weekly ──► Dependabot ──► auto-merge low-risk / `manual-review`
```

Every decision the pipeline makes (which lanes a change needs, whether the gate passes, whether a PR title is valid, whether a tag matches the versions, the release notes, the Dependabot verdict, the contents of `latest.json`) is a pure function in [`tools/ci/policy.mjs`](../tools/ci/policy.mjs) with tests in `policy.test.mjs`. The workflows only gather inputs and act on the answers through [`tools/ci/cli.mjs`](../tools/ci/cli.mjs). YAML can't be unit-tested, so logic doesn't live there. To change a decision, change it test-first in `policy.test.mjs`.

## Roles and how they are enforced

**Release Managers** are `cavallinilorenzo` and `itsmrma`. They alone may approve a release build and publish a release. Everything below enforces that one rule from a different side.

| Control | What it does |
| --- | --- |
| `release` environment | Required reviewers are exactly the two Release Managers. The signing secrets are readable only by jobs of this environment, so no release is built, and no key is touched, until one of them approves. Deployment refs are limited to `v*` tags, so a workflow edited on a branch can't request the secrets. |
| `release tags` ruleset | `refs/tags/v*` can't be updated or deleted by anyone but the repository admin. Creation stays open to write collaborators. |
| `main protection` ruleset | PR required, required check `gate`, squash only, no force-push, no deletion. The same for `release/**`. |
| `verify` job | Refuses a tag that isn't on `main` or `release/*`, doesn't match the three manifests, or whose commit has no green `gate`. |
| Draft releases | The pipeline never publishes. A Release Manager reads the draft and clicks Publish. |
| Immutable releases | A published release's tag and assets can't change. |

**Why the tag ruleset can't limit who creates a tag.** Oxide lives in a personal repository: there is only the owner (admin) and collaborators (write), no Maintain role, and ruleset bypass lists take roles, not users. So tag creation can't be restricted to exactly two people. The `release` environment is the binding control: a tag pushed by anyone else just waits for approval that never comes. Moving to an organization would add a Maintain role, but it changes the repository URL that the updater feed hardcodes. Revisit if more collaborators get write access.

**Why self-approval is allowed.** With two Release Managers, strict four-eyes would block every release while one is away. The approval is still a deliberate second act: the approver sees `verify`'s result before the keys unlock.

## CI jobs

The workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). Triggers: `pull_request`, `push` to `main` and `release/**`, and manual dispatch. The token is read-only by default and each job asks for more only if it needs it. Concurrency is per ref: a new push cancels the superseded PR run, but a `main` run always finishes. Every job has a timeout sized to its normal duration. Runners are pinned to `ubuntu-24.04`, `macos-15` (Apple Silicon) and `windows-2025`.

In the tables, **Blocking** means a red job turns `gate` red. Every job below blocks.

The local runner is `node tools/check.mjs` (everything the PR lanes run on this OS) or `node tools/check.mjs fast` (rustfmt, ESLint, TypeScript). Where a job has no individual command, the entry says so.

### `changes`

- **What:** lists the PR's changed files through the API and calls `lanesFor`, which decides which lanes run.
- **Why:** a docs-only PR shouldn't wait for a Windows build.
- **When / where:** every run, Linux.
- **Blocking:** yes, indirectly. It fails open: if the list is missing, truncated or has a path no rule knows, every lane runs.
- **Local:** `node tools/ci/cli.mjs lanes <file-with-changed-paths>`.

### `web`

- **What:** frozen pnpm install, TypeScript, ESLint, Vitest, production `vite build`.
- **Why:** the checks are platform-independent (jsdom gives the same answer everywhere), so they run once on Linux and don't queue behind scarce macOS runners. The production build catches Vite, Monaco and Shiki breakage before the bundle job does.
- **When / where:** `web` lane, Linux.
- **Local:** `pnpm --dir web install --frozen-lockfile`, then `pnpm --dir web typecheck`, `lint`, `test`, `build`. All are part of `node tools/check.mjs`.

### `rust-fmt`

- **What:** `cargo fmt --all --check`.
- **Why:** mechanical, and it fails in seconds without waiting for a compile.
- **When / where:** `rust` lane, Linux.
- **Local:** `cargo fmt --all --check` (also in `fast`).

### `rust (macos)` and `rust (windows)`

- **What:** Clippy (`--locked --workspace --all-targets -D warnings`), then `cargo nextest run --locked --workspace --profile ci`, then a check that the generated `web/src/bindings.ts` is committed. Failures list flaky tests in the job summary and upload JUnit.
- **Why:** both are shipped platforms, and `cfg`-specific code (Metal and objc2 on macOS; Job Objects, the registry and the PowerShell PTY on Windows) only compiles on its own OS. Windows is the critical path, so these jobs install no Node and build no frontend: debug builds don't embed `web/dist`.
- **When / where:** `rust` lane, macOS and Windows.
- **Local:** `node tools/check.mjs` runs Clippy, the tests and the bindings check on your OS. It needs `cargo install --locked cargo-nextest`. The local run uses nextest's default profile, with no retries and no timeouts. Stale bindings: `cargo test -p oxide-app --test bindings_and_capabilities`, then commit `web/src/bindings.ts`.

### `supply-chain`

- **What:** the Tauri alignment check (the `tauri` crate and `@tauri-apps/*` packages must share a `major.minor`); `cargo deny check bans licenses sources` against the macOS and Windows graphs, and against the Vulkan and CUDA worker lockfiles (they ship but are outside the workspace), using [`deny.toml`](../deny.toml); on PRs, GitHub's dependency review (`fail-on-severity: high`, licence allowlist).
- **Why:** it is policy over lockfiles and needs no build. It stops a licence we can't ship, a git source, a wildcard version, a new dependency with a high advisory, or a half-landed Tauri bump from reaching `main`.
- **When / where:** `supplyChain` lane (any manifest, lockfile or `deny.toml`), Linux.
- **Local:** `node tools/ci/cli.mjs tauri-alignment` (in `check.mjs`), and `cargo deny check bans licenses sources` after `cargo install --locked cargo-deny`. Dependency review runs only in CI.

### `automation`

- **What:** actionlint, zizmor, JSON-schema checks of the issue forms and `dependabot.yml`, and `node --test "tools/**/*.test.mjs"` (the tooling suite).
- **Why:** broken automation must fail a PR instead of silently stopping. A typo in `dependabot.yml` otherwise disables updates; an expression injection or over-broad permission otherwise ships.
- **When / where:** `automation` lane (`.github/`, `tools/`), Linux.
- **Local:** `node --test "tools/**/*.test.mjs"` (in `check.mjs`). actionlint, zizmor and check-jsonschema run only in CI; the versions are in [Pinned versions](#pinned-versions-dependabot-cant-bump).

### `pr-title`

- **What:** `checkPrTitle`. The title must be `<type>(<scope>): <description>`; the scope is optional and `!` before the colon marks a breaking change. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `research`, `perf`, `build`, `ci`, `revert`.
- **Why:** PRs are squash-merged, so the title *is* the `main` commit and the release-notes line.
- **When / where:** pull requests only, Linux.
- **Local:** `PR_TITLE="fix(x): y" node tools/ci/cli.mjs pr-title`.

### `bundle (macos)` and `bundle (windows)`

- **What:** call the shared [`build.yml`](../.github/workflows/build.yml) with `release: false`: an unsigned release-profile `tauri build` (macOS `.app` + `.dmg`; Windows NSIS with the Vulkan and CUDA dictation workers), then the dictation package checks: macOS verifies the app; Windows installs the setup silently into a scratch folder, verifies it and probes each worker and the app with no SDK on `PATH`. The artifact is kept 7 days.
- **Why:** a debug `cargo test` never runs `tauri build`. This catches config, capability, icon, resource and frontend-embedding breakage, and a package that would need a developer SDK or crash without a GPU driver. Each check and the failure it prevents are in [docs/dictation.md](dictation.md#checks-and-what-each-prevents). The runners have no GPU, so this is not hardware validation.
- **When / where:** `bundle` lane on PRs (Tauri config or capabilities, icons, bundle resources, manifests and lockfiles, build scripts, the build workflow); **always** on `main` and `release/**`, so no commit is released without a proven bundle.
- **Local:** `node tools/check.mjs` builds your OS's bundle and runs its package checks; on Windows it first stages the GPU workers (`node tools/dictation-package.mjs stage`, which needs the Vulkan SDK and CUDA Toolkit from `node tools/dictation-package.mjs setup` and an x64 Native Tools prompt). It reports the other OS's bundle, and the silent install that only CI does, as skipped.

### `gate`

- **What:** `needs` every job above and runs `evaluateGate` (`if: always()`).
- **Why:** it is the one required status check, so adding, renaming or removing a job never touches the ruleset.
- **Passes** when every job succeeded, or was skipped because its lane is off (or `pr-title` on a push). **Fails** when any job failed, was cancelled, or was skipped although its lane was on.
- **When / where:** every run, Linux. On a `main` push, a green `gate` is what makes the commit releasable.
- **Local:** `node tools/check.mjs`.

## Lanes

`lanesFor` turns lanes on from the paths a PR changes. Pushes, schedules and manual runs turn everything on, and so does any input it can't judge.

| Lane | Turns on when the PR changes… |
| --- | --- |
| `rust` | crates, Cargo manifests or lock, the toolchain file, Cargo config, the nextest config, the shared Rust setup action, the generated bindings |
| `web` | the web app, `.node-version` |
| `bundle` | Tauri config or capabilities, icons, bundle resources, Cargo or web manifests and lockfiles, build scripts, the GPU worker crates and the dictation build/package scripts, the shared build workflow, `.node-version` |
| `supplyChain` | any manifest or lockfile (including the GPU workers' lockfiles), `web/pnpm-workspace.yaml`, `deny.toml` |
| `automation` | `.github/`, `tools/` |

Docs, research and UI-review screenshots match no lane, so a docs-only PR runs `changes`, `pr-title` and `gate` only. The exception is `docs/licenses/`, which is bundled as app resources and turns on `bundle`.

## Test layers

| Layer | What it proves | Where |
| --- | --- | --- |
| Rust unit tests | Local logic per crate | `rust (macos)`, `rust (windows)` |
| `oxide-core` integration tests | Behaviour through the Core API (Threads, Turns, Checkpoints, git, GitHub through a fake `gh`, process hygiene, window lifecycle…) with fake Providers and temp repositories | both Rust jobs |
| Provider contract and adapter tests | Each Provider adapter honours the Provider contract against fake CLIs and fixtures | both Rust jobs |
| Bindings and capabilities test | TypeScript bindings match the Tauri commands, and the webview has no filesystem, shell or process capability | both Rust jobs, plus the committed-bindings diff |
| Web component tests (Vitest, jsdom) | Frontend behaviour against mocked IPC | `web` |
| Tooling tests | Every pipeline decision | `automation` |
| App bundles | `tauri build` succeeds with the real config, icons, resources and embedded frontend | `bundle (macos)`, `bundle (windows)` |
| Live Provider smoke tests and live language installs (`#[ignore]`) | The real Provider CLIs and language-support downloads still work | A Release Manager's machine, before publishing. Never in CI: they need logins and network |
| UI review scripts | Visual review with screenshots | By hand during UI work. Not a gate |

nextest runs each test in its own process with the settings in [`.config/nextest.toml`](../.config/nextest.toml): a hard per-test timeout of 5 minutes, one retry (a pass on retry is reported as flaky, not hidden), JUnit output, and a `process-heavy` test group capped at 2 threads for the Provider adapter and terminal suites, whose child processes and PTYs time out under full parallelism.

## Release workflows

### `build.yml` (shared build)

- **What:** the one place installers are built. Inputs: `platform` (`macos-aarch64` or `windows-x64`) and `release`.
  - `release: false` (CI): unsigned, caches allowed, no updater artifacts.
  - `release: true`: no caches at all, frozen installs, the updater config (`tauri.updater.conf.json`) and `TAURI_SIGNING_PRIVATE_KEY`. It fails if that key is missing. Apple signing and notarization switch on by themselves when the Apple secrets exist; without them the macOS build is ad-hoc signed (Apple Silicon refuses to launch an app with no signature) and the notes say so.
- **Why:** PR bundles and release bundles come from one definition, so what `main` proves is what ships. It declares the `release` environment itself, because a job that calls a reusable workflow can't name one, and the approval must guard the job that reads the secrets.
- **Bundles:** macOS `app,dmg` (CPU and Metal dictation); Windows `nsis` only (the updater's Windows package is the NSIS setup) with CPU, Vulkan and CUDA dictation. On Windows the job installs the pinned Vulkan SDK and CUDA Toolkit (`node tools/dictation-package.mjs setup`), stages the release workers and their runtime in an MSVC environment, and bundles with `crates/oxide-app/tauri.windows-gpu.conf.json`. `GGML_NATIVE=OFF` keeps native code portable instead of tuned to the runner. The Windows job has 180 minutes because it compiles CUDA kernels for every supported architecture.
- **Local:** `node tools/check.mjs` builds an unsigned bundle for your OS. Signed builds are never made locally.

### `release.yml` (Release)

Trigger: a `v*.*.*` tag. Concurrency is per tag and never cancelled.

1. **`verify`** (read-only): the tagged commit is an ancestor of `main` or a `release/*` branch; `checkReleaseVersion` finds the tag equal to the versions in `Cargo.toml`, `crates/oxide-app/tauri.conf.json` and `web/package.json`; `gate` succeeded on that commit's push run. *Why the last one:* the ruleset doesn't require up-to-date branches, so two individually green PRs can break together. Each refusal says what failed and how to fix it.
2. **`build`** (both platforms in parallel, `release: true`) waits for approval of the `release` environment.
3. **`publish`** (the only job with `contents`, `id-token` and `attestations: write`; it holds no signing secrets): names the deliverables (`Oxide_<v>_aarch64.dmg`, `Oxide_<v>_aarch64.app.tar.gz` + `.sig`, `Oxide_<v>_x64-setup.exe` + `.sig`), generates `latest.json` and `SHA256SUMS.txt`, attests build provenance for every file, exports the SPDX SBOM from the dependency graph, drafts the notes, and creates a **draft** release (a pre-release when the tag has a suffix such as `-rc.1`).

**Why rebuild at release instead of promoting `main`'s CI bundle:** signing happens inside `tauri build`, so promoting would mean giving every `main` push the signing secrets without approval. A clean, cache-free rebuild of the same commit, with locked dependencies and a pinned toolchain, is the safer trade.

**Why no "prepare release" workflow that opens the bump PR:** a PR made with `GITHUB_TOKEN` triggers no workflows, so its `gate` would never run. Avoiding that needs an extra credential just to save one local command.

**Release notes** come from the Conventional Commit titles merged since the previous `v*` tag, grouped into Breaking changes, Features, Fixes, Dependencies, Documentation and Other, with PR links. `chore(release)` commits are omitted. They end with a per-platform signing notice.

**Local:** `node tools/ci/cli.mjs bump X.Y.Z` (see the runbook), `node tools/ci/cli.mjs release-version vX.Y.Z` (does the tag match the manifests?), `node tools/ci/cli.mjs release-notes vX.Y.Z` (needs full git history).

### `verify-release.yml` (Verify release)

- **What:** when a release is published, re-downloads every asset and checks `SHA256SUMS.txt`, runs `gh attestation verify` on each file, and, for a stable release, checks that `releases/latest/download/latest.json` serves this version, every URL in it resolves and every signature is non-empty.
- **Why:** the updater feed is the one thing that, once broken, affects every installed app. A failure opens a `needs-triage` issue, so it is triaged even if nobody watches Actions.
- **Blocking:** it can't block a publish that already happened. The remedy is to roll forward.
- **Local:** `gh attestation verify <file> --repo cavallinilorenzo/oxide` and `sha256sum --check SHA256SUMS.txt`.

## Scheduled and automatic workflows

### `advisories.yml` (Advisories)

- **What:** daily (and on manual dispatch) `cargo deny check advisories` over the whole Rust tree. Yanked crates are denied; unmaintained crates are reported for direct dependencies only. On failure it opens, or comments on, one `needs-triage` tracking issue.
- **Why not on PRs:** a new advisory against an untouched crate would block unrelated work. *Why on top of Dependabot alerts:* RustSec also reports unmaintained and yanked crates. npm needs no daily job: Dependabot alerts cover existing packages and dependency review covers new ones.
- **Blocking:** no. **Local:** `cargo deny check advisories`.

### `dependabot-auto-merge.yml` (Dependabot auto-merge)

- **What:** acts only on PRs *authored* by `dependabot[bot]` into `main` (the author, not the actor, so a human re-run still qualifies and a human PR never does). `dependabotDecision` picks: **auto** (patches, and minors of packages at 1.0 or later) enables squash auto-merge, and `gate` stays the only judge; **manual** (majors, 0.x minors, 0.0.x patches, the `tauri` and `specta` groups, anything unreadable) applies the `manual-review` label and a comment.
- **Why a GitHub App token:** a merge made with `GITHUB_TOKEN` triggers no `push` workflow, so the merge commit would never get a `gate` result and could never be released. The App credentials are the Dependabot secrets `AUTOMERGE_APP_ID` and `AUTOMERGE_APP_PRIVATE_KEY`. Without them the workflow only labels and comments.
- **Config:** [`.github/dependabot.yml`](../.github/dependabot.yml) covers Cargo, the pnpm web app, GitHub Actions and the Rust toolchain, weekly on Monday at 07:00 Europe/Rome, with cooldowns (Cargo: 3 days patch, 7 minor, 14 major; pnpm: 7, 7, 14, to match `minimumReleaseAge`; Actions and the toolchain: 7; security updates are not delayed) and groups for packages that break when moved alone. The `supply-chain` job rejects Tauri drift if only half of a bump lands. [CONTRIBUTING](../CONTRIBUTING.md#dependencies-and-supply-chain-policy) has the details.
- **pnpm:** `web/pnpm-workspace.yaml` sets `minimumReleaseAge` (7 days) and an explicit `allowBuilds` list, because Dependabot's cooldown only protects the updates Dependabot makes.

## Release runbook

Only a Release Manager does this. Hotfixes on `release/x.y` branches follow the same steps and the same gates.

1. **Bump.** `node tools/ci/cli.mjs bump X.Y.Z` writes the version into `Cargo.toml`, `crates/oxide-app/tauri.conf.json` and `web/package.json` and refreshes the workspace entries of `Cargo.lock`. Open a PR titled `chore(release): vX.Y.Z`, and merge it like any other. Use `X.Y.Z-rc.N` for a release candidate.
2. **Wait for `gate`** on the `main` run of the merge commit. That run also builds both bundles.
3. **Tag** the merged commit, annotated, and push it:

   ```sh
   git tag -a vX.Y.Z <sha> -m "Oxide vX.Y.Z"
   git push origin vX.Y.Z
   ```

   If `verify` refuses, its message says what to fix. A pushed tag can't be moved or deleted (only the admin can); fix forward with the next version, or have the admin delete a mistaken tag.
4. **Approve** the `release` deployment: Actions → Release → *Review deployments*. Either Release Manager may approve.
5. **Smoke test.** When `publish` finishes there is a **draft** release. Download its builds and run the live Provider smoke tests on each platform you can (CI can't check the real Provider CLIs):

   ```sh
   cargo test -p oxide-provider --test claude_live_smoke -- --ignored
   cargo test -p oxide-provider --test codex_live_smoke -- --ignored
   cargo test -p oxide-provider --test agy_live_smoke -- --ignored
   ```

   Dictation GPU support is a separate gate: CI proves the packages load, not that a GPU is used. When a release changes dictation, its packaging or its native dependencies, install the draft's builds on the physical hardware and attach evidence of actual offload (NVIDIA CUDA and Vulkan, AMD Vulkan, Apple Silicon Metal) as described in #235. Missing hardware leaves that row unverified in the notes.

6. **Publish.** Edit the notes, then click Publish. The release becomes immutable and, if stable, the updater feed goes live.
7. **Watch** the *Verify release* run. If it opens an issue, roll forward.

**Rehearsal.** Tag `vX.Y.Z-rc.1` after the bump merged. It produces a draft pre-release that the updater feed ignores (`releases/latest` skips drafts and pre-releases). Afterwards the admin deletes the draft and the tag (deleting a tag needs the bypass).

**Rollback is rolling forward.** Published releases are immutable and installed apps only update forward. Never try to edit one under pressure: publish `vX.Y.Z+1`. While Oxide is pre-1.0, a minor bump may break and a patch bump only fixes.

## Secrets and the fork/PR threat model

- **Signing secrets exist only in the `release` environment:** `TAURI_SIGNING_PRIVATE_KEY` (and `_PASSWORD`), and, when available, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_PRIVATE_KEY`. They are readable only by a job for a `v*` tag after a Release Manager approves.
- **The updater key** is the root of trust for every installed app: apps accept only packages signed by it, and the matching public key is in `crates/oxide-app/tauri.conf.json`. Keep an encrypted offline backup. If it is lost, installed apps can never be updated again. Never commit it or replace the public key casually.
- **Fork PRs** run on `pull_request` with a read-only token and no secrets. Actions settings require approval for first-time contributors.
- **No `pull_request_target` workflow checks out PR code.** Untrusted code never gets a write token.
- **Every workflow starts from `contents: read`** (auto-merge from none) and grants more per job: `publish` alone writes releases and attestations, `verify-release` and `advisories` alone write issues, and the auto-merge job alone writes pull requests. Auto-merge also mints a short-lived GitHub App token, scoped to contents, pull requests and workflows, only for low-risk Dependabot PRs.
- **Checkouts don't persist credentials,** so later steps can't push with the token.
- **Third-party actions are pinned to a full commit SHA** with a version comment, so a moved tag can't inject code. Dependabot keeps the pins current.
- **Release builds are clean:** no cache is restored or saved, so a poisoned cache can't reach a shipped binary.
- **actionlint and zizmor** run on every PR that touches `.github/`.
- **Dependency intake:** cooldowns on Dependabot, `minimumReleaseAge` and an install-script allowlist in pnpm, `cargo-deny` licences and sources, dependency review on PRs.
- **Users can verify a download** with `SHA256SUMS.txt` or `gh attestation verify`, which ties it to the exact workflow run and commit.
- **CodeQL** (default setup for Actions, JavaScript/TypeScript and Rust) is advisory, not merge-blocking: Rust analysis is young and its false-positive rate here is unknown. Promote it to a code-scanning ruleset rule once the baseline is clean.

## Pinned versions Dependabot can't bump

| What | Pinned in | Bumped by |
| --- | --- | --- |
| Rust toolchain, rustfmt, clippy | `rust-toolchain.toml` | Dependabot |
| Actions | full SHA + version comment | Dependabot |
| Node (22) | `.node-version` | by hand |
| pnpm | `packageManager` in `web/package.json` | by hand |
| cargo-nextest | `ci.yml` (`taiki-e/install-action` input) | by hand |
| cargo-deny | `ci.yml` (`supply-chain`) and `advisories.yml` | by hand |
| zizmor | `ci.yml` (`taiki-e/install-action` input) | by hand |
| actionlint (version and SHA-256) | `ci.yml`, `automation` job | by hand |
| check-jsonschema | `ci.yml`, `automation` job | by hand |
| Runner images (`ubuntu-24.04`, `macos-15`, `windows-2025`) | workflow `runs-on` | by hand, when GitHub announces a deprecation |
| CUDA Toolkit (12.9.1) and Vulkan SDK (1.4.363.0), with SHA-256 | `GPU_BUILD_SDKS` in `tools/ci/policy.mjs` | by hand. CUDA stays on 12.x (13 drops compute capability below 7.5); a new CUDA major also renames the runtime DLLs, which the tests check |

When bumping a tool by hand, change it everywhere it appears (`grep` for the version) and keep the local install instructions in CONTRIBUTING in step.

## What to do with a flaky test

A test that fails and then passes on retry is **flaky**: nextest retries once and lists it under "Flaky tests" in the job summary, so it is visible and countable. A retry is not a fix.

1. **Open an issue** naming the test, the OS and the failing output. Link the CI run.
2. **Find the cause.** Usually shared state, a fixed port or path, a wall-clock timing assumption, or contention. For process-heavy suites, check whether they belong in the `process-heavy` group in `.config/nextest.toml`.
3. **Fix it** in the same PR if the cause is clear.
4. **Otherwise quarantine it explicitly:** mark it `#[ignore = "flaky: #<issue>"]` so the reason and the issue are in the code. Don't raise `retries`, lengthen a timeout to hide it, or merge past a red `gate`.
5. A test that fails twice is a real failure, not a flaky one.

## GitHub settings

These live in the GitHub UI, not in the repository, so they are recorded here. An admin sets them.

- **Repository:** squash merge only (merge commits and rebase off); auto-merge and delete-branch-on-merge on; **immutable releases** on. Actions: default workflow token read-only, "Allow Actions to create and approve PRs" off, approval required for fork PRs from first-time contributors.
- **Ruleset `main protection`** (and the same for `release/**`): PR required with 0 approvals; required status check `gate` (up-to-date branch not required); squash only; no force-push; no deletion.
- **Ruleset `release tags`** on `refs/tags/v*`: block update and deletion; bypass for the repository admin only.
- **Environment `release`:** required reviewers `cavallinilorenzo` and `itsmrma`; deployment refs `v*` tags only; the secrets above.
- **Labels:** `dependencies`, `manual-review`, plus the triage labels.
- **Dependabot secrets** `AUTOMERGE_APP_ID` and `AUTOMERGE_APP_PRIVATE_KEY` (optional, for auto-merge).
- **Security:** secret scanning, push protection, Dependabot alerts and security updates, private vulnerability reporting, and CodeQL default setup.
