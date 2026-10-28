# Attachments are prompt segments, delivered per Provider

A prompt is an ordered list of segments (text, or a stored Attachment), and every layer passes segments rather than a string plus a side list of paths. The Transcript records them that way (see ADR-0002), so the composer and the Transcript look the same on every Provider; how a file reaches the agent is each adapter's job.

## Consequences

- Each Attachment is delivered natively when the Provider takes its kind and it fits the transport (Claude Code: images, PDFs, text as `image`/`document` blocks, up to about 9 MB per message; Codex: `localImage`), otherwise as a path reference. Either way a `[Attachment: name]` marker names it at its place.
- **Read access for path references.** Claude Code and Antigravity CLI are started with `--add-dir <home>/attachments` (`agy --help` lists a repeatable `--add-dir`, so Antigravity CLI needs neither a copy inside the Project nor a refusal). Codex needs nothing: its `readOnly` and `workspaceWrite` sandbox policies default to full read access, and only writes are confined.
- `Provider::send_prompt_with_segments` has no default: an adapter that cannot deliver an Attachment must fail the send, and Core reports it before any Turn starts, never dropping the file silently.
- Removing a chip is undoable in the composer, so a removed Attachment is forgotten when the prompt is sent; unsent leftovers older than a day are cleaned at startup.
