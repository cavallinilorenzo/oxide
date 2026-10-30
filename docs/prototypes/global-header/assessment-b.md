# Assessment B — detector and browser evidence

Target: `C:\Users\mbena\.codex\worktrees\277-global-header\oxide\docs\prototypes\global-header\index.html`
Live fixture: `http://127.0.0.1:8277/index.html?variant=C&size=900x560`
Method: independent evidence assessment, without Assessment A findings. No source or tracker edits. Tested only the in-memory fixture.

## Deterministic detector

Ran exactly once from the worktree with `impeccable.cmd detect --json <absolute index.html>`. Exit 2 (findings). Complete unmodified JSON is retained in `detector.json` beside this report.

- Total findings: **1**.
- Rule: **tiny-text** / **Tiny body text**.
- Category: **quality**; severity: **warning**.
- Location returned: full target path above, **line 0** (detector did not resolve a useful source line).
- Snippet: **11px body text**.
- All other rule counts: **0 reported**. This is a source scan, not proof that other accessibility or runtime properties pass.

The underlying small text exists: `.label`, `.badge`, `.row-detail`, `.composer .hint`, `.scope`, `.statusbar`, and other metadata use 11px; `.checkout .path` uses 10px (source lines 22–26). The base body itself is 13px (line 22), so the detector's wording “11px body text” overgeneralizes. Classify this as a valid small-metadata readability signal, not evidence that all body text is 11px or a reason to enlarge every label uniformly. It did not produce a measured contrast result.

## Browser method and limits

Created a fresh hidden IAB tab; did not reuse Assessment A's tab. Browser viewport was 1280×720. Used supported CUA actions, fresh AX states, screenshots, and read-only Playwright DOM measurements.

The documented `evaluate` API is read-only. Mutable injection is unavailable by contract, so no title mutation, script injection, overlay server, presentation, or `[Human]` overlay was attempted. No reliable user-visible detector overlay exists. The fallback is the source detector JSON plus native browser screenshots, AX output, DOM geometry, and fixture interactions. Browser console detector findings are not applicable because the detector did not run inside the page. Tab stayed hidden throughout.

Screenshots were inspected in the browser tool trace (compact default; compact long branch; commit dialog; compact maximized Diff; maximized Terminal with focused input; post-simulation Diff; large fixture). They were not exported as separate PNG files.

## Verified behavior

1. **Compact layout and truncation:** At fixture size 900×560 the stage rendered at actual 900×560, unscaled, with the 482px dock and 416px centre. Selecting Long branch produced `oxide/fix-conpty-resize-and-preserve-wrapped-lines-on-windows`. The checkout button remained 210px wide, its branch text had clientWidth 168px versus scrollWidth 375px and visibly ellipsized. The full branch stayed present in DOM/accessibility text and in the scope text. The needs-input chip remained completely visible: approximately 105×28px, with clientWidth and scrollWidth both 103px. Commit & Push remained visible.

2. **Needs-input survives maximization:** Maximizing Diff at 900×560 kept the header's `3 need input` action, Project selector, dock handle, and a restore-Thread button. Terminal maximization did the same. Clicking the global needs-input action restored the Thread and selected Slash command catalog's pending Approval, focusing Allow once. This is a successful signal-to-action flow.

3. **Background notification does not steal shell focus:** In maximized Terminal, entered `echo pinned-oxide` in the fixture shell input, then pressed Ctrl+Shift+I. The selected Thread and Terminal scope stayed in place; `document.activeElement.id` remained `shell`; the statusbar reported `New Approval in Slash command catalog`. The chip stayed visible. Its count remained 3 because the helper chose a Thread already needing input, so this particular fixture does not demonstrate a count increment.

4. **Terminal checkout stays pinned across Thread navigation:** Started in oxide's Terminal at `~/.oxide/worktrees/oxide/conpty-resize`, entered the text above, and selected Slash command catalog using the maximized rail. Selected Thread checkout changed to `~/.oxide/worktrees/oxide/slash-catalog`; Terminal stayed at conpty-resize with its input retained, and showed the explicit different-checkout warning. Its branch label remained `oxide/conpty-resize`.

5. **Project switching:** Project selector switched oxide → compiler. Terminal scope became `Project compiler · tab checkout: C:/dev/compiler` with branch main and a distinct empty shell input. Entered `echo pinned-compiler`, then returned to oxide: Terminal returned to conpty-resize and restored `echo pinned-oxide`. Switching Projects also selected the first Thread in that Project; returning did not restore the previously selected catalog Thread. This is observed behavior, not a proven requirement violation.

6. **Commit target and simulation:** On Slash command catalog, Diff and Commit & Push dialog both named its selected checkout `~/.oxide/worktrees/oxide/slash-catalog`, rather than Terminal's conpty-resize checkout. Dialog stated all 3 files, +24/−8, changes outside displayed Turn Diff, exclusion of other checkouts and Terminal, and simulation-only execution. Simulate Commit & Push changed Diff's count to 0, disabled Commit & Push, and reported `Simulated Commit & Push … no Git operation`. Only fixture state changed.

7. **Large fixture:** Selected 1440×900; header and needs-input were still present and branch still truncated. The page scales this fixture to fit available browser height: screenshot stage was about 1001.6×626 (scale 0.696). This verifies structure and presence, not full-size typography at a native 1440×900 browser viewport.

## Reproducible browser issues / fixture limitations

### P2 — keyboard focus is lost after Surface navigation

With any normal Thread selected, focus Terminal in Surface tabs and activate with Enter. The tab changes correctly, but the AX state reports WebArea focus and DOM inspection returns `document.activeElement.tagName === 'BODY'`, with empty focus id. This was reproduced at 1440×900; ordinary tab and maximize clicks also discarded focused controls in compact mode. The full stage is rebuilt with `stage.innerHTML` in render (line 109), and most actions call render without restoring focus (lines 124–146). Keyboard users lose their location after a basic navigation action. Preserve focus on the activated tab or move it intentionally to the new Surface; do not let it fall to body. The special background Approval path already demonstrates deliberate focus retention.

### P2 — compact dialogs escape the simulated window bounds

At the 900×560 stage, open Commit & Push. The stage occupied x=190…1090, y=38…598, while the modal visibly occupied approximately x=150…1130, width 980px. `dialog` sizing is relative to the real browser viewport (`width:min(980px,95vw)`), not the selected simulated stage (line 26), and the dialogs sit outside the stage (line 34). This makes the compact fixture's modal evidence overoptimistic: the dialog is 80px wider than the intended app window. Constrain a simulated modal host to the stage, or test dialogs with an actual browser viewport matching the target window before judging compact behavior. This is a prototype fidelity limitation, not evidence of a production modal defect.

### Fixture detail — Long branch aliases every Board Thread to the same branch

With Long branch enabled, switching from resize to catalog changes the worktree path correctly but keeps the literal resize-themed branch `oxide/fix-conpty-resize-and-preserve-wrapped-lines-on-windows`. Source line 63 applies the same string to any Board Thread. Thus long-name truncation is proven; correct per-Thread branch naming in that stress state is not. Commit targeting remained distinct by worktree path in the observed flow.

## Cleanup / handoff

- Browser evidence tab was Reset and explicitly closed. It was never made visible or marked as a deliverable.
- No browser viewport override was installed; the fixture size was controlled through its own UI.
- No server was started by Assessment B. Existing parent-owned static server at port 8277 was left running for the parent to manage.
- No overlay server or injected script existed to remove.
- Only intended artifacts were written: `detector.json` and this report. No temporary files to delete.
- No source edits, Git operations, tracker writes, or production mutations were performed.
- Parent owns slug/ignore-list/persistence/trend accounting; this assessment did not read prior critique findings or Assessment A.

## Narrow follow-up after parent correction

After the initial assessment was written, the parent reported a scoped correction to all-uncommitted review and checkout-keyed fixture Git state. The deterministic scan above predates that correction and was deliberately not rerun (one-run requirement; parent reports styles unchanged). Source line references above refer to the initial assessed file and may shift after that correction.

Created a second fresh hidden tab at C / 900×560 solely for the requested follow-up. Clicking `3 files +24 −8` now opens **Uncommitted Diff · 3 files**, explicitly scoped to `~/.oxide/worktrees/oxide/conpty-resize · all checkout changes`, with three expanded illustrative diffs:

- `crates/oxide-pty/src/resize.rs` · +10 −4
- `crates/oxide-pty/tests/resize.rs` · +12 −2
- `docs/terminal.md` · +2 −2

`Back to Branch Diff` returns to the narrower Branch Diff. Commit & Push now explicitly lists those same three filenames before its all-checkout summary. The selected checkout still matches conpty-resize. The dialog still visibly extends outside the 900px simulated stage, so the fidelity limitation persists. Review navigation still leaves WebArea/body focus, consistent with the keyboard issue already reported. Cancelled the dialog and explicitly closed the second tab; no additional server or temporary files were created. No broader re-audit or second detector run was performed.
