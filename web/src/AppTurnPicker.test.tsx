// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

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
const thread = { id: 2, projectId: 1, title: "Existing", provider: "claude", status: "completed", updatedAt: "2026-01-01T00:00:00Z" };
const file = (path: string) => ({ path, oldPath: null, status: "modified", added: 1, removed: 0, binary: false, hunks: [] });
const calls: { command: string; args: unknown }[] = [];

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread];
    if (command === "list_turn_picks") {
      return [
        { turnIndex: 0, prompt: "Add the parser", checkpointed: true },
        { turnIndex: 1, prompt: "Rename it", checkpointed: true },
      ];
    }
    if (command === "git_turn_diff") return { base: null, files: [file(`turn${(args as { turnIndex: number }).turnIndex}.rs`)] };
    if (command === "git_diff") return { base: "main", files: [] };
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

it("inspects an earlier Turn from the Turn scope, defaulting to the latest", async () => {
  await act(async () => root.render(<App />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Toggle tools panel"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Diff"]')!.click());

  await vi.waitFor(() => expect(host.querySelector('select[aria-label="Turn"]')).not.toBeNull());
  const picker = host.querySelector<HTMLSelectElement>('select[aria-label="Turn"]')!;
  expect(picker.value).toBe("1");
  expect(host.textContent).toContain("turn1.rs");

  await act(async () => {
    picker.value = "0";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(calls.filter(({ command }) => command === "git_turn_diff").at(-1)?.args).toEqual({ threadId: 2, turnIndex: 0 });
  expect(host.textContent).toContain("turn0.rs");
});
