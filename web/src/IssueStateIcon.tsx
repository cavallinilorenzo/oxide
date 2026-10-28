import { IssueClosedIcon, IssueOpenedIcon, SkipIcon } from "@primer/octicons-react";
import { ISSUE_PHASE_LABEL, type IssuePhase } from "./issueView";

/** The icon GitHub shows for an issue: open, closed as done, or closed as not planned. */
export function IssueStateIcon({ phase, size = 16 }: { phase: IssuePhase; size?: number }) {
  const props = { size, className: `issue-state-${phase}`, "aria-label": ISSUE_PHASE_LABEL[phase] };
  if (phase === "open") return <IssueOpenedIcon {...props} />;
  if (phase === "notPlanned") return <SkipIcon {...props} />;
  return <IssueClosedIcon {...props} />;
}
