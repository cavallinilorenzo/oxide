# Assessment B: detector and browser evidence

Target: `docs/prototypes/thread-board/index.html`.

## Deterministic scan

Ran the shipped `C:/Users/mbena/.agents/skills/impeccable/scripts/impeccable.cmd detect --json` exactly once against the absolute target. Exit code 2 (findings). Full output: `detector.json`.

One finding: `tiny-text` / Tiny body text, severity `warning`, category `quality`, file `docs/prototypes/thread-board/index.html`, detector line **0** (no precise line supplied), snippet `11px body text`. Source corroborates 11px content in `.row-detail` (line 13), `.thread-card .card-status` and `.checkout` (line 14), `.scope`, `.statusbar`, compact dock tabs (line 15). Not a false positive, although the scan aggregates selectors and does not identify a single source location. Body base is 13px, so its label “11px body text” should not be read as the actual body element size.

## Browser evidence

Created an independent background IAB tab at the existing `http://127.0.0.1:8276/index.html`. Inspected A, B and C using the shipped 900×560 fixture control. Host browser viewport was 1280×720. Read-only DOM measurement found body clientWidth = scrollWidth = 1280; no page horizontal overflow in the tested states.

- A Board: sidebar client 209×485 / scroll 209×515; Board client 668×485 / scroll 668×612. Vertical scrolling is available; the third Needs input card continues below the fold. Long sidebar titles ellipsize intentionally.
- B Board: sidebar client 209×485 / scroll 209×549; Board client 668×485 / scroll 668×612. The sidebar Thread Board button wraps both “Thread Board” and “3 need input” onto two lines in its 28px minimum-height button; text crowds its border. Source entry: lines 67–68; shared `.entry` / button rules: lines 12–13.
- C: compact Thread+Dock initially hides the sidebar. Clicking the sidebar toggle once produced no accessibility, DOM, or visual change; a second click exposed it and closed the dock. Source cause: `showSide` suppresses requested sidebar when compact dock is open (line 89), while the toggle flips the remembered `S.side` flag (line 109). This can require two clicks to show the currently invisible sidebar. With sidebar shown its client 209×485 / scroll 209×663 means Completed items and the other Project need scrolling.

The no-effect first sidebar click is shared compact-state logic, not intrinsically limited to C. C makes it more consequential because Board content is only in the sidebar. These are observed browser issues, not additional CLI findings.

## Run limits and fallback

Browser evaluate is documented read-only. Mutable title/script preflight and injection are unsupported; no overlay or detector console findings were produced. Used CLI output, screenshots, source corroboration and read-only layout measurements as fallback. Did not start an Impeccable live server; no live-server cleanup required. Did not start or stop the existing prototype server. Did not edit `index.html`, read Assessment A output, or post to the tracker. `detector.json` and this report are intentional retained evidence, not temporary files.
