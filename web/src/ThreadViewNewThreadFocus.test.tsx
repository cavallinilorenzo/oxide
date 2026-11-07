// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

const thread = {
  id: 3,
  projectId: 1,
  provider: "antigravity",
  model: null,
  effort: null,
  permissionMode: "auto-edit" as const,
  status: "completed" as const,
  title: "New Thread",
  sessionLost: false,
  continuedFrom: null,
  continuedIn: null,
  branch: null,
  worktreePath: null,
  setupOutput: null,
  issueNumber: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function setup() {
  mockIPC((command) => {
    switch (command) {
      case "subscribe_thread":
        return { thread, capabilities: { reasoningText: true }, turns: [], turnOffset: 0, turnCount: 0, lastSeq: 0, supportedPermissionModes: [] };
      case "get_settings": return { settings: { defaultProvider: "antigravity", providers: {} }, errors: [] };
      case "get_provider_capabilities": return { supportedPermissionModes: [], reportsUsageLimits: false, midThreadModelSwitch: true };
      case "get_model_catalog": case "list_slash_commands": return [];
      case "git_status": return { branch: "main", changedFiles: 0 };
      default: return null;
    }
  });
}

type FocusRequest = { threadId: number; id: number } | null;
const render = (newThreadFocus: FocusRequest, onNewThreadFocusHandled = vi.fn()) => act(async () => root.render(
  <ThreadView
    threadId={3}
    projectId={1}
    initialProvider="antigravity"
    newThreadFocus={newThreadFocus}
    onNewThreadFocusHandled={onNewThreadFocusHandled}
    onThreadCreated={vi.fn()}
    onStatusChange={vi.fn()}
    prefill={null}
    onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()}
    onThreadContinued={vi.fn()}
  />,
));

const editor = () => host.querySelector<HTMLElement>('[role="textbox"]')!;
const composer = () => host.querySelector<HTMLFormElement>("form.composer")!;

it("focuses the composer and shows a short cue when New Thread reopens the empty Thread", async () => {
  setup();
  await render(null);
  expect(document.activeElement).not.toBe(editor());

  const handled = vi.fn();
  await render({ threadId: 3, id: 1 }, handled);

  expect(document.activeElement).toBe(editor());
  expect(composer().className).toContain("composer-focus-cue");
  expect(handled).toHaveBeenCalledTimes(1);

  // The cue is feedback, not a permanent state.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)); });
  expect(composer().className).not.toContain("composer-focus-cue");
});

it("does not move focus when the request belongs to another Thread", async () => {
  setup();
  await render({ threadId: 4, id: 1 });

  expect(document.activeElement).not.toBe(editor());
  expect(composer().className).not.toContain("composer-focus-cue");
});
