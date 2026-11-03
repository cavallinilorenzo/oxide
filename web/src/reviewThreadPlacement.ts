import type { CommentSide, Diff, DiffFile, PullRequestReviewThread } from "./bindings";
import { numberHunk } from "./diffView";

/** Threads that share a line, so the line is named and quoted once. */
export interface ThreadLine {
  /** The path, line and side, unique among the groups. */
  key: string;
  path: string;
  line: number | null;
  side: CommentSide | null;
  /** The line's text as GitHub quoted it, without the diff marker. */
  code: string;
  threads: PullRequestReviewThread[];
}

/** Threads anchored to the diff, and threads the diff no longer holds. */
export interface ReviewThreadGroups {
  inDiff: ThreadLine[];
  notInDiff: ThreadLine[];
}

/** The line the thread sits on now, or the one it was written on when GitHub dropped it. */
export function threadLine(thread: PullRequestReviewThread): number | null {
  return thread.line ?? thread.originalLine ?? null;
}

/** GitHub's hunk ends at the commented line, so its last content line is what the thread is about. */
export function threadCode(thread: PullRequestReviewThread): string {
  const lines = thread.diffHunk.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === "" || line.startsWith("@@") || line.startsWith("\\")) continue;
    return line.slice(1);
  }
  return "";
}

/** A `null` side means GitHub reported none; the thread still reads against the new side. */
function inDiff(files: DiffFile[], thread: PullRequestReviewThread): boolean {
  const line = threadLine(thread);
  if (line === null) return false;
  const side = thread.side ?? null;
  const file = files.find((candidate) => candidate.path === thread.path || candidate.oldPath === thread.path);
  if (!file) return false;
  return file.hunks.some((hunk) =>
    numberHunk(hunk).some((numbered) =>
      side === "old"
        ? numbered.old === line && numbered.kind !== "added"
        : numbered.new === line && numbered.kind !== "removed",
    ),
  );
}

const sideRank = (side: CommentSide | null): number => (side === "old" ? 0 : side === "new" ? 1 : 2);

function ordered(a: ThreadLine, b: ThreadLine): number {
  return (
    a.path.localeCompare(b.path) ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    sideRank(a.side) - sideRank(b.side)
  );
}

/** Places each thread on its line of the diff, keeping the ones the diff lost reachable. */
export function groupReviewThreads(diff: Diff, threads: PullRequestReviewThread[]): ReviewThreadGroups {
  const groups = new Map<string, ThreadLine>();
  const result: ReviewThreadGroups = { inDiff: [], notInDiff: [] };
  for (const thread of threads) {
    const line = threadLine(thread);
    const side = thread.side ?? null;
    const key = `${thread.path}\u0000${line ?? ""}\u0000${side ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, path: thread.path, line, side, code: threadCode(thread), threads: [] };
      groups.set(key, group);
      (inDiff(diff.files, thread) ? result.inDiff : result.notInDiff).push(group);
    }
    group.threads.push(thread);
  }
  result.inDiff.sort(ordered);
  result.notInDiff.sort(ordered);
  return result;
}
