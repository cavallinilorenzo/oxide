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
      { name: "a", state: "success" as const },
      { name: "b", state: "failure" as const },
      { name: "c", state: "pending" as const },
      { name: "d", state: "success" as const },
    ];
    expect(summarizeChecks(checks)).toBe("1 failing, 1 pending, 2 passing");
  });

  it("omits the empty kinds", () => {
    expect(summarizeChecks([{ name: "a", state: "success" }])).toBe("1 passing");
  });
});
