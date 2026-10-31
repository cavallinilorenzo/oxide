import type { DiffFile } from "./bindings";
export interface CodeOpenRequest { id: number; path: string; diff?: DiffFile; remote?: boolean }

/** The working-file line a cursor on `line` (1-based) of a patch document stands for. */
export function hunkTarget(patch: string, line: number): number {
  const lines = patch.split("\n");
  let start = -1;
  let next = 1;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(lines[i]);
    if (header) {
      next = Number(header[1]);
      start = i;
      continue;
    }
    if (start < 0) continue;
    // Removed lines don't exist in the working file; added and context lines advance it.
    if (i < line - 1 && !lines[i].startsWith("-") && !lines[i].startsWith("\\")) next++;
  }
  return start < 0 ? 1 : next;
}

/** Keep GitHub's exact patch, including deleted files and a PR that isn't checked out. */
export function patchDocument(file: DiffFile): string {
  return [
    `--- ${file.status === "added" || file.status === "untracked" ? "/dev/null" : `a/${file.oldPath ?? file.path}`}`,
    `+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}`,
    ...(file.binary ? ["Binary or too large to show."] : file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`)])),
  ].join("\n");
}
