// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

const { onError } = vi.hoisted(() => ({ onError: vi.fn() }));
vi.mock("./ThreadView", () => ({ ThreadView: ({ threadId, draft }: { threadId: number; draft: string }) => <div data-thread={threadId}>{draft}</div> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("./PullRequestPanel", () => ({ PullRequestPanel: ({ onFixPullRequest }: { onFixPullRequest: (prompt: string) => Promise<void> }) =>
  <button onClick={() => void onFixPullRequest("Fix PR #42\nhttps://github.com/me/repo/pull/42").catch(onError)}>Fix PR</button>,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
const oldThread = { id: 2, projectId: 1, title: "Existing", provider: "claude", status: "completed", updatedAt: "2026-01-01T00:00:00Z" };
const calls: { command: string; args: unknown }[] = [];
let createError: boolean;
let sendError: boolean;

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  createError = false;
  sendError = false;
  onError.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [oldThread];
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {
      codex: { model: "gpt-5", effort: "high", permissionMode: "ask" },
    } }, errors: [] };
    if (command === "create_thread") {
      if (createError) throw { message: "Cannot create Thread" };
      return { ...oldThread, id: 3, provider: "codex", title: null };
    }
    if (command === "send_prompt" && sendError) throw { message: "Agent unavailable" };
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

async function fix() {
  await act(async () => root.render(<App />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Toggle tools panel"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Pull request"]')!.click());
  const button = [...host.querySelectorAll("button")].find((button) => button.textContent === "Fix PR")!;
  await act(async () => button.click());
}

it("creates a fresh Thread with Settings defaults, sends automatically, and opens it", async () => {
  await fix();
  expect(calls.filter(({ command }) => command === "create_thread")).toEqual([{
    command: "create_thread", args: { projectId: 1, provider: "codex", model: "gpt-5", effort: "high", permissionMode: "ask" },
  }]);
  expect(calls.find(({ command }) => command === "send_prompt")?.args).toEqual({
    threadId: 3, segments: [{ kind: "text", text: "Fix PR #42\nhttps://github.com/me/repo/pull/42" }],
  });
  expect(host.querySelector('[data-thread="3"]')?.textContent).toBe("");
  expect(onError).not.toHaveBeenCalled();
});

it("opens the created Thread with the request preserved when sending fails", async () => {
  sendError = true;
  await fix();
  expect(host.querySelector('[data-thread="3"]')?.textContent).toContain("Fix PR #42");
  expect(onError).toHaveBeenCalledWith(new Error("Agent unavailable"));
});

it("keeps the current Thread and reports creation failures without sending", async () => {
  createError = true;
  await fix();
  expect(host.querySelector('[data-thread="2"]')).not.toBeNull();
  expect(calls.some(({ command }) => command === "send_prompt")).toBe(false);
  expect(onError).toHaveBeenCalledWith(new Error("Cannot create Thread"));
});
