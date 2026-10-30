# Thread-centred window acceptance

`web/scripts/window-review.mjs` drives the real App through the existing
`openReview` deterministic Tauri IPC fixture. Run a Vite dev server and set
`OXIDE_REVIEW_URL` and `OXIDE_PLAYWRIGHT_MODULE` for the installed browser runtime,
then run from `web`:

```sh
node scripts/window-review.mjs ../docs/ui-review/window
```

Verified in Chromium at actual 1440×900 and 900×560 browser viewports:

- Exactly five dock tabs; no Work mode switch or bottom terminal.
- Thread width of at least 360px beside Diff, with no horizontal overflow.
- Compact sidebar/dock exclusivity and restoration when the window grows.
- Maximize/restore and a visible collapsed Thread handle.
- The same Files editor instance across Terminal loading, hiding, maximizing,
  Board and Settings; Thread draft and selected Surface retained.
- Shell startup command count unchanged by presentation changes.
- Region-local Diff loading keeps the frame and composer visible.
- Legacy Code → Files and Terminal → Terminal preferences; no implicit shell.
- No-Project and no-Thread next actions, without a hidden Git mutation target.

The native command boundary is mocked. This acceptance proves presentation and
captured command counts, not real PTY process lifetime or Git repository roots;
the later terminal and scoped-Git slices carry those supplemental Core contracts.
The screenshots record the baseline frame before the later header/ownership slices.
