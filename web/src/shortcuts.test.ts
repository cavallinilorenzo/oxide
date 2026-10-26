import { describe, expect, it } from "vitest";
import {
  isClearCommand,
  isModelShortcut,
  isNewThreadShortcut,
  stopsTurn,
  toggleForKey,
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

const key = (key: string, mods: Partial<Parameters<typeof toggleForKey>[0]> = {}) =>
  toggleForKey({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("toggleForKey", () => {
  it("maps ⌘\\ to the tools panel and ⌘J to the Terminal", () => {
    expect(key("\\")).toBe("tools");
    expect(key("j")).toBe("terminal");
  });
  it("maps ⌘B to the Chat / Board toggle", () => {
    expect(key("b")).toBe("board");
    expect(key("b", { shiftKey: true })).toBeNull();
  });
  it("maps ⌘, to the Settings view", () => {
    expect(key(",")).toBe("settings");
    expect(key(",", { shiftKey: true })).toBeNull();
  });
  it("ignores keys without ⌘ or with extra modifiers", () => {
    expect(key("j", { metaKey: false })).toBeNull();
    expect(key("j", { shiftKey: true })).toBeNull();
    expect(key("x")).toBeNull();
  });
  it("maps Ctrl shortcuts on Windows and Linux", () => {
    expect(key("j", { metaKey: false, ctrlKey: true })).toBe("terminal");
    expect(key("\\", { metaKey: false, ctrlKey: true })).toBe("tools");
    expect(key("b", { metaKey: false, ctrlKey: true })).toBe("board");
    expect(key(",", { metaKey: false, ctrlKey: true })).toBe("settings");
    expect(key("j", { metaKey: true, ctrlKey: true })).toBeNull();
  });
});

describe("isNewThreadShortcut", () => {
  it("recognizes ⌘N and rejects ⌘⇧N (which is Project palette)", () => {
    expect(
      isNewThreadShortcut({
        key: "n",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(true);
    expect(
      isNewThreadShortcut({
        key: "N",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(true);
    expect(
      isNewThreadShortcut({
        key: "n",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      })
    ).toBe(false);
    expect(
      isNewThreadShortcut({
        key: "n",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(false);
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

describe("isModelShortcut", () => {
  it("returns index for ⌘1..9 / Ctrl 1..9", () => {
    expect(
      isModelShortcut({
        key: "1",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(1);
    expect(
      isModelShortcut({
        key: "9",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      })
    ).toBe(9);
    expect(
      isModelShortcut({
        key: "0",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBeNull();
    expect(
      isModelShortcut({
        key: "1",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })
    ).toBeNull();
  });
});

