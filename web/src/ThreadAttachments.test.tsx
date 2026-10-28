// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";
import type { AttachmentKind } from "./bindings";
import { encodeDraft, type ComposerChip } from "./attachments";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = { command: string; args: any };
const PNG = [0x89, 0x50, 0x4e, 0x47];

const stored = (name: string, over: Record<string, unknown> = {}) => ({
  id: `id-${name}`, name, attachmentKind: (name.endsWith(".png") ? "image" : "text") as AttachmentKind,
  mediaType: name.endsWith(".png") ? "image/png" : "text/plain", sizeBytes: 2048, path: `/h/attachments/id-${name}/${name}`, ...over,
});

function setup(opts: {
  turns?: unknown[];
  attachPaths?: (paths: string[]) => unknown;
  sendPrompt?: () => unknown;
  dialog?: unknown;
} = {}) {
  const calls: Call[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    switch (command) {
      case "subscribe_thread":
        return {
          thread: { id: 7, projectId: 1, title: "T", provider: "claude", permissionMode: "auto-edit", status: "completed" },
          capabilities: { reasoningText: true }, turns: opts.turns ?? [], turnOffset: 0, turnCount: (opts.turns ?? []).length, lastSeq: 0,
          supportedPermissionModes: ["ask", "auto-edit", "full-access"],
        };
      case "get_settings": return { settings: { defaultProvider: "claude", providers: {} }, errors: [] };
      case "get_provider_capabilities": return { supportedPermissionModes: ["ask", "auto-edit", "full-access"] };
      case "git_status": return { branch: "main" };
      case "get_model_catalog": case "list_slash_commands": return [];
      case "create_thread": return { id: 7, projectId: 1, provider: "claude", permissionMode: "auto-edit", status: "completed" };
      case "send_prompt": return opts.sendPrompt ? opts.sendPrompt() : null;
      case "attach_paths": return opts.attachPaths ? opts.attachPaths((args as { paths: string[] }).paths) : [];
      case "attach_bytes": return stored("image.png");
      case "plugin:dialog|open": return opts.dialog ?? null;
      default: return null;
    }
  });
  return calls;
}

const props = (over: Record<string, unknown> = {}) => ({
  threadId: null as number | null, projectId: 1, projectPath: "/test", onThreadCreated: vi.fn(), onStatusChange: vi.fn(),
  prefill: null, onPrefillUsed: vi.fn(), onOpenThread: vi.fn(), onThreadContinued: vi.fn(), ...over,
});
const render = (over: Record<string, unknown> = {}) => act(async () => root.render(<ThreadView {...props(over)} />));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const editor = () => container.querySelector<HTMLElement>('[role="textbox"]')!;
const chips = (scope: ParentNode = editor()) => Array.from(scope.querySelectorAll<HTMLElement>('[role="img"][aria-label^="Attachment,"]'));
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
const sentSegments = (calls: Call[]) => calls.find((c) => c.command === "send_prompt")?.args.segments;

/** Puts the caret `offset` characters into the editor's first text node. */
function caretAt(offset: number) {
  const text = editor().firstChild!;
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const paste = (files: File[], text = "") => act(async () => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, getData: () => text } });
  editor().dispatchEvent(event);
});

const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  editor().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
});

const pngFile = (name = "image.png") => new File([new Uint8Array(PNG)], name, { type: "image/png" });

it("pastes a screenshot as a chip at the caret and sends it in place", async () => {
  const calls = setup();
  await render({ draft: "Ciao prova  123!!!" });
  caretAt("Ciao prova ".length);
  await paste([pngFile("immagine.png")]);
  await flush();

  expect(calls.some((c) => c.command === "attach_bytes")).toBe(true);
  expect(chips()).toHaveLength(1);
  expect(chips()[0].getAttribute("aria-label")).toBe("Attachment, image.png, image");
  expect(editor().textContent).toContain("Ciao prova ");
  expect(editor().textContent).toContain(" 123!!!");
  const order = Array.from(editor().childNodes).map((n) => (n.nodeType === 3 ? n.textContent : "[chip]"));
  expect(order).toEqual(["Ciao prova ", "[chip]", " 123!!!"]);

  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(sentSegments(calls)).toEqual([
    { kind: "text", text: "Ciao prova " },
    { kind: "attachment", id: "id-image.png" },
    { kind: "text", text: " 123!!!" },
  ]);
});

it("shows a busy chip, and does not allow sending, until the file is stored", async () => {
  let finish: (v: unknown) => void = () => {};
  const calls = setup({ attachPaths: () => new Promise((r) => { finish = r; }), dialog: ["/Users/me/spec.pdf"] });
  await render({ draft: "read this" });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click());
  await flush();

  expect(chips()).toHaveLength(1);
  expect(chips()[0].classList.contains("busy")).toBe(true);
  expect(sendButton()!.disabled).toBe(true);
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(calls.some((c) => c.command === "send_prompt")).toBe(false);

  await act(async () => finish([{ path: "/Users/me/spec.pdf", attachment: stored("spec.pdf", { attachmentKind: "pdf" as AttachmentKind }), error: null }]));
  await flush();
  expect(chips()[0].classList.contains("busy")).toBe(false);
  expect(sendButton()!.disabled).toBe(false);
});

it("inserts the files picked in the dialog, and a refused file shows its reason while the others stay", async () => {
  const calls = setup({
    dialog: ["/Users/me/a.png", "/Users/me/Folder", "/Users/me/notes.md"],
    attachPaths: () => [
      { path: "/Users/me/a.png", attachment: stored("a.png"), error: null },
      { path: "/Users/me/Folder", attachment: null, error: "Folder is a folder. Attach files instead." },
      { path: "/Users/me/notes.md", attachment: stored("notes.md"), error: null },
    ],
  });
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click());
  await flush();

  expect(calls.find((c) => c.command === "attach_paths")!.args.paths).toEqual(["/Users/me/a.png", "/Users/me/Folder", "/Users/me/notes.md"]);
  expect(chips().map((c) => c.getAttribute("aria-label"))).toEqual(["Attachment, a.png, image", "Attachment, notes.md, text"]);
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("Folder is a folder");
});

it("enables Send for a prompt made only of Attachments", async () => {
  const calls = setup({ dialog: "/Users/me/a.png", attachPaths: () => [{ path: "/Users/me/a.png", attachment: stored("a.png"), error: null }] });
  await render();
  expect(sendButton()!.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click());
  await flush();
  expect(sendButton()!.disabled).toBe(false);
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(sentSegments(calls)).toEqual([{ kind: "attachment", id: "id-a.png" }]);
});

it("Backspace next to a chip removes the whole chip, and undo brings it back", async () => {
  const chip: ComposerChip = { kind: "attachment", key: "k1", ...stored("a.png") };
  setup();
  await render({ draft: encodeDraft([{ kind: "text", text: "see " }, chip, { kind: "text", text: " ok" }]) });
  expect(chips()).toHaveLength(1);

  // Caret just after the chip.
  const range = document.createRange();
  range.setStart(editor(), 2);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await press("Backspace");
  expect(chips()).toHaveLength(0);
  expect(editor().textContent).toBe("see  ok");

  await press("z", { metaKey: true });
  expect(chips()).toHaveLength(1);
  expect(editor().textContent).toContain("see ");
});

it("Delete before a chip removes it too, and arrows do not touch the prompt", async () => {
  const chip: ComposerChip = { kind: "attachment", key: "k1", ...stored("a.png") };
  setup();
  await render({ draft: encodeDraft([{ kind: "text", text: "go " }, chip]) });
  const range = document.createRange();
  range.setStart(editor().firstChild!, 3);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await press("ArrowRight");
  expect(chips()).toHaveLength(1);
  await press("Delete");
  expect(chips()).toHaveLength(0);
});

it("copying a selection with a chip gives [name] text", async () => {
  const chip: ComposerChip = { kind: "attachment", key: "k1", ...stored("a.png") };
  setup();
  await render({ draft: encodeDraft([{ kind: "text", text: "see " }, chip, { kind: "text", text: " ok" }]) });
  const range = document.createRange();
  range.selectNodeContents(editor());
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const data: Record<string, string> = {};
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData: (t: string, v: string) => { data[t] = v; } } });
  await act(async () => { editor().dispatchEvent(event); });
  expect(data["text/plain"]).toBe("see [a.png] ok");
});

it("Shift+Enter adds a line, Enter sends", async () => {
  const calls = setup();
  await render({ draft: "one" });
  caretAt(3);
  await press("Enter", { shiftKey: true });
  expect(editor().querySelector("br")).not.toBeNull();
  await act(async () => { editor().append(document.createTextNode("two")); editor().dispatchEvent(new Event("input", { bubbles: true })); });
  await press("Enter");
  await flush();
  expect(sentSegments(calls)).toEqual([{ kind: "text", text: "one\ntwo" }]);
});

it("refuses an Oxide-run Slash command that carries an Attachment, keeping the prompt", async () => {
  const chip: ComposerChip = { kind: "attachment", key: "k1", ...stored("a.png") };
  const calls = setup();
  await render({ draft: encodeDraft([{ kind: "text", text: "/model " }, chip]) });
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("Attachments can't be sent with /model");
  expect(chips()).toHaveLength(1);
  expect(calls.some((c) => c.command === "send_prompt" || c.command === "create_thread")).toBe(false);
});

it("lets a Provider's own Slash command carry Attachments", async () => {
  const chip: ComposerChip = { kind: "attachment", key: "k1", ...stored("diff.png") };
  const calls = setup();
  await render({ threadId: 7, draft: encodeDraft([{ kind: "text", text: "/review " }, chip]) });
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(sentSegments(calls)).toEqual([{ kind: "text", text: "/review" + " " }, { kind: "attachment", id: "id-diff.png" }]);
});

it("keeps the text and Attachments when sending fails", async () => {
  const chip: ComposerChip = { kind: "attachment", key: "k1", ...stored("a.png") };
  setup({ sendPrompt: () => { throw { message: "The Provider is unavailable." }; } });
  await render({ threadId: 7, draft: encodeDraft([{ kind: "text", text: "try this " }, chip]) });
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("The Provider is unavailable.");
  expect(editor().textContent).toContain("try this");
  expect(chips()).toHaveLength(1);
});

it("tells the user when a prompt goes over the Attachment limit", async () => {
  const chipsOfTen = Array.from({ length: 10 }, (_, i) => ({ kind: "attachment" as const, key: `k${i}`, ...stored(`f${i}.txt`) }));
  const calls = setup({ dialog: "/Users/me/extra.png" });
  await render({ draft: encodeDraft(chipsOfTen) });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!.click());
  await flush();
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("at most 10 attachments");
  expect(chips()).toHaveLength(10);
  expect(calls.some((c) => c.command === "attach_paths")).toBe(false);
});

it("forgets an Attachment that was taken out of the prompt once the prompt is sent", async () => {
  const keep: ComposerChip = { kind: "attachment", key: "k1", ...stored("keep.png") };
  const drop: ComposerChip = { kind: "attachment", key: "k2", ...stored("drop.png") };
  const calls = setup();
  await render({ threadId: 7, draft: encodeDraft([{ kind: "text", text: "x " }, keep, drop]) });
  await flush();
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Remove drop.png"]')!.click(); });
  expect(chips()).toHaveLength(1);
  expect(calls.some((c) => c.command === "discard_attachment")).toBe(false);
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(calls.filter((c) => c.command === "discard_attachment").map((c) => c.args.id)).toEqual(["id-drop.png"]);
});

it("announces the paperclip as Attach files and disables it while a Turn runs", async () => {
  setup();
  await render({ threadId: 7 });
  await flush();
  const clip = () => container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;
  expect(clip().disabled).toBe(false);
});

it("shows the Attachments of the Turn being sent as chips, in place, before Core confirms it", async () => {
  const chip: ComposerChip = { kind: "attachment", key: "k1", ...stored("c.png") };
  const calls = setup({ sendPrompt: () => new Promise(() => {}) });
  await render({ threadId: 7, draft: encodeDraft([{ kind: "text", text: "and " }, chip, { kind: "text", text: " more" }]) });
  await flush();
  await act(async () => container.querySelector("form")!.requestSubmit());
  await flush();
  expect(calls.some((c) => c.command === "send_prompt")).toBe(true);
  const bubble = container.querySelector(".transcript-outgoing .user-bubble")!;
  expect(chips(bubble).map((c) => c.getAttribute("aria-label"))).toEqual(["Attachment, c.png, image"]);
  expect(Array.from(bubble.childNodes).map((n) => n.textContent)).toEqual(["and ", "c.png", " more"]);
  expect(bubble.querySelector("img")).toBeNull();
});
