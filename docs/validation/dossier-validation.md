# Validation kit: the Verification Dossier with senior engineers

Status: **ready for the maintainers to run**. This document is the protocol and the decision
record for [#336]; it is not evidence by itself. The observations and the ledger figures the
maintainers collect are the evidence.

- Parent spec: [#320].
- Priority ADR: [ADR-0010](../adr/0010-prioritize-the-path-to-a-confident-merge.md).
- Blocked until the decision: [#337] and [#338] (Blind review), [#339] and [#340] (Dossier in the
  pull request).
- Templates: [session notes](dossier-session-notes.md), [two-week ledger tally](review-ledger-tally.md).

## What is being tested

The hypothesis, from ADR-0010 and the parent spec: a senior engineer deciding what enters `main`
opens the Dossier unprompted, and it changes what they check before merging.

The validation answers two questions, and keeps them apart:

1. **Does it get used?** In 5-8 sessions on real pull requests, does the engineer deliberately
   engage with the Dossier before the observer mentions it?
2. **Does it change the decision work?** Does the engineer check something else, skip a check they
   would have done, or reach a different merge decision because of it?

The two-week Review ledger adds the maintainers' own baseline: how long finished work waited for
its merge, and how often the maintainers left Oxide to reach a merge decision.

A negative result is a valid result. The gate exists so a wrong bet is found while it is cheap.

## What the current build does and does not do

Audited on commit `1f95553` (2026-11-04) against the closed Dossier tickets [#332]-[#335] and the
Review ledger ticket [#322]. Read this before inviting anyone: several limits decide which pull
requests can be used at all.

### Where the Dossier lives

- It is a section at the top of the Diff Surface, above the changed files. It is not a separate
  Surface and has no collapse of its own (ADR-0009). In Branch scope it also shows the branch
  evidence.
- It requires an **Oxide Thread** that produced the change. A pull request from someone else, or
  one opened outside Oxide without a Thread on its branch, has no Dossier. Only use pull requests
  whose branch has an Oxide Thread with at least one completed Turn.
- A Board Thread opens the Diff Surface on Branch scope; a chat Thread opens on Turn scope. The
  user can switch scopes. Branch scope is the one that matches a pull request about to merge.

### What the Dossier shows

- **Verification commands** the Provider reported, with a state: `Fresh`, `Stale`, `Failed`,
  `Never run` or `Unknown`. Freshness compares the command's most recent success with the latest
  known change, including human edits. A change the Transcript cannot attribute to a FileChange
  Item makes freshness `Unknown`, not `Fresh`.
- **Risk signals**, separate and self-explaining, never combined into a score: a changed language
  with no Verification command, source without a test change, a sensitive path (CI, dependency
  manifests, migrations, plus the Project's globs), and a diff over the shown threshold.
- **Intent**: the stored issue and the Thread's prompts, verbatim. The agent's closing message is
  labelled **Agent claim**, apart from the computed facts.
- **Branch evidence**: commits on the branch that no Turn produced, the pull request's checks,
  Approvals granted or denied, and the Permission modes the Turns started in.
- The Project's own Verification commands and sensitive paths are edited from the two collapsed
  sections at the bottom of the Dossier. They are stored in Oxide's local database, not in the
  repository.

### What it does not see

- Commands run in Oxide's terminal, or outside Oxide, are not evidence. Only commands a Provider
  reports in its event stream count. A shell command the agent ran through a Provider that does
  not report structured command data stays invisible.
- A Provider that reports no outcome yields `Unknown`; Oxide never invents a pass or a failure.
- The Dossier is computed on demand and not persisted. Deleting the Thread deletes its Transcript
  and therefore its Dossier.
- The Dossier is not published to GitHub. That is [#339], blocked on this decision.

### Review ledger facts the maintainers need

- The ledger lives in the Project overview, under **Time to merge**, **Reverts and follow-up
  fixes** and **Review rounds**. It is local only, sends nothing, and **Clear ledger…** removes it
  for every Project.
- A merge is recorded when it is made from Oxide, and when Oxide refreshes a Board Thread's pull
  request: at app start for every open Project, or when the Project's Board is opened. **A merge
  made in the browser while Oxide stays open is not recorded until the Board is opened again or
  Oxide restarts.** Open the Board after any external merge, or the two-week figures will silently
  undercount.
- Only pull requests whose branch has an Oxide Thread are tracked.
- A **review round** is one send of Line comments or selected reviewer comments to a Thread. It is
  not every comment read, and it is not recorded for reviews done in the browser.
- The app does **not** record when someone leaves Oxide. That has to be observed and tallied by
  hand in the [two-week tally](review-ledger-tally.md).
- The ledger has no export. Copy the numbers or take a screenshot at the end of the window.

### Measurement caveat: "opened unprompted"

The Dossier is always visible in the Diff Surface, so "opened it" cannot mean clicking a closed
panel. For this validation, define it before the first session as:

> **Unprompted engagement**: before the observer says "Dossier", points at the section or explains
> a badge, the participant deliberately reads or uses the evidence: reads a command state aloud,
> clicks a file from a risk signal, expands the prompts, or cites a check or signal in their merge
> decision. Scrolling past the section without engaging does not count.

Record separately whether they *noticed* the section, asked what it was, or used it. A participant
who asks "what is this?" noticed it unprompted; record that, but do not count the explanation as
evidence that the section was understood.

## Part A - two weeks of maintainer baseline

Run this first, so the sessions happen on a build and a workflow the maintainers already know.

1. **Choose the window.** Two consecutive weeks of normal work. Record the start and end dates and
   the Oxide commit used.
2. **Decide eligibility before starting.** An eligible pull request is one opened from an Oxide
   Thread's branch and merged during the window. Work merged without an Oxide Thread is out of
   scope; note how much of the week's work that was, so the sample is not mistaken for all merges.
3. **Merge from Oxide where possible.** Otherwise open the Project's Board before reading the
   ledger, so the external merge is recorded.
4. **Tally leaving Oxide per eligible pull request.** Before the merge decision, did the maintainer
   leave the Oxide window to get information the Dossier should have covered? Count GitHub in a
   browser, CI logs, an external terminal running checks, or another editor. Do not count unrelated
   absences (chat, mail). Record the number of visits and the reason. Use the
   [tally template](review-ledger-tally.md).
5. **Read the ledger at the end.** Record the median wait, the number of merges, the review-round
   groups with their sample sizes, and any reverts or follow-up candidates. Also record how many
   eligible merges are missing from the ledger and why.
6. **Keep the raw numbers with the notes.** The ledger is local; once cleared it is gone. Clearing
   is the user's choice, not a step in this protocol.

Guidance, not an acceptance threshold: a median over fewer than about ten merges is weak evidence.
If the window yields fewer, extend it or say so in the decision.

## Part B - 5-8 senior engineer sessions

### Participants

- 5-8 senior engineers who own merges and already use coding agents. A mix of Oxide users and
  people who have never used Oxide is more informative than Oxide enthusiasts only.
- Each session uses a real pull request the participant would actually review. Prefer one from
  their own work; where they do not use Oxide yet, use a real maintainer pull request in their
  area. Either way its branch must have an Oxide Thread. Do not use a fixture, a toy repository or
  a pull request whose Dossier you have already explained to them.
- Get consent to take notes and to quote anonymized observations in the issue.

### Before the session

- Install the same build on the participant's machine (or pair on the maintainer's machine with
  the participant driving).
- Add the repository as a Project, set its Verification commands and sensitive paths, and make
  sure the pull request's branch has an Oxide Thread with completed Turns and a recorded
  Verification command. Check that the ledger is readable for that Project.
- Do not mention the Dossier, the risk signals, the ledger or this document in the invitation or
  the brief.

### Session script

Keep it neutral. The point is what they do, not what they say they like.

1. "This is a real pull request, and you are its reviewer. Review it in Oxide the way you normally
   would, and decide whether you would merge it. Please think aloud. There are no wrong answers, and
   you can stop at any time."
2. Start the observation log. Do not point at the Dossier. Do not explain a badge unless the
   participant is blocked; if they ask, answer with a neutral question such as "What do you make of
   it?" and record the question verbatim.
3. Record every time they:
   - notice or deliberately use a Dossier section (commands, signals, intent, branch evidence,
     agent claim);
   - check something by hand (run tests, read CI, read the diff, ask the author, inspect a file);
   - leave Oxide (browser, external terminal, editor, chat) and why;
   - change what they check or how they decide after using the Dossier;
   - express confusion or distrust.
4. If a bug blocks them for more than five minutes, help, and record it as a blocker. Do not let a
   bug consume the session, but do not hide it either.
5. Stop when they state a merge decision, or at 45 minutes, whichever comes first.

### After the decision

Ask open questions, in this order, and record the answers verbatim where possible:

1. "Walk me through what you looked at to decide."
2. "Was there anything you checked that you did not trust, or still wanted to verify yourself?"
3. "Was there anything in Oxide that changed what you looked at?"
4. "What would you have done without Oxide?"
5. "Was there anything you expected to find and did not?"

Do not ask "did you like the Dossier?" until the end, and record that answer separately from the
observed behaviour.

### Coding the session

Use the [session notes template](dossier-session-notes.md). The two fields that decide the gate
are:

- **Unprompted engagement**: yes / noticed only / no, with the first evidence.
- **Changed what they checked**: yes / no / unclear, with the specific check, skip or decision.

Everything else is context for the decision, not a score.

## Part C - analysis and decision

### Agree the thresholds before the first session

Write the thresholds into the decision comment draft before collecting data. A threshold moved
after seeing the results is a finding about the process, not a pass. Starting proposal, derived
from the acceptance criteria in [#336]:

| Decision | When |
| --- | --- |
| **Continue** | At least two weeks of ledger data with about ten eligible merges; at least 5 of 8 sessions show unprompted engagement; at least 3 of those show a check, skip or decision that changed; no recurring confusion that makes the evidence misleading. |
| **Change** | Some unprompted engagement, but the Continue bar is not met: fewer than 5 of 8 engage unprompted, or fewer than 3 change a check. Also when one recurring blocking confusion explains the result, or only one section is used and the rest is noise. Narrow the feature, fix the confusion, and re-run a smaller session set. |
| **Stop** | Fewer than half the sessions engage with it unprompted, or at most one session changes a check because of it, or participants still leave Oxide for the same checks the Dossier claims to replace. |

Apply the rows in order: any Stop condition wins, then any Change condition, then Continue. This
keeps a weak result from being rounded up.

The parent spec's own rule is stricter than a score: if senior engineers do not open the Dossier
unprompted, **or** it does not change what they check, the direction must be revisited. Treat
"continue" as requiring both halves.

### Write the decision

Post the same comment on [#336] and the parent spec [#320]. Use this shape:

```markdown
## Dossier validation - decision: continue | change | stop

**Window and build.** Two weeks from YYYY-MM-DD to YYYY-MM-DD on commit `<sha>`. Ledger: <n> eligible
merges, median wait <duration>, <n> review-round groups. Missing merges: <n>, reason: <...>.

**Leaving Oxide.** <n> of <n> eligible merges involved leaving Oxide before the decision. Reasons:
<...>.

**Sessions.** <n> senior engineers on <n> real pull requests. Unprompted engagement: <n>. Changed
what they checked: <n>. Still checked by hand: <list>. Recurring confusion: <list>.

**What the Dossier replaced.** <checks or steps engineers skipped because the Dossier already
answered them>

**What it did not replace.** <checks engineers still did by hand, and why>

**Decision.** <continue | change | stop>, because <one paragraph tied to the thresholds above>.

**If change or stop.** Blocked tickets updated: <#337, #338, #339, #340 and what happened to each>.

**Evidence.** Session notes: <link or attachment>. Ledger tally: <link or attachment>.
```

If the decision is **change** or **stop**, update or close the blocked tickets before closing
[#336]:

- [#337] and [#338]: Blind review.
- [#339] and [#340]: publishing the Dossier in the pull request.

Only then close [#336]; the issue's own acceptance criteria require it. If the decision is
**continue**, say explicitly that [#337]-[#340] are unblocked, and record it on the parent spec.

## How this maps to #336

| Acceptance criterion | Where it is satisfied |
| --- | --- |
| Two weeks of Review ledger data and how often the maintainers left Oxide | Part A and the [tally template](review-ledger-tally.md) |
| 5-8 senior engineers use the Dossier on a real pull request, without being asked to open it | Part B, with the operational definition of unprompted engagement above |
| Per session: opened unprompted, what they still checked by hand, whether it changed what they checked | Gate fields in the [session notes template](dossier-session-notes.md) |
| Findings and a decision posted on #336 and the parent spec | Part C decision comment, posted on both issues |
| If change or stop, blocked tickets updated or closed first | Part C end, with the exact ticket list |

## Privacy

- Record only what the protocol asks for: session observations, PR numbers, ledger numbers and
  counts. Do not copy Transcript text, prompts, issue bodies or command output into the notes.
- The Review ledger itself holds identifiers and numbers, never Transcript text. Keep it that way
  when transcribing it.
- Anonymize participants in anything posted publicly (`Engineer A`, not a name or handle) unless
  they agree to be named.
- Do not publish repository contents, customer names or secrets seen during a session.
- Deleting the ledger is a local user action; do not delete it just because a session ended.

[#322]: https://github.com/getoxide/oxide/issues/322
[#332]: https://github.com/getoxide/oxide/issues/332
[#333]: https://github.com/getoxide/oxide/issues/333
[#334]: https://github.com/getoxide/oxide/issues/334
[#335]: https://github.com/getoxide/oxide/issues/335
[#336]: https://github.com/getoxide/oxide/issues/336
[#337]: https://github.com/getoxide/oxide/issues/337
[#338]: https://github.com/getoxide/oxide/issues/338
[#339]: https://github.com/getoxide/oxide/issues/339
[#340]: https://github.com/getoxide/oxide/issues/340
[#320]: https://github.com/getoxide/oxide/issues/320
