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
  const count = (state: PullRequestCheck["state"]) => checks.filter((c) => c.state === state).length;
  return [
    [count("failure"), "failing"],
    [count("pending"), "pending"],
    [count("success"), "passing"],
  ]
    .filter(([n]) => n !== 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(", ");
}
