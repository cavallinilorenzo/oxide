// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({ ThreadView: ({ threadId }: { threadId: number }) => <div data-testid="thread">{threadId}</div> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
const acceptedThread = {
  id: 9, projectId: 1, title: "Propose a rule", provider: "claude", status: "working",
  updatedAt: "2026-01-01T00:00:00Z",
};
type Suggestion = { id: number; projectId: number; comments: string[] };
let suggestions: Suggestion[];
const calls: { command: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  suggestions = [
    {
      id: 7,
      projectId: 1,
      comments: [
        "Please validate the input before using it",
        "Always validate the input before using it",
        "Please validate the input before using it",
      ],
    },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: null };
    if (command === "list_threads") return [];
    if (command === "rule_suggestions") return suggestions;
    if (command === "dismiss_rule_suggestion") {
      suggestions = suggestions.filter((suggestion) => suggestion.id !== args.id);
      return null;
    }
    if (command === "get_settings") {
      return { settings: { defaultProvider: "claude", providers: {} }, errors: [] };
    }
    if (command === "accept_rule_suggestion") {
      suggestions = suggestions.filter((suggestion) => suggestion.id !== args.id);
      return acceptedThread;
    }
    if (command === "subscribe_board") return [];
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

const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find((element) => element.textContent === name);

async function overview() {
  await act(async () => root.render(<App />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
}

it("shows the comments a rule suggestion is based on in the Project overview", async () => {
  await overview();
  const section = host.querySelector('[aria-label="Rule suggestions"]')!;
  expect(section).not.toBeNull();
  expect(section.textContent).toContain("3 similar comments");
  expect(section.textContent).toContain("Always validate the input before using it");
  expect(section.textContent).toContain("Please validate the input before using it");
});

it("dismisses a rule suggestion for good", async () => {
  await overview();
  await act(async () => button("Dismiss")!.click());
  expect(calls.filter((call) => call.command === "dismiss_rule_suggestion")).toEqual([
    { command: "dismiss_rule_suggestion", args: { projectId: 1, id: 7 } },
  ]);
  expect(host.querySelector('[aria-label="Rule suggestions"]')).toBeNull();
});

it("starts a Thread that proposes the rule from the Settings default Provider", async () => {
  await overview();
  await act(async () => button("Accept")!.click());

  expect(calls.filter((call) => call.command === "accept_rule_suggestion")).toEqual([
    { command: "accept_rule_suggestion", args: { projectId: 1, id: 7, provider: "claude" } },
  ]);
  expect(host.querySelector('[data-testid="thread"]')?.textContent).toBe("9");
  expect(host.querySelector('[aria-label="Rule suggestions"]')).toBeNull();
});
