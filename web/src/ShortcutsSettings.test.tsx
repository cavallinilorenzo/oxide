// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { DEFAULT_SHORTCUTS, type Shortcuts } from "./shortcuts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); });

const seen = { shortcuts: DEFAULT_SHORTCUTS as Shortcuts };
function Harness() {
  const [shortcuts, setShortcuts] = useState<Shortcuts>(DEFAULT_SHORTCUTS);
  const change = (next: Shortcuts) => { seen.shortcuts = next; setShortcuts(next); };
  return <ShortcutsSettings shortcuts={shortcuts} onChange={change} errorsFor={() => []} />;
}

const keyButton = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label} shortcut"]`)!;
const press = (button: HTMLButtonElement, init: KeyboardEventInit) =>
  act(async () => { button.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

it("records a new shortcut for an action, then resets it", async () => {
  await act(async () => root.render(<Harness />));
  expect(container.querySelectorAll(".shortcut-row")).toHaveLength(14);
  act(() => keyButton("Terminal").click());
  expect(keyButton("Terminal").textContent).toBe("Press keys…");
  await press(keyButton("Terminal"), { key: "Meta", metaKey: true });
  expect(seen.shortcuts.terminal).toBe("Mod+Shift+T");
  await press(keyButton("Terminal"), { key: "j", code: "KeyJ", metaKey: true });
  expect(seen.shortcuts.terminal).toBe("Mod+J");
  expect(keyButton("Terminal").textContent).not.toBe("Press keys…");

  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Reset Terminal shortcut"]')!.click());
  expect(seen.shortcuts.terminal).toBe("Mod+Shift+T");
});

it("refuses a shortcut another action uses, and Esc cancels recording", async () => {
  await act(async () => root.render(<Harness />));
  act(() => keyButton("Files").click());
  await press(keyButton("Files"), { key: "M", code: "KeyM", metaKey: true, shiftKey: true });
  expect(seen.shortcuts.files).toBe("Mod+Shift+F");
  expect(container.textContent).toContain("is already used by Model picker");
  await press(keyButton("Files"), { key: "Escape" });
  expect(keyButton("Files").textContent).not.toBe("Press keys…");
  expect(container.textContent).not.toContain("is already used");
});

it("needs ⌘ or Ctrl in a new shortcut", async () => {
  await act(async () => root.render(<Harness />));
  act(() => keyButton("Diff").click());
  await press(keyButton("Diff"), { key: "x", code: "KeyX" });
  expect(seen.shortcuts.diff).toBe("Mod+Shift+D");
  expect(container.textContent).toContain("Include ⌘");
});
