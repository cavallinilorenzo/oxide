# Driving Codex as an Oxide Provider

**Research date:** 2026-10-21

## Recommendation

Use `codex app-server --listen stdio://` as Oxide's long-lived Provider transport. It is newline-delimited JSON-RPC, exposes lifecycle, thread/turn streaming, model catalog, settings, and resumable thread APIs. `codex exec --json` is a simpler one-shot/noninteractive fallback, but its JSONL event stream is not a general interactive session protocol. Keep a protocol adapter around app-server because the wire API is evolving and includes experimental capabilities. [App-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) · [official app-server docs](https://developers.openai.com/codex/app-server)

## Findings

| Concern | Verified behavior and Oxide implication |
|---|---|
| Start / stop | Spawn `codex app-server --listen stdio://`, exchange one JSON object per line, initialize the connection, then use `thread/start` and `turn/start`. Keep stdin/stdout alive for the session; shutdown by closing stdin and awaiting process exit, with terminate/kill as a timeout fallback. Stdio launch is documented by Codex's app-server client README. Exact graceful-shutdown guarantees for a child process are not specified. [Test-client README](https://github.com/openai/codex/blob/main/codex-rs/app-server-test-client/README.md) |
| Events | JSON-RPC responses correlate by `id`; server notifications stream independently. App-server v2 has typed item and turn notifications: message content/deltas, reasoning items, command execution, file changes, MCP/tool calls, errors and terminal turn status. Preserve item lifecycle and raw payloads; map into Oxide events rather than parsing human-readable CLI output. [Protocol source](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2) |
| Approvals / permissions | Choose a sandbox and `approvalPolicy` at thread start/settings. When an action needs approval, app-server sends a server-initiated JSON-RPC request to the client; client responds with a decision (accept/decline and supported variants). Thus Oxide must service inbound requests while awaiting normal RPC replies. Do not equate sandbox mode with approval policy. Exact choices depend on request type and protocol version. [App-server protocol README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| Models / effort | Call `model/list`; entries include model identifiers and per-model reasoning support/default metadata. Use the returned supported levels, not a hard-coded global list. This catalog is not an entitlement guarantee; a real turn can still fail if account/provider access is missing. [Codex app-server account setup](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) · [Model metadata source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs) |
| Installed / authenticated | Check the configured executable via PATH resolution and a bounded `codex --version`/app-server startup probe. App-server exposes account read/login APIs and notifications; a successful `initialize` alone is not proof inference is authenticated. Probe account state and surface login-required/error state; final verification is a successful model request. Exact portable CLI detection contract is not documented. [App-server account protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2) |
| Resume | Persist `thread.id`; call `thread/resume` with it, then start another turn. Resume returns thread metadata/history (full history by default in current protocol; `excludeTurns` and paged history avoid large responses). [App-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| Slash commands / skills | No documented RPC for injecting TUI slash commands such as `/compact`. Treat slash commands as UI affordances, not Provider API. Skills are instruction/filesystem capabilities discovered by Codex, not evidence that arbitrary slash commands can be invoked. Use explicit protocol methods (for example compaction APIs, where supported) or ordinary user input. Exact custom-command parity is unknown. [App-server protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2) |
| Subagents | Codex protocol has multi-agent/thread concepts and item events, but the sources reviewed do not establish a stable, complete public event contract for every delegated subagent lifecycle. Do not promise UI subagent visibility in MVP; retain unknown event payloads and add mapping when verified against the chosen CLI version. |
| Attachments | User input supports structured content including text and image/file references, subject to API type and local resource handling. App-server also has stored-thread attachment APIs, which are durable metadata references and should not be conflated with per-turn file input. Validate image/file serialization against the generated v2 types. [V2 protocol source](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2) |
| T3 Code integration | `references/t3code/` exists in this checkout but is empty, so no local implementation or behavior could be verified. This report makes no claim about how T3 Code integrates. |

## Alternative: `codex exec --json`

Use for fire-and-forget work: launch a process per request, parse JSONL events until completion, inspect exit status, and optionally pass a resume identifier if supported by the installed CLI. It is operationally simpler, but a persistent Oxide Thread needs bidirectional control, approvals, settings/catalog calls, and resume; app-server is the better fit. The checked-out T3 reference contains no source to compare against. The current official CLI documentation does not enumerate the JSON event schema, so verify event names against the targeted CLI build before implementing this fallback.

## Decision-relevant unknowns

- Pin/record the Codex CLI version and negotiate app-server capabilities; the protocol source is actively changing.
- Confirm exact item event variants, compaction method availability, and file/image input types against the release Oxide supports.
- Test installed/authenticated checks across ChatGPT login, API key, and custom providers; catalog listing alone does not prove entitlement.
- Confirm which subagent events are emitted and how they relate to parent thread IDs.
- Verify T3 Code integration once its reference source is present.

## Primary sources

- [Codex app-server documentation](https://developers.openai.com/codex/app-server)
- [Codex CLI documentation](https://developers.openai.com/codex/cli)
- [Codex app-server protocol and implementation](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2)
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex app-server test client README](https://github.com/openai/codex/blob/main/codex-rs/app-server-test-client/README.md)
- [Codex model metadata source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs)
