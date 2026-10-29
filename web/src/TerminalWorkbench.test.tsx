// @vitest-environment jsdom
import { act, useEffect } from "react";
import type { Channel } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { TerminalWorkbench } from "./TerminalWorkbench";

vi.mock("./TerminalCommandBlock", () => ({ TerminalCommandBlock: ({ block, onReady }: { block: { command: string }; onReady: (rows: number, cols: number) => void }) => {
  useEffect(() => { onReady(24, 80); }, [onReady]);
  return <section aria-label={`Command: ${block.command}`} />;
} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.scrollIntoView = vi.fn();
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); vi.unstubAllGlobals(); });

it.each(["clear", "CLS", "Clear-Host"])("%s clears completed blocks without replacing the shell or history", async (command) => {
  const calls: string[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  let channel: Channel<number[]>;
  mockIPC((name, args) => {
    calls.push(name);
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") {
      const { token } = args as { token: string };
      channel.onmessage([...new TextEncoder().encode(`\x1b]633;Oxide;${token};start\x07hello\r\n\x1b]633;Oxide;${token};end;0;/test\x07`)]);
    }
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} threadId={null} rootPath="/test" contextKey="1" visible queuedCommand={null} onCommandConsumed={() => {}} />));
  const submit = async (value: string) => {
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.requestSubmit());
  };
  await submit("echo hello");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(container.querySelectorAll('[aria-label^="Command:"]')).toHaveLength(1);
  await submit(command);
  expect(container.querySelector('[aria-label^="Command:"]')).toBeNull();
  expect(calls.filter((c) => c === "start_block_terminal")).toHaveLength(1);
  expect(calls).not.toContain("close_terminal");
  expect(container.querySelector("textarea")?.value).toBe("");
  expect(JSON.parse(localStorage.getItem("oxide:terminal-history:1")!)).toEqual([expect.objectContaining({ command: "echo hello", exitCode: 0 })]);
});
