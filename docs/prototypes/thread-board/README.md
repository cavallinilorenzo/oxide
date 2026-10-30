# Thread Board home — throwaway prototype

Question: [Where does the Thread Board live next to the sidebar's Thread list?](https://github.com/cavallinilorenzo/oxide/issues/276)

Status: **B chosen by itsmrma**, with an icon-only Board button in each Project heading instead of a separate Thread Board row. Fixture only; nothing runs a Provider or changes Git. This branch is a primary source and must never be merged.

## Open

Double-click `index.html`. No build, dependencies, server or installation required.

Optional HTTP preview, from this directory:

```powershell
python -m http.server 8276 --bind 127.0.0.1
```

Open `http://127.0.0.1:8276/index.html?variant=B`. The floating bar and left/right arrows select A/B/C. `?size=900x560` selects the minimum window. A 1440×900 stage scales down if the host browser is smaller; screenshots in this folder used a 1460×1000 host viewport so both target stages render at scale 1.

| Variant | Board home | Main tradeoff |
| --- | --- | --- |
| A | Header Board toggle | Familiar entry, but navigation sits among pane toggles |
| B | Icon-only Board button beside each Project name | Clear Project scope; keeps recent Threads and overview as distinct navigation tasks |
| C | Status groups inside the sidebar | One list and uninterrupted Transcript; less overview detail, rows move when status changes |

Shared foundation: the chosen B from [Which window skeleton should Oxide adopt?](https://github.com/cavallinilorenzo/oxide/issues/271), source `prototype/window-skeleton` at `8e34696d11b32694bc0d864a0543ed9ef78281df`. This file reuses its dark palette, density and full-window fixture convention. It rebuilds the relevant window interactions around the three Board alternatives. There are no Work modes; Diff, Files, Terminal, Pull request and Issues remain in the right dock. Open files stay inside Files. Project terminal tabs keep their checkout when the selected Thread changes, following the later terminal decision.

## Try

1. In A use Board in the header. In B click the Board icon in the same row as oxide or compiler; each opens only that Project’s Board. In C use the sidebar's status groups. At 900×560, open the sidebar first if the dock is visible.
2. Click the header's needs-input count: the pending Approval opens in its Thread in one action. Allow once changes it to working; Deny changes it to interrupted.
3. Dispatch a Board Thread. Inspect the Provider, base branch and own-worktree preview. Submit to create a working in-memory Thread with branch and checkout metadata; no real branch or worktree is created. Ordinary New Thread uses the main checkout.
4. Type a draft; switch Thread, Board or variant, then return. Open Files and edit the sample. In Terminal type a shell command, switch Thread and check the different-checkout indicator. State reveals the relevant fixture state. Reset clears everything.
5. While typing, press Ctrl+Shift+I to simulate a background Approval. Selection and caret remain in place. From a focused sidebar row, the same shortcut preserves row focus.

Ctrl+B toggles sidebar; Ctrl+J toggles dock (from the Board it returns to the selected Thread with the dock open); Ctrl+Shift+B opens the Board or C's grouped sidebar; Esc returns/cancels. Arrow variant switching does not intercept editable fields.

## Small-window rules represented here

- At 900×560 the sidebar yields to the dock: a Thread has 416px beside a 482px dock, above the 360px floor.
- Board overview suspends the dock and uses the centre; returning restores the remembered dock state. Vertical Board/Thread-list scrolling remains available.
- Board cards omit full paths at the minimum size but retain own-worktree/main-checkout labels and branch names. Selecting a Thread exposes its checkout in the status bar and scoped dock.
- Maximize gives the dock full attention; header status and a Thread rail remain.
- The header's sidebar/dock handles and shortcuts stay visible. The full collapse hierarchy is a separate map decision.

## Recommendation and evidence

**B · Project overview.** Give the Board an icon-only button in its Project heading, with a tooltip and an accessible name; reserve no separate sidebar row. Keep the recent Thread list for direct switching, the overview for cross-Thread supervision, and C's explicit checkout distinction. Neither B nor A pretends the Board is a Surface: its central overview temporarily replaces the Transcript. This is a deliberate task boundary to confirm with the deciders.

See [review.md](review.md) for the eight-principle comparison, independent assessment provenance, limits and verification. `Compare` in the prototype shows the same reasoning at a glance. `screenshots/` contains every alternative at both required stage sizes. `assessment-b.md` and `detector.json` are retained detector evidence from the initial review, before the documented interaction fixes.
