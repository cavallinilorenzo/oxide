import { describe, expect, it } from "vitest";
import { toggleForKey } from "./shortcuts";

const key = (key: string, mods: Partial<Parameters<typeof toggleForKey>[0]> = {}) =>
  toggleForKey({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("toggleForKey", () => {
  it("maps ⌘\\ to the tools panel and ⌘J to the Terminal", () => {
    expect(key("\\")).toBe("tools");
    expect(key("j")).toBe("terminal");
  });
  it("ignores keys without ⌘ or with extra modifiers", () => {
    expect(key("j", { metaKey: false })).toBeNull();
    expect(key("j", { shiftKey: true })).toBeNull();
    expect(key("x")).toBeNull();
  });
});
