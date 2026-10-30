# Header placement review

Method: independent design assessment A (`header_design_review`) and browser/detector assessment B (`header_browser_evidence`), followed by parent synthesis and narrow verification of corrections. This is an Operate surface and a human decision prototype. **Initial recommendation: C. Subsequent human choice: B, by itsmrma; see the canonical resolution on [the decision ticket](https://github.com/cavallinilorenzo/oxide/issues/277).** The assessments below preserve the evidence available before that choice.

The supplied brief and previously chosen skeleton define the visual world. Dark surfaces, density and existing icon vocabulary are held constant. PRODUCT/GLOSSARY still contain legacy Work mode wording; updating those belongs to the map’s final handoff, not this placement prototype.

## Recommendation and tradeoffs

C gives Git one stable home in Diff and places review beside its actions. Keep Project navigation, needs-input across open Projects, and region handles global. Keep Thread title/status and checkout identity with the Thread. Diff owns branch/details, counters and Commit & Push. Its tab shows changed-file count. Board remains per Project in the sidebar, with no implicit Git target while its overview is open.

A offers immediate Git access everywhere, at the cost of reconciling a global-looking action with a selected-Thread checkout, especially when a visible Terminal belongs to another checkout. B makes that ownership clearer and stays fast beside the conversation, but consumes Thread height and requires restoring Thread from a maximized Surface. C asks for one Diff-tab action from another Surface and uses more vertical room above the hunk. The preferred choice depends on that tradeoff; the evidence does not establish user preference.

The existing production `GitHeader.tsx` already opens Diff for its dirty Commit & Push action. A/B should not be read as a claim that production commits without review. Branch switching and commit/staging policy are outside the question; details and simulated all-checkout commit are fixtures.

## Eight principles

| Principle | A · Global checkout | B · Thread checkout | C · Git in Diff |
| --- | --- | --- | --- |
| Ambient Thread status | Pass: all-Project needs-input remains visible | Pass | Pass, including maximized Surface |
| Signal, do not seize | Background Approval retains shell focus and selected Thread | Same | Same |
| Keep working set | Tested drafts/shell/tool input retained | Same | Same; complete editor state not exhaustively tested |
| One stable home | One position, but global appearance hides target dependency | Clear Thread home; unavailable when maximized | Strongest: Diff owns review/action; count on tab aids discovery |
| Co-used things together | Review and initiation in different regions | Same, plus restore detour from maximized Diff | Strongest after correction: counters open explicit all-uncommitted review |
| Inputs announce purpose | Provider/shell labels and checkout cues | Same | Same |
| Navigation versus pane toggles | Mixes Project navigation, checkout and Git actions | Clear separation | Clear separation |
| 900×560 disclosure | Branch truncates first; busiest header | Toolbar wraps, consuming Transcript space | Lean header; extra Diff height cost |

Research basis: [UX principles](https://github.com/cavallinilorenzo/oxide/issues/269), [agentic app patterns](https://github.com/cavallinilorenzo/oxide/issues/268), [chosen skeleton](https://github.com/cavallinilorenzo/oxide/issues/271), [Project terminal ownership](https://github.com/cavallinilorenzo/oxide/issues/272), and [Board placement](https://github.com/cavallinilorenzo/oxide/issues/276). These are qualitative design judgments; no user test was performed.

## Design assessment

Independent A scored A **23/40**, B **26/40**, C **28/40** on Nielsen’s ten heuristics. The detailed per-heuristic scores and persona findings live in `assessment-a.md`. They reflect this limited fixture, not production certification. C’s Project → Thread → checkout relationships fit Oxide specifically; its repeated path/scope copy still crowds the review at the minimum size. Five Surface choices plus maximize remain a dense decision group, inherited from the chosen skeleton.

Strong points: ambient attention does not interrupt input; Approval navigation exposes the exact command and checkout; C separates a pinned terminal from the selected Thread’s Git target. Priority refinements remaining for discussion: C’s metadata density; B’s restore-to-commit detour; A’s target ambiguity; the needs-input chip’s first-pending selection among several Threads. A secondary queue menu is an idea for later specification, not a silently added decision here.

## Corrections and verification

Independent assessments found three concrete fixture problems. They were corrected before capture:

- Git counters originally reopened a narrow illustrative Branch Diff. They now open **Uncommitted Diff · 3 files** with three explicit illustrative diffs, a return to Branch/Turn Diff, and the same file list in the commit dialog. Both evidence assessment B and parent verified this route.
- Rebuilding the stage lost keyboard focus after Surface navigation. Render now restores the activated control or a destination heading. Parent browser check verified Terminal activation retains Terminal-tab focus.
- The native dialog originally exceeded the simulated 900px window. Dialogs now center within, and constrain their dimensions to, the rendered stage. Parent measured commit dialog **868×361**, fully inside the **900×560** stage, and captured `C-commit-900x560.jpg`.

Git simulation state is keyed by checkout path, so main-checkout Threads share the same counters. No real Git action occurs. The detector ran once before the scoped review/focus/dialog corrections; `detector.json` retains the original evidence. It reported **one `tiny-text` warning**, line 0, corresponding to inherited 10–11px metadata; it does not establish contrast or full accessibility. Metadata styling is outside this structural decision and was retained. Browser evaluation is read-only, so no detector overlay was injected; source scan plus AX/geometry/screenshots are the evidence.

Parent captured all alternatives at exact **900×560 and 1440×900** browser/stage dimensions with lab controls hidden. Assessments used the fixture’s stage selector in a default browser; their 1440 stage was scaled, as their reports disclose. Parent additionally inspected compact C, compact B, long-branch A, all-uncommitted review and the corrected commit dialog. Inline JavaScript syntax parsing and Git whitespace check pass. No production code changed; production CI was not run for a standalone throwaway HTML fixture.

## Remaining limits and run notes

- Long branch stress uses the same illustrative long name for Board Threads; it proves truncation, not same-prefix branch disambiguation. Worktree paths still distinguish targets.
- Project switching selects that Project’s first Thread. Per-Project terminal input values are preserved; complete Project navigation history is not modelled.
- Commit fixture assumes all uncommitted files; branch details are read-only; no branch picker or staging semantics are resolved.
- Assessment evidence retains pre-correction findings as primary observations; this synthesis identifies what was fixed and how it was rechecked.
- Target: `docs/prototypes/global-header/index.html`. No prior critique ignore file was used. This review is retained beside the prototype rather than as a production design audit/trend snapshot.
- Assessment tabs closed; no overlay server or temporary injection existed. Parent’s preview server on loopback port 8277 remains for human reaction; Ctrl+C in its process stops it. The standalone file remains usable without the server. No temporary files entered the prototype branch. Browser viewport override was reset after exact-size captures.

The human reaction selected B; the linked decision ticket holds the resolution and rationale. No GLOSSARY term changes for this placement. The final layout ADR/spec remain the map’s handoff.
