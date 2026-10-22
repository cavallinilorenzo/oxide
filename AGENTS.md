## Agent skills

### Issue tracker

Issues live in GitHub Issues for `cavallinilorenzo/oxide` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Workflow and PRs

- Claim assigned tickets via `gh issue edit <id> --add-assignee @me`.
- Always work on a dedicated branch and open a Pull Request targeting `main`.
- Automatically close the issue (`gh issue close <id>`) once implementation and verification are complete.
