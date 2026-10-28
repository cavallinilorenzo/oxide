import { describe, expect, it } from "vitest";
import {
  acceleratorFromEvent,
  actionForKey,
  adjacentThreadId,
  DEFAULT_SHORTCUTS,
  formatAccelerator,
  isClearCommand,
  matchesAccelerator,
  modelDigitShortcut,
  stopsTurn,
} from "./shortcuts";

describe("stopsTurn", () => {
  const esc = { key: "Escape", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  it("stops on a bare Esc while a Turn is working or waiting on an Approval", () => {
    expect(stopsTurn(esc, "working")).toBe(true);
    expect(stopsTurn(esc, "needs-input")).toBe(true);
  });
  it("does nothing when no Turn is running, or with modifiers or other keys", () => {
    expect(stopsTurn(esc, "completed")).toBe(false);
    expect(stopsTurn(esc, "interrupted")).toBe(false);
    expect(stopsTurn({ ...esc, shiftKey: true }, "working")).toBe(false);
    expect(stopsTurn({ ...esc, key: "Enter" }, "working")).toBe(false);
  });
});

const press = (over: Partial<Record<string, unknown>>) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as Parameters<typeof modelDigitShortcut>[0];

describe("matchesAccelerator", () => {
  it("matches ⌘ or Ctrl, any letter case, and nothing else", () => {
    expect(matchesAccelerator(press({ key: "n", metaKey: true }), "Mod+N")).toBe(true);
    expect(matchesAccelerator(press({ key: "N", ctrlKey: true }), "Mod+N")).toBe(true);
    expect(matchesAccelerator(press({ key: "n" }), "Mod+N")).toBe(false);
    expect(matchesAccelerator(press({ key: "n", metaKey: true, ctrlKey: true }), "Mod+N")).toBe(false);
  });
  it("distinguishes ⌘N from ⌘⇧N and ⌘⌥N", () => {
    expect(matchesAccelerator(press({ key: "N", metaKey: true, shiftKey: true }), "Mod+N")).toBe(false);
    expect(matchesAccelerator(press({ key: "N", metaKey: true, shiftKey: true }), "Mod+Shift+N")).toBe(true);
    expect(matchesAccelerator(press({ key: "n", metaKey: true }), "Mod+Shift+N")).toBe(false);
    expect(matchesAccelerator(press({ key: "n", metaKey: true, altKey: true }), "Mod+N")).toBe(false);
  });
  it("matches arrows, symbols and the Alt letter by physical key", () => {
    expect(matchesAccelerator(press({ key: "ArrowUp", metaKey: true }), "Mod+ArrowUp")).toBe(true);
    expect(matchesAccelerator(press({ key: "\\", metaKey: true }), "Mod+\\")).toBe(true);
    expect(matchesAccelerator(press({ key: "|", code: "Backslash", metaKey: true, shiftKey: true }), "Mod+Shift+\\")).toBe(true);
    expect(matchesAccelerator(press({ key: "ß", code: "KeyS", metaKey: true, altKey: true }), "Mod+Alt+S")).toBe(true);
    expect(matchesAccelerator(press({ key: "+", metaKey: true }), "Mod++")).toBe(true);
  });
  it("rejects a malformed accelerator", () => {
    expect(matchesAccelerator(press({ key: "n", metaKey: true }), "N")).toBe(false);
    expect(matchesAccelerator(press({ key: "n", metaKey: true }), "")).toBe(false);
  });
});

describe("actionForKey with the default shortcuts", () => {
  const action = (over: Partial<Record<string, unknown>>) => actionForKey(press({ metaKey: true, ...over }), DEFAULT_SHORTCUTS);
  it("maps every shortcut the app ships with", () => {
    expect(action({ key: "n" })).toBe("newThread");
    expect(action({ key: "N", shiftKey: true })).toBe("openProject");
    expect(action({ key: "M", shiftKey: true })).toBe("modelPicker");
    expect(action({ key: "P", shiftKey: true })).toBe("pullRequests");
    expect(action({ key: "I", shiftKey: true })).toBe("issues");
    expect(action({ key: "T", shiftKey: true })).toBe("terminal");
    expect(action({ key: "F", shiftKey: true })).toBe("files");
    expect(action({ key: "D", shiftKey: true })).toBe("diff");
    expect(action({ key: "ArrowUp" })).toBe("previousThread");
    expect(action({ key: "ArrowDown" })).toBe("nextThread");
    expect(action({ key: "\\" })).toBe("toggleTools");
    expect(action({ key: "b" })).toBe("toggleBoard");
    expect(action({ key: "," })).toBe("openSettings");
  });
  it("ignores other keys", () => {
    expect(action({ key: "x" })).toBeNull();
    expect(actionForKey(press({ key: "n" }), DEFAULT_SHORTCUTS)).toBeNull();
  });
  it("follows a rebound shortcut and frees the old keys", () => {
    const rebound = { ...DEFAULT_SHORTCUTS, terminal: "Mod+J" };
    expect(actionForKey(press({ key: "j", metaKey: true }), rebound)).toBe("terminal");
    expect(actionForKey(press({ key: "T", metaKey: true, shiftKey: true }), rebound)).toBeNull();
  });
});

describe("acceleratorFromEvent", () => {
  it("spells the keys pressed", () => {
    expect(acceleratorFromEvent(press({ key: "m", metaKey: true, shiftKey: true }))).toBe("Mod+Shift+M");
    expect(acceleratorFromEvent(press({ key: "ArrowDown", ctrlKey: true }))).toBe("Mod+ArrowDown");
    expect(acceleratorFromEvent(press({ key: "ß", code: "KeyS", metaKey: true, altKey: true }))).toBe("Mod+Alt+S");
    expect(acceleratorFromEvent(press({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }))).toBe("Mod+Shift+1");
    expect(acceleratorFromEvent(press({ key: "F5", metaKey: true }))).toBe("Mod+F5");
  });
  it("waits for a real key and requires ⌘ or Ctrl", () => {
    expect(acceleratorFromEvent(press({ key: "Meta", metaKey: true }))).toBeNull();
    expect(acceleratorFromEvent(press({ key: "Shift", metaKey: true, shiftKey: true }))).toBeNull();
    expect(acceleratorFromEvent(press({ key: "m", shiftKey: true }))).toBeNull();
    expect(acceleratorFromEvent(press({ key: "Enter", metaKey: true }))).toBeNull();
    expect(acceleratorFromEvent(press({ key: "Escape", metaKey: true }))).toBeNull();
  });
  it("round-trips through matchesAccelerator", () => {
    const event = press({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true });
    const accelerator = acceleratorFromEvent(event)!;
    expect(accelerator).toBe("Mod+Shift+\\");
    expect(matchesAccelerator(event, accelerator)).toBe(true);
  });
});

describe("formatAccelerator", () => {
  it("uses symbols on macOS", () => {
    expect(formatAccelerator("Mod+Shift+M", true)).toBe("⌘⇧M");
    expect(formatAccelerator("Mod+ArrowUp", true)).toBe("⌘↑");
    expect(formatAccelerator("Mod+Alt+Shift+K", true)).toBe("⌘⌥⇧K");
  });
  it("spells the keys out elsewhere", () => {
    expect(formatAccelerator("Mod+Shift+M", false)).toBe("Ctrl+Shift+M");
    expect(formatAccelerator("Mod+ArrowDown", false)).toBe("Ctrl+Down");
    expect(formatAccelerator("Mod+\\", false)).toBe("Ctrl+\\");
  });
});

describe("adjacentThreadId", () => {
  it("moves one step and stops at the ends", () => {
    expect(adjacentThreadId([5, 4, 3], 4, 1)).toBe(3);
    expect(adjacentThreadId([5, 4, 3], 4, -1)).toBe(5);
    expect(adjacentThreadId([5, 4, 3], 3, 1)).toBe(3);
    expect(adjacentThreadId([5, 4, 3], 5, -1)).toBe(5);
  });
  it("starts from the top or bottom when no Thread is open", () => {
    expect(adjacentThreadId([5, 4, 3], null, 1)).toBe(5);
    expect(adjacentThreadId([5, 4, 3], null, -1)).toBe(3);
    expect(adjacentThreadId([5, 4, 3], 99, 1)).toBe(5);
  });
  it("has nowhere to go without Threads", () => {
    expect(adjacentThreadId([], null, 1)).toBeNull();
  });
});

describe("isClearCommand", () => {
  it("matches /clear with optional surrounding whitespace", () => {
    expect(isClearCommand("/clear")).toBe(true);
    expect(isClearCommand("  /clear  ")).toBe(true);
    expect(isClearCommand("/reset")).toBe(true);
    expect(isClearCommand("/new")).toBe(true);
    expect(isClearCommand("/clear something")).toBe(false);
    expect(isClearCommand("/model")).toBe(false);
  });
});

describe("modelDigitShortcut", () => {
  it("returns the digit for ⌘ or Ctrl plus the physical digit row", () => {
    expect(modelDigitShortcut(press({ code: "Digit1", metaKey: true }))).toBe(1);
    expect(modelDigitShortcut(press({ code: "Digit9", ctrlKey: true }))).toBe(9);
  });
  it("follows the physical key, not the produced character (AZERTY)", () => {
    expect(modelDigitShortcut(press({ key: "&", code: "Digit1", metaKey: true }))).toBe(1);
    expect(modelDigitShortcut(press({ key: "1", code: "KeyQ", metaKey: true }))).toBeNull();
  });
  it("rejects 0, no modifier, both modifiers, Alt and Shift", () => {
    expect(modelDigitShortcut(press({ code: "Digit0", metaKey: true }))).toBeNull();
    expect(modelDigitShortcut(press({ code: "Digit1" }))).toBeNull();
    expect(modelDigitShortcut(press({ code: "Digit1", metaKey: true, ctrlKey: true }))).toBeNull();
    expect(modelDigitShortcut(press({ code: "Digit1", metaKey: true, altKey: true }))).toBeNull();
    expect(modelDigitShortcut(press({ code: "Digit1", metaKey: true, shiftKey: true }))).toBeNull();
  });
});
