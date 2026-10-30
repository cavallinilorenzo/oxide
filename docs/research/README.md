# Oxide research

Research reports gathered for the Oxide MVP map. Each report records its scope, primary sources, recommendations, and evidence limits. Findings are inputs to design decisions; recommendations that have not been accepted in the map remain proposals.

Some reports link into `references/`, which holds pinned upstream snapshots as Git submodules: [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) and [`warpdotdev/warp`](https://github.com/warpdotdev/warp). They aren't needed to build Oxide. To browse them locally, run `git submodule update --init references/t3code` (or `references/warp`).

| Topic | Report | Map ticket |
|---|---|---|
| Claude Code Provider | [claude-code-provider.md](claude-code-provider.md) | [#2](https://github.com/cavallinilorenzo/oxide/issues/2) |
| Codex Provider | [codex-provider.md](codex-provider.md) | [#3](https://github.com/cavallinilorenzo/oxide/issues/3) |
| Antigravity CLI Provider | [antigravity-cli-provider.md](antigravity-cli-provider.md) | [#4](https://github.com/cavallinilorenzo/oxide/issues/4) |
| ACP as common protocol | [acp-as-single-provider-protocol.md](acp-as-single-provider-protocol.md) | [#5](https://github.com/cavallinilorenzo/oxide/issues/5) |
| T3 Code architecture | [t3-code-architecture.md](t3-code-architecture.md) | [#6](https://github.com/cavallinilorenzo/oxide/issues/6) |
| Tauri and Rust building blocks | [tauri-rust-building-blocks.md](tauri-rust-building-blocks.md) | [#7](https://github.com/cavallinilorenzo/oxide/issues/7) |
| Tauri frontend frameworks | [tauri-frontend-frameworks.md](tauri-frontend-frameworks.md) | [#8](https://github.com/cavallinilorenzo/oxide/issues/8) |
| Agentic app window layouts | [agentic-app-layouts.md](agentic-app-layouts.md) | [#268](https://github.com/cavallinilorenzo/oxide/issues/268) |

## Cross-cutting takeaways

- Keep an Oxide-owned Provider contract and normalize provider-specific events behind adapters. ACP is a promising shared transport for providers that expose it, but feature negotiation and provider-specific capabilities remain necessary; it is not a guarantee of feature parity.
- Preserve native session strengths where needed: Claude Code's JSONL stream, Codex app-server, and Antigravity CLI's documented headless stream have different lifecycle, approval, model, and event behavior. Antigravity's separate ACP runtime is not evidence that its CLI implements ACP.
- Tauri Channels are the documented fit for ordered high-rate Rust-to-webview streaming. `portable-pty` plus xterm.js is the suggested terminal foundation; Tauri does not publish numeric throughput limits, so measure the actual workload.
- Use Git CLI and `gh` for the MVP's local mutations and GitHub operations, with Rust owning process lifecycle and secrets. Parallel repository walking is a candidate for discovery, but the roots and policies remain a product decision.
- Prototype Svelte 5, Solid, and React with the same representative chat workload. The research found no apples-to-apples evidence for declaring a fastest framework.
- T3 Code offers useful domain and process-boundary references, but its event-sourced persistence, broad provider surface, worktree/checkpoint system, and multi-client architecture carry significant scope. Reuse the ideas that support the MVP rather than reproducing the full system.

These takeaways are research synthesis, not additional settled decisions. See the [MVP map](https://github.com/cavallinilorenzo/oxide/issues/1) and the dependent design tickets before turning them into implementation requirements.
