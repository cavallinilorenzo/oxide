import { describe, expect, it } from "vitest";
import type { GitStatus } from "./bindings";
import { commitPaths, nextAction } from "./gitAction";

const clean: GitStatus = {
  branch: "feat/x",
  upstream: "origin/feat/x",
  ahead: 0,
  behind: 0,
  added: 0,
  removed: 0,
  changedFiles: 0,
  pickerDisabledReason: null,
  protected: false,
  unpublished: false,
};

describe("nextAction", () => {
  it("is Commit & Push when there are changes", () => {
    expect(nextAction({ ...clean, changedFiles: 2 })).toMatchObject({ kind: "commit-push", label: "Commit & Push" });
  });

  it("is Push when only commits are ahead, or the branch is unpublished", () => {
    expect(nextAction({ ...clean, ahead: 1 })).toMatchObject({ kind: "push", label: "Push" });
    expect(nextAction({ ...clean, upstream: null, unpublished: true })).toMatchObject({ kind: "push" });
  });

  it("is up to date otherwise, including when only behind", () => {
    expect(nextAction(clean)).toMatchObject({ kind: "up-to-date", label: "✓ up to date" });
    expect(nextAction({ ...clean, behind: 3 })).toMatchObject({ kind: "up-to-date" });
  });

  it("blocks pushing, with a reason, when behind and ahead", () => {
    const diverged = { ...clean, ahead: 1, behind: 1 };
    expect(nextAction(diverged).blockedReason).toMatch(/Pull/);
    expect(nextAction({ ...diverged, changedFiles: 1 }).blockedReason).toMatch(/Pull/);
    expect(nextAction({ ...clean, ahead: 1 }).blockedReason).toBeNull();
  });
});

describe("commitPaths", () => {
  it("lists checked files, with the old path of a rename", () => {
    const files = [
      { path: "a.ts", oldPath: null },
      { path: "b.ts", oldPath: "old.ts" },
      { path: "c.ts", oldPath: null },
    ];
    expect(commitPaths(files, new Set(["c.ts"]))).toEqual(["a.ts", "b.ts", "old.ts"]);
  });
});
