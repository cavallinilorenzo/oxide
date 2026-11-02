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
