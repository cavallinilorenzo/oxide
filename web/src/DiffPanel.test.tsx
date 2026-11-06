// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type PullRequestReviewThread, type RestoreChange } from "./bindings";
import { DiffPanel } from "./DiffPanel";
import { clearQueryCache } from "./queryCache";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

const diffOf = (path: string) => ({
  base: null,
  files: [{ path, oldPath: null, status: "modified" as const, additions: 1, deletions: 0, binary: false, hunks: [] }],
});

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "gitDiff").mockResolvedValue({ status: "ok", data: diffOf("src/first.rs") } as never);
  vi.spyOn(commands, "listPullRequestLineComments").mockResolvedValue({ status: "ok", data: [] } as never);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (scope: "uncommitted" | "branch" = "uncommitted") =>
  act(async () =>
    root.render(
      <DiffPanel
        projectId={1}
        onOpenFile={() => {}}
        threadId={null}
        board={false}
        worktree={false}
        scope={scope}
        reviewedPr={null}
        onScopeChange={() => {}}
        focus={null}
        refreshKey=""
        onChanged={() => {}}
        onOpenPullRequest={() => {}}
      />,
    ),
  );

it("opens the selected Git patch in Code with the keyboard and removes the small viewer", async () => {
  const open = vi.fn();
  await act(async () => root.render(<DiffPanel projectId={1} threadId={null} board={false} worktree={false} scope="branch" reviewedPr={null} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={() => {}} onOpenPullRequest={() => {}} onOpenFile={open} />));
  await act(async () => host.querySelector('[role="option"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: "src/first.rs" }));
  expect(host.querySelector(".diff-body")).toBeNull();
});

it("shows the last diff of the scope at once when coming back, then refreshes it", async () => {
  await render();
  expect(host.textContent).toContain("first.rs");
  await act(() => root.unmount());
  root = createRoot(host);

  let resolve!: (r: Awaited<ReturnType<typeof commands.gitDiff>>) => void;
  vi.mocked(commands.gitDiff).mockImplementation(() => new Promise((r) => (resolve = r)));
  await render();
  expect(host.textContent).toContain("first.rs");
  expect(host.textContent).not.toContain("Loading…");
  await act(async () => resolve({ status: "ok", data: diffOf("src/second.rs") } as never));
  expect(host.textContent).toContain("second.rs");
});

it("remembers each scope's own diff", async () => {
  await render("uncommitted");
  vi.mocked(commands.gitDiff).mockImplementation(() => new Promise(() => {}));
  await render("branch");
  expect(host.querySelector('.skeleton[aria-busy="true"]')).not.toBeNull();
  await render("uncommitted");
  expect(host.textContent).toContain("first.rs");
});

const hunk = (header: string) => ({ header, lines: [{ kind: "added" as const, text: "x" }] });
const fileOf = (path: string, status: "modified" | "added" | "untracked", hunks = [hunk("@@ -1 +1 @@")]) => ({
  path, oldPath: null, status, added: 1, removed: 0, binary: false, hunks,
});

function renderRevert(
  props: { scope?: "uncommitted" | "branch" | "turn"; turnRunning?: boolean; threadId?: number | null; onChanged?: () => void } = {},
) {
  const scope = props.scope ?? "uncommitted";
  return act(async () =>
    root.render(
      <DiffPanel projectId={1} onOpenFile={() => {}} threadId={props.threadId ?? 7} board={false} worktree={false} turnRunning={props.turnRunning} scope={scope} reviewedPr={null} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={props.onChanged ?? (() => {})} onOpenPullRequest={() => {}} />,
    ),
  );
}

const click = (el: Element | null) => act(async () => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

it("reverts a file from the Diff and refreshes it", async () => {
  vi.spyOn(commands, "gitDiff").mockResolvedValue({ status: "ok", data: { base: null, files: [fileOf("src/a.rs", "modified")] } } as never);
  const revert = vi.spyOn(commands, "revertDiff").mockResolvedValue({ status: "ok", data: null } as never);
  const onChanged = vi.fn();
  await renderRevert({ onChanged });
  await click(host.querySelector('[aria-label="Revert src/a.rs"]'));
  expect(revert).toHaveBeenCalledWith(1, 7, "uncommitted", "src/a.rs", null, false);
  expect(onChanged).toHaveBeenCalled();
});

it("reverts one hunk of the selected file", async () => {
  vi.spyOn(commands, "gitDiff").mockResolvedValue({ status: "ok", data: { base: null, files: [fileOf("src/a.rs", "modified", [hunk("@@ -1 +1 @@"), hunk("@@ -40 +40 @@")])] } } as never);
  const revert = vi.spyOn(commands, "revertDiff").mockResolvedValue({ status: "ok", data: null } as never);
  await renderRevert();
  await click(host.querySelector('[aria-label="Revert hunk @@ -40 +40 @@ of src/a.rs"]'));
  expect(revert).toHaveBeenCalledWith(1, 7, "uncommitted", "src/a.rs", { index: 1, header: "@@ -40 +40 @@" }, false);
});

it("asks before a revert deletes a file", async () => {
  vi.spyOn(commands, "gitDiff").mockResolvedValue({ status: "ok", data: { base: null, files: [fileOf("new.rs", "untracked")] } } as never);
  const revert = vi.spyOn(commands, "revertDiff").mockResolvedValue({ status: "ok", data: null } as never);
  await renderRevert();
  await click(host.querySelector('[aria-label="Revert new.rs"]'));
  expect(revert).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("deletes the file");
  await click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Delete file")!);
  expect(revert).toHaveBeenCalledWith(1, 7, "uncommitted", "new.rs", null, true);
});

it("reports why a revert failed and does not refresh", async () => {
  vi.spyOn(commands, "gitDiff").mockResolvedValue({ status: "ok", data: { base: null, files: [fileOf("src/a.rs", "modified")] } } as never);
  vi.spyOn(commands, "revertDiff").mockResolvedValue({ status: "error", error: { message: "Nothing was reverted." } } as never);
  const onChanged = vi.fn();
  await renderRevert({ onChanged });
  await click(host.querySelector('[aria-label="Revert src/a.rs"]'));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Nothing was reverted.");
  expect(onChanged).not.toHaveBeenCalled();
});

it("reports a failed Dossier update after Commit & Push", async () => {
  vi.spyOn(commands, "gitDiff").mockResolvedValue({ status: "ok", data: diffOf("src/first.rs") } as never);
  vi.spyOn(commands, "gitStatus").mockResolvedValue({
    status: "ok",
    data: {
      branch: "topic", upstream: "origin/topic", ahead: 1, behind: 0,
      added: 1, removed: 0, changedFiles: 1, protected: false, unpublished: false,
      pickerDisabledReason: null,
    },
  } as never);
  vi.spyOn(commands, "commit").mockResolvedValue({ status: "ok", data: null } as never);
  vi.spyOn(commands, "push").mockResolvedValue({
    status: "ok",
    data: { dossier: { state: "failed", pullRequest: 5, message: "HTTP 502" } },
  } as never);
  await render();
  const message = host.querySelector<HTMLTextAreaElement>('[aria-label="Commit message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(message, "Ship it");
    message.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(host.querySelector("button.primary"));

  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "Pushed, but the Dossier was not updated: HTTP 502",
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(commands.push).toHaveBeenCalledWith(1, null, false);
});

it("offers no revert in Branch scope or while a Turn is running", async () => {
  vi.spyOn(commands, "gitDiff").mockResolvedValue({ status: "ok", data: { base: "main", files: [fileOf("src/a.rs", "modified")] } } as never);
  await renderRevert({ scope: "branch" });
  expect(host.textContent).toContain("a.rs");
  expect(host.querySelector('[aria-label^="Revert"]')).toBeNull();
  await renderRevert({ scope: "uncommitted", turnRunning: true });
  expect(host.querySelector('[aria-label^="Revert"]')).toBeNull();
});


const picks = [
  { turnIndex: 0, prompt: "Add the parser", checkpointed: true },
  { turnIndex: 1, prompt: "Rename it", checkpointed: true },
  { turnIndex: 2, prompt: "Plan only", checkpointed: false },
];

const renderTurn = (threadId: number | null, scope: "turn" | "uncommitted" = "turn") =>
  act(async () =>
    root.render(
      <DiffPanel projectId={1} onOpenFile={() => {}} threadId={threadId} board={false} worktree={false} scope={scope} reviewedPr={null} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={() => {}} onOpenPullRequest={() => {}} />,
    ),
  );
const picker = () => host.querySelector<HTMLSelectElement>('select[aria-label="Turn"]')!;
const choose = (value: string) =>
  act(async () => {
    picker().value = value;
    picker().dispatchEvent(new Event("change", { bubbles: true }));
  });
const mockTurns = (data: typeof picks) => {
  vi.spyOn(commands, "listTurnPicks").mockResolvedValue({ status: "ok", data } as never);
  vi.spyOn(commands, "gitTurnDiff").mockImplementation((_t, turn) => Promise.resolve({ status: "ok", data: diffOf(`turn${turn}.rs`) }) as never);
};

it("offers every Turn by position and prompt, and a Turn without Checkpoints says it has no diff", async () => {
  mockTurns(picks);
  await renderTurn(5);
  expect([...picker().options].map((o) => o.textContent)).toEqual(["Turn 1 · Add the parser", "Turn 2 · Rename it", "Turn 3 · Plan only"]);
  expect(picker().value).toBe("2");
  expect(host.textContent).toContain("no Checkpoints");
  expect(commands.gitTurnDiff).not.toHaveBeenCalled();
});

it("shows the diff between the chosen Turn's Checkpoints and leaves other scopes alone", async () => {
  mockTurns(picks.slice(0, 2));
  await renderTurn(5);
  expect(host.textContent).toContain("turn1.rs");
  await choose("0");
  expect(commands.gitTurnDiff).toHaveBeenLastCalledWith(5, 0);
  expect(host.textContent).toContain("turn0.rs");
  expect(host.textContent).not.toContain("turn1.rs");

  await renderTurn(5, "uncommitted");
  expect(commands.gitDiff).toHaveBeenLastCalledWith(1, 5, "uncommitted");
  expect(host.querySelector('select[aria-label="Turn"]')).toBeNull();
});

it("falls back to the latest Turn when the Thread changes", async () => {
  mockTurns(picks.slice(0, 2));
  await renderTurn(5);
  await choose("0");
  await renderTurn(6);
  expect(picker().value).toBe("1");
  expect(commands.gitTurnDiff).toHaveBeenLastCalledWith(6, 1);
});

it("offers Revert on the latest Turn only, since Core reverts the latest", async () => {
  mockTurns(picks.slice(0, 2));
  vi.spyOn(commands, "gitTurnDiff").mockResolvedValue({ status: "ok", data: { base: null, files: [{ path: "a.rs", oldPath: null, status: "modified", added: 1, removed: 0, binary: false, hunks: [] }] } } as never);
  await renderTurn(5);
  expect(host.querySelector('[aria-label="Revert a.rs"]')).not.toBeNull();
  await choose("0");
  expect(host.querySelector('[aria-label^="Revert"]')).toBeNull();
});

const renderRestore = (props: { threadId?: number | null; checkoutBusy?: boolean; onChanged?: () => void; onRestored?: () => void } = {}) =>
  act(async () =>
    root.render(
      <DiffPanel projectId={1} onOpenFile={() => {}} threadId={props.threadId ?? 5} board={false} worktree={false} checkoutBusy={props.checkoutBusy} scope="turn" reviewedPr={null} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={props.onChanged ?? (() => {})} onRestored={props.onRestored} onOpenPullRequest={() => {}} />,
    ),
  );

const mockRestore = (files: { path: string; change: RestoreChange }[], turnIndex = 1) => {
  vi.spyOn(commands, "restorePreview").mockResolvedValue({ status: "ok", data: { turnIndex, files } } as never);
  vi.spyOn(commands, "restoreTurn").mockResolvedValue({ status: "ok", data: { turnIndex, files, undone: false } } as never);
  vi.spyOn(commands, "pendingRestore").mockResolvedValue({ status: "ok", data: null } as never);
};

it("offers a restore on a Turn with Checkpoints and names the files it changes", async () => {
  mockTurns(picks.slice(0, 2));
  mockRestore([{ path: "src/a.rs", change: "rewritten" }, { path: "src/new.rs", change: "removed" }]);
  const onChanged = vi.fn();
  const onRestored = vi.fn();
  await renderRestore({ onChanged, onRestored });
  await click(host.querySelector('[aria-label="Restore the files to before Turn 2"]'));
  const dialog = host.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("src/a.rs");
  expect(dialog?.textContent).toContain("src/new.rs");
  expect(commands.restoreTurn).not.toHaveBeenCalled();
  await click(dialog!.querySelector("button.primary"));
  expect(commands.restoreTurn).toHaveBeenCalledWith(5, 1);
  expect(onChanged).toHaveBeenCalled();
  expect(onRestored).toHaveBeenCalled();
});

it("offers no restore without Checkpoints or while the Thread's checkout is busy", async () => {
  mockTurns(picks);
  mockRestore([]);
  await renderRestore({ checkoutBusy: true });
  expect(host.querySelector('[aria-label^="Restore the files"]')).toBeNull();
  await renderRestore();
  await choose("1");
  expect(host.querySelector('[aria-label="Restore the files to before Turn 2"]')).not.toBeNull();
  await choose("2");
  expect(host.querySelector('[aria-label^="Restore the files"]')).toBeNull();
});

it("reports why a restore was refused", async () => {
  mockTurns(picks.slice(0, 2));
  vi.spyOn(commands, "pendingRestore").mockResolvedValue({ status: "ok", data: null } as never);
  vi.spyOn(commands, "restoreTurn").mockResolvedValue({ status: "ok", data: { turnIndex: 1, files: [], undone: false } } as never);
  vi.spyOn(commands, "restorePreview").mockResolvedValue({ status: "error", error: { message: "A Turn is running in this Thread. Wait for it to finish or stop it." } } as never);
  await renderRestore();
  await click(host.querySelector('[aria-label="Restore the files to before Turn 2"]'));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("A Turn is running in this Thread.");
  expect(commands.restoreTurn).not.toHaveBeenCalled();
});

it("offers to undo a restore that can still be undone", async () => {
  mockTurns(picks.slice(0, 2));
  vi.spyOn(commands, "pendingRestore").mockResolvedValue({ status: "ok", data: { turnIndex: 1, files: [{ path: "src/a.rs", change: "rewritten" }] } } as never);
  const undo = vi.spyOn(commands, "undoRestore").mockResolvedValue({ status: "ok", data: { turnIndex: 1, files: [], undone: true } } as never);
  const onRestored = vi.fn();
  await renderRestore({ onRestored });
  await click(host.querySelector('[aria-label="Undo the restore"]'));
  expect(undo).toHaveBeenCalledWith(5);
  expect(onRestored).toHaveBeenCalled();
});

const reviewThread = (overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({
  id: "t1",
  path: "src/app.rs",
  line: 1,
  originalLine: 1,
  side: "new" as const,
  resolved: false,
  outdated: false,
  diffHunk: "@@ -1 +1 @@\n+    run();\n",
  comments: [{ author: "alice", body: "Please add a guard.", createdAt: "2026-01-01T00:00:00Z" }],
  ...overrides,
});

async function renderPr(threads = [reviewThread()]) {
  vi.spyOn(commands, "pullRequestDetail").mockResolvedValue({
    status: "ok",
    data: { diff: { base: "main", files: [fileOf("src/app.rs", "modified")] } },
  } as never);
  vi.spyOn(commands, "pullRequestReviewThreads").mockResolvedValue({ status: "ok", data: threads } as never);
  await act(async () =>
    root.render(
      <DiffPanel projectId={1} onOpenFile={() => {}} threadId={null} board={false} worktree={false} scope="pr" reviewedPr={5} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={() => {}} onOpenPullRequest={() => {}} />,
    ),
  );
}

it("shows GitHub review threads on the PR diff with their line, author and comments", async () => {
  const fetchThreads = vi.spyOn(commands, "pullRequestReviewThreads");
  await renderPr();
  expect(fetchThreads).toHaveBeenCalledWith(1, 5);
  const section = host.querySelector('[aria-label="Review threads"]');
  expect(section?.textContent).toContain("src/app.rs:1");
  expect(section?.textContent).toContain("    run();");
  expect(section?.textContent).toContain("@alice");
  expect(section?.textContent).toContain("Please add a guard.");
});

it("collapses a resolved thread until asked, and keeps an outdated one in reach", async () => {
  await renderPr([
    reviewThread({ id: "resolved", resolved: true }),
    reviewThread({
      id: "lost",
      path: "src/gone.rs",
      line: null,
      originalLine: 9,
      outdated: true,
      comments: [{ author: "bob", body: "Old note.", createdAt: "2026-01-01T00:00:00Z" }],
    }),
  ]);
  expect(host.textContent).toContain("Resolved");
  expect(host.textContent).not.toContain("Please add a guard.");
  expect(host.querySelector('[aria-label="Review threads not in this diff"]')?.textContent).toContain("src/gone.rs:9");
  await click(host.querySelector('.review-thread-summary[aria-expanded="false"]'));
  expect(host.textContent).toContain("Please add a guard.");
});

it("shows a GitHub review thread error without hiding the diff", async () => {
  vi.spyOn(commands, "pullRequestDetail").mockResolvedValue({
    status: "ok",
    data: { diff: { base: "main", files: [fileOf("src/app.rs", "modified")] } },
  } as never);
  vi.spyOn(commands, "pullRequestReviewThreads").mockResolvedValue({
    status: "error",
    error: { message: "gh: Not authenticated" },
  } as never);
  await act(async () =>
    root.render(
      <DiffPanel projectId={1} onOpenFile={() => {}} threadId={null} board={false} worktree={false} scope="pr" reviewedPr={5} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={() => {}} onOpenPullRequest={() => {}} />,
    ),
  );
  expect(host.textContent).toContain("app.rs");
  expect(host.querySelector(".surface-empty.error")?.textContent).toContain("Not authenticated");
});

it("offers Blind review and starts it with the selected provider", async () => {
  const providersMock = vi.spyOn(commands, "blindReviewProviders").mockResolvedValue({
    status: "ok",
    data: [
      { provider: "claude", name: "Claude", sameProvider: true, label: "Claude (same provider)" },
      { provider: "codex", name: "Codex", sameProvider: false, label: "Codex" },
    ],
  } as never);
  const startReviewMock = vi.spyOn(commands, "startBlindReview").mockResolvedValue({
    status: "ok",
    data: {
      id: 99,
      projectId: 1,
      provider: "claude",
      model: null,
      effort: null,
      permissionMode: "ask",
      status: "running",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      title: "Blind review (Claude · same provider)",
      blindReview: true,
      branch: null,
      worktreePath: "/tmp/detached",
      issueNumber: null,
      sessionLost: false,
      continuedFrom: null,
      continuedIn: null,
    },
  } as never);

  const onThreadCreated = vi.fn();
  const onChanged = vi.fn();

  await act(async () =>
    root.render(
      <DiffPanel
        projectId={1}
        threadId={7}
        threadProvider="claude"
        threadIssue="#42"
        board={false}
        worktree={false}
        scope="uncommitted"
        reviewedPr={null}
        onScopeChange={() => {}}
        focus={null}
        refreshKey=""
        onChanged={onChanged}
        onOpenPullRequest={() => {}}
        onOpenFile={() => {}}
        onThreadCreated={onThreadCreated}
      />,
    ),
  );

  const blindBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Blind review"]');
  expect(blindBtn).not.toBeNull();
  await click(blindBtn);

  expect(providersMock).toHaveBeenCalledWith("claude");
  const dialog = host.querySelector('[role="dialog"][aria-label="Blind review"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).toContain("Claude (same provider)");

  const issueInput = dialog?.querySelector<HTMLInputElement>('input[aria-label="Issue"]');
  expect(issueInput?.value).toBe("#42");

  const startBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (b) => b.textContent?.includes("Start Blind review"),
  );
  expect(startBtn).toBeDefined();
  await click(startBtn!);

  expect(startReviewMock).toHaveBeenCalledWith({
    projectId: 1,
    threadId: 7,
    provider: "claude",
    scope: "uncommitted",
    turnIndex: null,
    issue: "#42",
  });
  expect(onThreadCreated).toHaveBeenCalled();
  expect(onChanged).toHaveBeenCalled();
});

it("shows a notice when no provider can honour non-writing configuration", async () => {
  vi.spyOn(commands, "blindReviewProviders").mockResolvedValue({
    status: "ok",
    data: [],
  } as never);

  await renderRevert();
  await click(host.querySelector('button[aria-label="Blind review"]'));

  const dialog = host.querySelector('[role="dialog"][aria-label="Blind review"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.textContent).toContain("No provider is available that can honour a non-writing configuration");

  const startBtn = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (b) => b.textContent?.includes("Start Blind review"),
  );
  expect(startBtn?.disabled).toBe(true);
});
