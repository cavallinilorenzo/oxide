import type { DiffFile } from "./bindings";
export interface CodeOpenRequest { id: number; path: string; diff?: DiffFile }

/** Keep GitHub's exact patch, including deleted files and a PR that isn't checked out. */
export function patchDocument(file: DiffFile): string {
  return [
    `--- ${file.status === "added" || file.status === "untracked" ? "/dev/null" : `a/${file.oldPath ?? file.path}`}`,
    `+++ ${file.status === "deleted" ? "/dev/null" : `b/${file.path}`}`,
    ...(file.binary ? ["Binary or too large to show."] : file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`)])),
  ].join("\n");
}
