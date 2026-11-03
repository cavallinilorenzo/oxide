// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";
import { patchDocument, type CodeOpenRequest } from "./codeOpen";
import { CommentComposer } from "./CommentComposer";

// Monaco does not run in jsdom: the workbench is a stand-in that offers the same composer on line 4 of the patch.
vi.mock("./CodeWorkbench", () => ({
  CodeWorkbench: ({ openRequest, projectId }: { openRequest: CodeOpenRequest | null; projectId: number }) =>
    openRequest?.diff && openRequest.review ? (
      <CommentComposer projectId={projectId} path={openRequest.path} patch={patchDocument(openRequest.diff)} line={5} review={openRequest.review} onClose={() => {}} />
    ) : null,
}));
vi.mock("./ThreadView", () => ({ ThreadView: () => <div /> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
let status: "completed" | "working";
const thread = () => ({ id: 2, projectId: 1, title: "Existing", provider: "claude", status, updatedAt: "2026-01-01T00:00:00Z" });
const file = {
  path: "src/a.ts", oldPath: null, status: "modified", added: 1, removed: 1, binary: false,
  hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ kind: "context", text: "keep" }, { kind: "removed", text: "old" }, { kind: "added", text: "new" }] }],
};
type Args = { threadId: number; comment: Record<string, unknown> };
const calls: { command: string; args: Args }[] = [];
let drafts: Record<string, unknown>[];

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  drafts = [];
  status = "completed";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, payload) => {
    const args = payload as Args;
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "git_turn_diff" || command === "git_diff") return { base: null, files: [file] };
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread()];
    if (command === "add_line_comment") {
      const saved = { id: drafts.length + 1, threadId: args.threadId, outdated: false, ...args.comment };
      drafts.push(saved);
      return saved;
    }
    if (command === "list_line_comments") return drafts;
    if (command === "send_line_comments") { drafts = []; return null; }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
  localStorage.clear();
});

const press = (selector: string) => act(async () => host.querySelector<HTMLElement>(selector)!.click());
const type = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

async function openDiff() {
  await act(async () => root.render(<App />));
  await press('[aria-label="Toggle tools panel"]');
  await press('[role="tab"][aria-label="Diff"]');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
}

it("comments on a line from the Diff, keeps the draft on the Diff Surface and sends it in one action", async () => {
  await openDiff();
  await press('[role="option"]');
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!, "Why was this renamed?");
  await press('form[aria-label="Comment on line"] button[type="submit"]');
  expect(calls.find((c) => c.command === "add_line_comment")?.args).toEqual({
    threadId: 2,
    comment: { scope: "turn", path: "src/a.ts", side: "old", line: 2, code: "old", body: "Why was this renamed?" },
  });

  await press('[role="tab"][aria-label="Diff"]');
  const list = host.querySelector('[aria-label="Line comments"]')!;
  expect(list.textContent).toContain("src/a.ts:2");
  expect(list.textContent).toContain("Why was this renamed?");

  await press('[aria-label="Line comments"] .btn.primary');
  expect(calls.filter((c) => c.command === "send_line_comments")).toEqual([{ command: "send_line_comments", args: { threadId: 2 } }]);
  expect(host.querySelector('[aria-label="Line comments"]')).toBeNull();
});

it("offers Send only when the Thread is not working", async () => {
  status = "working";
  drafts = [{ id: 1, threadId: 2, scope: "turn", path: "src/a.ts", side: "new", line: 1, code: "keep", body: "hm", outdated: true }];
  await openDiff();
  const send = host.querySelector<HTMLButtonElement>('[aria-label="Line comments"] .btn.primary')!;
  expect(send.disabled).toBe(true);
  expect(host.querySelector('[aria-label="Line comments"]')!.textContent).toContain("Outdated");
});
