// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
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
  await act(async () => root.render(<DiffPanel projectId={1} threadId={null} board={false} scope="branch" reviewedPr={null} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={() => {}} onOpenPullRequest={() => {}} onOpenFile={open} />));
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
      <DiffPanel projectId={1} onOpenFile={() => {}} threadId={props.threadId ?? 7} board={false} turnRunning={props.turnRunning} scope={scope} reviewedPr={null} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={props.onChanged ?? (() => {})} onOpenPullRequest={() => {}} />,
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
      <DiffPanel projectId={1} onOpenFile={() => {}} threadId={threadId} board={false} scope={scope} reviewedPr={null} onScopeChange={() => {}} focus={null} refreshKey="" onChanged={() => {}} onOpenPullRequest={() => {}} />,
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
