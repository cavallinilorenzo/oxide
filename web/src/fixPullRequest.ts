import type { PullRequestDetail } from "./bindings";
import { dedupeChecks } from "./pullRequestReview";

/** Only observed failures are repair tasks; running checks and missing reviews are waits. */
export function pullRequestFixPrompt(detail: PullRequestDetail): string | null {
  if (detail.phase !== "open" && detail.phase !== "draft") return null;
  const failing = dedupeChecks(detail.checks).filter((check) => check.state === "failure");
  const conflicts = detail.mergeState === "conflicting";
  if (!conflicts && failing.length === 0) return null;
  const pr = detail.pullRequest;
  return [
    `Fix PR #${pr.number}: ${pr.title}`,
    pr.url,
    "",
    `Work on the existing pull request branch ${pr.head} targeting ${pr.base}. Check the current PR status before making changes.`,
    "",
    "Problems reported by GitHub:",
    ...(conflicts ? [`- Resolve merge conflicts between ${pr.head} and ${pr.base}.`] : []),
    ...failing.map((check) => `- Fix failing CI check: ${check.name}${check.url ? ` (${check.url})` : ""}.`),
    "",
    ...(failing.length > 0 ? ["Inspect the failing check logs and resolve the causes of the reported failures."] : []),
    "Run the relevant local checks, commit the fixes, and push to the existing PR branch. Do not merge or close the PR.",
  ].join("\n");
}
