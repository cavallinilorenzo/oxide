# Review ledger tally - two-week baseline

Copy this file for the window. One row per eligible merge: a pull request opened from an Oxide
Thread's branch and merged during the window. Do not copy Transcript text, prompts, issue bodies or
command output.

## Window

- Start / end dates:
- Oxide build / commit:
- Maintainer(s):
- Projects included:
- Work merged without an Oxide Thread (out of scope, for context only):

## Window start snapshot

The ledger has no date filter: its median and count cover the Project's whole history, and the list
shows only the 20 most recent entries. Record these before the window starts.

| Project | Ledger count | Median | Newest entry (PR / merged) | Oldest visible entry (PR / merged) |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Eligible merges

`Left Oxide` means the maintainer left the Oxide window before the merge decision for information
the Dossier should have covered (GitHub in a browser, CI logs, an external terminal running checks,
another editor). Do not count unrelated absences.

| Pull request | Thread | Provider / Model | Turn completed (local) | Merged (local) | Wait | Merged in | Left Oxide? | Visits | Reasons | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  | Oxide / GitHub / other | yes / no |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |

## Ledger figures at the end of the window

Copy the numbers from the Project overview. There is no export.

- Projects read:
- End `count`:
- Start `count` (from the window start snapshot):
- In-window recorded merges (end minus start):
- Median wait computed from the in-window rows in the eligible merges table:
- The overview's all-history median (do not use it as the window median):
- Eligible merges missing from the ledger, and why (no Oxide Thread, no completed Turn at or
  before the merge, not refreshed after an external or auto merge, other):
- Review-round groups:

| Provider | Model | Languages | Size band | Issue labels | Sample size |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

- Reverts:
- Candidate follow-up fixes (and whether each was confirmed or dismissed):
- Did anyone clear the ledger during the window? If so, what was lost:

## Leaving Oxide

Summarize the per-row tally.

- Eligible merges:
- Merges with at least one visit outside Oxide before the decision:
- Total visits:
- Reasons, grouped:
  - GitHub pull request page or review threads:
  - CI logs or checks:
  - Running tests or checks outside Oxide:
  - Reading code in another editor:
  - Other:

## Reliability notes

- Was the Board opened (or Oxide restarted) after every external merge, so the merge was recorded?
- Which Pull requests had no Dossier, and why?
- Did any Provider report no command outcome, making evidence `Unknown`?
- Any build change during the window? If so, dates and commits.

## What this supports

- The wait figures and the leaving-Oxide tally are the baseline for the Dossier validation. They do
  not prove the Dossier works; they say how expensive the current path is and whether it is
  measurable.
- Keep this file with the session notes. The decision comment on [#336] and [#320] summarizes it;
  it does not replace it.

[#336]: https://github.com/getoxide/oxide/issues/336
[#320]: https://github.com/getoxide/oxide/issues/320
