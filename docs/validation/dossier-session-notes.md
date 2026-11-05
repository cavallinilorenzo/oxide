# Dossier session notes - engineer <n>

Copy this file per session. Keep one file per participant and pull request. Do not add Transcript
text, prompts, issue bodies or command output.

## Session

- Date:
- Participant: `Engineer A` (anonymized)
- Oxide build / commit:
- Repository and pull request: `<owner>/<repo>#<n>`
- Thread and branch:
- Provider / Model:
- Permission mode:
- Dossier scope used: `Branch` / `Turn` / `PR` (record every change)
- Observer:
- Started / ended (local time):
- Decision reached: `merge` / `request changes` / `keep reviewing` / `stop`
- Time to decision:

## Build readiness (check before starting)

- [ ] The pull request's branch has an Oxide Thread with completed Turns.
- [ ] A Verification command is recorded in the Dossier (not only "No Verification command has
      run").
- [ ] The Project's Verification commands and sensitive paths are set.
- [ ] The pull request appears in the Branch scope.
- [ ] The Review ledger is readable for this Project.

If any box is unchecked, record it as a blocker and do not start the session.

## Observation log

One row per event. Use verbatim quotes when they matter.

| Time | Event | What happened / quote | Section involved |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |

Event kinds, to keep the log consistent:

- `notice` - looked at or read a Dossier section.
- `engage` - deliberately used it: clicked a signal file, expanded prompts, cited a state.
- `hand-check` - verified something themselves (ran tests, read CI, read the diff, asked the author).
- `leave` - left Oxide (browser, external terminal, editor, chat) and why.
- `change` - changed a check, its order, or the decision because of the Dossier.
- `confusion` - did not understand a state, label, or scope; record the question verbatim.
- `blocker` - bug or missing prerequisite; record what was done.

## Gate fields

- **Unprompted engagement**: `yes` / `noticed only` / `no`
  - First evidence, before any observer mention:
- **Noticed the section**: `yes` / `no`
  - Did they ask what it was? Quote:
- **Changed what they checked**: `yes` / `no` / `unclear`
  - What changed (specific check, skip, reordering or decision):
- **Still checked by hand** (list every check, whether the Dossier already stated it, and why they
  still did it):
  - 
- **Left Oxide before the decision**: `yes` / `no`
  - Visits and reasons:

## Sections used

Mark how each was used, not whether it was liked.

| Section | Not used | Read | Used in a decision | Quote or note |
| --- | --- | --- | --- | --- |
| Intent (issue and prompts) |  |  |  |  |
| Verification commands and states |  |  |  |  |
| Risk signals |  |  |  |  |
| Branch evidence (uncovered commits, PR checks) |  |  |  |  |
| Supervision (Approvals, Permission modes) |  |  |  |  |
| Agent claim |  |  |  |  |

## Post-session questions

Record answers verbatim where possible.

1. Walk me through what you looked at to decide.
   - 
2. Was there anything you checked that you did not trust, or still wanted to verify yourself?
   - 
3. Was there anything in Oxide that changed what you looked at?
   - 
4. What would you have done without Oxide?
   - 
5. Was there anything you expected to find and did not?
   - 
6. (Last) What did you think of the Dossier section?
   - 

## Observer summary

- One paragraph on what happened, without interpretation beyond the gate fields.
- Bugs or blockers, with the build/commit and a reproduction if available.
- Candidate changes for a `change` decision, if any.
- Anything that made the observation unreliable (observer intervened, build changed, session cut
  short).
