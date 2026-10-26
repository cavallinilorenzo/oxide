import type { MergeMethod, PullRequestCheck } from "./bindings";

/** The method to preselect: the user's current pick if still allowed, else the first allowed. */
export function defaultMergeMethod(allowed: MergeMethod[], current: MergeMethod | null): MergeMethod | null {
  return current !== null && allowed.includes(current) ? current : (allowed[0] ?? null);
}

const MERGE_LABELS: Record<MergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

export function mergeLabel(method: MergeMethod): string {
  return MERGE_LABELS[method];
}

const CHECK_RANK: Record<PullRequestCheck["state"], number> = { failure: 0, pending: 1, success: 2 };

/** One entry per check name, worst state winning, failing first. GitHub lists a check once per
 *  workflow run, so the same name often shows up pending and passing at once. */
export function dedupeChecks(checks: PullRequestCheck[]): PullRequestCheck[] {
  const byName = new Map<string, PullRequestCheck>();
  for (const c of checks) {
    const seen = byName.get(c.name);
    if (!seen || CHECK_RANK[c.state] < CHECK_RANK[seen.state]) byName.set(c.name, c);
  }
  return [...byName.values()].sort((a, b) => CHECK_RANK[a.state] - CHECK_RANK[b.state]);
}

export interface CheckCounts {
  failing: number;
  pending: number;
  passing: number;
}

export function countChecks(checks: PullRequestCheck[]): CheckCounts {
  const counts = { failing: 0, pending: 0, passing: 0 };
  for (const c of dedupeChecks(checks)) {
    if (c.state === "failure") counts.failing++;
    else if (c.state === "pending") counts.pending++;
    else counts.passing++;
  }
  return counts;
}

/** One line on the checks, putting what needs attention first. */
export function summarizeChecks(checks: PullRequestCheck[]): string {
  if (checks.length === 0) return "No checks";
  const { failing, pending, passing } = countChecks(checks);
  const parts: string[] = [];
  if (failing > 0) parts.push(`${failing} failing`);
  if (pending > 0) parts.push(`${pending} running`);
  if (passing > 0) parts.push(`${passing} passing`);
  return parts.join(", ");
}

export type Readiness = { tone: "ok" | "warn" | "bad" | "neutral"; label: string };

/** The one-glance answer to "can I merge this?", shown beside the merge button. */
export function readiness(checks: PullRequestCheck[], draft: boolean): Readiness {
  if (draft) return { tone: "neutral", label: "Draft: mark it ready on GitHub to merge" };
  const { failing, pending } = countChecks(checks);
  if (failing > 0) return { tone: "bad", label: `${failing} ${failing === 1 ? "check" : "checks"} failing` };
  if (pending > 0) return { tone: "warn", label: `${pending} ${pending === 1 ? "check" : "checks"} still running` };
  if (checks.length === 0) return { tone: "neutral", label: "No checks reported" };
  return { tone: "ok", label: "All checks passed" };
}

/** "5m", "3h", "2d", "4w", "8mo", "2y": short enough for a narrow row. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "now";
  const steps: [number, string][] = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
    [604800, "w"],
    [2592000, "mo"],
    [31536000, "y"],
  ];
  let unit = steps[0];
  for (const step of steps) if (s >= step[0]) unit = step;
  return `${Math.floor(s / unit[0])}${unit[1]}`;
}
