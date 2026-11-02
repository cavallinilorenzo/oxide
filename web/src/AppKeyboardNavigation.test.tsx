// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
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
vi.mock("./CodeWorkbench", () => ({
  CodeWorkbench: ({ onOpenFilesChange }: { onOpenFilesChange?: (open: boolean) => void }) => {
    // The editor reports a file as open, as it does once the user picks one.
    useEffect(() => { onOpenFilesChange?.(true); }, [onOpenFilesChange]);
    return <div className="code-workbench">Editor</div>;
  },
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
const thread = (id: number, title: string) => ({
  id, projectId: 1, provider: "claude", title, status: "completed", updatedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z", branch: null, worktreePath: null, issueNumber: null,
});
const threads = [thread(2, "Alpha work"), thread(3, "Beta work")];

beforeEach(() => {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command) => {
    // console.log("IPC call:", command);
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": return threads;
      case "git_diff": case "git_turn_diff": return { base: "main", files: [] };
      case "git_status": return { branch: "main", upstream: null, ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0, protected: false, unpublished: false, pickerDisabledReason: null };
      case "list_turns": return { turnCount: 1, turns: [] };
      case "plugin:event|listen": return 1;
      case "remember_selection": return null;
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {}, shortcuts: {} }, errors: [] };
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

it("cycles major visible regions with F6 and Shift+F6 in visual order", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Initially: sidebar and centre are visible; tools dock is closed.
  const toolsToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!;
  expect(toolsToggle).toBeTruthy();

  // Focus starts or moves into sidebar
  const searchInput = host.querySelector<HTMLInputElement>('.sidebar-search input')!;
  searchInput.focus();
  expect(document.activeElement).toBe(searchInput);

  // F6 from Sidebar moves to Centre (composer)
  await press("F6");
  const composer = host.querySelector<HTMLElement>('[role="textbox"]')!;
  expect(document.activeElement).toBe(composer);

  // F6 from Centre moves to Dock handle since dock is closed
  await press("F6");
  expect(document.activeElement).toBe(toolsToggle);

  // F6 from Dock handle wraps around to Sidebar
  await press("F6");
  expect(document.activeElement?.closest("#workspace-sidebar")).not.toBeNull();

  // Shift+F6 cycles backwards: Sidebar -> Dock handle -> Centre -> Sidebar
  await press("F6", { shiftKey: true });
  expect(document.activeElement).toBe(toolsToggle);

  await press("F6", { shiftKey: true });
  expect(document.activeElement).toBe(composer);

  await press("F6", { shiftKey: true });
  expect(document.activeElement?.closest("#workspace-sidebar")).not.toBeNull();
});

it("cycles through dock tabs and restores focus deliberately when collapsing/restoring", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const toolsToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!;
  // Open the dock
  await act(async () => toolsToggle.click());
  await settle();

  const diffTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Diff"]')!;
  expect(diffTab).toBeTruthy();
  expect(diffTab.getAttribute("aria-selected")).toBe("true");
  expect(diffTab.getAttribute("tabindex")).toBe("0");

  // Surface tabs roving focus with ArrowRight
  diffTab.focus();
  const tabsNav = host.querySelector<HTMLElement>('[role="tablist"][aria-label="Surfaces"]')!;
  await act(async () => {
    tabsNav.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  });
  await settle();

  const filesTab = host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Files"]')!;
  expect(filesTab.getAttribute("aria-selected")).toBe("true");

  // Collapsing a focused dock moves focus to its handle
  await press("\\", { ctrlKey: true });
  await settle();
  expect(document.activeElement).toBe(toolsToggle);

  // Restoring the dock deliberately restores focus into the dock
  await press("\\", { ctrlKey: true });
  await settle();
  expect(document.activeElement?.getAttribute("role")).toBe("tab");
});

it("handles Escape hierarchy: closes topmost overlay, else restores maximization", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Open dock and maximize it
  const toolsToggle = host.querySelector<HTMLButtonElement>('button[aria-label="Toggle tools panel"]')!;
  await act(async () => toolsToggle.click());
  await settle();

  // Full screen is for editing: no button on Diff, only on Files with a file open.
  expect(host.querySelector('button[aria-label="Maximize Surface"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Files"]')!.click());
  await settle();
  const maxBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Maximize Surface"]')!;
  await act(async () => maxBtn.click());
  await settle();

  // Thread is hidden, thread-restore-handle is shown
  expect(host.querySelector('.thread-restore-handle')).not.toBeNull();

  // Open Project palette overlay (Mod+Shift+N)
  await press("N", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('.palette')).not.toBeNull();

  // Escape closes overlay first, Surface stays maximized
  await press("Escape");
  await settle();
  expect(host.querySelector('.palette')).toBeNull();
  expect(host.querySelector('.thread-restore-handle')).not.toBeNull();

  // Second Escape restores maximization
  await press("Escape");
  await settle();
  expect(host.querySelector('.thread-restore-handle')).toBeNull();
  expect(host.querySelector('[role="textbox"]')).not.toBeNull();
});

it("collapsing and restoring sidebar moves focus to handle and back into sidebar", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const searchInput = host.querySelector<HTMLInputElement>('.sidebar-search input')!;
  searchInput.focus();
  expect(document.activeElement).toBe(searchInput);

  // Collapse sidebar with Mod+Shift+E
  await press("E", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('#workspace-sidebar')?.hasAttribute("hidden")).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('button[aria-label="Toggle sidebar"]'));

  // Restore sidebar with Mod+Shift+E deliberately restores focus into sidebar
  await press("E", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('#workspace-sidebar')?.hasAttribute("hidden")).toBe(false);
  expect(document.activeElement?.closest('#workspace-sidebar')).not.toBeNull();
});

it("surface shortcut actions select the single Surface and move focus", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Terminal shortcut Mod+Shift+T
  await press("T", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");

  // Files shortcut Mod+Shift+F
  await press("F", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Files"]')?.getAttribute("aria-selected")).toBe("true");

  // Diff shortcut Mod+Shift+D
  await press("D", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Diff"]')?.getAttribute("aria-selected")).toBe("true");

  // Issues shortcut Mod+Shift+I
  await press("I", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Issues"]')?.getAttribute("aria-selected")).toBe("true");

  // Pull request shortcut Mod+Shift+P
  await press("P", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Pull request"]')?.getAttribute("aria-selected")).toBe("true");
});

it("toggles Board with Mod+B preserving Thread selection and dock state", async () => {
  await act(async () => root.render(<App />));
  await settle();

  // Open tools dock on Terminal
  await press("T", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(host.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");

  // Toggle Board with Mod+B
  await press("B", { ctrlKey: true });
  await settle();
  expect(host.querySelector('[aria-label="Thread Board"]')).not.toBeNull();
  expect(host.querySelector('#workspace-tools')?.hasAttribute("hidden")).toBe(true);

  // Toggle Board back with Mod+B
  await press("B", { ctrlKey: true });
  await settle();
  expect(host.querySelector('[aria-label="Thread Board"]')).toBeNull();
  expect(host.querySelector('#workspace-tools')?.hasAttribute("hidden")).toBe(false);
  expect(host.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");
});

it("overlay dismissal returns focus to the invoker element", async () => {
  await act(async () => root.render(<App />));
  await settle();

  const openProjectBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Open a Project"]')!;
  openProjectBtn.focus();
  expect(document.activeElement).toBe(openProjectBtn);

  // Click Open a Project
  await act(async () => openProjectBtn.click());
  await settle();
  expect(host.querySelector('.palette')).not.toBeNull();

  // Press Escape to dismiss
  await press("Escape");
  await settle();
  expect(host.querySelector('.palette')).toBeNull();
  expect(document.activeElement).toBe(openProjectBtn);
});
