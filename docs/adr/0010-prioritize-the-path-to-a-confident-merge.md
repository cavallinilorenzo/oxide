# Features are prioritized by the path to a confident merge

Oxide is for senior engineers who drive coding agents and stay personally responsible for what enters `main`. A feature is prioritized by whether it shortens the path from a finished agent Turn to a confident merge. Generating a change is cheap; deciding whether it can be trusted is not, and that decision is where Oxide aims to save time. Running more agents in parallel is not the goal: other tools already sell that, and "GitHub integration" or "no VS Code" are no longer reasons to choose Oxide.

This is a hypothesis, not a finding. No users have been interviewed yet. The Verification Dossier is validated with 5-8 senior engineers on real pull requests before Blind review or Dossier publishing is built on it. If they do not open the Dossier unprompted, or it does not change what they check, this ADR should be revisited.

## Consequences

- Work is ordered so that each phase is usable alone: baseline measurement, Line comments, undo, worktrees and GitHub review, the Dossier, a validation gate, Blind review, publishing the Dossier, reliability data. Spec: [#320](https://github.com/cavallinilorenzo/oxide/issues/320).
- The Verification Dossier holds facts that Oxide computes from the Transcript, Checkpoints, Settings and GitHub, with no LLM and no aggregate risk score. The agent's own closing message is shown only as a labelled claim, apart from those facts. Where a Provider reports nothing, the value is unknown, never invented (ADR-0001).
- The Dossier is a section of the Diff Surface and Line comments live in Diff scopes. No sixth Surface is added (ADR-0009).
- Only normalized command data is added to the Transcript. Raw Provider payloads stay unpersisted (ADR-0002).
- The Review ledger (local figures about completed work, outliving Threads) keeps only numbers and identifiers: Provider, Model, timestamps and counts, never Transcript text. So ADR-0005 still holds for Transcript content: a deleted Thread loses its Transcript. The Dossier published in the pull request is the lasting knowledge that ADR-0005 says belongs there. The ledger sends no telemetry and can be cleared.
- A feature that does not shorten this path, such as fleet views, cloud execution, an Oxide-owned AI reviewer or an extension system, needs a stronger case than one that does.
