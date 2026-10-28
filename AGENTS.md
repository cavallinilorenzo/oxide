## Agent skills

### Issue tracker

Issues live in GitHub Issues for `cavallinilorenzo/oxide` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Workflow and PRs

- Claim assigned tickets via `gh issue edit <id> --add-assignee @me`.
- Branching model: trunk-based, `main` is the only long-lived branch. Never commit or push directly to it. Branch off `main` and open the Pull Request with `--base main`. Full rules in `docs/agents/git-workflow.md`.
- Only a human tags releases.
- Put `Closes #<id>` in the PR body: `main` is the repo's default branch, so GitHub links the PR to the issue and closes it on merge. No manual `gh issue close` needed.

### Checks

Every check lives in `tools/checks/catalogue.json`, with the failure it prevents. Run the PR tier locally with `node tools/checks/run.mjs pr`, the quick tier with `fast`, or one check by id. `node tools/checks/run.mjs --list` shows them all.
