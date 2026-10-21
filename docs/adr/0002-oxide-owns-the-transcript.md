# Oxide owns the transcript; Provider sessions are only for resuming

Oxide stores every Thread's Turns and Items, normalized, in its own SQLite database (`~/.oxide/oxide.db`) and renders Threads only from that copy; the Provider's session files are used solely to resume the conversation, never read for display. Reading them instead would mean three parsers for private, evolving formats, and would break "Threads are archived, never deleted": Claude Code deletes its sessions after 30 days by default, and `agy` documents no storage at all. The duplication is deliberate.

## Consequences

- A Thread whose Provider session is gone stays readable but can't continue: it goes to error ("Provider session no longer available") and offers **Continue in new Thread**, prefilled with a recap built from Oxide's Transcript. The Thread ↔ Provider session mapping stays one-to-one; Oxide never silently swaps sessions under a Thread.
- Raw Provider payloads are not persisted (except `Unknown` events), so the stored Transcript is only as good as the adapter's normalization.
- Sessions started outside Oxide are not imported.
