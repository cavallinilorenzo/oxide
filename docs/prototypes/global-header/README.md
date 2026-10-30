# Global header scope — throwaway prototype

Question: [What stays global in the header once Work modes are gone?](https://github.com/cavallinilorenzo/oxide/issues/277).

Status: **B chosen by itsmrma** in the live discussion. The canonical resolution is recorded on the linked decision ticket. Fixture only. This branch is a primary source and must never be merged.

Double-click `index.html`, or run from this folder:

```powershell
python -m http.server 8277 --bind 127.0.0.1
```

Open `http://127.0.0.1:8277/index.html?variant=B&size=900x560`. B is also the default without a variant parameter. The floating bar and left/right arrows switch variants; size buttons change the simulated window. Inputs do not intercept variant arrows. Compare shows the eight-principle judgement; State exposes the fixture state; Reset clears it. No installation or build is required.

| Variant | Git controls | Tradeoff |
| --- | --- | --- |
| A · Global checkout toolbar | Branch/details, counters and Commit & Push in global header | Fast access from maximized tools, but the target follows the selected Thread, not the Terminal tab |
| B · Thread checkout toolbar | Same controls below the Thread title | Clear ownership and fast access; costs Thread height and needs restoring from a maximized Surface |
| C · Git lives in Diff | Checkout details, counters and Commit & Push inside Diff | One review/action home; another step to reach Git from Files or Terminal |

Every variant preserves the chosen skeleton: Thread central; Diff, Files, Terminal, Pull request and Issues in one right dock; no Work modes. The Board button stays beside each Project name, never in the header. Open files stay inside Files. Project terminal tabs keep their original checkout. Needs-input counts all open Projects and opens the pending Approval in one action, including from a maximized Surface or another Project.

## Try

1. Compare A/B/C at both sizes; turn on **Long branch** to test truncation.
2. Open the sidebar (Ctrl+B), switch between the Board Thread and a main-checkout Thread, then inspect the Git target. At 900×560 the sidebar yields to the dock.
3. Open Terminal. Select a different Thread: the terminal checkout stays fixed and a mismatch message appears. Change Project: that Project has its own terminal fixture.
4. Maximize a Surface. The header needs-input chip stays visible. Activate it to open the pending Approval and its exact command/worktree. Allow/Deny updates the fixture.
5. Click each Project’s Board icon, switch Projects from the header, and return. Board and dispatch have no implicit global Git target.
6. Type a draft or code/shell input, switch away and back. Ctrl+Shift+I simulates a background Approval without moving the caret. Ctrl+J toggles the dock; Ctrl+Shift+B opens the current Project’s Board; Esc restores the Thread.
7. Open Commit & Push. Inspect the exact selected Thread, branch and checkout. Cancel, or simulate the action: only fixture counters change. No Git command, Provider, filesystem mutation or network request runs.

## Scope and limits

This compares **placement**, not the branch-changing or commit/staging workflow. The checkout button opens read-only details; it does not implement a branch picker. The simulated commit treats all uncommitted files in the checkout as its target and spells out that they can exceed a Turn Diff. That is a fixture assumption, not a new staging-policy decision. The existing production header already sends its dirty Commit & Push action to Diff (`web/src/GitHeader.tsx`); the prototypes do not imply production commits without review.

Files/editor and shell are illustrative inputs, not Monaco or a PTY. Per-Thread drafts/Transcript scroll and tool input values persist in memory; full editor/file-tab state is not the question under test. The simulated terminal has one fixed tab per Project. Refresh clears all state.

At 900×560 the 482px dock leaves 416px for the Thread. Sidebar and dock are exclusive; visible header handles and shortcuts remain. At 1440×900 all three regions fit. Normal viewing scales the stage to the browser; `&capture=1` uses exact stage dimensions with no prototype controls for screenshots.

## Initial recommendation (before human reaction)

**C · Git lives in Diff.** Global controls navigate Projects, signal needs-input, and show/hide regions. The Thread names its checkout; the Surface owns its actions. Diff keeps review and commit together, shows changed-file count on its tab, and makes the commit target independent of a pinned Terminal checkout. Choose B if immediate Git access beside the conversation is the higher priority.

Derived from the settled [window skeleton](https://github.com/cavallinilorenzo/oxide/issues/271), [Board placement](https://github.com/cavallinilorenzo/oxide/issues/276), [terminal ownership](https://github.com/cavallinilorenzo/oxide/issues/272), and the eight principles in [UX evidence](https://github.com/cavallinilorenzo/oxide/issues/269). Source fixture: `codex/prototype/276-thread-board` at `c08f701`. See `review.md`, independent assessments, detector evidence and `screenshots/` for verification and limitations.
