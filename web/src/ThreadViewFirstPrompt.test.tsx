// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

type Call = { command: string; args: unknown };

const freshThread = {
  id: 3,
  projectId: 1,
  provider: "claude",
  model: null,
  effort: null,
  permissionMode: "auto-edit",
  status: "completed" as const,
  title: null,
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
  const calls: Call[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "subscribe_thread":
        return {
          thread: freshThread,
          capabilities: { reasoningText: true },
          turns: [],
          turnOffset: 0,
          turnCount: 0,
          lastSeq: 0,
          supportedPermissionModes: ["ask", "auto-edit", "full-access"],
        };
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {} }, errors: [] };
      case "get_provider_capabilities": return { supportedPermissionModes: ["ask", "auto-edit", "full-access"] };
      case "git_status": return { branch: "main", added: 0, removed: 0, changedFiles: 0, protected: false, unpublished: false };
      case "get_model_catalog": case "list_slash_commands": return [];
      case "list_turns": return { offset: 0, turns: [], turnCount: 0 };
      case "send_prompt": return null;
      case "create_file": case "write_file": case "find_files": return null;
      default: return null;
    }
  });
  return calls;
}

const render = (draft: string) => act(async () => root.render(
  <ThreadView
    threadId={3}
    projectId={1}
    draft={draft}
    onThreadCreated={vi.fn()}
    onStatusChange={vi.fn()}
    prefill={null}
    onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()}
    onThreadContinued={vi.fn()}
  />,
));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const editor = () => container.querySelector<HTMLElement>('[role="textbox"]')!;
const send = () => act(async () => container.querySelector("form")!.requestSubmit());

it("sends the first prompt of a fresh chat Thread, which gives it its own worktree", async () => {
  const calls = setup();
  await render("Fix the login bug");
  await flush();
  expect(editor().textContent).toBe("Fix the login bug");
  await send();
  await flush();
  expect(calls.find(({ command }) => command === "send_prompt")?.args).toEqual({
    threadId: 3,
    segments: [{ kind: "text", text: "Fix the login bug" }],
  });
});
