// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { App } from "./App";

const renders = vi.hoisted(() => ({ thread: 0 }));
vi.mock("./ThreadView", () => ({ ThreadView: () => { renders.thread++; return <div>Transcript</div>; } }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./ProjectPalette", () => ({ ProjectPalette: () => <div>Project palette</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const container = document.createElement("div"); document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); });

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
