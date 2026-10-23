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

/** One line on the checks, putting what needs attention first. */
export function summarizeChecks(checks: PullRequestCheck[]): string {
  if (checks.length === 0) return "No checks";
  let failing = 0;
  let pending = 0;
  let passing = 0;
  for (const c of checks) {
    if (c.state === "failure") failing++;
    else if (c.state === "pending") pending++;
    else if (c.state === "success") passing++;
  }
  const parts: string[] = [];
  if (failing > 0) parts.push(`${failing} failing`);
  if (pending > 0) parts.push(`${pending} pending`);
  if (passing > 0) parts.push(`${passing} passing`);
  return parts.join(", ");
}
