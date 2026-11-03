import { expect, it } from "vitest";
import type { Diff, DiffFile, PullRequestReviewThread } from "./bindings";
import { groupReviewThreads, threadCode, threadLine } from "./reviewThreadPlacement";

const thread = (overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({
  id: "t1",
  path: "src/app.rs",
  line: 2,
  originalLine: 2,
  side: "new",
  resolved: false,
  outdated: false,
  diffHunk: "@@ -1,2 +1,3 @@\n fn main() {\n+    run();\n",
  comments: [{ author: "alice", body: "This needs a guard.", createdAt: "2026-01-01T00:00:00Z" }],
  ...overrides,
});

const file = (path: string, hunks: DiffFile["hunks"]): DiffFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 1,
  removed: 0,
  binary: false,
  hunks,
});

const diff = (...files: DiffFile[]): Diff => ({ base: "main", files });
const hunk = (header: string, lines: { kind: "context" | "added" | "removed"; text: string }[]) => ({ header, lines });

it("prefers the current line, then the line the thread was written on", () => {
  expect(threadLine(thread())).toBe(2);
  expect(threadLine(thread({ line: null, originalLine: 7 }))).toBe(7);
  expect(threadLine(thread({ line: null, originalLine: null }))).toBeNull();
});

it("quotes the commented line from GitHub's hunk, without its diff marker", () => {
  expect(threadCode(thread())).toBe("    run();");
  expect(threadCode(thread({ diffHunk: "@@ -1 +1 @@\n-old\n+new\n" }))).toBe("new");
  expect(threadCode(thread({ diffHunk: "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n" }))).toBe("old");
  expect(threadCode(thread({ diffHunk: "" }))).toBe("");
});

it("anchors a thread to its line in the diff and groups threads that share one", () => {
  const line = hunk("@@ -1,2 +1,3 @@", [
    { kind: "context", text: "fn main() {" },
    { kind: "removed", text: "    work();" },
    { kind: "added", text: "    run();" },
    { kind: "context", text: "}" },
  ]);
  const groups = groupReviewThreads(diff(file("src/app.rs", [line])), [
    thread({ id: "t1", line: 2 }),
    thread({ id: "t2", line: 2 }),
  ]);
  expect(groups.inDiff).toHaveLength(1);
  expect(groups.inDiff[0]).toMatchObject({ path: "src/app.rs", line: 2, side: "new", code: "    run();" });
  expect(groups.inDiff[0].threads.map((t) => t.id)).toEqual(["t1", "t2"]);
  expect(groups.notInDiff).toEqual([]);
});

it("keeps an old-side thread on a removed line apart from a new-side one on the same number", () => {
  const line = hunk("@@ -4,2 +4,2 @@", [
    { kind: "removed", text: "old" },
    { kind: "added", text: "new" },
  ]);
  const groups = groupReviewThreads(diff(file("src/app.rs", [line])), [
    thread({ id: "old", line: 4, side: "old" }),
    thread({ id: "new", line: 4, side: "new" }),
  ]);
  expect(groups.inDiff.map((group) => [group.side, group.line])).toEqual([
    ["old", 4],
    ["new", 4],
  ]);
});

it("keeps threads whose line is not in the diff reachable", () => {
  const line = hunk("@@ -1,1 +1,2 @@", [
    { kind: "context", text: "unchanged" },
    { kind: "added", text: "extra" },
  ]);
  const groups = groupReviewThreads(diff(file("src/app.rs", [line])), [
    thread({ id: "gone", line: null, originalLine: 40, outdated: true }),
    thread({ id: "elsewhere", path: "src/other.rs", line: 2 }),
    thread({ id: "wrong-side", line: 2, side: "old" }),
  ]);
  expect(groups.inDiff).toEqual([]);
  expect(groups.notInDiff.flatMap((group) => group.threads.map((t) => t.id)).sort()).toEqual([
    "elsewhere",
    "gone",
    "wrong-side",
  ]);
});

it("orders files and lines the way the diff reads", () => {
  const first = hunk("@@ -1,3 +1,3 @@", [
    { kind: "context", text: "a" },
    { kind: "context", text: "b" },
    { kind: "context", text: "c" },
  ]);
  const groups = groupReviewThreads(
    diff(file("src/a.rs", [first]), file("src/b.rs", [first])),
    [
      thread({ id: "b1", path: "src/b.rs", line: 1 }),
      thread({ id: "a3", path: "src/a.rs", line: 3 }),
      thread({ id: "a1", path: "src/a.rs", line: 1 }),
    ],
  );
  expect(groups.inDiff.map((group) => `${group.path}:${group.line}`)).toEqual([
    "src/a.rs:1",
    "src/a.rs:3",
    "src/b.rs:1",
  ]);
});
