## Agent skills

### Issue tracker

Issues live in GitHub Issues for `cavallinilorenzo/oxide` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Workflow and PRs

- Claim assigned tickets via `gh issue edit <id> --add-assignee @me`.
- Branching model: `main` is stable, `dev` is integration. Never commit or push directly to either. Branch off `dev`, open the Pull Request with `--base dev`, **never** `main`. Full rules in `docs/agents/git-workflow.md`.
- Only a human promotes `dev` to `main`.
- Put `Closes #<id>` in the PR body: `dev` is the repo's default branch, so GitHub links the PR to the issue and closes it on merge. No manual `gh issue close` needed.
