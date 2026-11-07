// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";
import { encodeDraft } from "./attachments";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

it("intercepts an unavailable permission mode before a Thread exists", async () => {
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "get_settings") return { settings: { defaultProvider: "agy", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit", "full-access"] };
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog" || command === "list_slash_commands") return [];
    return null;
  });
  await act(async () => root.render(<ThreadView threadId={null} projectId={1} draft="/permissions ask"
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.textContent).toContain("Ask is not offered");
  expect(calls).not.toContain("create_thread");
  expect(calls).not.toContain("send_prompt");
  expect(container.querySelector('[aria-label^="Permission mode:"]')?.getAttribute("aria-label")).toContain("Auto-edit");
});


it("loads capabilities before applying a permission command in a new Thread", async () => {
  let requests = 0;
  mockIPC((command) => {
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") {
      requests++;
      return requests < 3 ? new Promise(() => {}) : { supportedPermissionModes: ["ask", "auto-edit", "full-access"] };
    }
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog" || command === "list_slash_commands") return [];
    return null;
  });
  await act(async () => root.render(<ThreadView threadId={null} projectId={1} draft="/permissions full"
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.querySelector('[aria-label^="Permission mode:"]')?.getAttribute("aria-label")).toContain("Full access");
  expect(container.textContent).not.toContain("not offered");
});


it.each(["claude", "codex", "agy"])("intercepts commands in a %s Thread without sending a Turn", async (provider) => {
  const calls: { command: string; args: unknown }[] = [];
  const openDiff = vi.fn();
  const titleChanged = vi.fn();
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "subscribe_thread") return {
      thread: { id: 7, projectId: 1, title: "Old", provider, permissionMode: "auto-edit", status: "completed" },
      capabilities: {}, turns: [], turnOffset: 0, turnCount: 0, lastSeq: 0,
      supportedPermissionModes: provider === "agy" ? ["auto-edit", "full-access"] : ["ask", "auto-edit", "full-access"],
    };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: provider === "agy" ? ["auto-edit", "full-access"] : ["ask", "auto-edit", "full-access"] };
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog" || command === "list_slash_commands") return [];
    return null;
  });
  const render = (draft: string) => <ThreadView threadId={7} projectId={1} draft={draft}
    onOpenDefaultDiff={openDiff} onThreadCreated={vi.fn()} onStatusChange={vi.fn()} onThreadTitleChange={titleChanged}
    prefill={null} onPrefillUsed={vi.fn()} onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />;
  await act(async () => root.render(render("/rename New title")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(calls.some((c) => c.command === "rename_thread" && (c.args as { title: string }).title === "New title")).toBe(true);
  expect(titleChanged).toHaveBeenCalledWith(7, "New title");
  await act(async () => root.render(render("/diff")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(openDiff).toHaveBeenCalledOnce();

  await act(async () => root.render(render("/reload-cache")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(calls.some((c) => c.command === "list_slash_commands" && (c.args as { refresh: boolean; threadId: number }).refresh && (c.args as { threadId: number }).threadId === 7)).toBe(true);


  await act(async () => root.render(render("/permissions full")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(calls.some((c) => c.command === "set_thread_permission_mode" && (c.args as { permissionMode: string }).permissionMode === "full-access")).toBe(true);
  expect(calls.some((c) => c.command === "send_prompt")).toBe(false);
});


it("reports a failed cache reload without sending the command to the provider", async () => {
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "get_settings") return { settings: { defaultProvider: "agy", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit"] };
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog") return [];
    if (command === "list_slash_commands") throw "provider unavailable";
    return null;
  });
  await act(async () => root.render(<ThreadView threadId={null} projectId={1} draft="/reload-cache"
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.textContent).toContain("Could not refresh the Slash command catalog");
  expect(calls).not.toContain("send_prompt");
  expect(calls).not.toContain("create_thread");
});

// ---- Slash menu ergonomics, /clear and /model ----

type Call = { command: string; args: Record<string, unknown> };
const model = (id: string, name: string, efforts: string[], effort: string | null, isLegacy = false) =>
  ({ id, name, description: null, supportedEfforts: efforts, defaultEffort: effort, isLegacy });
const claudeCatalog = [
  model("opus", "Opus", ["low", "high"], "high"),
  model("sonnet", "Sonnet", ["low", "medium", "high"], "medium"),
  model("haiku", "Haiku", [], null),
];
/** More commands than fit a short menu, so Arrow navigation really has somewhere to scroll. */
const menuCommands = [
  { name: "clear", description: "Start a fresh Thread", argumentHint: null, aliases: ["reset", "new"], route: "oxide" },
  { name: "model", description: "Switch model", argumentHint: "<model>", aliases: [], route: "oxide" },
  { name: "effort", description: "Set effort", argumentHint: "[level]", aliases: [], route: "oxide" },
  { name: "compact", description: "Compact the Thread", argumentHint: "<instructions>", aliases: [], route: "passthrough" },
  { name: "diff", description: "Open the Diff", argumentHint: null, aliases: [], route: "oxide" },
  { name: "context", description: "Show context", argumentHint: null, aliases: [], route: "oxide" },
  { name: "init", description: "Initialise", argumentHint: null, aliases: [], route: "passthrough" },
  { name: "review", description: "Review changes", argumentHint: null, aliases: [], route: "passthrough" },
  { name: "status", description: "Show status", argumentHint: null, aliases: [], route: "passthrough" },
  { name: "undo", description: "Undo", argumentHint: null, aliases: [], route: "passthrough" },
  { name: "redo", description: "Redo", argumentHint: null, aliases: [], route: "passthrough" },
  { name: "help", description: "Show help", argumentHint: null, aliases: [], route: "passthrough" },
];
const chip = { kind: "attachment" as const, key: "k1", id: "att-1", name: "a.png", attachmentKind: "image" as const, mediaType: "image/png", sizeBytes: 10, path: "/tmp/a.png" };

function setupSlash(opts: { turns?: number; catalog?: unknown[]; commands?: unknown[] } = {}) {
  const calls: Call[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
    switch (command) {
      case "subscribe_thread":
        return {
          thread: { id: 7, projectId: 1, title: "T", provider: "claude", model: "opus", effort: "high", permissionMode: "auto-edit", status: "completed" },
          capabilities: {}, turns: [], turnOffset: opts.turns ?? 0, turnCount: opts.turns ?? 0, lastSeq: 0,
          supportedPermissionModes: ["ask", "auto-edit", "full-access"],
        };
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {} }, errors: [] };
      case "get_provider_capabilities": return { supportedPermissionModes: ["ask", "auto-edit", "full-access"], midThreadModelSwitch: true };
      case "git_status": return { branch: "main" };
      case "get_model_catalog": return opts.catalog ?? claudeCatalog;
      case "list_slash_commands": return opts.commands ?? menuCommands;
      case "get_favourite_models": return [];
      default: return null;
    }
  });
  return calls;
}

const renderSlash = (draft: string, over: Record<string, unknown> = {}) => act(async () => root.render(
  <ThreadView threadId={7} projectId={1} draft={draft}
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} {...over} />));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const editor = () => container.querySelector<HTMLElement>('[role="textbox"]')!;
const options = () => Array.from(container.querySelectorAll<HTMLElement>(".slash-menu [role=\"option\"]"));
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  editor().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
});
const setModelCalls = (calls: Call[]) =>
  calls.filter((c) => c.command === "set_thread_model_and_effort").map((c) => c.args);

it("scrolls the highlighted slash command into view with the arrow keys", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });
  try {
    setupSlash();
    await renderSlash("/");
    await flush();
    expect(options().length).toBeGreaterThan(8);

    await press("ArrowUp");
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(options().at(-1));

    await press("ArrowDown");
    expect(scrollIntoView.mock.instances.at(-1)).toBe(options()[0]);
  } finally {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

it("runs a command without arguments on Enter", async () => {
  const openDiff = vi.fn();
  setupSlash();
  await renderSlash("/diff", { onOpenDefaultDiff: openDiff });
  await flush();
  await press("Enter");
  expect(openDiff).toHaveBeenCalledOnce();
});

it("runs a command with an optional argument on Enter once its name is typed", async () => {
  setupSlash();
  await renderSlash("/effort");
  await flush();
  await press("Enter");
  await flush();
  expect(container.querySelector('[role="dialog"][aria-label="Model Selector"]')).not.toBeNull();
});

it("completes a command whose argument is required instead of submitting it", async () => {
  const draftChanged = vi.fn();
  setupSlash();
  await renderSlash("/compact", { onDraftChange: draftChanged });
  await flush();
  await press("Enter");
  expect(draftChanged).toHaveBeenLastCalledWith("/compact ");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("opens the Model picker for /model without an argument", async () => {
  setupSlash();
  await renderSlash("/model");
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(container.querySelector('[role="dialog"][aria-label="Model Selector"]')).not.toBeNull();
});

it("resolves /model <name> against the active Provider's catalog", async () => {
  const calls = setupSlash();
  await renderSlash("/model sonnet");
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(setModelCalls(calls)).toEqual([{ threadId: 7, model: "sonnet", effort: "high" }]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("reports an unmatched /model query with a few available names", async () => {
  const calls = setupSlash();
  await renderSlash("/model gpt");
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain('No model matches "gpt"');
  expect(alert.textContent).toContain("Sonnet");
  expect(alert.textContent).toContain("Opus");
  expect(setModelCalls(calls)).toEqual([]);
});

it("mentions which model a multi-match /model query resolved to", async () => {
  const calls = setupSlash({
    catalog: [model("claude-sonnet", "Claude Sonnet", [], null), model("claude-haiku", "Claude Haiku", [], null)],
  });
  await renderSlash("/model claude");
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(container.querySelector('[role="status"]')!.textContent).toContain("using Claude Haiku");
  expect(setModelCalls(calls)).toHaveLength(1);
});

it.each(["/clear", "/reset", "/new"])("keeps the empty Thread and clears the draft on %s", async (command) => {
  const calls = setupSlash({ turns: 0 });
  const onClearThread = vi.fn();
  const draftChanged = vi.fn();
  await renderSlash(encodeDraft([{ kind: "text", text: command }, chip]), { onClearThread, onDraftChange: draftChanged });
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(onClearThread).not.toHaveBeenCalled();
  expect(draftChanged).toHaveBeenLastCalledWith("");
  expect(container.querySelectorAll('[role="img"][aria-label^="Attachment,"]')).toHaveLength(0);
  expect(calls.some((c) => c.command === "create_thread" || c.command === "send_prompt")).toBe(false);
});

it("starts a fresh Thread on /clear once the current Thread has Turns", async () => {
  const calls = setupSlash({ turns: 2 });
  const onClearThread = vi.fn();
  await renderSlash("/clear", { onClearThread });
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(onClearThread).toHaveBeenCalledOnce();
  expect(calls.some((c) => c.command === "send_prompt")).toBe(false);
  expect(editor().textContent?.trim()).toBe("");
});
