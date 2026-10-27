# Driving Antigravity CLI (`agy`) as an Oxide Provider

**Research date:** 2026-10-21  
**Environment checked:** macOS, installed `~/.local/bin/agy` version 1.4.4  
**Recommendation:** Implement `agy` as a subprocess Provider using its documented headless `stream-json` mode. Do not use ACP to drive this CLI: the official CLI documentation exposes its own line protocol, and does not document ACP support. The official Antigravity SDK is a separate Python agent runtime, not a wrapper for the installed CLI.

## Findings

| Need | Finding and implication for Oxide |
|---|---|
| Start, keep alive, stop | Spawn `agy --input-format stream-json --output-format stream-json` with project cwd, pipes for stdin/stdout/stderr. Send one JSON line per turn: `{"event":"user","message":{"content":"..."}}`; parse stdout incrementally and wait for each turn's `result` before sending the next. Closing stdin lets the process finish the current turn and exit; use process termination/SIGINT for cancellation. [Headless mode](https://antigravity.google/docs/cli/headless) documents this exact lifecycle. |
| Event stream | NDJSON starts with `init`, continues with `step_update`, and concludes each turn with `result`. Step types include `user_input`, `agent_response`, `tool`, and `checkpoint`; response text arrives in `text_delta` fragments, tool data in `tool_info` (`name`, `parameters`, `output`, optional error), and subagent data in `subagent_info`. Terminal result provides status, response, conversation ID, duration, turns, and token usage. Thinking token *counts* are exposed; reasoning/thought text is not documented as an event. File edits can be inferred from tool steps such as file-write tools and their outputs, but the documented stream does not promise a canonical diff event: Oxide should inspect the working tree/diff independently. [Stream schema](https://antigravity.google/docs/cli/headless) |
| Approvals / permissions | Headless mode has no interactive approval prompt. It uses saved permission policy: workspace file reads/writes are auto-allowed; shell tools default to Ask and are soft-denied if approval cannot be obtained. Preconfigure narrowly scoped `permissions.allow` rules in `~/.gemini/antigravity-cli/settings.json`, or use `--dangerously-skip-permissions` (all tools auto-approved). There is no documented stream control-response mechanism to approve a pending tool call; the CLI explicitly rejects `control_request`/`control_response` input. This is the largest gap for an Oxide approval UI. [Permissions and input limitations](https://antigravity.google/docs/cli/headless) |
| Models and effort | Run `agy models` to enumerate model slugs and their supported effort variants; pass a listed slug with `--model`. The CLI supports `--effort low|medium|high|xhigh|max` in the installed 1.4.4 help (model availability may constrain this; prefer the concrete slugs returned by `agy models`). Run `agy agents` for agent names and pass `--agent`. These are separate subprocess calls, not stream RPCs. Locally, `agy models` returned Gemini 3.8 Flash low/medium/high, Claude Sonnet 4.6, Claude Opus 4.6 Thinking, and GPT-OSS 120B medium. This is an account/environment snapshot, not a stable catalog. [Headless model selection](https://antigravity.google/docs/cli/headless) |
| Installed / authenticated | Resolve `agy` on `PATH` (or check the documented macOS/Linux `~/.local/bin/agy`) and run `agy --version`. There is no documented dedicated auth-status command. Headless mode uses cached credentials; if absent it exits with an `authentication required` error instead of hanging. A lightweight `agy -p ... --output-format json` health probe can confirm usable authentication, but it makes a model request; alternatively parse failures from `agy models`/a real request. The locally installed binary returned version 1.4.4 and `agy models` succeeded. Credentials are stored through the system keyring per the official CLI repository README. [Install/auth docs](https://antigravity.google/docs/cli/install/) |
| Resume | `--continue` resumes the latest conversation; `--conversation <id>` resumes a known conversation ID from the result. These start a new process. The multi-turn stdin stream itself keeps one conversation alive until stdin closes. Persist conversation IDs per Oxide Thread. [Resume docs](https://antigravity.google/docs/cli/headless) |
| Slash commands / skills | `agy` 1.4.7 expanded a workspace skill sent as `/oxide-probe` in stream-json, and accepted a second turn on the same stream. Its response arrived as ordinary `agent_response` deltas, not a distinct command-output event. CLI-handled commands such as `/model` and `/usage` remain unsupported inside stream mode and terminate the run; do not offer them as passthrough commands. `--disable-slash-commands` disables expansion in print mode. See the 1.4.7 investigation below. [Input and slash-command behavior](https://antigravity.google/docs/cli/headless) |
| Subagents | Tool steps may expose `subagent_info.subagents` entries with type, role, conversation ID, log URI, and workspace URIs. This supports reporting subagent-spawn metadata, not necessarily a full lifecycle/event stream. Docs confirm Antigravity CLI has subagent functionality, but Oxide should treat further progress as unavailable unless separately observed. [Stream schema](https://antigravity.google/docs/cli/headless), [subagents](https://antigravity.google/docs/subagents/) |
| Attachments | Stream input accepts text or a list of text blocks only; any other block type errors and ends the session. There is no documented image/file attachment block. A practical fallback is put files in the project workspace and reference their paths in text, subject to the agent's filesystem access; this does not provide uploaded/pasted attachment semantics. [Input format](https://antigravity.google/docs/cli/headless) |
| ACP / SDK | No official documentation found for launching `agy` in ACP mode; the public CLI flags/subcommands inspected locally also contain no ACP option. ACP itself is a JSON-RPC protocol with initialize/session/prompt/update/cancel and optional permissions, so a compliant ACP adapter would be a distinct transport, not something to assume from CLI stream-json. The official Antigravity SDK is a Python SDK for building agents, configured with Gemini API credentials; it does not document controlling the installed `agy` process or reusing its login. [ACP overview](https://agentclientprotocol.com/protocol/v1/overview), [Antigravity SDK](https://antigravity.google/docs/sdk/overview/) |
| T3 Code integration | The ticket mentions `references/t3code`, but that path is absent from this checkout (and no `agy` references were found in the repository search). Therefore no existing integration behavior could be verified here. The installed CLI's subprocess stream is the closest apparent adapter surface; do not attribute an implementation to T3 Code based on this checkout. |

## Suggested Provider shape

Use a supervised long-lived child process, with the Rust Provider owning pipes and translating NDJSON events into Oxide's Provider event model. Keep stderr separate for diagnostics, retain `conversation_id`, make a `result` the turn boundary, and kill the child on Thread cancellation. Support model/agent discovery with short-lived `agy models` / `agy agents` calls. For permissions, initially expose only a documented safe mode with preconfigured allow rules; an approval UI cannot yet round-trip approval into this stream. Test each supported CLI version for stdout behavior, event additions, and exit/status handling before treating it as a durable protocol.

## Evidence and limits

Primary sources used: [official headless CLI docs](https://antigravity.google/docs/cli/headless), [official install/auth docs](https://antigravity.google/docs/cli/install/), [official CLI repository](https://github.com/google-antigravity/antigravity-cli), [official subagent docs](https://antigravity.google/docs/subagents/), [official Antigravity SDK docs](https://antigravity.google/docs/sdk/overview/), and the [ACP v1 protocol specification](https://agentclientprotocol.com/protocol/v1/overview). The CLI is distributed as a binary, and its full implementation is not in this Oxide checkout; conclusions about behavior follow official CLI docs plus local `agy --help`, `agy --version`, and `agy models`. Absence of ACP support means “not documented/advertised,” not proof that no hidden or future mode exists. No model prompt was sent during the original 1.4.4 investigation.

## Skills and commands: `agy` 1.4.7 (2026-10-27, Windows)

A temporary workspace contained `.agents/skills/oxide-probe/SKILL.md`, with a `name`,
`description`, and instruction to reply `OXIDE_SKILL_EXPANDED_93`. Sending
`{"event":"user","message":{"content":"/oxide-probe"}}` to `agy --input-format
stream-json --output-format stream-json` produced a `user_input` step, then
`agent_response` deltas containing the marker, then a `SUCCESS` result. A second
ordinary prompt sent to the same still-running process returned its own successful
result. This verifies that this skill expanded and the stream survived; it does
not establish that every command or skill does. The init event did not list skills.
The observed response contained no separately identifiable command-output event.

The [CLI skills documentation](https://www.antigravity.google/docs/skills?tab=ide)
identifies workspace `.agents/skills/<name>/`, global
`~/.gemini/antigravity-cli/skills/<name>/`, and plugin skills under
`~/.gemini/antigravity-cli/plugins/<name>/skills/`. `agy plugin list --json`
reports installed plugins and their bundled skills, but is not a complete skill
inventory; this installation returned `[]`. Its `skills.json` also explicitly
registers `~/.agents/skills`, so that path is configuration-dependent, not proof
of a universal default. The CLI's bundled customization documentation describes
workspace aliases and `skills.json` registrations. It also describes global
`~/.gemini/config/`, while the public CLI documentation names the CLI-specific
global directory above; the exact effective precedence and all configured sources
have not been independently verified.

`agy --help` advertises no general skills or custom commands listing subcommand;
`agy help skills` and `agy help commands` reported unknown subcommands. Custom
command locations and whether they expand independently of skills remain
unverified. [Legacy workflows](https://www.antigravity.google/docs/ide/workflows/)
are documented as discontinued on October 19, 2026, and should not be assumed
to be the CLI's current custom-command source. On 1.4.8, the documented CLI command `agy -p /skills --output-format json`
returned `status: SUCCESS` and a structured `command.data.skills` array with
name, description, path and metadata. With a temporary workspace skill, the
array included that skill when the command ran in the workspace. This is a
provider-reported skill inventory, not a disk scan by Oxide. `/skills` itself is
a CLI command and must run as a separate probe, never inside the Turn stream.
The [CLI reference](https://www.antigravity.google/docs/cli/reference/) lists
CLI-owned names and aliases. `agy -p /help --output-format json` also returns a
structured `command.data.commands` list with names and aliases. Both sources
are used to exclude collisions from the passthrough catalog. This list must be reviewed when supporting newer versions.
The probe does not establish whether separate legacy custom commands are included.

The two JSON probes have been verified with 1.4.8, not every version in the
pinned 1.4.x range. If the CLI does not return the expected command payload,
Oxide falls back to its own commands. The existing catalog API probes the project
root rather than a dispatched Thread's worktree, so differing worktree skills
are not yet represented accurately. The CLI setting `disableSlashCommands` may
prevent the probes from executing as commands; its effect on these probes has
not been verified.
