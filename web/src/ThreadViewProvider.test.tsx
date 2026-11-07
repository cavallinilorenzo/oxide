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

const thread = (id: number, provider: string) => ({
  id,
  projectId: 1,
  provider,
  model: null,
  effort: null,
  permissionMode: "auto-edit" as const,
  status: "completed" as const,
  title: `Thread ${id}`,
  sessionLost: false,
  continuedFrom: null,
  continuedIn: null,
  branch: null,
  worktreePath: null,
  setupOutput: null,
  issueNumber: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const snapshot = (id: number, provider: string) => ({
  thread: thread(id, provider),
  capabilities: { reasoningText: true },
  turns: [],
  turnOffset: 0,
  turnCount: 0,
  lastSeq: 0,
  supportedPermissionModes: [],
});

function mockThreadCalls(onSubscribe: (command: string, args: unknown) => unknown) {
  mockIPC((command, args) => {
    const subscribe = onSubscribe(command, args);
    if (subscribe !== undefined) return subscribe;
    switch (command) {
      case "get_settings": return { settings: { defaultProvider: "antigravity", providers: {} }, errors: [] };
      case "get_provider_capabilities": return { supportedPermissionModes: [], reportsUsageLimits: false, midThreadModelSwitch: true };
      case "get_model_catalog": case "list_slash_commands": return [];
      case "git_status": return { branch: "main", changedFiles: 0 };
      default: return null;
    }
  });
}

const render = (threadId: number | null, initialProvider?: string) => act(async () => root.render(
  <ThreadView
    threadId={threadId}
    projectId={1}
    initialProvider={initialProvider}
    onThreadCreated={vi.fn()}
    onStatusChange={vi.fn()}
    prefill={null}
    onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()}
    onThreadContinued={vi.fn()}
  />,
));

it("renders a new Thread with the configured default Provider before its Transcript arrives", async () => {
  let finish!: (value: unknown) => void;
  mockThreadCalls((command) => command === "subscribe_thread" ? new Promise((resolve) => { finish = resolve; }) : undefined);

  await render(8, "antigravity");

  // The header avatar and the composer mark are Provider identity: both are right at once,
  // while the Transcript is still loading.
  expect(host.querySelector('.thread-avatar [aria-label="Antigravity"]')).not.toBeNull();
  expect(host.querySelector('.thread-avatar [aria-label="Claude Code"]')).toBeNull();
  expect(host.querySelector('[aria-label="Model: antigravity"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Model: claude"]')).toBeNull();
  expect(host.textContent).not.toContain("Claude");

  await act(async () => finish(snapshot(8, "antigravity")));
});

it("starts a new Thread with no branding until Settings name the default Provider", async () => {
  let finishSettings!: (value: unknown) => void;
  mockIPC((command) => {
    switch (command) {
      // The Transcript never arrives while the test looks at the draft.
      case "subscribe_thread": return new Promise(() => {});
      case "get_settings": return new Promise((resolve) => { finishSettings = resolve; });
      case "get_provider_capabilities": return { supportedPermissionModes: [], reportsUsageLimits: false, midThreadModelSwitch: true };
      case "get_model_catalog": case "list_slash_commands": return [];
      case "git_status": return { branch: "main", changedFiles: 0 };
      default: return null;
    }
  });

  await render(null);

  // Settings still loading: no Provider is guessed, so no brand mark and no "Claude" anywhere.
  expect(host.textContent).not.toContain("Claude");
  expect(host.querySelector('.thread-avatar [aria-label="Claude Code"]')).toBeNull();

  await act(async () => finishSettings({ settings: { defaultProvider: "antigravity", providers: {} }, errors: [] }));

  expect(host.querySelector('.thread-avatar [aria-label="Antigravity"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Model: antigravity"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Claude");
});

it("switches Provider branding immediately when another Thread is selected", async () => {
  let defer = false;
  let finish!: (value: unknown) => void;
  mockThreadCalls((command, args) => {
    if (command !== "subscribe_thread") return undefined;
    if (defer) return new Promise((resolve) => { finish = resolve; });
    return snapshot((args as { threadId: number }).threadId, "codex");
  });

  await render(7, "codex");
  expect(host.querySelector('.thread-avatar [aria-label="Codex"]')).not.toBeNull();

  defer = true;
  await render(8, "antigravity");
  expect(host.querySelector('.thread-avatar [aria-label="Antigravity"]')).not.toBeNull();
  expect(host.querySelector('.thread-avatar [aria-label="Codex"]')).toBeNull();

  await act(async () => finish(snapshot(8, "antigravity")));
});
