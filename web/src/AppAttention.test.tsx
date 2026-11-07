// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { App } from "./App";

vi.mock("./ThreadView", () => ({
  ThreadView: ({ threadId }: { threadId: number }) => <div>
    <span data-testid="thread">{threadId}</span>
    <div role="textbox" contentEditable aria-label="Message" suppressContentEditableWarning />
    {threadId === 20 && <div aria-label="Approval" className="approval-card pending"><button className="approval-btn allow">Allow</button></div>}
  </div>,
}));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./BoardView", () => ({ BoardView: ({ projectId }: { projectId: number }) => <main aria-label="Thread Board">Board {projectId}</main> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
const container = document.createElement("div"); document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

const project = (id: number, name: string) => ({ id, name, path: `/${name}`, hidden: false, open: true, missing: false });
const thread = (id: number, projectId: number, status: string, extra: { title?: string; branch?: string } = {}) => ({
  id, projectId, title: extra.title ?? `T${id}`, status, provider: "codex", updatedAt: "2026-01-01T00:00:00Z",
  branch: extra.branch ?? null, worktreePath: extra.branch ? `/wt/${extra.branch}` : null,
});
const card = (t: ReturnType<typeof thread>, approvals = 0) => ({
  thread: t, pullRequest: null,
  pendingApprovals: Array.from({ length: approvals }, () => ({ approvalId: "a1", kind: "command", summary: "rm", options: [] })),
});

type Thread = ReturnType<typeof thread>;
type BoardCard = ReturnType<typeof card>;
function setup(fixture?: { threads?: Record<number, Thread[]>; boards?: Record<number, BoardCard[]> }) {
  const channels: Record<number, { onmessage: (event: unknown) => void }> = {};
  const threads: Record<number, Thread[]> = fixture?.threads ?? { 1: [thread(10, 1, "working")], 2: [thread(20, 2, "needs-input")] };
  mockIPC((command, args) => {
    const a = args as { projectId?: number; onEvent?: { onmessage: (event: unknown) => void } };
    if (command === "list_projects" || command === "rescan_projects") return [project(1, "Alpha"), project(2, "Beta")];
    if (command === "last_selection") return { projectId: 1, threadId: 10 };
    if (command === "list_threads") return threads[a.projectId!];
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {} }, errors: [] };
    if (command === "subscribe_board") {
      channels[a.projectId!] = a.onEvent!;
      return fixture?.boards?.[a.projectId!] ?? (a.projectId === 2 ? [card(threads[2][0], 1)] : [card(threads[1][0])]);
    }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
  return channels;
}
const attentionButton = () => container.querySelector<HTMLButtonElement>(".attention-btn")!;
const attentionDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const attentionItem = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".attention-item")]
  .find((button) => button.textContent?.includes(text))!;
const shownThread = () => container.querySelector('[data-testid="thread"]')?.textContent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
});

/** Alpha has an error and an interrupted Thread; Beta has a pending Approval on a branch. */
function richSetup() {
  const threads: Record<number, Thread[]> = {
    1: [
      thread(10, 1, "working", { title: "Alpha work" }),
      thread(11, 1, "error", { title: "Build failed", branch: "fix/build" }),
      thread(12, 1, "interrupted", { title: "Lost session" }),
    ],
    2: [thread(20, 2, "needs-input", { title: "Release check", branch: "feat/beta" })],
  };
  return setup({
    threads,
    boards: { 1: threads[1].map((t) => card(t)), 2: [card(threads[2][0], 1)] },
  });
}

it("shows attention for a background Project and jumps to its pending Approval from the tray", async () => {
  setup();
  await act(async () => root.render(<App />));
  expect(shownThread()).toBe("10");
  expect(attentionButton().getAttribute("aria-label")).toBe("1 Thread needs you: 1 waiting for input (1 Approval)");
  await act(async () => attentionButton().click());
  await act(async () => attentionItem("T20").click());
  await settle();
  expect(shownThread()).toBe("20");
  expect(document.activeElement?.className).toContain("approval-btn");
  expect(attentionDialog()).toBeNull();
});

it("toggles an accessible Attention Center dialog from the bell", async () => {
  setup();
  await act(async () => root.render(<App />));
  const bell = attentionButton();
  expect(bell.getAttribute("aria-haspopup")).toBe("dialog");
  expect(bell.getAttribute("aria-expanded")).toBe("false");
  await act(async () => bell.click());
  expect(bell.getAttribute("aria-expanded")).toBe("true");
  expect(attentionDialog()?.getAttribute("aria-label")).toBe("Attention Center");
  await act(async () => bell.click());
  expect(bell.getAttribute("aria-expanded")).toBe("false");
  expect(attentionDialog()).toBeNull();
});

it("lists pending Threads by Project with their branch and urgency reason", async () => {
  richSetup();
  await act(async () => root.render(<App />));
  await act(async () => attentionButton().click());
  const dialog = attentionDialog()!;
  const group = (name: string) => [...dialog.querySelectorAll<HTMLElement>(".attention-group")]
    .find((section) => section.querySelector("h3")?.textContent === name)!;
  expect([...dialog.querySelectorAll(".attention-group h3")].map((heading) => heading.textContent)).toEqual(["Alpha", "Beta"]);
  const alpha = group("Alpha");
  expect(alpha.textContent).toContain("Build failed");
  expect(alpha.textContent).toContain("fix/build");
  expect(alpha.textContent).toContain("Failed Turn");
  expect(alpha.textContent).toContain("Lost session");
  expect(alpha.textContent).toContain("Interrupted");
  expect(alpha.textContent).not.toContain("Release check");
  const beta = group("Beta");
  expect(beta.textContent).toContain("Release check");
  expect(beta.textContent).toContain("feat/beta");
  expect(beta.textContent).toContain("Pending Approval");
  expect(beta.textContent).toContain("rm");
  expect(dialog.textContent).not.toContain("Alpha work");
});

it("clicking a tray item navigates, focuses its action card and closes the tray", async () => {
  richSetup();
  await act(async () => root.render(<App />));
  expect(shownThread()).toBe("10");
  await act(async () => attentionButton().click());
  await act(async () => attentionItem("Release check").click());
  await settle();
  expect(shownThread()).toBe("20");
  expect(document.activeElement?.className).toContain("approval-btn");
  expect(attentionDialog()).toBeNull();
  expect(attentionButton().getAttribute("aria-expanded")).toBe("false");
});

it("closes the tray on Escape and returns focus to the bell", async () => {
  setup();
  await act(async () => root.render(<App />));
  const bell = attentionButton();
  bell.focus();
  await act(async () => bell.click());
  expect(attentionDialog()).not.toBeNull();
  await press("Escape");
  expect(attentionDialog()).toBeNull();
  expect(document.activeElement).toBe(bell);
});

it("closes the tray when clicking outside it", async () => {
  setup();
  await act(async () => root.render(<App />));
  await act(async () => attentionButton().click());
  expect(attentionDialog()).not.toBeNull();
  await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  expect(attentionDialog()).toBeNull();
});

it("jumps straight to the most urgent item from the keyboard without opening the tray", async () => {
  richSetup();
  await act(async () => root.render(<App />));
  expect(shownThread()).toBe("10");
  await press("a", { ctrlKey: true, shiftKey: true });
  await settle();
  expect(shownThread()).toBe("20");
  expect(document.activeElement?.className).toContain("approval-btn");
  expect(attentionDialog()).toBeNull();
  expect(attentionButton().getAttribute("aria-expanded")).toBe("false");
});

it("updates the indicator from background events without moving focus or the selection", async () => {
  const channels = setup();
  await act(async () => root.render(<App />));
  const input = container.querySelector<HTMLElement>('[role="textbox"]')!;
  input.focus();
  await act(async () => channels[1].onmessage({ type: "ThreadChanged", payload: { ...card({ ...thread(10, 1, "error") }), thread: { ...thread(10, 1, "error"), updatedAt: "2026-01-02T00:00:00Z" } } }));
  expect(attentionButton().getAttribute("aria-label")).toContain("2 Threads need you");
  expect(attentionButton().getAttribute("aria-label")).toContain("1 error");
  expect(document.activeElement).toBe(input);
  expect(shownThread()).toBe("10");
});

it("keeps an always-visible Board button per Project that toggles the Board and restores the Thread", async () => {
  setup();
  await act(async () => root.render(<App />));
  const boardButton = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="Thread Board of ${name}"]`)!;
  expect(boardButton("Alpha")).not.toBeNull();
  expect(boardButton("Beta")).not.toBeNull();
  await act(async () => boardButton("Alpha").click());
  expect(container.textContent).toContain("Board 1");
  expect(boardButton("Alpha").getAttribute("aria-pressed")).toBe("true");
  await act(async () => boardButton("Alpha").click());
  expect(container.textContent).not.toContain("Board 1");
  expect(shownThread()).toBe("10");
});
