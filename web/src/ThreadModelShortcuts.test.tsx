// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";
import { resetCatalogCache } from "./modelCatalogCache";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); resetCatalogCache(); });

const model = (id: string, name: string, efforts: string[], def: string | null) =>
  ({ id, name, description: null, isLegacy: false, supportedEfforts: efforts, defaultEffort: def });
const catalogs: Record<string, unknown[]> = {
  claude: [model("opus", "Opus", ["low", "high"], "high"), model("sonnet", "Sonnet", ["low", "medium", "high"], "medium"), model("haiku", "Haiku", [], null)],
  codex: [model("gpt", "GPT", ["medium"], "medium")],
  antigravity: [],
};

type Call = { command: string; args: Record<string, unknown> };
function setup(opts: { threadId: number | null; status?: string; turnCount?: number; midThread?: boolean; favourites?: string[]; effort?: string } ) {
  const calls: Call[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    if (command === "subscribe_thread") return {
      thread: { id: 7, projectId: 1, title: "T", provider: "claude", model: "opus", effort: opts.effort ?? "high", permissionMode: "auto-edit", status: opts.status ?? "completed" },
      capabilities: {}, turns: [], turnOffset: opts.turnCount ?? 0, turnCount: opts.turnCount ?? 0, lastSeq: 0, supportedPermissionModes: ["auto-edit"],
    };
    if (command === "get_settings") return { settings: { defaultProvider: "claude", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit"], midThreadModelSwitch: opts.midThread ?? true };
    if (command === "get_favourite_models") return opts.favourites ?? ["sonnet", "gpt", "haiku"];
    if (command === "get_model_catalog") return catalogs[(args as { provider: string }).provider] ?? [];
    if (command === "git_status") return { branch: "main" };
    if (command === "list_slash_commands") return [];
    return null;
  });
  return calls;
}
const render = (threadId: number | null, draft = "") => act(async () => root.render(
  <ThreadView threadId={threadId} projectId={1} projectPath="/test" draft={draft}
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
const press = (init: KeyboardEventInit) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const label = (name: string) => container.querySelector(`[aria-label^="${name}"]`)?.textContent ?? "";
const setCalls = (calls: Call[]) => calls.filter((c) => c.command === "set_thread_model_and_effort").map((c) => c.args);

it("⌘n switches to the nth Favourite Model, keeping the Effort it supports", async () => {
  const calls = setup({ threadId: 7, effort: "low" });
  await render(7);
  await press({ code: "Digit1", key: "1", metaKey: true });
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "sonnet", effort: "low" }]);
  expect(label("Model")).toContain("Sonnet");
});

it("falls back to the default Effort when the Favourite doesn't support the current one", async () => {
  const calls = setup({ threadId: 7, effort: "high" });
  await render(7);
  await press({ code: "Digit2", key: "2", ctrlKey: true });
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "haiku", effort: null }]);
});

it("does nothing for ⌘n beyond the Favourites, or with extra modifiers", async () => {
  const calls = setup({ threadId: 7 });
  await render(7);
  await press({ code: "Digit9", key: "9", metaKey: true });
  await press({ code: "Digit1", key: "1", metaKey: true, altKey: true });
  await press({ code: "Digit1", key: "!", metaKey: true, shiftKey: true });
  await flush();
  expect(setCalls(calls)).toEqual([]);
});

it("starts a new Thread for another Provider's Favourite once the Thread has Turns", async () => {
  const calls = setup({ threadId: 7, turnCount: 2 });
  await render(7);
  await press({ code: "Digit3", key: "3", metaKey: true });
  await flush();
  expect(setCalls(calls)).toEqual([]);
  expect(calls.find((c) => c.command === "create_thread")?.args).toMatchObject({ provider: "codex", model: "gpt", effort: "medium" });
});

it("respects the mid-Thread lock for a same-Provider Favourite", async () => {
  const calls = setup({ threadId: 7, turnCount: 2, midThread: false });
  await render(7);
  await press({ code: "Digit1", key: "1", metaKey: true });
  await flush();
  expect(setCalls(calls)).toEqual([]);
  expect(calls.some((c) => c.command === "create_thread")).toBe(false);
});

it("does nothing while a Turn is running", async () => {
  const calls = setup({ threadId: 7, status: "working" });
  await render(7);
  await press({ code: "Digit1", key: "1", metaKey: true });
  await press({ key: "M", code: "KeyM", metaKey: true, shiftKey: true });
  await flush();
  expect(setCalls(calls)).toEqual([]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("remembers a Favourite switch in a new-Thread draft without touching the draft text", async () => {
  const calls = setup({ threadId: null });
  await render(null, "half-written");
  await press({ code: "Digit3", key: "3", metaKey: true });
  await flush();
  expect(calls.some((c) => c.command === "set_thread_model_and_effort")).toBe(false);
  expect(label("Model")).toContain("GPT");
  expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("half-written");
  expect(localStorage.length).toBeGreaterThan(0);
});

it("⌘⇧M toggles the Model picker and ⌘⇧E the Effort menu, switching between them", async () => {
  setup({ threadId: 7 });
  await render(7);
  const m = { key: "M", code: "KeyM", metaKey: true, shiftKey: true };
  const e = { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true };
  await press(m);
  expect(container.querySelector('[aria-label="Model Selector"]')).not.toBeNull();
  await press(m);
  expect(container.querySelector('[aria-label="Model Selector"]')).toBeNull();
  await press(e);
  expect(container.querySelector(".effort-menu")).not.toBeNull();
  await press(m);
  expect(container.querySelector('[aria-label="Model Selector"]')).not.toBeNull();
  await press(e);
  expect(container.querySelector(".effort-menu")).not.toBeNull();
  await press(e);
  expect(container.querySelector(".effort-menu")).toBeNull();
});

it("picks the nth Effort level with a bare digit while the Effort menu is open", async () => {
  const calls = setup({ threadId: 7, effort: "high" });
  await render(7);
  await press({ key: "E", code: "KeyE", metaKey: true, shiftKey: true });
  await flush();
  expect(Array.from(container.querySelectorAll(".effort-option")).map((o) => o.textContent)).toEqual(["Low1", "High2"]);
  await press({ key: "1", code: "Digit1" });
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "opus", effort: "low" }]);
  expect(container.querySelector(".effort-menu")).toBeNull();
});

it("returns focus to the composer after closing a shortcut-opened picker", async () => {
  setup({ threadId: 7 });
  await render(7);
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  box.focus();
  await press({ key: "E", code: "KeyE", metaKey: true, shiftKey: true });
  await press({ key: "E", code: "KeyE", metaKey: true, shiftKey: true });
  expect(document.activeElement).toBe(box);
});
