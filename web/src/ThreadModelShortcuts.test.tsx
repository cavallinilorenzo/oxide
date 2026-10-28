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
  antigravity: [model("gem-low", "Gem (Low)", ["low", "high"], "high"), model("gem-high", "Gem (High)", ["low", "high"], "high")],
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

const M = { key: "M", code: "KeyM", metaKey: true, shiftKey: true };
const key = (k: string, init: KeyboardEventInit = {}) => press({ key: k, code: k, ...init });
const dialog = () => container.querySelector('[role="dialog"]');
const highlighted = () => container.querySelector('[role="option"][aria-selected="true"] .model-name')?.textContent ?? null;
const slider = () => container.querySelector('[role="slider"]')?.getAttribute("aria-valuetext") ?? null;
const activeTab = () => container.querySelector('.rail-tab[aria-current="true"]')?.textContent ?? null;
const type = (text: string) => act(async () => {
  const input = container.querySelector(".model-search-input") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const open = async (opts: Parameters<typeof setup>[0] = { threadId: 7 }) => {
  const calls = setup(opts);
  await render(7);
  await press(M);
  await flush();
  return calls;
};

it("⌘⇧M toggles the Model picker and ⌘⇧E does nothing", async () => {
  setup({ threadId: 7 });
  await render(7);
  await press({ key: "E", code: "KeyE", ctrlKey: true, shiftKey: true });
  expect(dialog()).toBeNull();
  await press(M);
  expect(dialog()).not.toBeNull();
  await press({ key: "E", code: "KeyE", metaKey: true, shiftKey: true });
  expect(dialog()).not.toBeNull();
  await press(M);
  expect(dialog()).toBeNull();
});

it("shows Model and Effort in one composer control that opens the picker", async () => {
  setup({ threadId: 7 });
  await render(7);
  const control = container.querySelector('[aria-label^="Model"]') as HTMLButtonElement;
  expect(control.getAttribute("aria-label")).toBe("Model: Opus, Effort: High");
  expect(control.textContent).toContain("Opus · High");
  expect(container.querySelector('[aria-label="Effort"]')).toBeNull();
  await act(async () => control.click());
  expect(dialog()).not.toBeNull();
});

it("starts on the current Model and Effort, and ↑/↓ wrap around", async () => {
  await open();
  expect(highlighted()).toBe("Opus");
  expect(slider()).toBe("High");
  await key("ArrowDown");
  expect(highlighted()).toBe("Sonnet");
  await key("ArrowDown");
  await key("ArrowDown");
  expect(highlighted()).toBe("Opus");
  await key("ArrowUp");
  expect(highlighted()).toBe("Haiku");
});

it("←/→ step the Effort and stop at the ends; Enter applies only the Effort on the current Model", async () => {
  const calls = await open();
  await key("ArrowRight");
  expect(slider()).toBe("High");
  await key("ArrowLeft");
  await key("ArrowLeft");
  expect(slider()).toBe("Low");
  await key("Enter");
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "opus", effort: "low" }]);
  expect(dialog()).toBeNull();
});

it("carries the Effort to a Model that supports it and falls back to the default otherwise", async () => {
  await open();
  await key("ArrowLeft");
  expect(slider()).toBe("Low");
  await key("ArrowDown");
  expect(highlighted()).toBe("Sonnet");
  expect(slider()).toBe("Low");
  await key("ArrowDown");
  expect(highlighted()).toBe("Haiku");
  expect(slider()).toBeNull();
  expect(container.textContent).toContain("This model has no effort levels.");
  await key("ArrowRight");
  await key("ArrowLeft");
  await key("ArrowUp");
  expect(slider()).toBe("Medium");
});

it("Enter applies the highlighted Model with its Effort in one call", async () => {
  const calls = await open();
  await key("ArrowDown");
  await key("ArrowRight");
  await key("Enter");
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "sonnet", effort: "high" }]);
});

it("Esc closes the picker without applying anything", async () => {
  const calls = await open();
  await key("ArrowDown");
  await key("ArrowLeft");
  await key("Escape");
  await flush();
  expect(dialog()).toBeNull();
  expect(setCalls(calls)).toEqual([]);
});

it("clicking a Model row applies it, and a slider stop picks the Effort", async () => {
  const calls = await open();
  await act(async () => (Array.from(container.querySelectorAll(".effort-stop")).find((b) => b.textContent === "Low") as HTMLElement).click());
  expect(slider()).toBe("Low");
  await act(async () => (Array.from(container.querySelectorAll('[role="option"]')).find((o) => o.textContent?.includes("Sonnet")) as HTMLElement).click());
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "sonnet", effort: "low" }]);
});

it("Tab and Shift+Tab cycle the tabs and keep the search text", async () => {
  await open();
  expect(activeTab()).toContain("Claude");
  await type("g");
  await key("Tab");
  expect(activeTab()).toContain("Codex");
  expect(highlighted()).toBe("GPT");
  expect((container.querySelector(".model-search-input") as HTMLInputElement).value).toBe("g");
  await key("Tab", { shiftKey: true });
  await key("Tab", { shiftKey: true });
  expect(activeTab()).toContain("Favourites");
  await key("Tab", { shiftKey: true });
  expect(activeTab()).toContain("Antigravity");
});

it("says so when the highlighted Model is from another Provider and the Thread has Turns", async () => {
  await open({ threadId: 7, turnCount: 2 });
  expect(container.textContent).not.toContain("starts a new Thread");
  await key("Tab");
  expect(container.textContent).toContain("starts a new Thread");
});

it("Enter does nothing when the search matches nothing", async () => {
  const calls = await open();
  await type("zzz");
  expect(container.textContent).toContain("No models found.");
  await key("Enter");
  await flush();
  expect(setCalls(calls)).toEqual([]);
  expect(dialog()).not.toBeNull();
});

it("starts a new Thread with the chosen Effort for another Provider's Model once the Thread has Turns", async () => {
  const calls = await open({ threadId: 7, turnCount: 2 });
  await key("Tab");
  await key("Enter");
  await flush();
  expect(setCalls(calls)).toEqual([]);
  expect(calls.find((c) => c.command === "create_thread")?.args).toMatchObject({ provider: "codex", model: "gpt", effort: "medium" });
});

it("skips locked Models with ↑/↓ but still changes the Effort of the current Model", async () => {
  const calls = await open({ threadId: 7, turnCount: 2, midThread: false });
  await key("ArrowDown");
  await key("ArrowUp");
  expect(highlighted()).toBe("Opus");
  await key("ArrowLeft");
  await key("Enter");
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "opus", effort: "low" }]);
});

it("resolves an effort-split Antigravity Model to the variant matching the Effort", async () => {
  const calls = await open();
  await key("Tab");
  await key("Tab");
  expect(activeTab()).toContain("Antigravity");
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(highlighted()).toBe("Gem");
  await key("ArrowLeft");
  await key("Enter");
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "gem-low", effort: "low" }]);
});

it("⌘n inside the picker applies the nth visible Model with its Effort", async () => {
  const calls = await open();
  await key("2", { code: "Digit2", metaKey: true });
  await flush();
  expect(setCalls(calls)).toEqual([{ threadId: 7, model: "sonnet", effort: "high" }]);
  expect(dialog()).toBeNull();
});

it("/effort with no argument opens the picker", async () => {
  setup({ threadId: 7 });
  await render(7);
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "/effort");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  await flush();
  expect(dialog()).not.toBeNull();
  expect(highlighted()).toBe("Opus");
});

it("returns focus to the composer after closing the picker, leaving the draft alone", async () => {
  setup({ threadId: 7 });
  await render(7, "keep me");
  const box = container.querySelector("textarea") as HTMLTextAreaElement;
  box.focus();
  await press(M);
  await key("ArrowLeft");
  await key("Escape");
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe("keep me");
});
