import type { DiffFile, DiffHunk, DiffKind } from "./bindings";

export interface NumberedLine {
  kind: DiffKind;
  text: string;
  /** Line number on the old side; absent for added lines. */
  old: number | null;
  /** Line number on the new side; absent for removed lines. */
  new: number | null;
}

/** The hunk's lines with their old and new line numbers, counted from its `@@ -a,b +c,d @@` header. */
export function numberHunk(hunk: DiffHunk): NumberedLine[] {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
  let oldNo = match ? Number(match[1]) : null;
  let newNo = match ? Number(match[2]) : null;
  return hunk.lines.map((line) => {
    const numbered: NumberedLine = {
      kind: line.kind,
      text: line.text,
      old: line.kind === "added" ? null : oldNo,
      new: line.kind === "removed" ? null : newNo,
    };
    if (oldNo !== null && line.kind !== "added") oldNo += 1;
    if (newNo !== null && line.kind !== "removed") newNo += 1;
    return numbered;
  });
}

/** The function or section after the second `@@`, which Git adds for context. */
export const hunkContext = (header: string) => header.replace(/^@@[^@]*@@\s?/, "");

const GENERATED = /(^|\/)(Cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|\.min\.(js|css)$/;

/** Changed lines past which a file starts collapsed, so one huge file can't bury the rest. */
export const BULKY_LINES = 400;

/** Lockfiles, minified bundles and very large changes start collapsed. */
export function startsCollapsed(file: DiffFile): boolean {
  return GENERATED.test(file.path) || file.added + file.removed > BULKY_LINES;
}

/** `src/app/main.rs` → `{ dir: "src/app/", name: "main.rs" }`. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { dir: "", name: path } : { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}
