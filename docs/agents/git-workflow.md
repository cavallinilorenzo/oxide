# Git workflow

Two long-lived branches, short-lived topic branches off `dev`.

```
main   ●───────────────●───────────────●   stable, release-quality
        \             / \             /
dev      ●──●──●──●──●   ●──●──●──●──●     integration of finished features
            \ /  \ /
feat/x       ●     fix/y                    one topic per branch
```

| Branch | Purpose | Who writes | Merge method |
| --- | --- | --- | --- |
| `main` | Stable version. Always builds, always green. | Nobody directly. PR from `dev` only. | merge commit |
| `dev` | Where features accumulate and get tested together. | Nobody directly. PRs from topic branches only. | squash |
| `<type>/<slug>` | One feature, fix, research note or map/label task. | The author. | n/a |

Both `main` and `dev` are protected by GitHub rulesets: PR required, `rust` and `web` CI checks must pass, no force-push, no deletion.

## Rules for every agent and human

1. **Branch from `dev`**, never from `main`: `git fetch origin && git switch -c <type>/<slug> origin/dev`.
2. **Name** topic branches `<type>/<slug>`, where type is `feat`, `fix`, `docs`, `chore`, `refactor`, `test` or `research`. Include the issue number when there is one: `feat/42-terminal-surface`.
3. **Open PRs against `dev`**: `gh pr create --base dev`. Never `--base main` unless you are promoting (rule 7).
4. **One topic per branch.** Do not stack unrelated work. If you depend on another unmerged branch, say so in the PR.
5. **Keep up to date** by merging or rebasing `origin/dev` into your branch, not `main`.
6. **Never push to `main` or `dev`, force-push shared branches, or merge your own promotion PR.** The rulesets enforce most of this; do not look for workarounds.
7. **Promotion (`dev` → `main`) is a human decision**, made when `dev` is stable enough. Open a PR `dev` → `main` and merge it with a **merge commit** (not squash, otherwise the branches diverge). After it lands, `main` is an ancestor of `dev` again; nothing else to sync.
8. **Hotfixes** also go through `dev` (branch `fix/...` off `dev`). If `main` is broken and urgent, a human cherry-picks via a PR to `main`, then merges `main` back into `dev`.
9. Branches are deleted automatically on merge. Do not reuse a merged branch name.

## Typical flow

```sh
gh issue edit <id> --add-assignee @me
git fetch origin && git switch -c feat/<id>-<slug> origin/dev
# ... work, commit ...
git push -u origin HEAD
gh pr create --base dev
# after merge into dev:
gh issue close <id>
```

## Why issues are closed by hand

GitHub only auto-closes issues (`Closes #n`) when a PR merges into the **default branch** (`main`). Since feature PRs target `dev`, close the issue yourself once the PR is merged.
