import { describe, expect, it } from "vitest";
import type { DiffFile } from "./bindings";
import { matchDiffFile } from "./diffOpen";

const file = (path: string): DiffFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 0,
  removed: 0,
  binary: false,
  hunks: [],
});

describe("matchDiffFile", () => {
  const files = [file("src/a.ts"), file("a.ts"), file("b.ts")];

  it("matches an exact path", () => {
    expect(matchDiffFile(files, "b.ts")?.path).toBe("b.ts");
  });

  it("matches a headline ending in a path, preferring the longest", () => {
    expect(matchDiffFile(files, "Edit src/a.ts")?.path).toBe("src/a.ts");
    expect(matchDiffFile(files, "Edited a.ts")?.path).toBe("a.ts");
  });

  it("does not match a partial file name or an empty hint", () => {
    expect(matchDiffFile(files, "Edit xb.ts")).toBeNull();
    expect(matchDiffFile(files, null)).toBeNull();
  });
});
