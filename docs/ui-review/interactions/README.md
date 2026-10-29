# Workbench interactions

Chromium visual checks at 1440 × 900, using the real React components and fixture
IPC responses. Screenshots cover the Terminal prompt/output, a pasted image in
the composer, Files opening an editable Code tab, Git opening a read-only patch
tab, and a Project switch keeping the application frame around its skeleton.
The visual harness reported no JavaScript errors. Fixture data is illustrative.

Regression coverage:

- `TerminalWorkbench.test.tsx`: `clear`, `CLS` and `Clear-Host` remove existing
  output without replacing the shell or losing command history.
- `useTerminalTransfer.test.tsx`: pasted image storage, literal Windows/POSIX path
  quoting, native drop coordinates and visibility, and storage errors.
- `ThreadAttachments.test.tsx`: image previews in the composer and outgoing Turn.
- `FilesPanel.test.tsx`, `DiffPanel.test.tsx`, `codeOpen.test.ts`: Code navigation,
  keyboard activation, and preserving the exact Git patch for deleted files.
- `AppOverlayPerformance.test.tsx`, `ThreadNavigation.test.tsx`: application-frame
  continuity, local loading skeletons, cached Transcript refresh and send gating.

Terminal images are inserted as quoted local file paths using xterm's bracketed
paste when a command is active. CLI-specific image interpretation (including
Antigravity) was not exercised in a live provider session.
