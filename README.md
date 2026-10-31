<p align="center">
  <img width="160" height="160" alt="Oxide logo" src="assets/brand/oxide/oxide-mark.svg" />
</p>

<h1 align="center">Oxide</h1>

Oxide is a desktop app for agentic engineering. You open a Project and drive coding agents from a chat, switching between the agent CLIs already installed on your machine, with Git and GitHub at hand.

> **Status: pre-release.** Official release builds target **macOS on Apple Silicon** and **Windows x64**. Expect rough edges and breaking changes between versions.

## Supported Providers

Oxide doesn't ship an agent of its own. It drives the agent CLIs you already use, called Providers:

- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`)
- [Codex](https://github.com/openai/codex) (`codex`)
- Antigravity CLI (`agy`)

Each Provider must be **installed and logged in** before you launch Oxide. Oxide detects which ones are available and only offers those.

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/cavallinilorenzo/oxide/releases):

- **macOS (Apple Silicon):** `Oxide_<version>_aarch64.dmg`. Drag `Oxide.app` into `/Applications`.
- **Windows (x64):** `Oxide_<version>_x64-setup.exe`.

Pre-release (`-rc`) builds are for testing and never reach the in-app updater.

### Updates

Oxide checks for new versions in **Settings → Updates** and installs them in place. It only offers published stable releases, and only accepts packages signed with Oxide's updater key.

### Verifying a download

Every release attaches `SHA256SUMS.txt` and a [build-provenance attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds) for each file, which ties it to the exact workflow run and commit that built it:

```sh
shasum -a 256 --check --ignore-missing SHA256SUMS.txt   # macOS; use sha256sum on Linux
gh attestation verify Oxide_<version>_aarch64.dmg --repo cavallinilorenzo/oxide
```

On Windows, compare `(Get-FileHash .\Oxide_<version>_x64-setup.exe).Hash` with the line in `SHA256SUMS.txt`.

### Opening an unsigned build

Each release says whether it is code-signed on your platform.

**macOS.** Until Oxide has an Apple Developer ID, releases are **ad-hoc signed and not notarized**, and Gatekeeper blocks them on first launch. To open one:

1. Drag `Oxide.app` from the `.dmg` into `/Applications` and try to open it once.
2. Open **System Settings → Privacy & Security**, scroll to the message about Oxide, and click **Open Anyway**.

Alternatively, remove the quarantine flag from the terminal: `xattr -dr com.apple.quarantine /Applications/Oxide.app`. Updates installed through Oxide are unaffected.

**Windows.** The installer is **not Authenticode-signed**, so SmartScreen may warn on first run. Choose **More info → Run anyway** after verifying the download as above.

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
pnpm --dir web build:app
```

The Tauri CLI must run from the repository root: that is where it finds `crates/oxide-app/tauri.conf.json`.

### Windows

To build and run Oxide from source on Windows (or to build your own installer), install:

- Windows 10 (version 1803 or later) or Windows 11. These include the [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/); on older or customized installations, install the Evergreen Runtime manually.
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload.
- [rustup](https://rustup.rs). The pinned toolchain in [`rust-toolchain.toml`](rust-toolchain.toml) is installed automatically.
- Node.js 22 and pnpm through [Corepack](https://nodejs.org/api/corepack.html). Enable Corepack with `corepack enable`; the pnpm version is pinned in `web/package.json`.
- `git`, and optionally the [GitHub CLI](https://cli.github.com) (`gh`, logged in) for GitHub features.
- At least one [Provider](#supported-providers), installed and logged in, and available on `PATH`.

In PowerShell, from the directory where you want the repository:

```powershell
git clone https://github.com/cavallinilorenzo/oxide.git
Set-Location oxide
pnpm --dir web install

# Run the app in development mode (hot-reloading frontend).
.\web\node_modules\.bin\tauri.cmd dev

# Build a Windows installer (NSIS `.exe`) into target\release\bundle\nsis\.
.\web\node_modules\.bin\tauri.cmd build --bundles nsis
```

That installer has CPU dictation only. The released installer also contains the Vulkan and CUDA dictation workers; to build it, follow [Packaging and distribution](docs/dictation.md#packaging-and-distribution). Neither needs an SDK on the user's machine; GPU dictation needs only the GPU vendor's driver.

Run the Tauri CLI from the repository root so it can find `crates/oxide-app/tauri.conf.json`. To build an MSI instead, use `--bundles msi`; if that fails with a `light.exe` error, enable the **VBScript** optional Windows feature and try again.

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

[docs/devops.md](docs/devops.md) lists every check CI runs, why it exists and its local equivalent.

## Learn more

- [GLOSSARY.md](GLOSSARY.md): the domain language (Project, Thread, Turn, Provider…)
- [docs/adr/](docs/adr/): architecture decisions
- [CONTRIBUTING.md](CONTRIBUTING.md): branch model, local checks
- [docs/devops.md](docs/devops.md): CI, releases and the release runbook
- [SECURITY.md](SECURITY.md): how to report a vulnerability
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
