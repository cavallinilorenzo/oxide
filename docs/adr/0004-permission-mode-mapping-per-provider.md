# Permission mode mapping per Provider

Oxide defines three Permission modes—Ask, Auto-edit, and Full access—configured per Thread and changeable between Turns. In accordance with ADR-0001, each Provider adapter offers only the modes it can honour, declaring its supported modes and whether interactive Approvals are supported via capability flags:

- **Claude Code** offers Ask, Auto-edit, and Full access. Ask runs the default mode with Approvals routed to Oxide through `--permission-prompt-tool` (emitting `ApprovalRequested`). Auto-edit runs with `acceptEdits`, with non-file actions routed to Oxide for Approval. Full access runs with `bypassPermissions`. If an unanswerable Approval request occurs, Oxide denies it explicitly instead of hanging.
- **Codex** offers Ask, Auto-edit, and Full access. Each mode maps to Codex's internal sandbox and `approvalPolicy` settings, set at Thread start and updated per Turn in `codex app-server`: Ask uses a read-only sandbox with an approval policy requiring Approval for every edit and command; Auto-edit uses a write sandbox for the Thread's checkout with an approval policy requiring Approval for commands and external actions; Full access uses a full-access sandbox with no Approvals required.
- **`agy`** offers Auto-edit and Full access. Because headless `stream-json` lacks interactive Approval support (`interactive_approvals: false`), `agy` cannot honour Ask, so Ask is not offered. Auto-edit relies on `agy`'s default behavior where file edits inside the Thread's folder proceed and actions that would require interactive approval are soft-denied; the UI composer chip explicitly labels this mode as `Auto-edit (soft-deny)`. Full access runs with `--dangerously-skip-permissions`. Oxide never modifies `agy`'s own configuration files.

## Consequences

- The composer chip renders only the Permission modes offered by the selected Provider. For `agy`, Ask is omitted, and Auto-edit is labelled with `soft-deny` to make the lack of interactive Approvals transparent without faking them.
- Adapters translate Oxide's Permission mode into Provider-specific CLI flags or RPC settings on every Turn and mid-Thread update.
- Claude Code and Codex adapters handle Approval requests during a Turn, while the `agy` adapter never produces Approval requests.
