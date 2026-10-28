export function formatIssueLabel(issue: { number: number; title: string }): string {
  return `#${issue.number} ${issue.title}`;
}

export function canSubmitIssue(title: string): boolean {
  return title.trim().length > 0;
}

export function canSubmitComment(body: string): boolean {
  return body.trim().length > 0;
}

/** Where an issue stands: open, or closed as done or as not planned, the way GitHub tells them apart. */
export type IssuePhase = "open" | "completed" | "notPlanned";

export function issuePhase(issue: { state: string; stateReason: string }): IssuePhase {
  if (issue.state !== "CLOSED") return "open";
  return issue.stateReason === "NOT_PLANNED" ? "notPlanned" : "completed";
}

export const ISSUE_PHASE_LABEL: Record<IssuePhase, string> = {
  open: "Open",
  completed: "Closed",
  notPlanned: "Not planned",
};

/** Whether an edited title is worth sending: not blank, and not what GitHub already has. */
export function titleChanged(current: string, draft: string): boolean {
  const next = draft.trim();
  return next.length > 0 && next !== current;
}
