<p align="center">
  <img width="160" height="160" alt="Oxide logo" src="assets/brand/oxide/oxide-mark.svg" />
</p>

<h1 align="center">Oxide</h1>

Oxide is a desktop app for agentic engineering. You open a Project and drive coding agents from a chat, switching between the agent CLIs already installed on your machine, with Git and GitHub at hand.

> **Status: pre-release.** Oxide runs on **macOS with Apple Silicon** only. Expect rough edges and breaking changes between versions.

## Supported Providers

Oxide doesn't ship an agent of its own. It drives the agent CLIs you already use, called Providers:

- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`)
- [Codex](https://github.com/openai/codex) (`codex`)
- Antigravity CLI (`agy`)

Each Provider must be **installed and logged in** before you launch Oxide. Oxide detects which ones are available and only offers those.

## Install

Download the latest `.dmg` from [GitHub Releases](https://github.com/cavallinilorenzo/oxide/releases). Each release lists SHA-256 checksums and has a [build-provenance attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds). You can check that a download was built by this repository's release workflow:

```sh
gh attestation verify Oxide_<version>_aarch64.dmg --repo cavallinilorenzo/oxide
```

### Opening an unsigned build

Until Oxide has an Apple Developer ID, releases are **unsigned**: ad-hoc signed and not notarized. Each release says whether it is signed. macOS Gatekeeper blocks unsigned apps on first launch. To open one:

1. Drag `Oxide.app` from the `.dmg` into `/Applications` and try to open it once.
2. Open **System Settings → Privacy & Security**, scroll to the message about Oxide, and click **Open Anyway**.

Alternatively, remove the quarantine flag from the terminal: `xattr -dr com.apple.quarantine /Applications/Oxide.app`.

## Build from source

Prerequisites:

- macOS on Apple Silicon, with the Xcode Command Line Tools (`xcode-select --install`)
- [rustup](https://rustup.rs). The toolchain version is pinned in [`rust-toolchain.toml`](rust-toolchain.toml), and rustup installs it automatically.
- Node.js 22 and pnpm via [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable`). The pnpm version is pinned in `web/package.json`.
- `git`, and optionally the [GitHub CLI](https://cli.github.com) (`gh`, logged in) for the GitHub features
- At least one [Provider](#supported-providers), installed and logged in

```sh
git clone https://github.com/cavallinilorenzo/oxide.git
cd oxide
pnpm --dir web install

# Run the app in development mode (hot-reloading frontend). Run this from the repo root.
web/node_modules/.bin/tauri dev

# Build the app bundle and .dmg into target/release/bundle/
web/node_modules/.bin/tauri build
```

The Tauri CLI must run from the repository root: that is where it finds `crates/oxide-app/tauri.conf.json`.

## Tests

```sh
cargo test --workspace     # Rust: Provider contract suite, core, app
pnpm --dir web test        # Frontend (Vitest)
```

The live smoke tests drive the real Provider CLIs, so they are opt-in and never run in CI. Run them only with the Provider installed and logged in:

```sh
cargo test -p oxide-provider --test claude_live_smoke -- --ignored
cargo test -p oxide-provider --test codex_live_smoke -- --ignored
cargo test -p oxide-provider --test agy_live_smoke -- --ignored
```

[CONTRIBUTING.md](CONTRIBUTING.md) lists every check CI runs and its local equivalent.

## Learn more

- [GLOSSARY.md](GLOSSARY.md): the domain language (Project, Thread, Turn, Provider…)
- [docs/adr/](docs/adr/): architecture decisions
- [CONTRIBUTING.md](CONTRIBUTING.md): branch model, local checks, releases
- [SECURITY.md](SECURITY.md): how to report a vulnerability
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
