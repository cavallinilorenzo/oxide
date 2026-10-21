# Native Provider adapters over ACP

Oxide drives each Provider through its own native interface (Claude Code `-p` stream-json, `codex app-server` JSON-RPC, `agy` stream-json), each behind one Oxide-owned Rust Provider trait that normalizes events into Turns and Items. ACP looked like a single protocol for all three, but for Claude it means running the Node-based `claude-agent-acp` adapter (a JS runtime, against our performance constraint), for `agy` a separate closed-source runtime not proven equivalent to the CLI, and for Codex a wrapper around `app-server` anyway. The Oxide event model borrows ACP's vocabulary where it fits, so an ACP adapter can later be added as just another Provider.

## Consequences

- Provider gaps are explicit capability flags (e.g. `agy` has no interactive approvals or reasoning text); the UI hides what a Provider lacks instead of faking it.
- Each adapter pins its supported CLI versions and keeps raw payloads, mapping unrecognized events to `Unknown` rather than dropping them.
