import { describe, expect, it } from "vitest";
import { defaultDiffScope, showsConcurrencyNote } from "./diffScope";

describe("defaultDiffScope", () => {
  it("is Turn for chat Threads and Branch for Board Threads", () => {
    expect(defaultDiffScope({ board: false })).toBe("turn");
    expect(defaultDiffScope({ board: true })).toBe("branch");
  });
});

describe("showsConcurrencyNote", () => {
  it("shows for chat Threads in the Turn scope only", () => {
    expect(showsConcurrencyNote("turn", { board: false })).toBe(true);
    expect(showsConcurrencyNote("turn", { board: true })).toBe(false);
    expect(showsConcurrencyNote("branch", { board: false })).toBe(false);
    expect(showsConcurrencyNote("uncommitted", { board: false })).toBe(false);
  });
});
