import { describe, expect, it } from "vitest";
import { clearDraft, getDraft, setDraft } from "./threadDrafts";

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
