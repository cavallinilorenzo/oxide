import { BellIcon } from "@primer/octicons-react";
import { attentionLabel, type AttentionSummary } from "./attention";

/** The global header's signal for Threads waiting on the user across every open Project. */
export function AttentionButton({ summary, failed, onActivate, onRetry }: {
  summary: AttentionSummary;
  /** The last jump could not show its destination. */
  failed: boolean;
  onActivate: () => void;
  onRetry: () => void;
}) {
  const label = attentionLabel(summary);
  return <>
    {failed && <span className="error header-error" role="alert">
      Could not show the request. <button className="btn" onClick={onRetry}>Retry</button>
    </span>}
    <button className={`icon-btn attention-btn${summary.total > 0 ? " active" : ""}`} disabled={summary.total === 0}
      aria-label={label} title={summary.total > 0 ? `${label}. Open the most urgent.` : label} onClick={onActivate}>
      <BellIcon size={16} />{summary.total > 0 && <span className="attention-count" aria-hidden="true">{summary.total}</span>}
    </button>
  </>;
}
