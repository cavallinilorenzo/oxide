# Usage and quota tracking for Claude Code, Codex and Antigravity (Orca vs Oxide)

**Research date:** 2026-11-02

Scope: how [stablyai/orca](https://github.com/stablyai/orca) fetches usage limits, how Oxide does it today, why Oxide's attempt likely fails, and a plan. Orca links point at `main`, so line numbers may drift. Oxide links point at the working tree.

## Orca: how it works

Orca polls each provider on a timer, with no dependence on a running agent turn. Docs: [usage-tracking.mdx](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/agents/usage-tracking.mdx). It polls about every 15 min while the window is focused. It refreshes on focus after more than 5 min, and on account switch. It warns at 80%. Orchestration lives in [src/main/rate-limits/service.ts](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/service.ts) and `service/`.

### Claude Code: OAuth usage endpoint

- **Endpoint:** `GET https://api.anthropic.com/api/oauth/usage`. Headers are `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20` and `User-Agent: claude-code/2.1.0`. The timeout is 10 s. [claude-oauth-usage-request.ts L19-L20, L83-L90](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-oauth-usage-request.ts#L19-L90)
- **Token source:** the existing Claude Code login. On macOS it reads the Keychain first. On every platform it falls back to `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json`, JSON path `claudeAiOauth.accessToken`. Orca also reads `refreshToken` and `refreshTokenExpiresAt`. It does not check the stored `expiresAt`, because the server decides whether the token is valid. [claude-oauth-credentials.ts L31-L58, L101-L125](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-oauth-credentials.ts#L31-L125)
- **Response:** `five_hour` and `seven_day` objects with `utilization` (a **percent 0-100**) and `resets_at` (an ISO string or an epoch). Orca also reads `limits[]` (`weekly_scoped`), `extra_usage` and `spend`. [claude-oauth-usage-request.ts L22-L39, L105-L118](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-oauth-usage-request.ts#L22-L118), [claude-usage-window.ts L10-L29, L53-L75](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-usage-window.ts#L10-L75). It treats timestamps above 1e10 as ms, otherwise as s.
- Orca discards stale idle snapshots with `isStaleClaudeUsageWindow`, which flags a lower percent or an earlier reset inside the same window. [claude-usage-window.ts L94-L112](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-usage-window.ts#L94-L112)

### Codex: two sources

1. **Primary: app-server JSON-RPC.** It spawns `codex app-server` and sends `initialize` with `clientInfo{name:'orca'}`. It then sends the `initialized` notification, then `account/rateLimits/read`. The result is `rateLimits.primary` / `secondary`, which Orca classifies by window duration (300 min = session, 10080 min = weekly), not by name. [codex-rpc-rate-limit-probe.ts L198-L275](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-rpc-rate-limit-probe.ts#L198-L275)
2. **Backend fallback and supplement.** It reads `<CODEX_HOME or ~/.codex>/auth.json`, fields `tokens.access_token` and `tokens.account_id`. It calls `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer`, `User-Agent: codex-cli`, `OpenAI-Beta: codex-1`, `originator: Codex Desktop` and `ChatGPT-Account-Id`. The response has `plan_type` and `rate_limit.primary_window` / `secondary_window` with `used_percent`, `limit_window_seconds` and `reset_at`. [codex-backend-auth.ts L62-L90](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-backend-auth.ts#L62-L90), [codex-backend-usage-client.ts L19-L103](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-backend-usage-client.ts#L19-L103). It is used when the RPC returns no session window. [L105-L135](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-backend-usage-client.ts#L105-L135)

### Antigravity: shell out to `agy` in print mode

- **Command:** `agy -p /usage --output-format json --print-timeout 20s`, run with the env `AGY_CLI_DISABLE_AUTO_UPDATE=true`. Timeout is 30 s. [antigravity-usage-command.ts L3-L20](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/antigravity-usage-command.ts#L3-L20)
- **Why a CLI call:** per Orca's comments, only `agy` can authenticate to `daily-cloudcode-pa` with its OS-keyring Google credential. Orca does not read the token itself. Same file, L3.
- **Guards:**
  - It requires agy >= 1.1.11, because earlier versions spend a model turn on `/usage`. It probes `agy --version` first. [L22-L29](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/antigravity-usage-command.ts#L22-L29)
  - It never passes `--disable-slash-commands`, which would turn `/usage` into a billed prompt. [L13](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/antigravity-usage-command.ts#L13)
  - If the output shows `num_turns > 0` or a `conversation_id`, it stops polling. [antigravity-usage-response.ts L185-L199](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/antigravity-usage-response.ts#L185-L199), [antigravity-usage-fetcher.ts L104, L197](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/antigravity-usage-fetcher.ts#L104)
- **Parsing:** find a JSON line with `status=="SUCCESS"`, `command.name=="usage"` and `command.data.groups[].buckets[]`. Each bucket has `id`, `name`, `window` (`5h` or `weekly`), `remaining_fraction` and `reset_time` (ISO), and may have `disabled`. `used% = round((1 - remaining_fraction) * 100)`. Disabled buckets are dropped. The most constrained bucket per window wins. [antigravity-usage-response.ts L22-L153](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/antigravity-usage-response.ts#L22-L153)

## Oxide today

The `UsageLimits` model is in [oxide-core/src/usage.rs](https://github.com/cavallinilorenzo/oxide/blob/main/crates/oxide-core/src/usage.rs): a 5-hour and a weekly window per provider, persisted to SQLite. The model and merge logic are sound. The gap is acquisition, which is purely passive and **provider-pushed**.

| Provider | Mechanism today | Source |
|---|---|---|
| Claude | Only parses the stream-json `rate_limit_event` seen during a turn | [claude.rs L566-L570, L718-L745](https://github.com/cavallinilorenzo/oxide/blob/main/crates/oxide-provider/src/claude.rs#L566-L745) |
| Codex | `account/rateLimits/updated` notifications, plus `account/rateLimits/read` once per start/turn | [codex.rs L113-L147, L380-L390, L974-L983, L1264, L1303](https://github.com/cavallinilorenzo/oxide/blob/main/crates/oxide-provider/src/codex.rs#L113-L1303) |
| Antigravity | Nothing: `reports_usage_limits: false` | [agy.rs L680](https://github.com/cavallinilorenzo/oxide/blob/main/crates/oxide-provider/src/agy.rs#L680) |

### Why it likely fails

1. **Claude is reactive only.**
   - `rate_limit_event` is emitted only inside a turn. Typically it appears only when the status changes or is near a limit, and it may carry no `utilization`, so the ring is empty or stale until the user has already spent quota.
   - There is no polling and no call to the OAuth usage endpoint, so there is no initial value after a restart unless one was persisted.
   - The parser also does `utilization * 100` ([claude.rs L735-L738](https://github.com/cavallinilorenzo/oxide/blob/main/crates/oxide-provider/src/claude.rs#L735)), assuming a fraction. Orca's OAuth endpoint reports a 0-100 percent, and Orca treats `utilization` as one ([claude-usage-window.ts L60-L70](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/claude-usage-window.ts#L60-L70)). If the stream event also uses percent, values would display 100x too large. I did not verify the stream-json unit. Check it against a live capture.
   - Only exact `five_hour` and `seven_day` types are kept. Any other `rateLimitType` is silently dropped.
2. **Codex relies on the shared app-server and on exact window durations.**
   - `parse_rate_limits` drops any window whose `windowDurationMins` is not exactly 300 or 10080, and drops a window with a null or missing duration or percent ([codex.rs L121-L126](https://github.com/cavallinilorenzo/oxide/blob/main/crates/oxide-provider/src/codex.rs#L121)). Orca falls back to default minutes and to the HTTP backend ([codex-backend-usage-client.ts L50-L58, L105-L135](https://github.com/stablyai/orca/blob/main/src/main/rate-limits/codex-backend-usage-client.ts#L50-L135)). Free and some plans may report a single window or `null` duration.
   - The read is a best-effort thread whose errors are swallowed (`if let Ok`), and it runs only at start and turn end. There is no periodic refresh and no auth-header fallback.
   - The read fails when the app-server is not yet initialised or the user is not logged in with ChatGPT. API-key logins have no rate limits.
3. **Antigravity is not implemented.** The flag is false and there is no `/usage` call.
4. **No active poller or token-based fetch exists anywhere**, and no credentials are read (neither `~/.claude/.credentials.json` nor `~/.codex/auth.json`).

I did not run any of these paths against live accounts, so the diagnoses above are code-reading inferences.

## Recommended implementation plan for Oxide

Add a **UsageProbe** module in `oxide-provider` (or `oxide-core`) that is independent of Threads and turns, and reuse the existing `UsageLimits` store and merge.

1. **Poller.**
   - Trigger on app start, window focus (when stale by more than 5 min), account change, and every ~15 min while focused.
   - Run one probe per provider concurrently, with a per-provider timeout (10 s for HTTP, 30 s for agy) and backoff on 401/429 (honour `Retry-After`).
   - Emit `ProviderEvent::UsageLimits` into the same path as today.
2. **Claude probe.**
   - Read `claudeAiOauth.accessToken` from `%CLAUDE_CONFIG_DIR%` or `~/.claude/.credentials.json`. On macOS, read the Keychain item "Claude Code-credentials".
   - Call `GET https://api.anthropic.com/api/oauth/usage` with the Bearer token, `anthropic-beta: oauth-2025-04-20` and a claude-code User-Agent. Use `reqwest` with rustls.
   - Map `five_hour` and `seven_day` as `utilization` = percent and `resets_at` = ISO or epoch (normalise s/ms). Keep the stale-snapshot guard.
   - Do not refresh the token. On 401, show "sign in via claude" and let Claude Code refresh it.
   - Fix the stream `utilization` unit after checking a real capture, and keep the event as a fast path between polls.
3. **Codex probe.**
   - Primary: reuse `CodexAppServer` and call `account/rateLimits/read` on the poll timer, not only at start.
   - Classify windows by `windowDurationMins` with default fallbacks (first window = session, second = weekly) rather than discarding unknown durations.
   - Fallback: `GET https://chatgpt.com/backend-api/wham/usage` using `~/.codex/auth.json` `tokens.access_token` and `account_id`, with the headers above. Map `rate_limit.primary_window` / `secondary_window` (`used_percent`, `limit_window_seconds` / 60, `reset_at`, which appears to be epoch seconds).
   - Surface "not signed in with ChatGPT" explicitly for API-key auth.
4. **Antigravity probe.**
   - Run `agy --version` and require >= 1.1.11. Then run `agy -p /usage --output-format json --print-timeout 20s` with `AGY_CLI_DISABLE_AUTO_UPDATE=true` and a hidden cwd. On Windows, spawn with `CREATE_NO_WINDOW` (Orca cites focus theft, #27390).
   - Parse the `groups[].buckets[]` envelope as described above. Map `5h` to FiveHour and `weekly` to Weekly, taking the max of used% per window.
   - Latch off, and tell the user, if the output shows `num_turns > 0` or a `conversation_id` (the billed-prompt case).
   - Set `reports_usage_limits: true`. Because agy bills a turn on old versions, keep a visible kill switch.
5. **Robustness and UX.**
   - Keep the last snapshot. Mark a result unavailable on failure and give the reason, such as `not-signed-in`, `cli-missing` or `http-error`, rather than silently showing nothing.
   - Never log tokens.
   - Tests: unit-test the parsers against recorded JSON fixtures, using `crates/oxide-provider/fixtures`. Add an HTTP mock for the Claude and Codex backends. The existing `tests/usage_limits.rs` covers the store.
   - Caveats: the Claude and Codex endpoints are undocumented and can change. Treat them as best-effort, version the parsers, and degrade to the passive path.
