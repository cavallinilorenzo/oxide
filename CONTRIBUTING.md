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
- App bundle: `web/node_modules/.bin/tauri build` from the repo root

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

