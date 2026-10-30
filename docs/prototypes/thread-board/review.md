# Thread Board alternatives: design review

Method: dual-agent (A: `/root/board_design_review` · B: `/root/board_detector`), with parent interaction checks and fixes. The design assessment completed before detector findings entered the parent synthesis. Source and screenshots are a throwaway fixture, not production UI or user testing.

## Recommendation

**B · Project overview.** The Thread Board belongs to a Project and deserves a named navigation entry there. Recent Threads remain an efficient conversation switcher. A is a viable low-change fallback, but mixes centre navigation with pane toggles in the header. C removes the duplicate view, but status changes relocate navigation rows and a narrow list is worse for cross-Thread inspection.

The design feels specific to Oxide: explicit worktree ownership, Provider identity, Thread status and a command Approval in its target checkout. The quiet incumbent visual language suits an Operate surface. Decorative changes would not help this decision.

## Eight principles

Judged at 1440×900 and 900×560, against [What does UX evidence say about modes versus docked panels?](https://github.com/cavallinilorenzo/oxide/issues/269). These ratings are local design judgements, not claims that research experimentally ranks these alternatives.

| Principle | A · Header toggle | B · Project overview | C · Sidebar groups |
| --- | --- | --- | --- |
| Thread status is ambient | Pass: header counts; pending Approval one action away | Pass: same, plus Project entry count | Pass: groups plus same header |
| Signal, don't seize | Pass after focus fix: status updates preserve input/navigation focus | Pass after same fix | Partial: focus retained, but Thread moves between status groups |
| Switching keeps the working set | Partial: drafts, file edits/caret, dock tabs, shell input and Transcript scroll remembered; Board hides Transcript | Partial: same, with an explicit overview boundary | Strongest central continuity; same fixture state retention |
| Each tool has one stable home | Partial: header Board duplicates sidebar Threads with weak Project scope | Strongest: explicit Project Board; recent list has a distinct switching purpose | One Thread list; moving rows cost spatial stability |
| What is used together is shown together | Partial: Thread + dock, command + Approval; Board replaces Transcript | Partial: same, deliberately a separate overview task | Thread + dock; less cross-Thread detail |
| Input announces itself | Pass: Provider prompt and shell command labels | Pass: same | Pass: same |
| Peer switchers / pane toggles | Partial: Board centre navigation among header pane controls | Pass: Project navigation separate from pane controls | Pass: sidebar disclosure separate from pane controls |
| Progressive disclosure at 900×560 | Pass within fixture: visible handles, centre ≥360px, Board scrolls | Pass after sidebar/entry fixes; Board scrolls | Partial: groups and Completed require more sidebar scrolling |

There is no claim that a production editor, file+hunk simultaneous pair, live command-output restoration, arbitrary content lengths or every accessibility state has been validated. Files uses a sample textarea; Diff is a fixed illustrative hunk. The prototype specifically tests Board placement, Thread/Approval access, checkout recognition and dispatch.

## Findings and fixes

- **P1, fixed and rechecked:** compact sidebar initially required two clicks because requested visibility differed from effective visibility under the dock. It now opens on the first click and hides the dock.
- **P1, fixed and rechecked:** a background Approval replaced navigation DOM and lost keyboard focus. It now restores the equivalent focused control while leaving typing controls untouched. Parent verified a focused Thread row remains a button, rather than BODY, after Ctrl+Shift+I.
- **P2, fixed:** B's compact Board entry and needs-input badge wrapped. A numeric badge now leaves Thread Board on one line; the header labels the count.
- **P2, fixed wording:** a tooltip promised "next" needs-input navigation while always prioritizing the first pending Approval. It now states that actual behavior.
- **P2, remains an inherent C tradeoff:** grouping by status changes row position; Error and Interrupted share Needs input. This grouping follows the existing glossary, so this placement decision does not redefine the statuses.
- **P2, remains:** metadata at 11px is small. The detector's single `tiny-text` warning is valid for row details/card status; its "body text" wording is broad because the page body is 13px. Density and visual language are outside this map's scope, but production should revisit metadata readability.
- **P2, production handoff:** New Thread versus Dispatch Board Thread must clearly communicate main checkout versus own worktree at the choice. The prototype shows this explicitly in dispatch preview and Thread metadata, but newcomer comprehension still needs human reaction.

The Board's repeated Threads add cognitive load, but B gives the two representations different purposes. At small sizes, low-priority metadata is reduced and vertical scrolling is explicit. C is attractive if the deciders value a single list more than the spacious overview. The dock's five peer labels are familiar but sit just above the critique skill's four-option threshold; changing its catalogue is outside this decision.

The emotional flow is calm during work and explicit at Approval. Grouping an intentionally stopped Thread with Errors can imply urgency; this is a pre-existing domain choice, recorded here for the later spec rather than silently changed.

## Independent initial heuristic scores for B

These scores describe the initial review, **before** the interaction fixes; no post-fix score was invented.

| Nielsen heuristic | Score / 4 |
| --- | ---: |
| Visibility of system status | 3 |
| Match with real world | 3 |
| User control and freedom | 2 |
| Consistency and standards | 3 |
| Error prevention | 3 |
| Recognition rather than recall | 3 |
| Flexibility and efficiency | 3 |
| Aesthetic and minimalist design | 3 |
| Error recognition and recovery | 2 |
| Help and documentation | 2 |
| Total | 27 / 40 |

Alex, the power user, encountered the compact toggle and misleading next-action tooltip; those are corrected. Sam, the keyboard user, encountered navigation focus loss; corrected and rechecked. Jordan, the newcomer, may still need clearer differentiation of the two Thread creation paths. No real participant testing was performed.

## Verification and run notes

- Parent and independent reviewers visually inspected A/B/C at both internal stage sizes. Six final captures were taken at a 1460×1000 host viewport; stage scaling is 1 at both target sizes.
- Parent drove an Approval to working; a typed draft survived Board round-trip; dispatch created a seventh Thread with working status and the previewed branch/worktree. Sidebar and background-focus fixes were exercised after edits.
- `node tools/check.mjs fast`: 3 passed, 0 failed. ESLint reported the existing `react-hooks/incompatible-library` warning in `web/src/ThreadView.tsx` for TanStack `useVirtualizer`; no production file was changed.
- Extracted inline JavaScript parses with Node `vm.Script`; `git diff --check` passes. No tests were added for throwaway UI.
- CLI detector ran once on `docs/prototypes/thread-board/index.html`: exit 2, one `tiny-text` warning, detector location line 0. Evidence is retained in `detector.json`; source corroboration and initial measurements are in `assessment-b.md`. It was not rerun to manufacture a clean result.
- Assessment B used a separate browser tab and read-only DOM measurements. No body horizontal overflow was found. A/B Board height exceeded the compact scroll area; this is intentional scrolling, not hidden content. C's grouped sidebar also scrolls.
- Browser evaluate is read-only, so mutable injection/title preflight and the detector overlay were unavailable. Fallback evidence: CLI scan, screenshots, read-only DOM and source inspection. No overlay was claimed; no Impeccable live-server was started, so none required cleanup.
- Target: `docs/prototypes/thread-board/index.html`. No critique ignore file was applied. Review artifacts remain together in the throwaway directory; the downloaded scratch skeleton source was removed. The optional prototype HTTP server may be kept for the human preview; it has no production or external bindings.
- Human question is handled by the wayfinder parent: choose A/B/C or a mix. This review does not resolve the ticket or change GLOSSARY/ADRs. The map destination is a later layout spec; implementation remains out of scope.
