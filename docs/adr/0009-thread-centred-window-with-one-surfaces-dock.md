# A central Thread and one maximizable Surfaces dock

Keep the Thread and its Transcript central, Projects and recent Threads in a
collapsible left sidebar, and exactly one right dock for Diff, Files, Terminal,
Pull request and Issues. Files owns the editor. Maximizing a Surface changes its
presentation while retaining the same tool and working state; restoring it brings
the Thread back. Work modes and the separate bottom terminal are removed.

The tradeoff is less space for each tool when reading a Thread beside it, in
exchange for stable navigation and visible conversation context. At the minimum
window size, opening the dock suspends the sidebar; explicitly opening the sidebar
suspends the dock. Fitting preserves preferred sizes for wider windows. Board and
Settings also suspend tool presentation without using tool switches as cleanup.

The human decisions are recorded in [the layout map (#267)](https://github.com/cavallinilorenzo/oxide/issues/267)
and [approved spec (#278)](https://github.com/cavallinilorenzo/oxide/issues/278):
[skeleton B (#271)](https://github.com/cavallinilorenzo/oxide/issues/271),
[Project-owned terminal tabs (#272)](https://github.com/cavallinilorenzo/oxide/issues/272),
[Files layout (#273)](https://github.com/cavallinilorenzo/oxide/issues/273),
[no terminal-agent integration (#274)](https://github.com/cavallinilorenzo/oxide/issues/274),
[Project Board entry (#276)](https://github.com/cavallinilorenzo/oxide/issues/276),
and [Thread-owned Git header B (#277)](https://github.com/cavallinilorenzo/oxide/issues/277).
Those tickets link the decision prototypes; prototypes are evidence, not
production implementations.

Thread Git operations resolve that Thread's checkout. Terminal tabs belong to the
Project and retain the checkout where they were created. These identities may
differ and must remain explicit. Tool maximization must never introduce another
Git toolbar or retarget a shell. Provider commands remain in the Transcript;
manually starting a CLI in a terminal does not create an Oxide Thread.

This decision preserves native Provider adapters (ADR-0001), Oxide-owned
Transcripts (ADR-0002), the React streaming boundary (ADR-0003) and permanent
Thread/worktree deletion (ADR-0005). It changes presentation and explicit tool
ownership, without changing Provider protocols, staging policy or deletion rules.

## Amendment — 2026-11-07: Files is a navigator; Code lives in the centre

The sentence above that "Files owns the editor" no longer holds. The Files Surface
is now a full-width navigator for the selected checkout: a click selects a file,
and a double click (or Enter/Space on a focused row) opens it in the Project's
**Code workspace**, an editor that lives in the centre beside the Thread. The
centre carries a Thread/Code switch, so the conversation and the editor share the
central area, and each Project keeps its own Code workspace and open buffers while
the user moves between Threads.

This supersedes only the editor-ownership part of the original decision. The rest
stands: there is still one right dock for Diff, Files, Terminal, Pull request and
Issues, a Surface still maximizes and restores its own working state, and the
sidebar/dock fitting rules are unchanged. The Files Surface no longer hosts an
editor, so maximizing it widens the navigator rather than an editor. Thread and
Terminal ownership rules from the original text remain as written.
