# ACP as the single Provider protocol

**Research date:** 2026-10-21  
**Ticket:** [#5](https://github.com/cavallinilorenzo/oxide/issues/5)

## Recommendation

ACP is viable as Oxide's common **session transport and event envelope**, but current evidence does not support treating it as a lossless, uniform Provider API for Claude Code, Codex, and Antigravity CLI. Put shared lifecycle, prompt, cancellation, permission, and streaming behind ACP; retain capability/config negotiation and an escape hatch for provider-specific operations. In particular, do not make cross-provider model/effort parity or subagent-event parity a baseline guarantee.

ACP v1 uses JSON-RPC and capability negotiation. The base session flow covers initialization, session creation, prompt turns, progress updates, permissions, and cancellation; existing optional surfaces cover modes, config options, slash commands and extensions. An ACP client must inspect negotiated capabilities rather than assume each feature exists. [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview) · [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options) · [ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)

## Provider support and maturity

| Provider | ACP path | Assessment |
|---|---|---|
| **Claude Code** | `agentclientprotocol/claude-agent-acp`, an ACP server built on Anthropic's Claude Agent SDK. | Strong adapter maturity: official ACP organization repo, frequent releases, broad event coverage, and active maintenance. It is an adapter to the SDK, not a native ACP transport in the `claude` CLI. Supports permission requests, custom slash commands, nested subagent transcripts and interactive/background terminals per its README. [Repo](https://github.com/agentclientprotocol/claude-agent-acp) |
| **Codex** | `agentclientprotocol/codex-acp`, a stdio ACP server that starts Codex App Server and translates requests/events. | Strong adapter maturity: official ACP organization repo with frequent releases. README lists model and reasoning-effort config, approval/sandbox config, slash commands, permissions and tool events, plus native child sessions after negotiated draft subagent support. It is still a translation layer, so surfaced details depend on adapter and client capability negotiation. [Repo](https://github.com/agentclientprotocol/codex-acp) |
| **Antigravity CLI (`agy`)** | Official ACP registry package `antigravity-acp` / `agy_acp_server`, a separate server/runtime. | Official but less transparent/mature from a source-audit perspective: Google publishes the ACP runtime through the ACP registry, but it is distinct from wrapping the `agy` CLI's own command interface. The runtime is a closed-source binary; consequently its internal mapping, compatibility policy, and parity with `agy` cannot be audited from the checked-out code. Do not conflate it with community wrappers around CLI output. [ACP registry entry](https://github.com/agentclientprotocol/registry/tree/main/registry/antigravity-acp) · [Google Antigravity CLI docs](https://www.antigravity.google/docs/cli/) |

**Verified / unknown:** Claude and Codex have well-documented adapters maintained in the ACP GitHub organization. The Antigravity registry is the primary source for the official ACP server, not proof that ACP is implemented inside the `agy` CLI. Public documentation/source reviewed here does not establish a stable mapping for every Antigravity CLI feature; test the actual server version and configuration before depending on it.

## What ACP preserves, and what it does not

- **Models and effort:** ACP has optional session config options; there is no universal semantic model/effort catalog or guarantee that every agent exposes either. Codex adapter explicitly maps model and reasoning effort. Other adapters may expose model or effort as agent-defined options, with provider-specific IDs/values. A common UI can render advertised options, but should retain opaque IDs and avoid implying that levels are equivalent across providers.
- **Slash commands:** the protocol has an optional advertised slash-command surface. Implementations choose which commands to expose; ACP clients cannot assume native CLI command parity. Both official Claude and Codex adapters document selected commands, which need not be identical to their full native CLI menus.
- **Approvals:** ACP has a standardized permission request/response path for tool calls. This preserves an approval interaction, but provider-specific policy modes, decision kinds, scope and persistence may be mapped or simplified. Codex adapter documents approval/sandbox mode config; verify semantics per adapter rather than treating `allow` as interchangeable with each provider's native approval modes.
- **Subagents:** ACP v1 baseline does not promise a first-class child-session lifecycle. The Codex adapter's native subagent sessions depend on draft extension capability negotiation; without it, it falls back to a tool call. Claude adapter documents nested subagent transcripts. This is not evidence of portable, guaranteed subagent events across all agents; Antigravity support remains unverified here.
- **Other differences:** adapter boundaries can affect session continuity, available event detail, authentication, and timing. Model and CLI releases can also outrun their ACP adapters.

These are distinctions between ACP's protocol guarantees and the listed adapter behavior, not claims that features are absent from a provider's native CLI.

## Rust client crate

Yes. The ACP organization maintains [`agentclientprotocol/rust-sdk`](https://github.com/agentclientprotocol/rust-sdk), whose stated scope is Rust SDK for ACP clients and agents; ACP's own library page links to it. It is a maintained SDK/crate source, not a provider implementation. Confirm the current crate version and API against its [crates.io package](https://crates.io/crates/agent-client-protocol) and repository before pinning; do not infer production maturity solely from repository activity.

## T3 Code packages in this checkout

The requested `packages/effect-acp` and `provider-acp` paths do **not** exist in the checked-out repository: this checkout contains only root docs and metadata (no `packages/` directory). I therefore cannot verify their code, package manifests, boundaries, or how one uses the other. Based on names alone, any description would be speculation. The likely architectural distinction to verify in the source is whether `effect-acp` owns protocol process/JSON-RPC and typed ACP messages while `provider-acp` adapts that client to Oxide's Provider interface; this sentence is an inference only, not a finding.

## Decision points for Oxide

1. Use ACP for shared turn lifecycle, streaming, cancellation, files and permission prompts where negotiated.
2. Model capabilities/config options as discovered, provider-scoped data; keep model and effort identifiers opaque and preserve a native-provider escape hatch.
3. Treat slash commands and subagent lifecycle as optional capabilities/extensions. Build explicit fallbacks and test each versioned adapter.
4. Before committing to Antigravity, validate registry runtime installation/auth, model/config enumeration, approvals, and subagent reporting against the exact binary version used by Oxide.
5. Revisit T3 package roles against the intended source branch; this checkout cannot answer that part of the ticket.

## Primary sources

- [ACP v1 protocol overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)
- [ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)
- [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
- [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)
- [Antigravity ACP registry entry](https://github.com/agentclientprotocol/registry/tree/main/registry/antigravity-acp)
- [ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) · [crate](https://crates.io/crates/agent-client-protocol)
