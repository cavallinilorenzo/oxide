import { describe, expect, it } from "vitest";
import { defaultMergeMethod, mergeLabel, summarizeChecks } from "./pullRequestReview";

describe("defaultMergeMethod", () => {
  it("keeps the current choice while the repository still allows it", () => {
    expect(defaultMergeMethod(["merge", "squash"], "squash")).toBe("squash");
  });

  it("falls back to the first allowed method", () => {
    expect(defaultMergeMethod(["merge", "squash"], "rebase")).toBe("merge");
    expect(defaultMergeMethod(["rebase"], null)).toBe("rebase");
  });

  it("prefers the method GitHub's merge box would offer over the first allowed", () => {
    expect(defaultMergeMethod(["merge", "squash"], null, "squash")).toBe("squash");
    expect(defaultMergeMethod(["merge"], null, "squash")).toBe("merge");
    expect(defaultMergeMethod(["merge", "squash"], "merge", "squash")).toBe("merge");
  });

  it("is null when the repository allows no merge", () => {
    expect(defaultMergeMethod([], "merge")).toBeNull();
  });
});

describe("mergeLabel", () => {
  it("names each method the way GitHub does", () => {
    expect(mergeLabel("merge")).toBe("Create a merge commit");
    expect(mergeLabel("squash")).toBe("Squash and merge");
    expect(mergeLabel("rebase")).toBe("Rebase and merge");
  });
});

describe("summarizeChecks", () => {
  it("says so when there are no checks", () => {
    expect(summarizeChecks([])).toBe("No checks");
  });

  it("counts failing and pending checks first, as they need attention", () => {
    const checks = [
      { name: "a", state: "success" as const, url: null },
      { name: "b", state: "failure" as const, url: null },
      { name: "c", state: "pending" as const, url: null },
      { name: "d", state: "success" as const, url: null },
    ];
    expect(summarizeChecks(checks)).toBe("1 failing, 1 running, 2 passing");
  });

  it("omits the empty kinds", () => {
    expect(summarizeChecks([{ name: "a", state: "success", url: null }])).toBe("1 passing");
  });
});
