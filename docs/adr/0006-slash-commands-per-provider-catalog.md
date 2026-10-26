# Slash commands are a per-Provider catalog with a route per command

The three Providers expose Slash commands in incompatible ways: Claude Code runs them when they arrive as prompt text in `-p` stream-json (built-ins such as `/context` included, even under `--safe-mode`), Codex's `app-server` has no text commands at all but one RPC per TUI command (`thread/compact/start`, `review/start`, …) and a structured `skill` input, and `agy` expands skills and custom commands over stream-json while its own CLI commands (`/model`, `/usage`) end the stream. So Oxide does not forward `/…` text blindly: each Thread gets a catalog of Slash commands, built from what its Provider reports, and every entry carries the route Oxide uses to run it.

- **Oxide**: intercepted and run by Oxide, the same for every Provider: `/clear`, `/model`, `/effort`, `/rename`, `/diff`, `/permissions`. They win over a Provider command of the same name, since a Thread maps one-to-one to a Provider session and Oxide owns its Model, Effort, name and Permission mode.
- **Passthrough**: sent to the Provider as the prompt text. Claude Code's built-ins, skills and custom commands; `agy`'s skills and custom commands.
- **Native**: Oxide translates the command into the Provider's own API. Codex `/compact` → `thread/compact/start`, `/review` → `review/start`, a skill → a `skill` user input listed by `skills/list`.
- **Hidden**: anything that only makes sense in the Provider's terminal UI (Claude Code's `/color`, `/focus`, `/heapdump`, `__remote-workflow`, …; `agy`'s CLI commands) is not offered, as ADR-0001 hides what a Provider lacks.

The catalog comes from the Provider, not from Oxide scanning the disk: Claude Code's `initialize` control response lists `commands` (name, description, argument hint, aliases, built-in flag) for exactly what that session loaded, including plugins. A `/word` that is not in the catalog is an ordinary prompt, so pasted paths and unknown text are never rejected.

A passthrough or native Slash command is a Turn, because the Provider treats it as one and Thread status needs no special case; an Oxide command is not. What a Slash command prints is its own Item kind, shown apart from agent messages and left out of the Continue in new Thread recap. Claude Code delivers it as a whole `assistant` message with `model: "<synthetic>"` and no streamed deltas.

## Considered options

- **Forward `/…` text to every Provider.** Works only for Claude Code: Codex has no text commands and `agy` drops the stream on its CLI commands.
- **Reimplement each command in Oxide.** Duplicates logic the Providers already ship and drifts with every CLI release.
- **Scan `.claude/commands` and skills folders on disk** (the first implementation). Misses built-ins and plugins, and lists commands a `--safe-mode` session never loaded.

## Consequences

- Slash commands are not uniform across Providers: Codex offers few, `agy` only skills and custom commands. Account and context figures (`/usage`, `/status`) belong to Oxide's own UI, such as the Usage limit rings, rather than to a command.
- Whether Claude Code passes Slash commands through no longer depends on the skills customization: built-ins run in `--safe-mode` too.
