import type { GitStatus } from "./bindings";

export type NextAction =
  | { kind: "commit-push"; label: "Commit & Push"; blockedReason: string | null }
  | { kind: "push"; label: "Push"; blockedReason: string | null }
  | { kind: "up-to-date"; label: "✓ up to date"; blockedReason: null }
  | { kind: "busy"; label: "Working…"; blockedReason: string };

/** Why nothing is offered while the Thread's agent has not finished its Turn. */
export const AGENT_BUSY = "The agent is still working: push once its Turn is done.";

const DIVERGED = "Behind and ahead of the upstream: Pull (fast-forward) first.";

/** The primary Git action for a status: what one click should do next. While the Thread's
 *  agent is mid-Turn (`agentBusy`) the checkout is still changing, so nothing is offered. */
export function nextAction(status: GitStatus, agentBusy = false): NextAction {
  if (agentBusy) return { kind: "busy", label: "Working…", blockedReason: AGENT_BUSY };
  const blockedReason = pushBlockedReason(status);
  if (status.changedFiles > 0) return { kind: "commit-push", label: "Commit & Push", blockedReason };
  if (status.ahead > 0 || status.unpublished) return { kind: "push", label: "Push", blockedReason };
  return { kind: "up-to-date", label: "✓ up to date", blockedReason: null };
}

/** Why pushing is refused right now, if it is. */
export function pushBlockedReason(status: GitStatus): string | null {
  return status.ahead > 0 && status.behind > 0 ? DIVERGED : null;
}

/** Why a pull request can't be opened from this branch right now, if it can't. */
export function createPrBlockedReason(status: GitStatus): string | null {
  if (status.branch === null) return "HEAD is detached: switch to a branch first.";
  if (status.protected) return `You are on ${status.branch}: create a branch to open a pull request from.`;
  return null;
}

/** The paths Core must commit: every file not unchecked, plus a rename's old path. */
export function commitPaths(
  files: { path: string; oldPath?: string | null }[],
  unchecked: ReadonlySet<string>,
): string[] {
  return files.filter((f) => !unchecked.has(f.path)).flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
}
