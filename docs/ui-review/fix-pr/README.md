# Fix PR

Fix PR appears directly beneath the first CI failure or merge conflict message, with
one action per PR. When only an optional check fails, it appears in the Checks card
beside the failed results. The action creates a new Thread in the same Project and automatically sends
the PR URL, failed check names and run URLs, and any merge conflicts to the Provider
selected in Settings, with its configured Model, Effort and permission mode.

## Automated verification

- `node tools/check.mjs fast`: rustfmt, ESLint and TypeScript pass. ESLint reports
  the existing TanStack Virtual/React Compiler warning in `ThreadView.tsx`.
- `pnpm --dir web test`: 81 files, 506 tests pass, including contextual placement, repair eligibility,
  failed-check deduplication, optional failures, conflicts, pending requests,
  dispatch errors, Settings defaults, automatic sending and draft recovery.
- `pnpm --dir web build`: passes, with the existing large-chunk warning.
- Chromium with deterministic native-service fixtures: the real App and PR panel
  dispatch exactly one request, use Settings defaults, and open the resulting Thread
  with its prompt in the Transcript. Panels at 288px and 480px have no horizontal
  overflow; no browser errors. Native Providers and GitHub writes are mocked.

Screenshots: [288px panel](action-288.png), [480px panel](action-480.png),
[pending request](starting.png), [new Thread](new-thread.png).
Details of the browser fixture's command calls are in [verification.json](verification.json).

## Final release validation

Consolidate the remaining manual PC/Mac/iOS checks into the final release pass:
where the PR surface is supported, open a PR with failed CI and/or conflicts,
activate Fix PR, verify that the same Project opens a new Thread using current
Settings defaults, and confirm that the installed Provider receives the PR link
and appropriate tasks. Verify native approval handling and recovery when the
Provider cannot start. Passing or pending checks alone must not show Fix PR;
closed and merged PRs must not offer it.
