// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { App } from "./App";

vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const container = document.createElement("div"); document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
const chat = { id: 2, projectId: 1, title: "Chat thread", status: "completed", provider: "codex", worktreePath: null, branch: null, updatedAt: "2026-01-01T00:00:00Z" };
const board = { id: 3, projectId: 1, title: "Board thread", status: "completed", provider: "codex", worktreePath: "/wt/three", branch: "oxide/dispatch-time", updatedAt: "2026-01-01T00:00:00Z" };
const snapshot = (id: number) => ({ thread: [chat, board].find((t) => t.id === id), capabilities: { reasoningText: true }, supportedPermissionModes: ["auto-edit"], turns: [], turnOffset: 0, turnCount: 0, lastSeq: 0 });
const status = (branch: string, changedFiles = 0) => ({ branch, upstream: null, ahead: 0, behind: 0, added: changedFiles, removed: 0, changedFiles, pickerDisabledReason: null, protected: false, unpublished: false });

type Call = { command: string; args: Record<string, unknown> };

function boot(selectedThread: number, gitStatus: (args: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: selectedThread };
    if (command === "list_threads") return [chat, board];
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit"] };
    if (command === "subscribe_thread") return snapshot((args as { threadId: number }).threadId);
    if (command === "git_status") return gitStatus((args ?? {}) as Record<string, unknown>);
    if (command === "plugin:event|listen") return 1;
    if (command === "list_branches" || command === "subscribe_board") return [];
    if (command === "fetch_project") return false;
    return null;
  });
  return calls;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const threadButton = (title: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes(title))!;

it("shows each Thread's own branch and counters beneath its title and sends that Thread's context", async () => {
  const calls = boot(3, (args) => (args.threadId === 3 ? status("oxide/feature-three", 4) : status("main", 0)));
  await act(async () => root.render(<App />));
  await flush();

  // The controls live in the Thread header, not the global one.
  expect(container.querySelector(".header .git-header")).toBeNull();
  const controls = container.querySelector(".thread-header-bar .git-header")!;
  expect(controls.querySelector(".branch-name")?.textContent).toBe("oxide/feature-three");
  expect(controls.querySelector(".dirty-chip")?.textContent).toContain("+4");
  expect(calls.filter((c) => c.command === "git_status").every((c) => c.args.threadId === 3)).toBe(true);

  // Another Thread of the same Project: its own checkout is asked for and shown.
  calls.length = 0;
  await act(async () => threadButton("Chat thread").click());
  await flush();
  const next = container.querySelector(".thread-header-bar .git-header")!;
  expect(next.querySelector(".branch-name")?.textContent).toBe("main");
  expect(next.querySelector(".dirty-chip")).toBeNull();
  const asked = calls.filter((c) => c.command === "git_status").map((c) => c.args.threadId);
  expect(asked.length).toBeGreaterThan(0);
  expect(new Set(asked)).toEqual(new Set([2]));
});

it("sends the displayed Thread for branch actions even when the Project terminal is elsewhere", async () => {
  const calls = boot(3, () => status("oxide/feature-three", 1));
  await act(async () => root.render(<App />));
  await flush();
  await act(async () => container.querySelector<HTMLButtonElement>(".thread-header-bar .branch-button")!.click());
  const search = container.querySelector<HTMLInputElement>("[aria-label='Search branches']")!;
  expect(search).not.toBeNull();
  const listed = calls.filter((c) => c.command === "list_branches");
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.every((c) => c.args.threadId === 3)).toBe(true);
  // The Thread's header never offers a Project-wide target: every Git call names the Thread.
  const git = calls.filter((c) => ["git_status", "list_branches", "pull", "push", "commit", "checkout_branch", "create_branch"].includes(c.command));
  expect(git.every((c) => c.args.threadId === 3)).toBe(true);
});

it("has no Git target in the Board view and does not reuse the previous Thread's toolbar", async () => {
  boot(3, () => status("oxide/feature-three", 2));
  await act(async () => root.render(<App />));
  await flush();
  expect(container.querySelector(".git-header")).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Thread Board of Project"]')!.click());
  await flush();
  expect(container.querySelector(".git-header")).toBeNull();
});
