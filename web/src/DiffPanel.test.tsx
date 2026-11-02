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
