# Assessment A — independent design review

Method: design review only, isolated from detector evidence. Operate surface. This is a recommendation for the human prototype decision, not a final choice or production acceptance.

Brief substitution: used the supplied scope and settled skeleton rather than interviewing the user from this subagent. Palette and typography were excluded. No detector was run or read. No implementation, issue or PR was changed.

## Recommendation

Prefer **C, Git in Diff**. Its global header reads as Project navigation plus ambient attention; the checkout action lives beside its relevant inspection surface. The Diff tab's file count provides a credible discovery cue from Terminal. **B** is a reasonable speed-first alternative, but its Git home disappears when a Surface is maximized and its wrapping toolbar consumes scarce Transcript height. **A** makes Git quickest to reach but gives a global-looking action a selected-Thread target, which is especially risky beside a maximized Terminal whose checkout is independent. The initial all-uncommitted review gap was corrected during this review and independently rechecked below.

Specificity: the composition is grounded in Oxide's actual Project → Thread → checkout relationships. Provider prompt versus Project Terminal and Board Thread worktrees are meaningfully distinguished. It does not need another navigation layer.

## Nielsen scores

Scores concern this prototype's control placement, target clarity, ambient status and discoverability. They do not certify backend recovery, full keyboard accessibility or Git correctness. All ten apply; help/error scores reflect the limited visible prototype evidence.

| Heuristic (0–4, higher is better) | A | B | C | Reason |
|---|---:|---:|---:|---|
| Visibility of system status | 3 | 3 | 3 | Global needs-input survives maximization; selected Thread and checkout remain identified. Count does not explain priority. |
| Match with user's world | 2 | 3 | 3 | A visually implies Project/global ownership for a Thread-following checkout. |
| User control and freedom | 3 | 3 | 3 | Restore, dock toggle, Board return and dialog Cancel are present. |
| Consistency and standards | 2 | 3 | 3 | B/C preserve clearer ownership boundaries between header, Thread and Surface. |
| Error prevention | 2 | 3 | 3 | Exact checkout and all-file scope are repeated before Commit & Push; A still invites wrong-target initiation. |
| Recognition rather than recall | 2 | 2 | 3 | B needs a restore path for Git; C exposes Diff's file count, though icon-only Board requires learning. |
| Flexibility and efficiency | 3 | 2 | 3 | A is immediate; B adds restore steps; C is one Diff-tab action from a maximized Surface. |
| Aesthetic/minimalist hierarchy | 2 | 3 | 3 | A mixes navigation/action scopes; C's repeated checkout metadata still uses excessive vertical space. |
| Recognize/recover from errors | 2 | 2 | 2 | Error and interrupted states are named; complete retry/recovery is outside the tested flow. |
| Help and documentation | 2 | 2 | 2 | Purposeful tooltips, labels and scope explanation; no complete contextual help flow demonstrated. |
| **Total /40** | **23** | **26** | **28** | A/B acceptable; C good within this narrow prototype scope. |

## Eight-principle judgment

| Principle | Judgment |
|---|---|
| 1. Ambient status | All pass the key requirement: the header needs-input chip remains visible with maximized Terminal and a long branch. |
| 2. Signal, do not seize | Pass in the tested background-Approval flow: count changed 3→4, shell text and focus stayed in the Terminal input, selected Thread did not change. |
| 3. Keep the working set | Pass for tested shell text through variant changes, Thread switching, maximization and Project round trip. Broader persistence was not exhaustively tested. |
| 4. One stable home | C strongest: Diff owns Git, including when maximized. B owns Git in Thread but must introduce a restore banner. A has one physical home with a less predictable semantic target. |
| 5. Put co-used controls together | C strongest: a corrected count control now opens all three uncommitted file diffs and the commit dialog repeats the same filenames. B/A separate the action from the review. |
| 6. Input announces purpose | Pass: Provider prompt and Shell command labels identify distinct destinations; Terminal's retained checkout is stated. |
| 7. Separate navigation and pane toggles | B/C pass: Project/attention global, Thread identity central, Surface controls on dock. A weakens this division. Board beside each Project remains sensible. |
| 8. Progressive disclosure at 900×560 | C best tradeoff, with a vertical-space cost in Diff. B wraps long checkout above actions, reducing Transcript room. A preserves action visibility by truncating the target, making target recognition weaker. Sidebar/dock exclusivity is understandable. |

## Priority defects and next refinements

1. **P1 — A: global action can target a different checkout from the dominant Surface.** After selecting Slash command catalog, Terminal still shows conpty-resize; maximize it and header Commit & Push still belongs to slash-catalog. Long-branch truncation removes the distinguishing suffix. The confirmation dialog limits the hazard, but does not repair the misleading initiation context. Favor the scoped location; if A is retained, visibly name the selected Thread checkout at the action and stress-test the mismatch.
2. **P2 — C: repeated checkout identification crowds out actual review at 900×560.** Scope line, branch button, “Selected Thread checkout” path and commit explanation occupy roughly the first 200px of Diff; long branches wrap the scope line and push the hunk farther down. Consolidate the identity into one persistent row with a full-details disclosure; retain a concise explicit “all uncommitted files” scope.
3. **P2 — B: Git requires restoring Thread even when Diff is maximized.** The explicit “Restore Thread for Git actions” banner makes the detour discoverable, but costs another action and breaks the natural review→commit sequence. The long checkout also makes the compact Thread toolbar two rows, squeezing the Approval/Transcript area.
4. **P2 — Shared discoverability: needs-input count does not convey destination or queue order.** One click successfully opens an Approval and focuses Allow once, even from another Project's maximized Terminal. With multiple pending Threads it chooses the first pending Approval and repeated clicking can revisit that same item; the visible chip does not say which Project/Thread will open. Keep the one-click route, but clarify its next destination and offer a secondary way to inspect the queue. Error/interrupted inclusion should remain understandable without first opening Board.

Resolved during review: the initial 3-files control reopened the same Branch Diff. After the parent's narrow correction, reloading C and clicking it produced “Uncommitted Diff · 3 files,” explicit diffs for `crates/oxide-pty/src/resize.rs`, `crates/oxide-pty/tests/resize.rs` and `docs/terminal.md`, plus Back to Branch Diff. Commit & Push repeated these same three filenames and the exact checkout. This resolves the scope-review gap at prototype fidelity; no staging policy or real Git behavior was assessed.

## Cognitive load, journey and personas

C has low-to-moderate load: grouping, hierarchy, single focus, one-decision-at-a-time, working-memory support and progressive disclosure pass. Minimal choices/chunking are the weak points: five sibling Surface tabs plus maximize form one decision group, and repeated scope facts compete above the Diff. B adds a stronger attention split between Thread Git actions and Surface review; A adds target reconciliation between header and retained Terminal checkout. The sidebar's seven Thread choices are navigation, with Project grouping and selected state, rather than seven competing primary actions.

Strongest moments: global attention remains available without interrupting typing; Approval jump immediately exposes the command, checkout and response buttons; C keeps commit beside inspection and declares its wider all-file scope. Its corrected all-file review resolves the initial uncertainty between “what I just inspected” and “what this commit includes.” A still requires target reconciliation when a different-checkout Terminal is dominant. The exact-checkout confirmation is reassuring but should confirm an already clear target.

- **Alex, power user:** C's one-click Diff route is acceptable; B's restore-to-commit detour interrupts a maximized review flow. A's convenience carries target-verification overhead.
- **Jordan, first-timer:** Board and layout toggles are icon-only, and the count chip's jump behavior is not explicit on its face. Tooltip labels help; the Diff count is a better visible cue than an absent Thread toolbar.
- **Riley, stress tester:** long branch truncation preserves urgent controls, but identical long-branch fixture values across Board Threads prevent a realistic same-prefix branch disambiguation test. Use two distinct long names in a later validation fixture.

Minor observations: the maximized status-only Thread rail has accessible names but requires hover/recall to distinguish multiple needs-input Threads. Board's per-Project placement and selected appearance are consistent; hiding it behind the sidebar at compact size is an accepted skeleton tradeoff, not a reason to put it back in the header.

## Run notes

- Target: `docs/prototypes/global-header/index.html`, served at `http://127.0.0.1:8277/`.
- Read Impeccable SKILL/critique reference and ran context once in the prototype worktree; read PRODUCT and GLOSSARY. Context reported legacy PRODUCT schema/platform metadata; left it unchanged.
- Created a dedicated background IAB tab, independent of other assessment tabs. Visually inspected A/B/C at fixture sizes 900×560 and 1440×900, including long branch. The 1440×900 stage was scaled by the prototype to fit the default 1280×720 browser viewport; layout dimensions were the requested fixture dimensions, not a native 1440px screenshot. No browser viewport override was applied.
- At 900×560, tested the header chip from maximized Terminal in A/B/C; each restored the selected Approval in one action and focused Allow once. At 1440×900, additionally verified a B jump from compiler's maximized Terminal into an oxide Approval, updating the selected Project.
- Tested background Approval while Terminal input contained `cargo check`: count updated, input/focus and selected Thread were retained. Tested C Board entry/return, Diff count click and Commit & Push's scope dialog; did not simulate the commit. Reloaded for the parent's narrow all-uncommitted review correction and verified the three explicit file diffs and matching commit file list. Shared-checkout state keying was reported by parent but not separately exercised here.
- No detector command, detector output, source changes, issue mutation or final design decision. Parent owns synthesis and user-facing decision questions. No critique server was started by this assessment.

Questions for synthesis: Is the primary optimization safer review-to-commit ownership (C) or immediate commit access beside conversation (B)? Should the needs-input chip expose the next destination, or add a secondary queue menu while retaining its direct jump?
