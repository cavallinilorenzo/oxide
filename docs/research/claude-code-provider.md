# Driving Claude Code as an Oxide provider

**Research date:** 2026-10-21  
**Scope:** Current official Claude Code documentation and this checkout. Statements are marked **Verified** (directly documented or present in checked-out files) or **Inference / unknown**.

## Recommendation

**Inference:** Implement the first Rust adapter as a managed `claude` child process, using `-p --input-format stream-json --output-format stream-json --verbose` and JSONL over stdin/stdout. This is the native, documented process interface and avoids embedding an unofficial protocol. Rust can launch it with `std::process::Command`, own stdin/stdout/stderr, parse one JSON object per output line, and terminate/reap the child. The official Agent SDK packages are TypeScript and Python; no official Rust SDK is documented. A Rust wrapper around the CLI is therefore the practical choice, with the CLI protocol version-gated and tolerant of unknown events.

## Process and stream lifecycle

- **Verified:** `claude -p` is noninteractive; `stream-json` emits newline-delimited JSON. For token deltas, use `--verbose --include-partial-messages`. The final line is a `result` message with response, cost, and session metadata. Stream stdout independently from stderr and use process exit status as an additional failure signal. [Headless/programmatic usage](https://code.claude.com/docs/en/headless)
- **Verified:** JSONL input is supported with `--input-format stream-json`; stdin may be piped, with a documented 10 MB cap for piped stdin. CLI flags also include `--model`, `--effort`, `--resume`/`--continue`, and permission controls. [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Verified:** SIGTERM exits with code 143, kills the running Bash process tree, runs `SessionEnd` hooks, and leaves the current turn unfinished. SIGINT ends the turn; SDK hosts can call `interrupt()`. Closing SDK input cancels a pending permission prompt. [Stop behavior](https://code.claude.com/docs/en/headless)
- **Inference:** For Rust, expose `start`, `send(input_json)`, `events()`, `interrupt`, `stop`, and `wait` operations. Close stdin for graceful end-of-input; use SIGINT for turn interruption and SIGTERM/kill only for shutdown escalation. Persist the session ID from `system/init`/`result` and reap every child.

## Events and mapping to an Oxide Provider

| Oxide-facing event | Claude stream evidence / handling |
|---|---|
| Assistant text | `stream_event` deltas (e.g. `text_delta`) with partial messages enabled; complete `assistant` messages also arrive. |
| Reasoning | Thinking blocks are available in the stream when present; treat as optional/sensitive content and do not assume every model/run emits them. |
| Tool calls/results | `assistant` message content contains `tool_use` and `tool_result` blocks. These represent Claude Code internal tools; the host should render them, not execute them itself. |
| File edits/diffs | Tool-use inputs and results can expose edit operations/content. **Unknown:** the docs do not promise a stable canonical diff event; obtain diffs from the workspace/git after execution if Oxide needs reviewable patches. |
| Errors/retries | `system/api_retry` reports retry attempt, delay, error category and session ID. With `--permission-prompts none`, permission denials arrive as `system/permission_denied` and in final `permission_denials`. Startup failures can be on stderr; in-run failures may be a result on stdout; nonzero exit codes indicate failure. |
| Completion | Final `result` event includes final text, cost and session metadata; process exit completes lifecycle. |
| Session metadata | `system/init` includes model, tools, MCP servers/plugins and optional `capabilities`; inspect capabilities rather than hard-coding CLI version where possible. |

Sources: [streaming and event formats](https://code.claude.com/docs/en/headless), [CLI behavior](https://code.claude.com/docs/en/cli-reference).

**Inference:** Normalize provider events to Oxide’s own stable schema and preserve the raw Claude JSON for forward compatibility. Partial text blocks, full assistant messages, tool calls, permission events, and the terminal result are distinct events; don’t treat each JSON line as a user-visible message.

## Permissions and approvals

- **Verified:** Permission modes include `default`/`manual`, `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`; `--allowedTools` and `--disallowedTools` add tool rules. `-p` mode can deny actions needing approval unless an approval host answers. Current CLI documentation exposes `--permission-prompt-tool` to route approval to a loaded MCP tool; SDKs expose `canUseTool`. `--permission-prompts none` denies requests without a human and avoids waiting. [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless permissions](https://code.claude.com/docs/en/headless)
- **Inference:** A Rust host that needs interactive approval should provide an MCP permission-prompt tool and implement the callback loop; plain JSONL input is not itself an approval callback contract. For MVP unattended operation, choose a least-privilege mode/ruleset (e.g. `acceptEdits` plus narrowly scoped allowed tools, or `auto`) and explicitly deny unanswered prompts. Avoid `bypassPermissions` for ordinary provider operation.

## Models, effort, installation, and authentication

- **Verified:** `--model` accepts aliases or model IDs; `--effort` accepts `low`, `medium`, `high`, `xhigh`, `max`, or `ultracode`, but available effort depends on model. The `system/init` event reports the model in use. [Model configuration](https://code.claude.com/docs/en/model-config), [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless events](https://code.claude.com/docs/en/headless)
- **Unknown:** The reviewed official docs do not define a stable command/API to enumerate models and effort levels available to a specific user/account/provider. Use aliases/configuration and feature-discover from installed CLI docs; do not present a static model list as live availability.
- **Verified:** `claude auth status` returns JSON, exits 0 when logged in and 1 when not; authentication methods include `claude.ai`, OAuth token, API key/helper, third party, or none. [CLI reference](https://code.claude.com/docs/en/cli-reference)
- **Inference:** Installed detection should resolve `claude` through PATH and run a bounded `claude --version` or `claude --help`; authenticated detection should call `claude auth status --json` and parse exit code plus JSON. Keep this separate from process startup: credentials may be environment/provider-specific and `--bare` deliberately skips OAuth/keychain credentials unless an API key/helper is supplied. [Authentication](https://code.claude.com/docs/en/iam), [bare mode](https://code.claude.com/docs/en/headless)

## Resume, slash commands, subagents, attachments

- **Verified:** Capture `session_id` from JSON output and pass `--resume <id>` for follow-up; `--continue` selects the most recent conversation. The CLI also accepts a transcript path for resume. [Headless usage](https://code.claude.com/docs/en/headless)
- **Verified:** User-invoked skills/custom slash commands work in `-p` when included in the prompt (e.g. `/skill-name`); terminal-only commands such as `/login` do not. `/model`, `/effort`, `/fast`, `/color`, `/rename` accept an argument. [Headless usage](https://code.claude.com/docs/en/headless)
- **Verified:** Subagents and forked skills appear as assistant/user messages tagged with `parent_tool_use_id`; tool calls/results are forwarded by default. `--forward-subagent-text` (or `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`) additionally forwards text and thinking blocks, permitting nested transcript reconstruction. [Subagent stream events](https://code.claude.com/docs/en/headless)
- **Unknown:** The reviewed CLI streaming page does not document a typed attachment-upload field in JSONL input. **Inference:** provide images/files through supported prompt references/path/context where appropriate; do not claim binary attachment support or invent a wire format. Piped stdin is text-oriented and capped at 10 MB. Verify image support against the exact CLI version before designing an Oxide attachment API.

## T3 Code integration

**Verified from checkout:** This worktree contains only the listed project docs and glossary; no `references/t3code` tree or Claude integration source is present. **Unknown:** T3 Code integration details cannot be established from this checkout. No behavior is inferred from the product name or external project.

## Decision points / risks

1. Use the child-process JSONL interface for Rust MVP; isolate protocol parsing behind a version-tolerant adapter.
2. Make approval routing explicit. CLI `-p` has no interactive terminal prompt path; a permission host is required for approvals, otherwise deny.
3. Do not promise live model/effort enumeration, canonical diff events, or binary attachments until separately verified.
4. Test CLI protocol/event behavior against supported Claude Code versions; the official docs evolve and feature flags include minimum-version requirements.

## Primary sources

All external sources above are Anthropic’s official Claude Code documentation. This checkout was searched for `claude`, `stream-json`, and `references/t3code`; no source integration was found.
