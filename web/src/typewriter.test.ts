import { describe, expect, it } from "vitest";
import { advanceReveal, revealPrefix } from "./typewriter";

describe("advanceReveal", () => {
  it("types a few characters per frame at the base pace", () => {
    const next = advanceReveal(0, 5, 16);
    expect(next).toBeGreaterThan(1);
    expect(next).toBeLessThan(5);
  });

  it("never overshoots the target", () => {
    expect(advanceReveal(9.9, 10, 64)).toBe(10);
    expect(advanceReveal(10, 10, 16)).toBe(10);
  });

  it("speeds up on a large backlog", () => {
    expect(advanceReveal(0, 2000, 16)).toBeGreaterThan(advanceReveal(0, 20, 16));
  });

  it("caps a long frame gap", () => {
    expect(advanceReveal(0, 100000, 5000)).toBe(advanceReveal(0, 100000, 64));
  });
});

describe("revealPrefix", () => {
  it("cuts at the count", () => {
    expect(revealPrefix("hello", 2.9)).toBe("he");
    expect(revealPrefix("hello", 99)).toBe("hello");
  });

  it("does not split a surrogate pair", () => {
    expect(revealPrefix("a😀b", 2)).toBe("a");
    expect(revealPrefix("a😀b", 3)).toBe("a😀");
  });
});
