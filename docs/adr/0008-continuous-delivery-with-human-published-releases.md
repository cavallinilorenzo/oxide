# Continuous delivery with human-published releases

Oxide verifies every `main` commit and keeps every one releasable, but only a human turns a commit into a release, and publishing is a human click. The pipeline is **continuous delivery, not continuous deployment**. The guide that operates it is [docs/devops.md](../devops.md).

## Decisions

- **Delivery, not deployment.** The Release workflow ends in a draft. A Release Manager reads the notes and assets, runs the live Provider smoke tests (the one thing CI can't check), and publishes. The updater feed only ever points at a release a person published. Nothing is auto-published.
- **Two Release Managers, enforced from several sides.** `cavallinilorenzo` and `itsmrma` alone approve release builds and publish. On a personal repository there is no Maintain role and ruleset bypass lists take roles, not users, so tag *creation* can't be limited to them. The binding control is the `release` environment: required reviewers are exactly the two, the signing secrets are readable only there, and deployment refs are limited to `v*` tags. A `release tags` ruleset makes `v*` tags immutable for everyone but the admin. We did not move to an organization for a Maintain role: it would change the repository URL the updater feed hardcodes, for a control the environment already provides. Either manager may approve a tag they pushed, because strict four-eyes would block releases whenever one of two people is away. Revisit when the team grows.
- **One required check, `gate`.** It depends on every job and fails if any failed, was cancelled, or was skipped although its lane was on. Adding, renaming or removing a job never touches the ruleset.
- **Path lanes that fail open.** A PR runs only the lanes its changed paths can affect, so a docs-only PR doesn't wait for a Windows build. When the file list is missing, truncated or contains a path no rule knows, every lane runs. Efficiency never costs safety.
- **Bundles always on `main`, only when relevant on PRs.** Clippy and the tests on both OSes already compile every line; only `tauri build` can break packaging. A release-profile-only break is caught by the `main` run before any release can use that commit, and fixed forward.
- **Rebuild at release instead of promoting `main`'s bundle.** Signing happens inside `tauri build`. Promoting a CI bundle would mean giving every `main` push the signing secrets without approval. A clean, cache-free rebuild of the same commit with locked dependencies and a pinned toolchain is the safer trade. PR and release builds still share one build definition.
- **Post-merge re-check enforced at release, instead of a merge queue.** The rulesets don't require up-to-date branches, so two individually green PRs can break together. The full `main` run, plus a `verify` job that refuses a tag whose commit has no green `gate`, gives the same guarantee at release time without a merge queue's cost for two people and agents.
- **Conventional Commit titles are the release-notes source.** Squash is the only merge method, so each PR is one `main` commit whose validated title is its notes line. Notes are drafted from those titles, grouped by type.
- **Immutable releases.** A published release's tag and assets can't change. Rollback is rolling forward with a patch release, because installed apps only update forward.
- **Every decision is a tested pure function.** Lanes, gate, titles, release versions, notes, Dependabot verdicts and `latest.json` live in `tools/ci/policy.mjs`; the YAML only gathers inputs. YAML can't be unit-tested and logic hidden in shell steps has failed before.

## Consequences

- Signing keys live in GitHub behind approval, not on a laptop. A lost machine costs nothing, provided the updater key's offline backup exists.
- A release is three deliberate acts (merge a bump PR, push a tag, approve the run) plus the publish click.
- A rare tag pushed by mistake costs an approval that is never given, not a leaked key. A mistaken tag can only be deleted by the admin.
- We deliberately do not run a merge queue, require approvals or up-to-date branches, or gate on CodeQL yet. These are revisited as the team and the baseline change.
