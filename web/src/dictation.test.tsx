// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { DictationController, useDictationTarget, dictationLine } from "./dictation";
import { DEFAULT_SHORTCUTS } from "./shortcuts";
vi.mock("./useShortcuts", () => ({ useShortcuts: () => DEFAULT_SHORTCUTS }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const insert = vi.fn();
function Target() {
  const ref = useRef<HTMLTextAreaElement>(null);
  useDictationTarget(ref, insert);
  return <textarea ref={ref} aria-label="Target" />;
}
async function key(key = "R") { await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: key === "R", shiftKey: key === "R", bubbles: true }))); }
async function setup() {
  vi.spyOn(commands, "dictationStart").mockResolvedValue({ status: "ok", data: null });
  vi.spyOn(commands, "dictationStop").mockResolvedValue({ status: "ok", data: "ciao mondo" });
  vi.spyOn(commands, "dictationCancel").mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 100 }] as unknown as DOMRectList);
  await act(async () => root.render(<><DictationController /><Target /></>));
  host.querySelector("textarea")!.focus();
}
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); insert.mockClear(); });
it("toggles recording and inserts once without submitting", async () => {
  await setup(); await key();
  expect(host.textContent).toContain("Listening"); expect(insert).not.toHaveBeenCalled();
  await key(); expect(insert).toHaveBeenCalledExactlyOnceWith("ciao mondo"); expect(commands.dictationStop).toHaveBeenCalledOnce();
});
it("Escape discards recording", async () => {
  await setup(); await key(); await key("Escape");
  expect(commands.dictationCancel).toHaveBeenCalled(); expect(commands.dictationStop).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
});
it("never redirects speech into an input opened later", async () => {
  await setup(); await key();
  await act(async () => root.render(<DictationController />));
  await key(); expect(insert).not.toHaveBeenCalled(); expect(host.textContent).toContain("original input was closed");
});
it("strips terminal control characters and newlines", () => { expect(dictationLine("echo hi\n\r\x1b[31m\x00")).toBe("echo hi   [31m "); });
