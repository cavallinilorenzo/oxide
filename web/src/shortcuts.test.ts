import { describe, expect, it } from "vitest";
import {
  isClearCommand,
  effortDigitShortcut,
  isEffortMenuShortcut,
  isModelPickerShortcut,
  modelDigitShortcut,
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

const press = (over: Partial<Record<string, unknown>>) =>
  ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }) as Parameters<typeof modelDigitShortcut>[0];

describe("isModelPickerShortcut / isEffortMenuShortcut", () => {
  it("match ⌘⇧M and ⌘⇧E, with Ctrl standing in for ⌘", () => {
    expect(isModelPickerShortcut(press({ key: "M", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isModelPickerShortcut(press({ key: "m", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isEffortMenuShortcut(press({ key: "E", metaKey: true, shiftKey: true }))).toBe(true);
    expect(isEffortMenuShortcut(press({ key: "e", ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it("reject a missing Shift, Alt, both ⌘ and Ctrl, and the other letter", () => {
    expect(isModelPickerShortcut(press({ key: "m", metaKey: true }))).toBe(false);
    expect(isModelPickerShortcut(press({ key: "M", metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isModelPickerShortcut(press({ key: "M", metaKey: true, ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isModelPickerShortcut(press({ key: "E", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isEffortMenuShortcut(press({ key: "M", metaKey: true, shiftKey: true }))).toBe(false);
  });
  it("do not collide with the existing bindings", () => {
    for (const key of ["n", "b", "j", "\\", ","]) {
      expect(isModelPickerShortcut(press({ key, metaKey: true }))).toBe(false);
      expect(isEffortMenuShortcut(press({ key, metaKey: true, shiftKey: true }))).toBe(false);
    }
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

describe("effortDigitShortcut", () => {
  it("accepts a bare digit or one with ⌘ / Ctrl", () => {
    expect(effortDigitShortcut(press({ code: "Digit3" }))).toBe(3);
    expect(effortDigitShortcut(press({ code: "Digit3", metaKey: true }))).toBe(3);
    expect(effortDigitShortcut(press({ code: "Digit3", ctrlKey: true }))).toBe(3);
  });
  it("rejects Alt, Shift, both modifiers and 0", () => {
    expect(effortDigitShortcut(press({ code: "Digit3", altKey: true }))).toBeNull();
    expect(effortDigitShortcut(press({ code: "Digit3", shiftKey: true }))).toBeNull();
    expect(effortDigitShortcut(press({ code: "Digit3", metaKey: true, ctrlKey: true }))).toBeNull();
    expect(effortDigitShortcut(press({ code: "Digit0" }))).toBeNull();
  });
});
