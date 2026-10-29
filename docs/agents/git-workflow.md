# Git workflow

Trunk-based: one long-lived branch, `main`, and short-lived topic branches off it.

```
main   ●──●──●──●──●──●──●──●   always green; releases are tags on main
        \ /  \ /  \ /
feat/x   ●    fix/y  docs/z     one topic per branch
```

| Branch | Purpose | Who writes | Merge method |
| --- | --- | --- | --- |
| `main` | The default branch. Always builds, always green. Releases are tagged here. | Nobody directly. PRs from topic branches only. | squash |
| `<type>/<slug>` | One feature, fix, research note or map/label task. | The author. | n/a |

`main` is protected by a GitHub ruleset: PR required, the status check `gate` required, squash merge only, no force-push, no deletion. `gate` is the single verdict of CI (see `docs/devops.md`), so there is never a second check to add to the ruleset. `release/**` branches have the same protection.

## Rules for every agent and human

1. **Branch from `main`**: `git fetch origin && git switch -c <type>/<slug> origin/main`.
2. **Name** topic branches `<type>/<slug>`, where type is `feat`, `fix`, `docs`, `chore`, `refactor`, `test` or `research`. Include the issue number when there is one: `feat/42-terminal-surface`.
3. **Open PRs against `main`**: `gh pr create --base main`.
4. **One topic per branch.** Do not stack unrelated work. If you depend on another unmerged branch, say so in the PR.
5. **Keep up to date** by merging or rebasing `origin/main` into your branch.
6. **Never push to `main`, force-push shared branches, or merge your own PR without a human's go-ahead.** The ruleset enforces most of this; do not look for workarounds.
7. **Releases are a human decision.** Only the Release Managers (`cavallinilorenzo`, `itsmrma`) release: bump the version in a normal `chore(release): vX.Y.Z` PR into `main`, wait for `gate` on the merge commit, then tag it (runbook in `docs/devops.md`). Never create a `v*` tag as an agent. Tags are immutable once pushed (a `release tags` ruleset; only the admin can delete one), and a release build waits for a Release Manager's approval.
8. **Hotfixes** are ordinary PRs into `main`. If an already-published release needs a fix and `main` has moved on, a human creates a `release/x.y` branch from the tag and cherry-picks.
9. Branches are deleted automatically on merge. Do not reuse a merged branch name.

## PR titles

PRs are squash-merged, so the PR title becomes the `main` commit and the release-notes line. CI (`pr-title`) requires a Conventional Commit title: `<type>(<scope>): <description>`, scope optional, `!` before the colon for a breaking change. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `research`, `perf`, `build`, `ci`, `revert`.

## Typical flow

```sh
gh issue edit <id> --add-assignee @me
git fetch origin && git switch -c feat/<id>-<slug> origin/main
# ... work, commit ...
git push -u origin HEAD
gh pr create --base main
# after merge into main:
# the issue closes by itself via `Closes #<id>` in the PR body
```

## Issue auto-close

`main` is the repository's **default branch**, so `Closes #<id>` in a PR body links the PR to the issue and closes it when the PR merges.
