import { describe, expect, it } from "vitest";
import type { DiffFile } from "./bindings";
import { hunkContext, numberHunk, splitPath, startsCollapsed } from "./diffView";

describe("numberHunk", () => {
  it("numbers each side from the hunk header", () => {
    const lines = numberHunk({
      header: "@@ -10,3 +10,4 @@ fn main() {",
      lines: [
        { kind: "context", text: "a" },
        { kind: "removed", text: "b" },
        { kind: "added", text: "c" },
        { kind: "added", text: "d" },
        { kind: "context", text: "e" },
      ],
    });
    expect(lines.map((l) => [l.old, l.new])).toEqual([
      [10, 10],
      [11, null],
      [null, 11],
      [null, 12],
      [12, 13],
    ]);
  });

  it("leaves numbers out when the header can't be read", () => {
    const [line] = numberHunk({ header: "Binary", lines: [{ kind: "context", text: "x" }] });
    expect([line.old, line.new]).toEqual([null, null]);
  });
});

describe("hunkContext", () => {
  it("keeps what Git put after the range", () => {
    expect(hunkContext("@@ -1,2 +1,3 @@ impl Pty {")).toBe("impl Pty {");
    expect(hunkContext("@@ -1 +1 @@")).toBe("");
  });
});

describe("startsCollapsed", () => {
  const file = (path: string, added = 1, removed = 0) => ({ path, added, removed }) as DiffFile;

  it("collapses lockfiles and huge changes", () => {
    expect(startsCollapsed(file("Cargo.lock"))).toBe(true);
    expect(startsCollapsed(file("web/pnpm-lock.yaml"))).toBe(true);
    expect(startsCollapsed(file("src/big.ts", 300, 200))).toBe(true);
  });

  it("keeps ordinary files open", () => {
    expect(startsCollapsed(file("src/lock.rs", 20, 3))).toBe(false);
  });
});

describe("splitPath", () => {
  it("separates the folder from the file name", () => {
    expect(splitPath("src/app/main.rs")).toEqual({ dir: "src/app/", name: "main.rs" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
