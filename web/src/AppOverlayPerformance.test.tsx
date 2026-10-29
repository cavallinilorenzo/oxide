// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { App } from "./App";

const renders = vi.hoisted(() => ({ thread: 0 }));
vi.mock("./ThreadView", () => ({ ThreadView: () => { renders.thread++; return <div>Transcript</div>; } }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./ProjectPalette", () => ({ ProjectPalette: () => <div>Project palette</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const container = document.createElement("div"); document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

it("keeps the app frame mounted and uses a local skeleton while another Project's Threads load", async () => {
  const project = { id: 1, name: "First", path: "/first", hidden: false, open: true, missing: false };
  const second = { ...project, id: 2, name: "Second", path: "/second" };
  const thread = { id: 2, projectId: 1, title: "Thread", status: "completed", provider: "codex" };
  let finish!: (threads: unknown[]) => void;
  mockIPC((command, args) => {
    if (command === "list_projects" || command === "rescan_projects") return [project, second];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return (args as { projectId: number }).projectId === 1 ? [thread] : new Promise((resolve) => { finish = resolve; });
    if (command === "get_settings") return { settings: { providers: {} }, errors: [] };
    if (command === "detected_editors") return [];
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  await act(async () => root.render(<App />));
  const header = container.querySelector(".header");
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>("button.project")).find((b) => b.textContent?.includes("Second"))!.click());
  expect(container.querySelector(".header")).toBe(header);
  expect(container.querySelector(".startup-screen")).toBeNull();
  expect(container.querySelector('.thread-loading .skeleton')).not.toBeNull();
  await act(async () => finish([{ ...thread, id: 3, projectId: 2 }]));
  expect(container.querySelector(".header")).toBe(header);
});

it("opens the delete confirmation and project palette without rerendering the Transcript", async () => {
  const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
  const thread = { id: 2, projectId: 1, title: "Thread", status: "completed", provider: "codex", updatedAt: "2026-01-01T00:00:00Z" };
  const settings = { defaultProvider: "codex", editor: "", providers: {} };
  mockIPC((command) => {
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread];
    if (command === "get_settings") return { settings, errors: [] };
    if (command === "detected_editors") return [];
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  await act(async () => root.render(<App />));
  const before = renders.thread;
  const trash = container.querySelector<HTMLButtonElement>('button[aria-label="Delete Thread"]')!;
  expect(trash).toBeTruthy();
  act(() => trash.click());
  expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
  expect(renders.thread).toBe(before);
  act(() => container.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!.click());
  const beforePalette = renders.thread;
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open a Project"]')!.click());
  expect(container.textContent).toContain("Project palette");
  expect(renders.thread).toBe(beforePalette);
});

it("shows the Project overview after deleting its last Thread and starts a real new Thread", async () => {
  const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
  const thread = { id: 2, projectId: 1, title: "Thread", status: "completed", provider: "codex", updatedAt: "2026-01-01T00:00:00Z" };
  mockIPC((command) => {
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread];
    if (command === "get_settings") return { settings: { defaultProvider: "codex", editor: "", providers: {} }, errors: [] };
    if (command === "detected_editors") return [];
    if (command === "delete_thread") return "deleted";
    if (command === "create_thread") return { ...thread, id: 3, title: null };
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  await act(async () => root.render(<App />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Delete Thread"]')!.click());
  const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find((b) => b.textContent?.includes("Delete"))!;
  await act(async () => confirm.click());
  expect(container.querySelector('[aria-label="Project overview"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Transcript");
  const start = container.querySelector<HTMLButtonElement>('.project-overview .primary')!;
  await act(async () => start.click());
  expect(container.querySelector('[aria-label="Project overview"]')).toBeNull();
  expect(container.textContent).toContain("Transcript");
});
