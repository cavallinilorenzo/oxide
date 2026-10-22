import { describe, expect, it } from "vitest";
import { takeFrameBatch } from "./terminalOutput";

describe("takeFrameBatch", () => {
  it("coalesces a burst into one write while preserving byte order", () => {
    const pending = [new TextEncoder().encode("one"), new TextEncoder().encode(" two"), new TextEncoder().encode(" three")];
    expect(new TextDecoder().decode(takeFrameBatch(pending))).toBe("one two three");
    expect(pending).toEqual([]);
  });

  it("limits a frame batch and leaves the remaining output queued", () => {
    const pending = [new Uint8Array([1, 2, 3, 4, 5])];
    expect([...takeFrameBatch(pending, 3)]).toEqual([1, 2, 3]);
    expect([...pending[0]]).toEqual([4, 5]);
  });
});
