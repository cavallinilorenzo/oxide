// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { terminalPaths, useTerminalTransfer } from "./useTerminalTransfer";

const native = vi.hoisted(() => ({ drop: vi.fn<(event: unknown) => void>(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: (callback: typeof native.drop) => { native.drop = callback; return Promise.resolve(native.stop); } }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); vi.clearAllMocks(); });
function Harness({ insert, visible = true }: { insert: (text: string) => void; visible?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const transfer = useTerminalTransfer(element, visible, insert);
  return <div ref={element} data-terminal>{transfer.error && <span role="alert">{transfer.error}</span>}</div>;
}
const paste = (files: File[]) => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  host.querySelector("[data-terminal]")!.dispatchEvent(event);
  return event;
};
it("quotes shell metacharacters, spaces and apostrophes literally on Windows and POSIX", () => {
  expect(terminalPaths(["C:\\my shots\\it's $(bad).png"], true)).toBe("'C:\\my shots\\it''s $(bad).png' ");
  expect(terminalPaths(["/tmp/it's $(bad).png"], false)).toBe("'/tmp/it'\\''s $(bad).png' ");
});
it("stores a pasted image, inserts its literal path without submitting, and leaves text paste alone", async () => {
  const insert = vi.fn();
  mockIPC((command) => command === "attach_bytes" ? { path: "/tmp/screen shot.png" } : null);
  await act(async () => root.render(<Harness insert={insert} />));
  expect(paste([]).defaultPrevented).toBe(false);
  await act(async () => { expect(paste([new File(["png"], "shot.png", { type: "image/png" })]).defaultPrevented).toBe(true); await new Promise((r) => setTimeout(r, 20)); });
  expect(insert).toHaveBeenCalledExactlyOnceWith("'/tmp/screen shot.png' ");
});
it("accepts native drops only over the visible terminal, scaled by the display DPI", async () => {
  const insert = vi.fn();
  await act(async () => root.render(<Harness insert={insert} />));
  vi.spyOn(host.querySelector("[data-terminal]")!, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 } as DOMRect);
  const drop = (x: number, y: number) => native.drop({ payload: { type: "drop", paths: ["C:\\image.png"], position: { x: x * window.devicePixelRatio, y: y * window.devicePixelRatio } } });
  act(() => drop(5, 5));
  expect(insert).not.toHaveBeenCalled();
  act(() => drop(50, 50));
  expect(insert).toHaveBeenCalledExactlyOnceWith("'C:\\image.png' ");
  await act(async () => root.render(<Harness visible={false} insert={insert} />));
  act(() => drop(50, 50));
  expect(insert).toHaveBeenCalledTimes(1);
  expect(native.stop).toHaveBeenCalled();
});
it("reports file storage failure without inserting an empty or partial path", async () => {
  const insert = vi.fn();
  mockIPC(() => { throw { message: "Cannot store this image" }; });
  await act(async () => root.render(<Harness insert={insert} />));
  await act(async () => { paste([new File(["png"], "shot.png")]); await new Promise((r) => setTimeout(r, 20)); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Cannot store this image");
  expect(insert).not.toHaveBeenCalled();
});
