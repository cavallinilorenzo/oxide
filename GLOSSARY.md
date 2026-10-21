# Oxide

A desktop app for agentic engineering: you open a Project and drive coding agents from a chat, switching between the agent CLIs already installed on your machine, with Git and GitHub at hand.

## Language

## Projects

**Project**:
A folder on the user's machine holding a Git repository, usually linked to a GitHub repository. The unit everything else belongs to.
_Avoid_: Workspace, repo (when meaning the Oxide concept)

## Threads

**Thread**:
One conversation with a Provider inside a Project, with its own Model, Effort and context. Model and Effort can change between Turns. `/clear` and ⌘N start a new Thread in the same Project; the old one stays in history.
_Avoid_: Agent, session, chat

**Turn**:
One user prompt in a Thread and everything the Provider does in response, until it completes, is interrupted, or fails.
_Avoid_: Run, exchange, round

**Item**:
One unit of a Turn's output: an agent message, reasoning, a tool call, a file change, or a subagent.
_Avoid_: Step, block, event (when meaning the unit)

**Thread Board**:
The per-Project view of all its Threads grouped by status (needs input, working, completed), from which a task can be dispatched to a new background Thread.
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
A panel docked to the side or bottom of the window showing one tool for the current Project: Terminal, Files, Diff, Pull request.
_Avoid_: Tab, pane, widget
