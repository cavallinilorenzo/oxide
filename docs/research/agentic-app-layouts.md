# How agentic coding apps lay out chat, terminal, editor and review

**Research date:** 2026-10-30
**Ticket:** [#268](https://github.com/cavallinilorenzo/oxide/issues/268), for the [window layout map](https://github.com/cavallinilorenzo/oxide/issues/267)
**Answer in one line:** The conversation-first apps have converged on one skeleton: a left list of conversations grouped by project, with live status; the conversation in the centre; and a tabbed right panel for Diff, Files, Terminal and Browser, all scoped to the selected conversation. None of them switches the whole centre between chat, terminal and editor. Products that also serve editor-first users ship a second window or a layout preset, and the only centre-replacing terminal (Conductor's Big Terminal Mode) is an experimental option that was removed and brought back twice.

## Scope

The report surveys ten products in their latest documented versions as of 2026-10-30: Cursor (Agents Window and the editor), the OpenAI Codex app (now Codex inside the ChatGPT desktop app), Claude Code desktop, Conductor, Warp, Zed, VS Code (Chat view and Agents window), T3 Code, Google Antigravity (App and IDE) and Superset (renamed **Paradev**). For each one it records:

- the window regions
- the primary object
- any chat/terminal/editor mode switch and how to reach it
- where the editor lives and how a file opens
- where the terminal lives and whom it belongs to
- where diffs are reviewed
- how parallel agents are overviewed
- documented reversals and user complaints

The vocabulary follows [GLOSSARY.md](../../GLOSSARY.md): Thread, Thread status, Work mode, Surface, Diff scope, Board Thread, Thread Board.

## Sources

Primary sources only, read on 2026-10-30. Where a claim rests on a forum thread, the thread is a user report with replies from the vendor's team. It is labelled as such.

- **Cursor:** [Agents Window docs](https://cursor.com/docs/agent/agents-window.md), [Agent Review docs](https://cursor.com/docs/agent/agent-review.md), changelogs [2.0](https://cursor.com/changelog/2-0) (2025-10-29), [3.0](https://cursor.com/changelog/3-0) (2026-04-02) and [3.1](https://cursor.com/changelog/3-1) (2026-04-13). Forum threads with team replies:
  - [Agents Window review vs Editor](https://forum.cursor.com/t/when-using-agents-window-should-approve-undo-diffs-be-visible-and-actionable-in-the-files-tab-and-other-questions/160526)
  - [file tree moved right](https://forum.cursor.com/t/the-project-directory-sidebar-has-disappeared-and-clicking-the-file-icon-opens-an-empty-untitled-tab-instead/164985)
  - [forced layout change reverted](https://forum.cursor.com/t/i-am-forced-to-use-cursor-agents-instead-of-cursor-ide/165631)
  - [per-chat terminal loses its PTY](https://forum.cursor.com/t/glass-agents-layout-per-chat-terminal-panel-missing-after-switching-sidebar-conversations/163709)
  - [crowded right-panel tab strip](https://forum.cursor.com/t/fixed-tab-strip-and-sidebars-for-each-tabs-in-agents-window/167891)
- **Codex:** the [Codex manual](https://learn.chatgpt.com/docs/codex-manual.md), which includes the app changelog digest, [Code review](https://learn.chatgpt.com/docs/code-review.md), [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal.md), [Commands and shortcuts](https://learn.chatgpt.com/docs/reference/commands.md), [Codex environments](https://learn.chatgpt.com/docs/environments/modes.md) and [Projects and chats](https://learn.chatgpt.com/docs/projects.md). The old `developers.openai.com/codex/app` pages now redirect to `learn.chatgpt.com`.
- **Claude Code desktop:** [Desktop docs](https://code.claude.com/docs/en/desktop) and [Redesigning Claude Code on desktop for parallel agents](https://claude.com/blog/claude-code-desktop-redesign) (2026-04-14).
- **Conductor:** the [docs corpus](https://www.conductor.build/llms-full.txt) (Diff viewer, Big Terminal Mode and Checks reference pages, and the workflow guides), the [changelog index](https://www.conductor.build/changelog.md), and the entries [0.10.2](https://www.conductor.build/changelog/0.10.2-toggle-big-terminal-mode), [0.11.4](https://www.conductor.build/changelog/0.11.4-the-return-of-big-terminal-mode), [0.16.0](https://www.conductor.build/changelog/0.16.0-diff-viewer-file-explorer), [0.44.0](https://www.conductor.build/changelog/0.44.0-new-sidebar-rebuilt-composer-codex-checkpoints), [0.48.0](https://www.conductor.build/changelog/0.48.0-big-terminal-mode), [0.62.0](https://www.conductor.build/changelog/0.62.0-repo-settings-browser-preview) and [0.84.0](https://www.conductor.build/changelog/0.84.0-edit-files-directly-in-diffs).
- **Warp:**
  - [Code docs](https://docs.warp.dev/_llms-txt/code.txt): Code editor, File Tree and Code Review panel
  - [Terminal and Agent modes](https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/)
  - [Vertical tabs](https://docs.warp.dev/terminal/windows/vertical-tabs/)
  - [Changelog](https://docs.warp.dev/_llms-txt/changelog.txt)
- **Zed:** [Agent Panel](https://zed.dev/docs/ai/agent-panel.md), [Parallel Agents](https://zed.dev/docs/ai/parallel-agents.md), [Terminal Threads](https://zed.dev/docs/ai/terminal-threads.md), [Windows & Projects](https://zed.dev/docs/windows-and-projects.md) and [Introducing Parallel Agents in Zed](https://zed.dev/blog/parallel-agents) (2026-04-22).
- **VS Code:** [Use the Agents window](https://code.visualstudio.com/docs/agents/agents-window), [Use the Chat view](https://code.visualstudio.com/docs/agents/run/chat-view.md) and the [GitHub changelog for v1.120–v1.123](https://github.blog/changelog/2026-06-03-github-copilot-in-visual-studio-code-may-releases), which puts the Agents window in Stable as a preview in May 2026.
- **T3 Code:** source at [`pingdotgg/t3code@32ecd71`](https://github.com/pingdotgg/t3code/tree/32ecd71726fee16f335484c1f95cbce126d461f6) (main, 2026-10-30): [`rightPanelStore.ts`](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/apps/web/src/rightPanelStore.ts), [`ThreadTerminalDrawer.tsx`](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/apps/web/src/components/ThreadTerminalDrawer.tsx), [`files/FilePreviewPanel.tsx`](https://github.com/pingdotgg/t3code/blob/32ecd71726fee16f335484c1f95cbce126d461f6/apps/web/src/components/files/FilePreviewPanel.tsx), the README, and the commit history of `rightPanelStore.ts`.
- **Antigravity:** [Choose your Antigravity](https://antigravity.google/docs/overview.md), [Features](https://antigravity.google/docs/features.md), [Review changes](https://antigravity.google/docs/review-changes.md) and the [Changelog](https://antigravity.google/docs/changelog.md), covering App v2.0.1–v2.28.1 and IDE v1.11.2–v2.6.0.
- **Paradev (formerly Superset):** [What is Paradev?](https://docs.paradev.com/llms.mdx/overview), [The Paradev Model](https://docs.paradev.com/llms.mdx/superset-model), [Editor & Files](https://docs.paradev.com/llms.mdx/editor), [Diff Viewer](https://docs.paradev.com/llms.mdx/diff-viewer), [Chat UI](https://docs.paradev.com/llms.mdx/chat), [Agent Status](https://docs.paradev.com/llms.mdx/agent-status) and [Multiple Windows](https://docs.paradev.com/llms.mdx/multiple-windows).

## Findings per product

### Cursor

Cursor ships **two windows** since 3.0 (2026-04-02):

- **Agents Window.** The [docs](https://cursor.com/docs/agent/agents-window.md) call it the "agent-first interface", generally available with Cursor 3. You open it with ⌘⇧P → *Open Agents Window* and return with *Open IDE*, and both windows can be open at once. Its left side lists workspaces and their agents. A right panel holds tabs for Changes, Files, Browser and Terminal. The Changes, Files and Terminal placements come from the forum threads above, not from the docs.
  - **Primary object:** the agent conversation, across projects ("multi-workspace").
  - **Files:** Files is a lightweight viewer. A team reply says it is "not a replacement for the Editor". Full editing means switching to the Editor window. Since 3.1 you can "jump from the diff straight to the exact line in the file".
  - **Review:** file-level diffs (stage, unstage, revert) through a Review button and a diff tab. Per-hunk accept/undo exists only in the Editor window, and the team acknowledged the parity gap in July 2026.
  - **Terminal:** stored per agent chat (`glass/cursor.editorPanelVisibility.agent/{composerId}`).
  - **Parallel agents:** 3.1 (2026-04-13) added a **tiled layout** for watching several agents side by side, and it persists across sessions.
- **Editor window.** The classic VS Code layout, file-first. Cursor 2.0 (2025-10-29) had already added a sidebar "for your agents and plans" there. An *Agent* or *Editor* window layout setting (⌘E) still toggles where the chat sits.

**Reversals and complaints:**

- A July 2026 update moved some users from the Agent layout to the Editor layout. Cursor "reverted that change" within a day ([thread](https://forum.cursor.com/t/i-am-forced-to-use-cursor-agents-instead-of-cursor-ide/165631)).
- Users thought the file tree had disappeared when it moved from the left sidebar to the right panel ([thread](https://forum.cursor.com/t/the-project-directory-sidebar-has-disappeared-and-clicking-the-file-icon-opens-an-empty-untitled-tab-instead/164985)).
- A per-chat terminal lost its PTY after switching conversations, from June to August 2026. The team confirmed it as a rebind bug ([thread](https://forum.cursor.com/t/glass-agents-layout-per-chat-terminal-panel-missing-after-switching-sidebar-conversations/163709)).
- Users asked to split the single flat tab strip that mixes file, terminal and browser tabs ([thread](https://forum.cursor.com/t/fixed-tab-strip-and-sidebars-for-each-tabs-in-agents-window/167891)).
- The layout mode is synced across all windows, and users complained about it.

### OpenAI Codex app (Codex in the ChatGPT desktop app)

- **History.** Codex launched as a standalone macOS app on 2026-02-02 and reached Windows on 2026-03-04. On **2026-07-09 it merged into the ChatGPT desktop app**, where Codex sits beside Chat and Work. That is the only app-level mode switch in this survey (⌃1 / ⌃2 / ⌃3), and it switches products, not tools.
- **Regions.** A sidebar lists projects and their chats (⌘B), with pinning and search. The chat sits in the centre. **Workspace tabs** sit beside the chat, and ⌘⇧B cycles them between full view, split view and hidden tabs. A bottom panel toggles with ⌘J.
- **Primary object:** the chat (thread) inside a project.
- **Terminal:** "Each chat … includes a terminal scoped to its current project or worktree". You open it as a tab (*New tab → Terminal*) or with ⌃\`, and Codex can read its output.
- **Review:** the review pane opens as a tab with ⌃⇧G. It shows **Unstaged** by default, with **Staged**, **Commit**, **Branch** and **Last turn** scopes. You can stage or revert per hunk, file or whole diff, and leave line comments that become guidance for the next turn. `/review` can run inline or as a detached review chat.
- **Editor:** no full editor. "Clicking a file name typically opens that file in your chosen editor", configured under **Open**. The app has workspace file tabs, a file tree (⌘⇧E), file search (⌘P) and, since July, inline editing in diffs.
- **Parallel agents:** the sidebar list plus unread and attention markers ("Next chat needing attention", ⌘⌥A). There is no grid. A floating, always-on-top chat window arrived in February 2026.

### Claude Code desktop

- **History.** [Redesigned on 2026-04-14](https://claude.com/blog/claude-code-desktop-redesign) for "many things in flight, and you in the orchestrator seat".
- **Regions.** A sidebar lists sessions grouped by project folder, with filters and grouping. The chat is central. A session rail on the side holds Environment, Changes and Context cards. **Drag-and-drop panes** cover chat, diff, browser, terminal, Files, plan, tasks and subagent. Panes open from title-bar buttons, and on narrow windows the buttons collapse into the ⋮ menu. You can pop panes out into their own window.
- **Primary object:** the session.
- **Files:** clicking a path in chat opens the **Files** pane, editable locally, with *Open in* VS Code, Cursor or Zed.
- **Terminal:** a pane opened with ⌃\` that "opens in your session's working directory and shares the same environment as Claude".
- **Review:** the diff pane opens from the Changes card or ⌘⇧D. It has a file list on the left and changes on the right. Line comments are submitted together, and Claude answers them with a new diff.
- **Parallel agents:** the sidebar, ⌃Tab switching, and a **split view** of two sessions (⌥-click) or a new window (⌘-click).
- **No chat/terminal/editor mode.** The view modes (Normal, Thinking, Verbose) only change transcript verbosity.
- **Reversal:** the *Summary* view mode shipped with the redesign was later removed (desktop v1.46388.1). The docs still contrast a "current layout" with an "earlier layout" in several places.

### Conductor

- **Regions.** A left sidebar lists **workspaces** (a worktree and branch, identified by PR title or branch name), simplified in 0.44.0 (2026-03-24) to show GitHub status at a glance. The centre panel holds **chat tabs**: several agents can share a workspace in separate tabs. A side panel holds the git panel and Changes tab, a Run tab and the terminal. A ➕ menu opens browser tabs (0.62.0).
- **Primary object:** the workspace, with chats inside it.
- **Review:** since 0.16.0 (2025-10-21) "the diff viewer [is] integrated into the main chat panel" (⌘⇧D). Line comments become composer attachments, and a **Checks** tab collects CI, deployments, review threads and todos before merge.
- **Editor:** since 0.84.0 (2026-09-02) changed files "open and edit directly in diffs by default", and the earlier file preview and editor survive only behind a legacy toggle. *Open In* (⌘O) opens the workspace in Cursor or VS Code.
- **Terminal:** the side panel by default. **Big Terminal Mode** "replaces the center panel with a full terminal" (⌘⇧T).
- **Reversal:** Big Terminal Mode existed by September 2025. 0.11.4 (2025-09-23) is titled "The Return of Big Terminal Mode", and 0.48.0 (2026-04-14) says "We've brought back Big Terminal Mode!", now under **Settings → Experimental**. It is the closest analogue to Oxide's Terminal Work mode, and its history is the most volatile in the survey.

### Warp

- **Regions.** A terminal window of tabs and split panes. An optional **vertical tabs** sidebar lists every pane with branch, directory, agent status badges and diff stats, designed for "running multiple coding agents side by side". A left tools panel holds the File Tree and the conversation list. The **Code Review panel** opens from the top-right *Code review* button, from the git diff chip in the input, or from *Review changes* at the end of a conversation.
- **Primary object:** the terminal tab or pane. An agent conversation lives inside a pane.
- **Editor:** a native editor with LSP. Files open from the tree, from paths in output or conversation, or with ⌘O, as a **split pane or a new tab** (a setting).
- **Review:** uncommitted changes, changes against main, or against another branch, with hunk revert, inline edits and comments sent to running agents, including Claude Code and Codex CLIs.
- **Mode switch:** each pane has **Terminal mode** and an **Agent conversation view**. Commands the agent runs stay in that conversation, and terminal blocks stay in the terminal.
- **Reversal:** Warp 2.0 (2025-06-25) shipped a single *Universal Input* that auto-detected command or prompt. On 2026-02-10 Warp introduced "two distinct modes: a clean terminal for commands, and a dedicated conversation view", which separates the contexts again.

### Zed

- **Regions:** an editor-first workspace with docks. The **Agent Panel** shows one thread, and the **Threads Sidebar** (⌘⌥J) lists threads grouped by project, with status and agent. Terminal Threads, which run an agent CLI in a terminal, sit in the same list.
- **Layout presets:** *Panel Layout → Agentic* puts Threads and the Agent Panel on the left and the Project and Git panels on the right. *Classic* restores the editor layout. The [2026-04-22 post](https://zed.dev/blog/parallel-agents) says the new layout is the default but "opt-in" for existing users.
- **Primary object:** the project, holding threads and files.
- **Editor:** the main area. The agent can "follow" into the files it edits.
- **Review:** *Review Changes* opens a **multibuffer tab** in the editor area with per-hunk keep and reject. An optional mode reviews inline in each file.
- **Terminal:** the regular terminal dock, plus Terminal Threads in the agent panel.
- **Parallel agents:** the Threads Sidebar. Worktree isolation is picked from the title bar.

### VS Code

VS Code offers **two interfaces over the same sessions**:

- **Chat view.** The Chat view sits in the Secondary Side Bar next to the editor. It can also open as an editor tab, in a separate window or maximized. It has a sessions list above the conversation, either compact or side-by-side. Review happens through a *working set* above the input, with **Keep** and **Undo**, or by opening a changed file's diff in the editor. The terminal and editor are the normal workbench ones.
- **Agents window.** A separate window, in Stable as a preview since May 2026. It has a sessions list across workspaces, with status and change stats. The chat sits in the centre, beside a **Changes** and **Files** side panel. Changes scopes are branch, uncommitted, all or last agent turn, with range comments, commit and a Create PR form. Files and diffs open "in an editor beside the chat or in a modal window". The title bar has *Open Terminal*, and sessions can tile in a grid.

You move between the two with *Open in Agents* and *Open in Editor*. Local harness sessions and Codex-extension sessions stay in the main window only.

### T3 Code

- **Regions.** A sidebar lists projects and their threads, with status indicators. The chat column has a **bottom terminal drawer**: per thread, splittable, at most 75 % of the height. A **right panel of tabs**, with state stored per thread, holds `diff`, `files`, `file`, `terminal`, `preview` (browser), `device`, `pull-request` and `pull-requests`.
- **Primary object:** the thread.
- **Editor:** the `file` tab is an editor with save sessions, plus an external-editor launcher.
- **Review:** the diff tab switches scope (since 2026-06-20) and can follow a turn's diff.
- **Mode switch:** none. The right panel can be maximized.
- **Reversal:** commit #5558 (2026-08-07), "plans stop hijacking the UI, fold into chat instead", removed `plan` and `agents` surfaces from the right panel, and the store migration drops them.

### Google Antigravity

- **History.**
  - **1.0 (2025-11-18):** a VS Code-fork IDE with an **Editor view** and an **Agent Manager** view. The Agent Manager had an inbox of conversations across workspaces.
  - **2.0 (2026-05-19):** the docs say Antigravity "evolved from the Agent Manager into a standalone desktop command center (Antigravity App)". The IDE carries on separately, and an *Open IDE* button hands a project over (App 2.0.6, 2026-05-22).
- **Regions.** A sidebar for new conversation, history, automations, and projects with their conversations. The conversation sits in the centre. A **side panel** opens tabs from ➕: Terminal (⌘J), Browser, Open File (File Viewer with a file tree), PDF, and the Overview. The Overview was redesigned on 2026-10-15 to gather artifacts, changed files, links and uploads. A **Review** pane opens from the Overview.
- **Primary object:** the conversation inside a project.
- **Review:** the Review pane offers **Uncommitted**, **Branch** and **Agent Edits** views, per-file stage, unstage and discard, commit, amend and push, and line comments to the agent.
- **Parallel agents:** the sidebar list with status hover cards (Action required, Working, Unread) and a split view of conversations.
- **Small windows:** since 2.28.0 (2026-10-27), "in windows narrower than 1024 pixels, the sidebar and side panel no longer open side by side … so the conversation keeps its room."

### Paradev (formerly Superset)

- **Regions.** A sidebar of projects and their **workspaces** (worktree plus branch), each with an activity strip showing running agents, ports and PR state. The workspace area holds **tabs, splits and panes that mix terminals, files, diffs and browser panes**. A file explorer sits in a sidebar. A **right sidebar** has a Changes control, with Pages and Run beside it. Several windows can show different workspaces.
- **Primary object:** the workspace. Agents are CLIs running in its terminals.
- **Editor:** a built-in editor opened from the explorer or from a diff line (*Edit Here*). ⌘O opens the workspace in your IDE "for longer editing sessions".
- **Review:** the Changes pane in the right sidebar, split or unified, with a focus mode and a Review tab for PR comments.
- **Mode switch:** a per-agent-pane **CLI / Chat** toggle that resumes the same session over ACP. The docs mark the Chat UI "coming soon".

## Comparative table

| Product (version, date) | Regions | Primary object | Chat / terminal / editor switch | Editor and file opening | Terminal | Diff review | Parallel overview |
|---|---|---|---|---|---|---|---|
| Cursor Agents Window (3.x, 2026-04 →) | Left workspaces + agents; centre chat (tiles); right tabbed panel | Agent conversation | Separate **Editor window** (⌘⇧P Open IDE); Agent/Editor layout setting | Files tab viewer; full editing in Editor window; diff → line | Right-panel tab per chat | Changes tab, file-level stage/revert; per-hunk only in Editor | Sidebar + tiled panes |
| Codex in ChatGPT desktop (2026-07-09 →) | Left projects → chats; centre chat; workspace tabs beside; bottom panel | Chat (thread) | App-level Chat/Work/Codex; ⌘⇧B full/split/hidden tabs | External editor by default; file tabs; inline edit in diffs | Per chat, tab or bottom (⌃\`, ⌘J) | Review tab (⌃⇧G): Unstaged/Staged/Commit/Branch/Last turn; line comments; hunk stage/revert | Sidebar, unread and attention |
| Claude Code desktop (redesign 2026-04-14) | Left sessions; centre chat; session rail; drag-and-drop panes | Session | None (view modes are verbosity) | Files pane, editable locally; Open in VS Code/Cursor/Zed | Pane in session cwd (⌃\`) | Diff pane (⌘⇧D), file list + changes, batched line comments | Sidebar; split view of two sessions |
| Conductor (0.92, 2026-10-23) | Left workspaces; centre chat/diff/browser tabs; side panel (git, Run, terminal) | Workspace (worktree) | **Big Terminal Mode** replaces centre (⌘⇧T, experimental) | Edit directly in diffs (0.84); Open In Cursor/VS Code | Side panel; or centre in Big Terminal Mode | Diff in main panel (⌘⇧D), comments → composer; Checks tab | Sidebar with GitHub status; chat tabs |
| Warp (2026-10) | Tabs/panes; vertical-tabs sidebar; left tools panel; Code Review panel | Terminal pane | Per-pane Terminal mode / Agent conversation view | Native editor, split pane or tab | The base surface | Code Review panel: uncommitted/vs main/vs branch; comments to CLI agents | Vertical tabs with agent status badges |
| Zed (Parallel Agents, 2026-04-22) | Editor centre; Agent Panel + Threads Sidebar; Project/Git panels | Project (threads + files) | *Agentic* / *Classic* panel layout preset | Full editor; agent "follow" | Terminal dock; Terminal Threads | Multibuffer review tab, per-hunk keep/reject | Threads Sidebar by project |
| VS Code Chat view (2026) | Editor workbench; chat in secondary side bar | File/editor | Chat as side bar, editor tab, window, or maximized; *Open in Agents* | Full editor | Bottom panel | Working set Keep/Undo; diff in editor | Sessions list in chat view |
| VS Code Agents window (preview, 2026-05 →) | Left sessions; centre chat; Changes/Files side panel | Session | Separate window; *Open in Editor* | Editor beside chat or modal | *Open Terminal* in title bar | Changes panel: branch/uncommitted/all/last turn; range comments; commit, PR | Sessions list + grid |
| T3 Code (main, 2026-10-30) | Left projects → threads; centre chat + bottom terminal drawer; right tabbed panel | Thread | None; right panel maximize | `file` tab editor; open in external editor | Bottom drawer per thread, or right-panel tab | `diff` tab with scope switching | Sidebar with status |
| Antigravity App (2.28, 2026-10-28) | Left projects → conversations; centre conversation; right side panel tabs | Conversation | Separate **Antigravity IDE** (*Open IDE*) | File Viewer in side panel; edit in IDE | Side-panel tab (⌘J) | Review pane: Uncommitted/Branch/Agent Edits; line comments; commit/push | Sidebar status cards; split view |
| Paradev / Superset (2026-10) | Left workspaces; tabs/splits of terminals, files, diffs, browser; right sidebar Changes | Workspace (worktree) | Per-pane CLI / Chat toggle (Chat "coming soon") | Built-in editor; Edit Here from diff; ⌘O to IDE | Central panes per workspace | Changes pane, split/unified, focus mode | Sidebar activity strip; multiple windows |

## Recurring patterns

1. **Three regions.** Seven of the ten products converge on the same three regions: a left list of conversations or workspaces grouped by project, a central conversation, and a **tabbed right panel** for review, files, terminal and browser. The seven are Cursor Agents, Codex, Claude Code, Conductor, T3 Code, Antigravity App and VS Code's Agents window, with Paradev close. The right panel is scoped to the selected conversation: Cursor stores its state per chat and T3 Code per thread.
2. **The conversation is the primary object; the editor is a guest.** In the conversation-first apps, a file opens as a tab or viewer inside the side panel, or straight inside a diff (Conductor 0.84, Codex inline diff editing, Paradev *Edit Here*, Cursor 3.1 diff-to-line). Heavy editing is handed to an IDE through *Open in*, *Open IDE* or *Open Editor*. Only the editor-first products (Zed, VS Code Chat view, Warp) put a full editor in the main area.
3. **No global chat/terminal/editor mode.** No conversation-first app replaces its whole centre by switching between chat, terminal and editor. Products that serve both audiences ship **two windows** (Cursor Agents Window and Editor, VS Code Agents window and Chat view, Antigravity App and IDE) or a **layout preset** (Zed's Agentic and Classic). The exceptions are narrow:
   - Conductor's Big Terminal Mode is opt-in and experimental, and was removed twice.
   - Warp switches between terminal and agent views per pane, not per window.
   - Codex's Chat/Work/Codex switch changes product, not tool.
4. **The terminal belongs to the conversation or workspace.** It opens in that conversation's working directory or worktree: Codex per chat, Claude Code per session, Cursor per agent chat, T3 Code per thread, Paradev and Conductor per workspace. Two placements recur, a tab in the right panel and a bottom drawer under the chat, and Codex and T3 Code offer both. Agents can read it (Codex, Conductor's `@terminal`).
5. **One review pattern.** Every product reviews in a dedicated diff tab or pane with:
   - a **scope selector** that maps onto Oxide's Diff scopes: uncommitted, staged, branch against base, commit, and a "last turn" or "agent edits" scope. Codex, Antigravity and VS Code have the turn scope.
   - **line comments sent back to the agent** as the next prompt's context: Codex, Claude Code, Conductor, Warp, VS Code Agents, Antigravity and Paradev. The sources read do not document this for Cursor's Agents Window or Zed.
   - **stage and revert** at file or hunk level, and often commit, push and PR in the same pane: Codex, Antigravity, VS Code Agents, Paradev, Conductor.
6. **Parallel work is overviewed in the sidebar list.** The list carries status badges and unread or needs-attention markers. Seeing two conversations at once is a split or grid of panes: Cursor tiles, Claude Code split view, VS Code grid, Antigravity split view, Paradev multiple windows. The one separate overview screen, Antigravity 1.0's Agent Manager, became the main window of a standalone app in 2.0. Warp's agent management panel lists cloud agents but is not the main navigation.
7. **Shortcuts are converging.** Toggle terminal ⌃\` (Codex, Claude Code). Toggle bottom or terminal panel ⌘J (Codex, Antigravity). Open diff ⌘⇧D (Claude Code, Conductor). Toggle sidebar ⌘B (Codex). Command palette or search ⌘K or ⌘⇧P.
8. **Narrow windows give way to the conversation.** Antigravity stops showing the sidebar and the side panel together below 1024 px. Claude Code folds pane buttons into the ⋮ menu. Codex's ⌘⇧B hides the tabs.

## Outliers

- **Warp is terminal-first.** The agent conversation is a mode of a terminal pane, and parallel agents are tabs or panes listed in vertical tabs. Its reversal from one Universal Input (June 2025) to two separate modes (February 2026) is evidence that mixing commands and prompts in one input confused people.
- **Zed is editor-first** and puts the agentic arrangement in a layout preset rather than in a new window. It is the only product where agent review happens in an editor multibuffer tab rather than a side panel.
- **Paradev and Conductor make the workspace (worktree), not the conversation, the unit.** Conversations are tabs inside it. Paradev treats agents as CLIs in terminals and adds chat as an optional view of the same session.
- **Codex** has no in-app code editor of its own beyond diffs and file tabs, and still defaults to an external editor.
- **Conductor's Big Terminal Mode** is the only centre-replacing terminal. It keeps getting removed and restored, and now sits behind an experimental flag.

## Implications for Oxide's skeleton

These are proposals for the map's prototype and decision tickets, not settled decisions.

- **The baseline already matches the convergent skeleton.** It has a sidebar of Projects and Threads, the Thread in the centre, and Tools on the right (Files, Diff, Pull request, Issues) beside a bottom Terminal panel. Prototypes should treat this three-region frame as the default to beat rather than reinvent it.
- **Work modes are the main point of divergence from the field.** No conversation-first product swaps the whole centre between Chat, Terminal and Code. The nearest analogues are an experimental, twice-restored Conductor option, and *separate windows* for editor-first work (Cursor, VS Code, Antigravity). This favours:
  - keeping Chat as the fixed centre;
  - turning Terminal and Code into **Surfaces that can be maximized into the centre** (Codex full view, Antigravity maximized side panel, Conductor Big Terminal Mode, T3 Code panel maximize) rather than skeleton-replacing modes.

  PRODUCT.md records that the user asked for three Work modes, so a decision to fold them into maximizable Surfaces has to say so explicitly. The prototype should compare the two.
- **Keep terminals keyed to the Thread, and keep their PTYs alive across Thread switches.** Ownership by (Project, Thread), with the cwd at the Thread's checkout or worktree, is the industry norm. Cursor's months-long "terminal loses its PTY after switching chats" bug shows that ownership has to live in Core (as Oxide's already does), not in the view. Offering both a bottom drawer and a terminal tab in the right dock is common (Codex, T3 Code).
- **Treat the Diff Surface as the review hub.**
  - Keep the Diff scope selector: Turn ≈ "Last turn" or "Agent Edits", plus Uncommitted and Branch.
  - Add line comments that feed the next Turn, and stage or revert per hunk.
  - Allow **jump from a hunk to the file at that line** in Code. Cursor 3.1, Paradev and Conductor all added this.
  - Put Commit & Push and PR next to the diff (Codex, Antigravity, VS Code Agents, Paradev) rather than only in the header. That is relevant to the "Header contents" open question.
- **The Code editor can be a Surface.** Most competitors ship a lighter editor plus *Open in* an external IDE. Oxide's Monaco and LSP editor is richer than most, so it can live as file tabs in the dock, maximizable, with an *Open in* fallback, instead of needing a mode of its own.
- **The Thread Board should read as the sidebar's status overview, not a separate view.** The field shows Thread status, unread and needs-input markers in the sidebar list, and offers side-by-side Threads as a split. The only separate overview screen (Antigravity 1.0's Agent Manager) became the main window of a standalone app. This argues for merging Board grouping into the sidebar, or making it a sidebar filter, and for a split of two Threads as the "see several at once" answer. The cost at 900×560 needs testing.
- **Collapse rules at 900×560.** Adopt a rule like Antigravity's: below roughly 1024 px, the sidebar and the right dock are mutually exclusive, so the Thread keeps its width. Move Surface buttons into an overflow menu as Claude Code does.
- **Shortcuts.**
  - Oxide's Ctrl+B / ⌘B opens Board, but ⌘B toggles the sidebar in Codex, and that is the dominant convention.
  - ⌃\` for Terminal and ⌘⇧D for Diff are the common choices.

## Evidence limits

- No product was run hands-on. Region placement comes from documentation text, changelogs, image captions or alt text, and, for T3 Code, source code. Screenshots and videos were not inspected visually.
- **Conductor:** the docs name the panels (sidebar, centre panel, side panel, git panel, Run tab, terminal panel) without stating their exact geometry.
- **Cursor:** the Agents Window regions come from team replies in forum threads, not from the docs page, which does not describe regions.
- **Antigravity 1.0:** the ⌘E toggle between Editor and Agent Manager was not confirmed in a primary source.
- **VS Code:** the docs do not say where the Agents window's terminal docks.
- **Paradev:** its Chat UI is documented as "coming soon". The date of the rename from Superset was not found in a primary source.
- **Versions and dates:** these are as published by each vendor on 2026-10-30. Layouts in this category change monthly, as several of the reversals above show, so treat the table as a dated snapshot.
- **No usability research:** none of the vendors published research or metrics for their layout changes. "Complaints" are forum reports and the vendors' own stated reasons, not measured outcomes.
