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
