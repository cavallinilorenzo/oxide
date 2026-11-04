# Oxide

A desktop app for agentic engineering: you open a Project and drive coding agents from a chat, switching between the agent CLIs already installed on your machine, with Git and GitHub at hand.

## Language

## Projects

**Project**:
A folder on the user's machine holding a Git repository, usually linked to a GitHub repository. The unit everything else belongs to.
_Avoid_: Workspace, repo (when meaning the Oxide concept)

**Open Project**:
A Project the user opened (from the Project palette, by adding or cloning it, or by selecting it), and so listed in the sidebar with its Threads. Repositories found by the scan of the scan roots are known but not open: the Project palette finds them, the sidebar does not list them. Closing a Project takes it out of the sidebar and keeps it known.
_Avoid_: Pinned, recent, favourite Project

**Project palette**:
The overlay opened with ⌘⇧N. It searches Projects (clicking a result or pressing Enter starts a new Thread in the pick, with Settings defaults) and registers new ones: an existing folder, a new folder with `git init`, a clone from a Git URL, or a clone of one of the user's GitHub repositories found through `gh`.
_Avoid_: Project switcher, quick open

## Threads

**Thread**:
One conversation with a single Provider inside a Project, with its own Model, Effort and context (Model and Effort can change between Turns); it maps one-to-one to the Provider's own session. `/clear` and ⌘N start a new Thread in the same Project; the old one stays in the sidebar until the user deletes it. A finished Thread is deleted, not archived: deleting removes its Transcript, Approvals, Attachments and Checkpoints for good, and its worktree with them (its branch stays). The Provider's own session files are left to the Provider. A new chat Thread works in a worktree of its own by default. See ADR-0005 and ADR-0011.
_Avoid_: Agent, session, chat, Archived Thread

**Thread status**:
Where a Thread stands right now: working (a Turn is running), needs input (the Provider is waiting on an approval or answer), completed (the last Turn finished and it's the user's move), error (the Turn failed), or interrupted (the Turn was stopped by the user or by quitting Oxide).
_Avoid_: State, phase

**Continue in new Thread**:
What a Thread offers instead of its composer when resuming its Provider session fails because the session is gone. It creates a new Thread with the same Provider, Model, Effort and permission mode, whose first prompt is prefilled with a recap (user prompts and final agent messages, no tool output, cut to a fixed length). The two Threads link to each other.

**Turn**:
One user prompt in a Thread and everything the Provider does in response, until it completes, is interrupted, or fails.
_Avoid_: Run, exchange, round

**Attachment**:
A file the user puts inside a prompt, at a position in its text, stored under the Oxide home until its Thread is deleted. Shown the same way for every Provider (image preview or extension icon, and file name); how it reaches the agent is up to the Provider adapter: natively where the Provider takes that kind (Claude Code: images, PDFs, text; Codex: images), otherwise as a file path at the same spot in the prompt, always preceded by a `[Attachment: name]` marker. A prompt is a sequence of segments, text or Attachment, and the Transcript records them that way. Up to 10 per prompt, 25 MB each.
_Avoid_: Upload, file input, image (when meaning any Attachment)

**Item**:
One unit of a Turn's output: an agent message, reasoning, a tool call, a file change, a subagent, the output of a Slash command, or the mark of a Restore. Slash command output and the mark of a Restore are their own kinds, never an agent message, and stay out of the Continue in new Thread recap.
_Avoid_: Step, block, event (when meaning the unit)

**Activity**:
The compressed, expandable record of what the Provider did in one Turn: a one-line summary of macro actions with counts ("Explored 4 files · Edited 2 files"), expanding into Phases and then Items. A view of the Turn's Items, not a new kind of Item; the agent's messages stay outside it. While the Turn runs it carries a live status line; a Turn with no tool-like Items has no Activity. A command the Provider reports as failed is marked even while the Activity is collapsed.
_Avoid_: Timeline, log, steps

**Command record**:
What a Provider reported about one command it ran during a Turn: the command line, whether it succeeded, failed or is unknown, and the exit code when reported. Stored on the command's Item and never inferred from the command's output; a Provider that reports nothing leaves the outcome unknown. See **Activity**.
_Avoid_: Command (alone), command evidence, exit status

**Phase**:
A run of consecutive Items of the same macro kind within an Activity: reasoning, explore, edit, run, delegate or other. A tool call's kind is assigned by its Provider adapter when it emits the Item (unmapped tools are other); Items stored without one fall back on their Item kind. The same kind returning later starts a new Phase.
_Avoid_: Stage, group

**Slash command**:
An instruction typed in the composer as `/name` with optional arguments, run by Oxide (`/clear`, `/model`) or by the Thread's Provider instead of being sent as a prompt; a Provider's skills and custom commands are Slash commands too. Each Provider offers its own set, and one it can't run inside Oxide is not offered. A `/word` that names no Slash command is an ordinary prompt. See ADR-0006.
_Avoid_: Command (alone), action, macro

**Transcript**:
Oxide's own record of a Thread's Turns and Items, the only thing a Thread is shown from. It outlives the Provider's session: when that session is gone the Thread stays readable, and can only be continued in a new Thread.
_Avoid_: History, log, session (when meaning the record)

**Checkpoint**:
A snapshot of a Thread's files taken when a Turn starts and when it ends, so the Diff Surface can show what that Turn changed and the Thread's files can be restored to how they were before a Turn. Restoring takes a Checkpoint first, so it can be undone, and does not rewind the Provider's session. See ADR-0011.
_Avoid_: Snapshot, save point

**Setup command**:
An optional per-Project shell command run in every new worktree before its Thread's first Turn, to prepare what Git doesn't carry over (env files, dependencies).
_Avoid_: Init script, bootstrap

**Board Thread**:
A Thread dispatched from the Thread Board. It works in a git worktree of its own at `~/.oxide/worktrees/<project>/<slug>`, on a new `oxide/<slug>` branch cut from the chosen base branch's local commits (uncommitted changes stay behind), and shows a branch icon in the sidebar. A new Thread started from the chat does the same by default, creating its worktree with its first prompt; a Project can opt out, and then its chat Threads work in the main checkout, as do chat Threads that existed before the default. See ADR-0011.
_Avoid_: Background agent, background task

**Thread Board**:
The per-Project view of all its Threads grouped by Thread status into needs input (including error and interrupted), working and completed, from which a Board Thread can be dispatched.
_Avoid_: Agent view, dashboard

## Review

**Line comment**:
A draft on one line of a Diff, with the quoted code, written by the user or by a reviewing Provider. It stays a draft until sent, and is then delivered to a Thread as part of one prompt, or to GitHub as part of a review.
_Avoid_: Inline comment, annotation, note

**Review thread**:
A GitHub discussion on the lines of a pull request's diff: the opening comment, its replies, and the path, line and side they refer to, which GitHub marks resolved or outdated. Shown in the Diff Surface's PR scope. Its own term, not a Thread: a Thread is Oxide's conversation with a Provider.
_Avoid_: Inline comment, comment thread, conversation

**Verification command**:
A command that counts as a check (tests, type checks, lint, build), recognized from built-in patterns plus the Project's own additions. Its state for a change is fresh, stale, failed, never run or unknown.
_Avoid_: Test command, check script

**Verification Dossier**:
The account of a change's intent, evidence and risk signals that Oxide computes, without an LLM, from the Transcript, Checkpoints, Settings and GitHub. It is a section of the Diff Surface, shows separate signals instead of a single score, and keeps the agent's closing message apart as a claim. In Branch scope it covers the whole branch: every Turn, the commits no Turn produced, the pull request's checks, Approvals and Permission modes. Also called the Dossier.
_Avoid_: Report, summary, risk score

**Risk signal**:
One separate fact in the Dossier that says what stayed uncovered and where to look first: a changed language no Verification command covers, source without a test change, a sensitive path, or a diff over the shown line threshold. Each signal explains itself in one sentence and points at the files in the Diff; signals are never combined into a score.
_Avoid_: Risk score, warning, severity

**Sensitive path**:
A changed path the Dossier flags for a reviewer: CI configuration, dependency manifests, migrations, or a glob the Project added. Matched with gitignore-style patterns.
_Avoid_: Dangerous path, protected path

**Uncovered commit**:
A commit on the branch since the base that no Turn of the Thread recorded as produced. The Dossier lists uncovered commits instead of presenting the whole branch as the Thread's work.
_Avoid_: Foreign commit, orphan commit

**Supervision**:
The Dossier section that counts the Approvals granted and denied over a Thread's Turns and the Permission modes those Turns started in. A Turn stored before its mode was recorded counts as unknown.
_Avoid_: Oversight, permissions summary

**Blind review**:
A review of a change by a Provider session that received only the diff and the issue, never the original Thread. Its findings become Line comments the user keeps or dismisses.
_Avoid_: Second opinion, AI review, auto-review

**Review ledger**:
Local figures about completed work that outlive Threads: identifiers, Provider, Model, timestamps and counts, never Transcript text. It is never sent anywhere and the user can clear it. See ADR-0010.
_Avoid_: History, analytics, telemetry

**Review round**:
One send of Line comments, or of selected reviewer comments, to a Thread. The Review ledger counts review rounds by Provider, Model and kind of work (languages touched, diff size band and the issue's labels when present), with the sample size of each group, so small groups are not read as strongly. It stores no comment text.
_Avoid_: Review pass, iteration, cycle

**Reviewer comment**:
One comment of a Review thread, written by a GitHub reviewer rather than by the user. It reaches a Thread only when the user selects its thread and asks for a fix, quoted and marked as external content. It is not a Line comment.
_Avoid_: Review comment, review note

## Providers

**Provider**:
An agent CLI installed and logged in on the user's machine that Oxide drives: Claude Code, Codex, or Antigravity CLI (`agy`).
_Avoid_: Agent, backend, harness

**Model**:
A specific LLM a Provider offers, chosen per conversation (e.g. Opus 5.5).

**Model picker**:
The single overlay where a Thread's Provider, Model and Effort are chosen together, opened with ⌘⇧M or from the composer's Model control. Providers are tabs along the top, that Provider's Models are listed on the left, and the highlighted Model's Effort slider sits on the right: it takes on a colour and more flourish (glow, shimmer, sparkles) as the Effort rises. ↑↓ move through Models, ←→ step the Effort, Tab cycles Providers, Enter applies and Esc closes.

**Favourite Model**:
A Model the user starred in the Model picker (see **Model picker**). Starred with the star on a Model row; ⌘1..9 outside the picker switches the Thread to the nth Favourite, in Provider order.

**Effort**:
The reasoning-depth setting a Provider exposes for a Model (e.g. low, high).
_Avoid_: Thinking level, reasoning mode

**Permission mode**:
How much a Thread's Provider may do without asking: Ask (every file edit and command asks), Auto-edit (file edits inside the Thread's folder go through, everything else asks) or Full access (nothing asks). Chosen per Thread, changeable between Turns; a mode a Provider can't honour is not offered for it.
_Avoid_: Sandbox, approval policy, trust level

**Approval**:
A Provider's request, during a Turn, for the user to allow or deny one action (a command, a file change, a tool call). A pending Approval puts the Thread in needs input and waits until answered or the Turn ends.
_Avoid_: Permission prompt, confirmation

**Usage limit**:
A cap the Provider's account puts on how much the user can run over a rolling window, reported by the Provider as a share used and a reset time. Oxide shows two: the 5-hour limit and the weekly limit (all Models); per-Model weekly caps and paid overage are not shown. It belongs to the Provider account, not to a Thread, so every Thread of a Provider shows the same figures. A Provider that reports none (Antigravity) shows none.
_Avoid_: Quota, rate limit (a rate limit is the Provider refusing a request; a Usage limit is the budget behind it), plan usage

## Layout

**Command block**:
One command entered in a Project terminal tab, grouped with its output and exit status. It belongs to a persistent shell session, so its working directory and shell variables carry into the next Command block.
_Avoid_: Turn, Thread, agent message

**Project terminal tab**:
One shell session in a Project's terminal tab strip. It keeps the checkout it was opened in, is flagged when that differs from the selected Thread's checkout, and survives Thread selection and Surface changes. Deleting a Board Thread closes only the tabs of its worktree.

**Surface**:
One of the five tools in the right dock: Diff, Files, Terminal, Pull request or Issues. A Surface can be maximized and restored while keeping its content and working state. The Pull request and Issues lists belong to the Project's repository; only branch actions (opening a pull request, checking one out) act on the selected Thread's checkout and name it. Reviewing a remote pull request records its identity for the Diff Surface and never changes a checkout.
_Avoid_: Tab, pane, widget

**Diff scope**:
What the Diff Surface compares: Uncommitted (staged, unstaged and untracked changes against HEAD), Branch (commits since the merge-base with the base branch) or Turn (the files changed between a Turn's two Checkpoints, for any Turn picked by position and prompt, the latest by default; a Turn of a Thread in a shared checkout may include concurrent changes from other Threads), all computed by Git; or PR, the changed files of a pull request opened for review, as GitHub reports them through `gh`. The default is Turn for Threads in the main checkout and Branch for Threads in a worktree of their own; PR is offered only once a pull request was opened for review.
_Avoid_: Diff mode, diff type

**Revert**:
Taking one file, or one hunk of it, out of the Uncommitted or Turn Diff by applying its patch in reverse to the selected Thread's checkout, leaving the rest of the change untouched. All-or-nothing: a patch that no longer applies cleanly changes nothing and says why. Deleting a file asks first, and it is refused while a Turn is running in that checkout. Not a **Restore**, which rewinds the whole checkout to before a Turn.

**Restore**:
Putting the selected Thread's files back to how they were before a chosen Turn, file by file: HEAD, the branches, the user's index and the ignored files stay as they were, and the Provider's session is not rewound. It asks first, naming the files it changes, and takes a Checkpoint first, so it can be undone. It is refused while a Turn runs in that checkout, and the agent is told on its next prompt which files went back. See ADR-0011.
_Avoid_: Rewind, rollback, checkout

**Base branch**:
The branch the Branch scope compares against: the remote's default branch, else `main`, `master` or `dev` (remote copy first).
_Avoid_: Target branch, parent branch
