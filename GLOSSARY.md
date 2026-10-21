# Oxide

A desktop app for agentic engineering: you open a Project and drive coding agents from a chat, switching between the agent CLIs already installed on your machine, with Git and GitHub at hand.

## Language

## Projects

**Project**:
A folder on the user's machine holding a Git repository, usually linked to a GitHub repository. The unit everything else belongs to.
_Avoid_: Workspace, repo (when meaning the Oxide concept)

## Threads

**Thread**:
One conversation with a single Provider inside a Project, with its own Model, Effort and context (Model and Effort can change between Turns); it maps one-to-one to the Provider's own session. `/clear` and ⌘N start a new Thread in the same Project; the old one stays in history.
_Avoid_: Agent, session, chat

**Thread status**:
Where a Thread stands right now: working (a Turn is running), needs input (the Provider is waiting on an approval or answer), completed (the last Turn finished and it's the user's move), error (the Turn failed), or interrupted (the Turn was stopped by the user or by quitting Oxide).
_Avoid_: State, phase

**Archived Thread**:
A Thread hidden from the Thread Board and sidebar but kept in history, still readable and resumable. Threads are archived, never deleted.
_Avoid_: Closed, deleted

**Turn**:
One user prompt in a Thread and everything the Provider does in response, until it completes, is interrupted, or fails.
_Avoid_: Run, exchange, round

**Item**:
One unit of a Turn's output: an agent message, reasoning, a tool call, a file change, or a subagent.
_Avoid_: Step, block, event (when meaning the unit)

**Transcript**:
Oxide's own record of a Thread's Turns and Items, the only thing a Thread is shown from. It outlives the Provider's session: when that session is gone the Thread stays readable, and can only be continued in a new Thread.
_Avoid_: History, log, session (when meaning the record)

**Checkpoint**:
A snapshot of a Thread's files taken when a Turn starts and when it ends, so the Diff Surface can show what that Turn changed. Read-only: nothing is ever restored from a Checkpoint.
_Avoid_: Snapshot, save point

**Setup command**:
An optional per-Project shell command run in every new worktree before its Thread's first Turn, to prepare what Git doesn't carry over (env files, dependencies).
_Avoid_: Init script, bootstrap

**Thread Board**:
The per-Project view of all its Threads grouped by Thread status into needs input (including error and interrupted), working and completed, from which a task can be dispatched to a new background Thread.
_Avoid_: Agent view, dashboard

## Providers

**Provider**:
An agent CLI installed and logged in on the user's machine that Oxide drives: Claude Code, Codex, or Antigravity CLI (`agy`).
_Avoid_: Agent, backend, harness

**Model**:
A specific LLM a Provider offers, chosen per conversation (e.g. Opus 5.5).

**Effort**:
The reasoning-depth setting a Provider exposes for a Model (e.g. low, high).
_Avoid_: Thinking level, reasoning mode

## Layout

**Surface**:
A panel docked to the side or bottom of the window showing one tool for the current Project: Terminal, Files, Diff, Pull request, Issues.
_Avoid_: Tab, pane, widget
