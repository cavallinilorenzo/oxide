import { expect, it } from "vitest";
import { hunkTarget, patchDocument } from "./codeOpen";
it("maps a cursor in a patch to the line it changes in the working file", () => {
  const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " keep", "-old", "+new", " tail", "@@ -20,2 +30,3 @@", " ctx", "+add", " end"].join("\n");
  expect(hunkTarget(patch, 6)).toBe(2); // an added line
  expect(hunkTarget(patch, 5)).toBe(2); // a removed line points where it was
  expect(hunkTarget(patch, 3)).toBe(1); // the hunk header points at its first line
  expect(hunkTarget(patch, 10)).toBe(31);
  expect(hunkTarget(patch, 1)).toBe(1); // file header, before any hunk
});
it("does not count a no-newline marker as a working-file line", () => {
  const patch = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file", " c"].join("\n");
  expect(hunkTarget(patch, 8)).toBe(2);
});
it("preserves GitHub patch context and deleted-file content without reading the local checkout", () => {
  expect(patchDocument({ path: "old.ts", status: "deleted", added: 0, removed: 1, binary: false, hunks: [{ header: "@@ -1 +0,0 @@", lines: [{ kind: "removed", text: "old content" }] }] })).toBe("--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old content");
});
