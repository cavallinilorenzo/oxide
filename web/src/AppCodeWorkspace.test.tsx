// @vitest-environment jsdom
// The real App with the real Files navigator: the dock browses the checkout, and a double click
// opens the file into the Project's central Code workspace, where Thread and Code views switch
// without losing the open buffers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";
import type { CodeOpenRequest } from "./codeOpen";

vi.mock("./ThreadView", () => ({
  ThreadView: ({ threadId }: { threadId: number }) => <div data-thread={threadId}>Conversation {threadId}</div>,
}));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./dictation", () => ({ DictationController: () => null }));
// Monaco does not run in jsdom: the workbench stands in with the props the host passes it.
vi.mock("./CodeWorkbench", () => ({
  CodeWorkbench: ({ openRequest, visible, showExplorer }: {
    openRequest: CodeOpenRequest | null;
    visible: boolean;
    showExplorer?: boolean;
  }) => (
    <div
      className="code-workbench"
      data-open-path={openRequest?.path ?? ""}
      data-visible={String(visible)}
      data-explorer={String(showExplorer)}
    />
  ),
}));
vi.mock("./TerminalSurface", () => ({ TerminalSurface: () => <div className="terminal-surface">Terminal</div> }));
vi.mock("./DiffPanel", () => ({ DiffPanel: () => <div className="diff-panel">Diff content</div> }));
vi.mock("./PullRequestPanel", () => ({ PullRequestPanel: () => <div className="pr-panel">PR content</div> }));
vi.mock("./IssuesSurface", () => ({ IssuesSurface: () => <div className="issues-surface">Issues content</div> }));
vi.mock("./BoardView", () => ({ BoardView: () => <main aria-label="Thread Board">Board</main> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Oxide", path: "/repo", hidden: false, open: true, missing: false };
const thread = {
  id: 2, projectId: 1, provider: "claude", title: "Alpha work", status: "completed",
  updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z",
  branch: null, worktreePath: null, issueNumber: null,
};
const secondThread = {
  ...thread, id: 3, title: "Beta work",
  updatedAt: "2026-01-01T00:00:01Z", createdAt: "2026-01-01T00:00:01Z",
};

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, payload) => {
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": return [thread, secondThread];
      case "list_dir": return (payload as { path: string }).path === ""
        ? [
            { path: "src", name: "src", isDir: true },
            { path: "README.md", name: "README.md", isDir: false },
          ]
        : [{ path: "src/app.ts", name: "app.ts", isDir: false }];
      case "find_files": return ["src/app.ts", "src/util.ts"];
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {}, shortcuts: {} }, errors: [] };
      case "plugin:event|listen": return 1;
      case "remember_selection": return null;
      default: return null;
    }
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
  localStorage.clear();
});

const settle = (ms = 60) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const click = (selector: string) => act(async () => host.querySelector<HTMLElement>(selector)!.click());
const dblclick = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
const rowWith = (text: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("#workspace-tools .files-navigation button"))
    .find((button) => button.textContent?.includes(text))!;
const fileRow = () => rowWith("app.ts");
const codeView = () => host.querySelector<HTMLElement>(".code-workbench")!;
const threadMain = () => host.querySelector<HTMLElement>('.centre[aria-label="Thread"]')!;

async function openFilesDock() {
  await act(async () => root.render(<App />));
  await settle();
  await click('button[aria-label="Toggle tools panel"]');
  await click('[role="tab"][aria-label="Files"]');
  await settle();
  await act(async () => rowWith("src").click());
  await settle();
}

it("opens a double-clicked dock file into the central Code workspace, not beside the tree", async () => {
  await openFilesDock();

  // The Files Surface is a full-width navigator: no editor is squeezed into the dock.
  expect(host.querySelector("#workspace-tools .files-navigation")).not.toBeNull();
  expect(host.querySelector("#workspace-tools .code-workbench")).toBeNull();

  // A single click only selects in the dock.
  await act(async () => fileRow().click());
  expect(host.querySelector(".code-workbench")).toBeNull();
  expect(fileRow().closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");

  await dblclick(fileRow());
  await settle();

  const editor = codeView();
  expect(editor).not.toBeNull();
  expect(editor.dataset.openPath).toBe("src/app.ts");
  expect(editor.dataset.visible).toBe("true");
  expect(editor.dataset.explorer).toBe("false");
  expect(threadMain().hasAttribute("hidden")).toBe(true);
  expect(host.querySelector("#workspace-tools .files-navigation")).not.toBeNull();
});

it("switches between the Thread and the Project's Code workspace without losing open files", async () => {
  await openFilesDock();

  // Opening code from the dock reveals the Code view.
  await act(async () => fileRow().click());
  await dblclick(fileRow());
  await settle();
  expect(codeView().dataset.visible).toBe("true");
  expect(codeView().dataset.openPath).toBe("src/app.ts");

  const threadTab = () => host.querySelector<HTMLElement>('[role="tab"][aria-label="Thread view"]')!;
  const codeTab = () => host.querySelector<HTMLElement>('[role="tab"][aria-label="Code view"]')!;
  expect(threadTab().getAttribute("aria-selected")).toBe("false");
  expect(codeTab().getAttribute("aria-selected")).toBe("true");

  await act(async () => threadTab().click());
  expect(threadMain().hasAttribute("hidden")).toBe(false);
  expect(threadMain().textContent).toContain("Conversation 2");
  expect(codeView().dataset.visible).toBe("false");
  expect(codeView().dataset.openPath).toBe("src/app.ts");

  await act(async () => codeTab().click());
  expect(threadMain().hasAttribute("hidden")).toBe(true);
  expect(codeView().dataset.visible).toBe("true");
  expect(codeView().dataset.openPath).toBe("src/app.ts");
});

it("reopening the Code view after switching Threads keeps the dock navigator, its selection and the open buffer", async () => {
  await openFilesDock();
  await act(async () => fileRow().click());
  await dblclick(fileRow());
  await settle();
  expect(fileRow().closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");

  // Another Thread in the same checkout: picking it shows that conversation, not the Code view.
  const beta = Array.from(host.querySelectorAll<HTMLElement>(".thread-item"))
    .find((item) => item.textContent?.includes("Beta work"))!;
  await act(async () => beta.click());
  await settle();
  expect(threadMain().hasAttribute("hidden")).toBe(false);
  expect(threadMain().textContent).toContain("Conversation 3");
  expect(host.querySelector('button[aria-label="Code view"]')).not.toBeNull();

  // Code is still the same Project workspace: the buffer and the Files selection survive.
  await click('button[aria-label="Code view"]');
  await settle();
  expect(codeView().dataset.openPath).toBe("src/app.ts");
  expect(host.querySelector("#workspace-tools .files-navigation")).not.toBeNull();
  expect(fileRow().closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");
});
