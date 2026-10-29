import { expect, it } from "vitest";
import { patchDocument } from "./codeOpen";
it("preserves GitHub patch context and deleted-file content without reading the local checkout", () => {
  expect(patchDocument({ path: "old.ts", status: "deleted", added: 0, removed: 1, binary: false, hunks: [{ header: "@@ -1 +0,0 @@", lines: [{ kind: "removed", text: "old content" }] }] })).toBe("--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old content");
});
