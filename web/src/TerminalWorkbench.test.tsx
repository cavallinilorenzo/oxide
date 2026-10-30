// @vitest-environment jsdom
import { act } from "react";
import type { Channel } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { TerminalWorkbench } from "./TerminalWorkbench";

// xterm needs a real canvas and layout; the Command block around it is what is under test.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    options = {};
    buffer = { active: { baseY: 0, cursorY: 0, length: 0, getLine: () => undefined }, onBufferChange: () => ({ dispose() {} }) };
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    write() {}
    paste() {}
    focus() {}
    blur() {}
    dispose() {}
    onData() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
HTMLElement.prototype.scrollIntoView = vi.fn();
for (const size of ["clientWidth", "clientHeight"]) Object.defineProperty(HTMLElement.prototype, size, { configurable: true, get: () => 600 });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
let now = 0;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** A shell behind mocked IPC whose OSC 633 markers the test sends by hand. */
async function openShell() {
  const calls: string[] = [];
  const tokens: string[] = [];
  let channel: Channel<number[]>;
  mockIPC((name, args) => {
    calls.push(name);
    if (name === "start_block_terminal") { channel = (args as { onOutput: Channel<number[]> }).onOutput; return { id: 1 }; }
    if (name === "run_terminal_block") tokens.push((args as { token: string }).token);
    return null;
  });
  await act(async () => root.render(<TerminalWorkbench projectId={1} threadId={null} rootPath="/test" contextKey="1" visible queuedCommand={null} onCommandConsumed={() => {}} />));
  const send = async (text: string) => {
    await act(async () => channel.onmessage([...new TextEncoder().encode(text)]));
    await settle();
  };
  const token = () => tokens[tokens.length - 1];
  return {
    calls,
    async submit(value: string) {
      const input = container.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => container.querySelector("form")!.requestSubmit());
      await settle();
    },
    start: () => send(`\x1b]633;Oxide;${token()};start\x07`),
    output: (text: string) => send(text),
    end: (exitCode: number, cwd = "/test") => send(`\x1b]633;Oxide;${token()};end;${exitCode};${cwd}\x07`),
    close: () => send("\x1b]633;Oxide;closed\x07"),
  };
}
function blocks() {
  return Array.from(container.querySelectorAll<HTMLElement>('[aria-label^="Command:"]'));
}
/** What a screen reader reads: the text outside aria-hidden subtrees. */
function spoken(element: Element) {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
  return copy.textContent;
}

it.each(["clear", "CLS", "Clear-Host"])("%s clears completed blocks without replacing the shell or history", async (command) => {
  const calls: string[] = [];
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

it("shows a Running indicator while a command runs and only its duration once it succeeds", async () => {
  const shell = await openShell();
  now = 1_000;
  await shell.submit("ls");
  await shell.start();
  const [block] = blocks();
  expect(spoken(block)).toContain("Running");
  expect(block.textContent).not.toMatch(/\d\s?ms|\d\s?s\b/);
  now = 1_017;
  await shell.output("a.txt\r\n");
  await shell.end(0);
  expect(spoken(block)).not.toContain("Running");
  expect(block.textContent).toContain("17 ms");
  expect(spoken(block)).toContain("Command duration: 17 ms");
  expect(block.textContent).not.toContain("Done");
});

it("shows the exit code beside the duration when a command fails", async () => {
  const shell = await openShell();
  now = 5_000;
  await shell.submit("false");
  await shell.start();
  now = 5_320;
  await shell.end(1);
  const [block] = blocks();
  expect(block.textContent).toContain("exit 1 · 320 ms");
  expect(spoken(block)).toContain("Exit 1 after 320 ms");
});

it("marks a command cut off by the shell exiting", async () => {
  const shell = await openShell();
  now = 0;
  await shell.submit("sleep 10");
  await shell.start();
  now = 1_240;
  await shell.close();
  const [block] = blocks();
  expect(block.textContent).toContain("shell exited · 1.24 s");
  expect(spoken(block)).not.toContain("Running");
  expect(container.textContent).toContain("Start a new shell");
});

it("keeps the header to the shell and its current directory, updated after every command", async () => {
  const shell = await openShell();
  const header = () => container.querySelector<HTMLElement>("header")!;
  expect(header().querySelectorAll("button")).toHaveLength(0);
  expect(header().textContent).toContain("/test");
  await shell.submit("cd sub");
  await shell.start();
  await shell.end(0, "/test/sub");
  expect(header().textContent).toContain("/test/sub");
  expect(header().querySelector('[title="/test/sub"]')).not.toBeNull();
  await shell.submit("cd nowhere");
  await shell.start();
  await shell.end(1, "/test/sub");
  expect(header().textContent).toContain("/test/sub");
});

it("renders only the command and its status: no cwd, Copy, Reuse or Collapse", async () => {
  const shell = await openShell();
  await shell.submit("ls");
  await shell.start();
  await shell.end(0, "/test/sub");
  await shell.submit("pwd");
  await shell.start();
  await shell.end(0, "/test/sub");
  expect(blocks()).toHaveLength(2);
  for (const block of blocks()) {
    expect(block.textContent).not.toContain("/test");
    expect(block.querySelectorAll("button")).toHaveLength(0);
    expect(block.querySelector("header")?.textContent).toMatch(/^(ls|pwd)/);
  }
});
