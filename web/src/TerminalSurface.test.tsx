// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { TerminalSurface } from "./TerminalSurface";
import { closeTab, openTab, selectTab, setRunning, type TerminalCheckout, type TerminalsByProject } from "./terminalTabs";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24; cols = 80; options = {};
    buffer = { active: { baseY: 0, cursorY: 0, length: 0, getLine: () => undefined }, onBufferChange: () => ({ dispose() {} }) };
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    loadAddon() {} open() {} write() {} paste() {} focus() {} blur() {} dispose() {}
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

const main: TerminalCheckout = { key: "1:main", threadId: null, rootPath: "/repo" };
const feature: TerminalCheckout = { key: "1:5", threadId: 5, rootPath: "/repo-wt/feature" };

let calls: { name: string; args: unknown }[] = [];
let nextId = 1;
beforeEach(() => {
  calls = []; nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  mockIPC((name, args) => {
    calls.push({ name, args });
    if (name === "start_block_terminal") return { id: nextId++ };
    return null;
  });
});
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const started = () => calls.filter((call) => call.name === "start_block_terminal");
const closed = () => calls.filter((call) => call.name === "close_terminal").map((call) => (call.args as { terminalId: number }).terminalId);
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); });
const tabs = () => Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

/** The App's wiring in miniature: tab state lives outside the Surface, as it does in App. */
function Harness({ initial, checkout, visible = true }: { initial: TerminalsByProject; checkout: TerminalCheckout | null; visible?: boolean }) {
  const [state, setState] = useState(initial);
  return <TerminalSurface projectId={1} terminals={state[1] ?? { tabs: [], selectedId: null, nextId: 1 }} checkout={checkout} visible={visible}
    queuedCommand={null} onCommandConsumed={() => {}}
    onOpenTab={() => checkout && setState((s) => openTab(s, 1, checkout))}
    onSelectTab={(id) => setState((s) => selectTab(s, 1, id))}
    onCloseTab={(id) => setState((s) => closeTab(s, 1, id))}
    onRunningChange={(id, command) => setState((s) => setRunning(s, 1, id, command))} />;
}

it("starts no shell until a tab is explicitly opened", async () => {
  await act(async () => root.render(<Harness initial={{}} checkout={main} />));
  await settle();
  expect(started()).toHaveLength(0);
  await click(container.querySelector(".surface-empty button"));
  await settle();
  expect(started()).toHaveLength(1);
  expect(started()[0].args).toMatchObject({ projectId: 1, threadId: null });
});

it("disables new tabs with an explanation when no Thread checkout is selected", async () => {
  await act(async () => root.render(<Harness initial={{}} checkout={null} />));
  const add = container.querySelector<HTMLButtonElement>('[aria-label="New terminal tab"]')!;
  expect(add.disabled).toBe(true);
  expect(add.title).toMatch(/Select a Thread/);
  await click(add);
  expect(started()).toHaveLength(0);
});

it("keeps a tab's shell and flags it when another Thread's checkout is selected", async () => {
  const initial = openTab({}, 1, feature);
  await act(async () => root.render(<Harness initial={initial} checkout={feature} />));
  await settle();
  expect(started()).toHaveLength(1);
  expect(started()[0].args).toMatchObject({ threadId: 5 });
  expect(container.querySelector(".terminal-tab-mismatch")).toBeNull();

  await act(async () => root.render(<Harness initial={initial} checkout={main} />));
  await settle();
  expect(container.querySelector(".terminal-tab-mismatch")?.textContent).toBe("other checkout");
  // Selecting another Thread neither restarted nor closed the shell.
  expect(started()).toHaveLength(1);
  expect(closed()).toEqual([]);
});

it("keeps shells running while the Surface is hidden and shown", async () => {
  const initial = openTab({}, 1, main);
  await act(async () => root.render(<Harness initial={initial} checkout={main} />));
  await settle();
  await act(async () => root.render(<Harness initial={initial} checkout={main} visible={false} />));
  await act(async () => root.render(<Harness initial={initial} checkout={main} />));
  await settle();
  expect(started()).toHaveLength(1);
  expect(closed()).toEqual([]);
});

it("closes only the Core session of the tab that is closed", async () => {
  const initial = openTab(openTab({}, 1, main), 1, feature);
  await act(async () => root.render(<Harness initial={initial} checkout={feature} />));
  await settle();
  expect(started()).toHaveLength(2);
  await click(container.querySelector('[aria-label="Close terminal feature"]'));
  await settle();
  expect(closed()).toEqual([2]);
  // The remaining main-checkout tab is flagged: the selected Thread is the worktree.
  expect(tabs().map((tab) => tab.textContent)).toEqual(["repoother checkout"]);
});

it("moves between tabs with the arrow keys", async () => {
  const initial = selectTab(openTab(openTab({}, 1, main), 1, feature), 1, 1);
  await act(async () => root.render(<Harness initial={initial} checkout={main} />));
  await settle();
  const list = container.querySelector('[role="tablist"]')!;
  await act(async () => { list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0]);
});
