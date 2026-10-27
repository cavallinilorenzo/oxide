import type { MergeMethod, MergeState, PullRequestCheck, PullRequestPhase, ReviewDecision } from "./bindings";

/** The method to preselect: the user's current pick if still allowed, else the one the web
 *  merge box would offer them, else the first allowed. */
export function defaultMergeMethod(
  allowed: MergeMethod[],
  current: MergeMethod | null,
  preferred: MergeMethod | null = null,
): MergeMethod | null {
  if (current !== null && allowed.includes(current)) return current;
  if (preferred !== null && allowed.includes(preferred)) return preferred;
  return allowed[0] ?? null;
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

export type Tone = "ok" | "warn" | "bad" | "neutral";

/** One line of the merge box: what stands between the pull request and the base branch. */
export interface MergeRequirement {
  kind: "draft" | "conflicts" | "behind" | "review" | "checks";
  tone: Tone;
  title: string;
  detail?: string;
}

export interface MergeInputs {
  phase: PullRequestPhase;
  checks: PullRequestCheck[];
  mergeState: MergeState;
  reviewDecision: ReviewDecision | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The merge box, laid out as the web does: review, checks, conflicts. Worst first. */
export function mergeRequirements({ phase, checks, mergeState, reviewDecision }: MergeInputs): MergeRequirement[] {
  const rows: MergeRequirement[] = [];
  if (phase === "draft") {
    rows.push({
      kind: "draft",
      tone: "neutral",
      title: "This pull request is still a draft",
      detail: "Mark it ready for review to merge it.",
    });
  }
  if (reviewDecision === "changesRequested") {
    rows.push({ kind: "review", tone: "bad", title: "Changes requested", detail: "A reviewer asked for changes." });
  } else if (reviewDecision === "reviewRequired") {
    rows.push({ kind: "review", tone: "warn", title: "Review required", detail: "An approving review is needed to merge." });
  } else if (reviewDecision === "approved") {
    rows.push({ kind: "review", tone: "ok", title: "Changes approved" });
  }
  const { failing, pending } = countChecks(checks);
  if (failing > 0) {
    rows.push({ kind: "checks", tone: "bad", title: `${plural(failing, "check")} failing`, detail: "Open a failing check to see what went wrong." });
  } else if (pending > 0) {
    rows.push({ kind: "checks", tone: "warn", title: `${plural(pending, "check")} still running` });
  } else if (checks.length > 0) {
    rows.push({ kind: "checks", tone: "ok", title: "All checks passed" });
  }
  if (mergeState === "conflicting") {
    rows.push({
      kind: "conflicts",
      tone: "bad",
      title: "This branch has conflicts that must be resolved",
      detail: "Check the branch out to resolve them, then push.",
    });
  } else if (mergeState === "behind") {
    rows.push({ kind: "behind", tone: "warn", title: "This branch is out of date with the base branch" });
  } else if (mergeState === "unknown") {
    if (phase === "draft" || phase === "open") {
      rows.push({
        kind: "conflicts",
        tone: "neutral",
        title: "Checking for conflicts…",
        detail: "It is still being worked out. Reload in a moment.",
      });
    }
  } else {
    rows.push({ kind: "conflicts", tone: "ok", title: "No conflicts with the base branch" });
  }
  const rank: Record<Tone, number> = { bad: 0, warn: 1, neutral: 2, ok: 3 };
  // Among equals, what blocks the merge button comes first: conflicts, then review, then checks.
  const kindRank: Record<MergeRequirement["kind"], number> = { draft: 0, conflicts: 1, behind: 2, review: 3, checks: 4 };
  return rows.sort((a, b) => rank[a.tone] - rank[b.tone] || kindRank[a.kind] - kindRank[b.kind]);
}

/** The one-glance answer to "can I merge this?", shown above the merge button. */
export function readiness(inputs: MergeInputs): { tone: Tone; label: string } {
  const first = mergeRequirements(inputs)[0];
  if (!first) return { tone: "neutral", label: "No checks reported" };
  if (first.tone === "ok") return { tone: "ok", label: "Ready to merge" };
  return { tone: first.tone, label: first.title };
}

/** Where a user's avatar is served from. Bots log in as `app/name` through `gh`. */
export function avatarUrl(login: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(login.replace(/^app\//, ""))}.png?size=${size}`;
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
