# Threads are deleted, not archived

A finished Thread is deleted, not archived. Oxide keeps its default harness as small as it can, so every session starts from a clean context window; a hidden-but-kept Thread that a prompt silently brings back (the old archive behaviour) works against that, and an ever-growing archive is state nobody asked to carry. What is worth keeping about finished work belongs in the pull request, an ADR or the `GLOSSARY.md`, not in a kept Thread. This reverses the earlier rule "Threads are archived, never deleted".

## Consequences

- Deleting a Thread removes its Transcript (Turns, Items, Approvals, unknown events), its attachments and its Checkpoints. It cannot be undone, so the UI confirms first.
- A running Turn is stopped first. A Board Thread's worktree is removed with it and its branch is kept; if the worktree has uncommitted changes, the user is asked again before they are discarded.
- A Thread that continued, or was continued by, a deleted Thread just loses the link.
- The Provider's own session files are not touched: they belong to the Provider, and Oxide only ever read them to resume (ADR-0002).
- Threads archived before this change are not deleted by the migration: they reappear in the sidebar, and the user deletes them.
