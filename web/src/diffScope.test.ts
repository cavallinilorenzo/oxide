import { describe, expect, it } from "vitest";
import { defaultDiffScope, showsConcurrencyNote } from "./diffScope";

describe("defaultDiffScope", () => {
  it("is Turn for chat Threads and Branch for Board Threads", () => {
    expect(defaultDiffScope({ board: false, worktree: false })).toBe("turn");
    expect(defaultDiffScope({ board: true, worktree: true })).toBe("branch");
  });
});

describe("showsConcurrencyNote", () => {
  it("shows for chat Threads in the Turn scope only", () => {
    expect(showsConcurrencyNote("turn", { board: false, worktree: false })).toBe(true);
    expect(showsConcurrencyNote("turn", { board: true, worktree: true })).toBe(false);
    expect(showsConcurrencyNote("branch", { board: false, worktree: false })).toBe(false);
    expect(showsConcurrencyNote("uncommitted", { board: false, worktree: false })).toBe(false);
  });

  it("does not show for a chat Thread in its own worktree", () => {
    expect(showsConcurrencyNote("turn", { board: false, worktree: true })).toBe(false);
  });
});
