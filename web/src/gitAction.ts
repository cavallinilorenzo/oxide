import type { GitStatus } from "./bindings";

export type NextAction =
  | { kind: "commit-push"; label: "Commit & Push"; blockedReason: string | null }
  | { kind: "push"; label: "Push"; blockedReason: string | null }
  | { kind: "up-to-date"; label: "✓ up to date"; blockedReason: null };

const DIVERGED = "Behind and ahead of the upstream: Pull (fast-forward) first.";

/** The primary Git action for a status: what one click should do next. */
export function nextAction(status: GitStatus): NextAction {
  const blockedReason = status.ahead > 0 && status.behind > 0 ? DIVERGED : null;
  if (status.changedFiles > 0) return { kind: "commit-push", label: "Commit & Push", blockedReason };
  if (status.ahead > 0 || status.unpublished) return { kind: "push", label: "Push", blockedReason };
  return { kind: "up-to-date", label: "✓ up to date", blockedReason: null };
}

/** Why pushing is refused right now, if it is. */
export function pushBlockedReason(status: GitStatus): string | null {
  return status.ahead > 0 && status.behind > 0 ? DIVERGED : null;
}

/** The paths Core must commit: every file not unchecked, plus a rename's old path. */
export function commitPaths(
  files: { path: string; oldPath?: string | null }[],
  unchecked: ReadonlySet<string>,
): string[] {
  return files.filter((f) => !unchecked.has(f.path)).flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
}
