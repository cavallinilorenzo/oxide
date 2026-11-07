// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { DEFAULT_SHORTCUTS } from "./shortcuts";
import { App } from "./App";

vi.mock("./ThreadView", () => ({
  ThreadView: ({ threadId }: { threadId: number }) => (
    <div data-thread={threadId}>
      <div role="textbox" contentEditable aria-label="Message" suppressContentEditableWarning />
    </div>
  ),
}));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./dictation", () => ({ DictationController: () => null }));
vi.mock("./CodeWorkbench", () => ({ CodeWorkbench: () => <div className="code-workbench">Editor</div> }));
vi.mock("./TerminalSurface", () => ({ TerminalSurface: () => <div className="terminal-surface">Terminal</div> }));
vi.mock("./DiffPanel", () => ({ DiffPanel: () => <div className="diff-panel">Diff content</div> }));
vi.mock("./PullRequestPanel", () => ({ PullRequestPanel: () => <div className="pr-panel">PR content</div> }));
vi.mock("./IssuesSurface", () => ({ IssuesSurface: () => <div className="issues-surface">Issues content</div> }));
vi.mock("./SettingsView", () => ({ SettingsView: ({ onClose }: { onClose: () => void }) => <div className="settings-view"><button onClick={onClose}>Close</button></div> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const projects = [
  { id: 1, name: "Project Alpha", path: "/alpha", hidden: false, open: true, missing: false },
  { id: 2, name: "Project Beta", path: "/beta", hidden: false, open: true, missing: false },
];
const thread = (id: number, projectId: number, title: string) => ({
  id, projectId, provider: "claude", title, status: "completed", updatedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z", branch: null, worktreePath: null, issueNumber: null,
});
const threads: Record<number, ReturnType<typeof thread>[]> = {
  1: [thread(10, 1, "Alpha thread 1"), thread(11, 1, "Alpha thread 2")],
  2: [thread(20, 2, "Beta thread 1"), thread(21, 2, "Beta thread 2")],
};

beforeEach(() => {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, args) => {
    switch (command) {
      case "list_projects": case "rescan_projects": return projects;
      case "last_selection": return { projectId: 1, threadId: 10 };
      case "list_threads": return threads[(args as { projectId: number })?.projectId ?? 1] ?? [];
      case "git_diff": case "git_turn_diff": return { base: "main", files: [] };
      case "git_status": return { branch: "main", ahead: 0, behind: 0, modified: 0, untracked: 0, staged: 0 };
      case "list_turns": return { turnCount: 1, turns: [] };
      case "plugin:event|listen": return 1;
      case "remember_selection": return null;
      case "get_settings": return {
        settings: {
          defaultProvider: "claude", confirmQuit: true, shortcuts: DEFAULT_SHORTCUTS,
          claudeCustomizations: { claudeMd: false, skills: false, plugins: false, mcpServers: false, hooks: false },
          providers: {
            claude: { model: "claude-sonnet", effort: "high", permissionMode: "ask" },
            codex: { model: null, effort: null, permissionMode: "auto-edit" },
            antigravity: { model: null, effort: null, permissionMode: "auto-edit" },
          },
        },
        errors: [],
      };
      default: return null;
    }
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });

it("preserves selected Thread and dock state across Settings round trips", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Select Thread 11
  const thread11Btn = host.querySelector<HTMLButtonElement>('button[title*="Alpha thread 2"]')!;
  expect(thread11Btn).toBeTruthy();
  await act(async () => thread11Btn.click());
  await settle();
  expect(host.querySelector('[data-thread="11"]')).not.toBeNull();

  // Open Tools on Terminal
  await press("T", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");

  // Open Settings with Mod+,
  await press(",", { ctrlKey: true });
  await settle();
  expect(host.querySelector('.settings-view')).not.toBeNull();
  expect(host.querySelector('#workspace-tools')?.hasAttribute("hidden")).toBe(true);

  // Close Settings with Escape
  await press("Escape");
  await settle();
  expect(host.querySelector('.settings-view')).toBeNull();
  expect(host.querySelector('[data-thread="11"]')).not.toBeNull();
  expect(host.querySelector('#workspace-tools')?.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");

  // Switch to Project Beta
  const betaBtn = host.querySelector<HTMLButtonElement>('button[title*="beta"]')!;
  expect(betaBtn).toBeTruthy();
  await act(async () => betaBtn.click());
  await settle();
  expect(host.querySelector('[data-thread="20"]')).not.toBeNull();

  // Switch back to Project Alpha
  const alphaBtn = host.querySelector<HTMLButtonElement>('button[title*="alpha"]')!;
  expect(alphaBtn).toBeTruthy();
  await act(async () => alphaBtn.click());
  await settle();
  // Selected Thread and dock Surface for Alpha are retained
  expect(host.querySelector('[data-thread="11"]')).not.toBeNull();
  expect(host.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");
});
