# Chat, Terminal and Code

The header's **Chat / Terminal / Code** control changes the central work area.
Switching modes keeps open buffers and terminal processes alive. Ordinary Threads
share their Project's checkout; Board Threads get their own editor and terminal
in their worktree. Board remains available beside the mode switch and with Ctrl+B
(⌘B on macOS).

## Terminal

Commands entered in the bottom composer run in one persistent PowerShell session
on Windows and a POSIX shell on macOS/Linux. Each block keeps command output and
exit status together. `cd` and shell variables carry over between commands.

- Enter runs a command; Shift+Enter adds another line.
- Right accepts the inline suggestion from your latest matching command.
- Tab requests shell completion, independently of history. Windows uses
  PowerShell's `TabExpansion2` in the live session, including its current directory,
  aliases and registered completers. POSIX completion covers files and PATH commands.
- Up opens the history picker; Up/Down navigate it, Enter inserts a command, and
  Escape dismisses it. Ctrl+R focuses its search field.
- Interact with a running program directly in its output terminal; Ctrl+C
  interrupts it. A shell that exits can be restarted from the toolbar.
- Cursor-addressed and alternate-screen applications use the central viewport.
  Output redraws do not resize the PTY. On Windows a command finishes at the next
  PowerShell prompt, so Ctrl+C leaves the shell usable.
- Block actions collapse output, copy output and put a command back in the
  composer. Reuse does not immediately execute the command.

History retains up to 300 commands per checkout in local application storage.
Output is session-only: the latest 24 blocks retain up to 256 KiB each, with an
explicit truncation notice. This is a local terminal workflow, not a Warp account
integration or Warp's AI service.

## Code

The explorer opens files in tabs. Monaco provides syntax highlighting, automatic
indentation, bracket pairing, folding, multiple cursors, undo/redo, Find/Replace
and its command palette. Local LSP servers add completion, hover information,
definitions, references, rename and formatting where the server supports them.
Problems shows errors and warnings in open files and jumps to their locations.

- Ctrl+P / ⌘P: find a file by name in the Project.
- Ctrl+N / ⌘N: create a file (existing parent folders only).
- Ctrl+S / ⌘S: save; Ctrl+Shift+S / ⌘Shift+S: save all.
- Ctrl+W / ⌘W: close the current file, with an unsaved-change prompt.
- Ctrl+F / ⌘F and Ctrl+H / ⌘H: Monaco's Find and Replace.
- F12: definition; Shift+F12: references; F2: rename, when supported by LSP.

The editor handles complete UTF-8 text files up to 1 MiB. Larger and binary files
remain readable through Files. Saves replace files atomically and refuse to
overwrite a buffer whose original content has changed on disk. Quitting asks
about unsaved buffers and offers Save all, Discard, or Cancel.

## First-use language support

Opening a supported file offers **Install support** when its server is missing.
Choosing Later dismisses that language's offer; Language tools in the editor
toolbar remains available. The download does not start merely by opening a file.

| Files | Server |
| --- | --- |
| Python | Pyright |
| C / C++ | clangd |
| JavaScript / TypeScript, JSX / TSX | typescript-language-server |
| Rust | rust-analyzer |

Tools install under Oxide's `tools/` directory in its application home.
clangd and rust-analyzer come from their official GitHub releases. Python and
TypeScript use npm packages in a private prefix, with a private Node.js LTS runtime
downloaded from nodejs.org if npm is unavailable. Node downloads verify SHA-256
checksums; GitHub asset digests are verified when supplied. No elevated installer
is used by the default Install action.

TypeScript uses a Project's JavaScript SDK when available, otherwise its compatible
managed TypeScript 6 SDK. TypeScript 7's native package does not ship tsserver.js.
Python/TypeScript package versions are pinned to the tested versions. Updates are
explicit installs, not background activity.

In **Language tools**, configure the executable, a JSON array of arguments and an
optional Python interpreter. Configuration is stored in `language-servers.json`
in the application home. Save or Recheck reconnects the servers for open files.
Rust project diagnostics need a Rust toolchain; Python imports depend on the
selected environment. For C/C++ project flags, provide `compile_commands.json` or
clangd arguments such as `--compile-commands-dir`.

Official clangd Linux binaries target x86_64. Other architectures can configure
a server installed through their own package manager. Manual setup commands and
upstream guides remain available under advanced language settings.

## Images and appearance

Paste images into the shared inline chat composer or drop files onto it. A
preview appears before sending; attachments can be removed individually. A
prompt can hold ten attachments, up to 25 MB each. Native drops and clipboard
data use the shared Attachment store introduced on main in #212.

Delivery follows [ADR-0007](adr/0007-attachments-are-segments-delivered-per-provider.md):
Providers receive native image inputs where supported, otherwise readable path
references. The ordered prompt segments preserve each attachment's position.

See [Fonts and JSON themes](themes.md) for per-area fonts, theme imports, the
supported Zed-style JSON structure and a complete example.

## Validation

Offline workbench integration tests use a local LSP fixture and real shell PTYs:

```sh
cargo test -p oxide-core --test workbench
```

Opt-in tests download and launch the real four language servers inside disposable
application homes; ordinary CI skips these network-dependent tests:

```sh
cargo test -p oxide-core --test language_install_live -- --ignored --nocapture
```

The browser regression uses the real Core PTY through a test-only JSON-lines
bridge. With Node.js, Python, Playwright/Chromium and the web dev server available:

```sh
cargo build -p oxide-core --example terminal_harness
node web/scripts/terminal-regression.cjs --appearance
```

Set `OXIDE_PLAYWRIGHT_PATH` to an existing Playwright module installation when it
is not on Node's module path. `OXIDE_TEST_URL` overrides the default dev server
(`http://127.0.0.1:1420`). The test checks stable full-screen geometry, real shell
completion, Right-arrow history completion, the Up history picker and applying
a JSON theme. It does not submit Provider/model prompts.
