import { describe, expect, it } from "vitest";
import { clearDraft, getDraft, isUnusedThread, setDraft, truncateTitle } from "./threadDrafts";

describe("thread drafts", () => {
  it("keeps unsent drafts per thread and returns empty string for unknown threads", () => {
    let drafts: Record<number, string> = {};
    expect(getDraft(drafts, 1)).toBe("");

    drafts = setDraft(drafts, 1, "draft for thread 1");
    drafts = setDraft(drafts, 2, "draft for thread 2");

    expect(getDraft(drafts, 1)).toBe("draft for thread 1");
    expect(getDraft(drafts, 2)).toBe("draft for thread 2");
    expect(getDraft(drafts, 3)).toBe("");
  });

  it("clears a draft when sent", () => {
    let drafts: Record<number, string> = { 1: "hello", 2: "world" };
    drafts = clearDraft(drafts, 1);
    expect(getDraft(drafts, 1)).toBe("");
    expect(getDraft(drafts, 2)).toBe("world");
  });
});

describe("isUnusedThread", () => {
  const idle = { id: 1, status: "completed" };
  it("is unused with no Turn, no draft and no running Turn", () => {
    expect(isUnusedThread(idle, 0, {})).toBe(true);
    expect(isUnusedThread(idle, 0, { 1: "   " })).toBe(true);
  });
  it("is used once something is typed, a Turn is running or a Turn exists", () => {
    expect(isUnusedThread(idle, 0, { 1: "hello" })).toBe(false);
    expect(isUnusedThread({ id: 1, status: "working" }, 0, {})).toBe(false);
    expect(isUnusedThread(idle, 1, {})).toBe(false);
  });
});

describe("truncateTitle", () => {
  it("takes the first non-empty line and truncates to 60 characters", () => {
    expect(truncateTitle("Short prompt")).toBe("Short prompt");
    expect(truncateTitle("\n\n  First line of prompt  \nSecond line")).toBe("First line of prompt");
    const longPrompt = "A".repeat(100);
    expect(truncateTitle(longPrompt)).toBe("A".repeat(60));
  });
});
