import { useRef, useState } from "react";
import { BellIcon, GitBranchIcon } from "@primer/octicons-react";
import {
  attentionLabel,
  type AttentionGroup,
  type AttentionReason,
  type AttentionSummary,
  type AttentionTarget,
} from "./attention";
import { Popover } from "./Popover";

/** The global header's signal for Threads waiting on the user across every open Project. */
export function AttentionButton({ summary, groups, failed, onActivate, onJump, onRetry }: {
  summary: AttentionSummary;
  groups: AttentionGroup[];
  /** The last jump could not show its destination. */
  failed: boolean;
  /** Jumps to the most urgent request, without opening the tray. */
  onActivate: () => void;
  /** Jumps to one tray item's Thread and focuses its response. */
  onJump: (target: AttentionTarget) => void;
  onRetry: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = attentionLabel(summary);
  // Attention can clear while the tray is open (another window answers it).
  const showTray = open && summary.total > 0;

  return <>
    {failed && <span className="error header-error" role="alert">
      Could not show the request. <button className="btn" onClick={onRetry}>Retry</button>
    </span>}
    <button ref={trigger} className={`icon-btn attention-btn${summary.total > 0 ? " active" : ""}`}
      disabled={summary.total === 0} aria-haspopup="dialog" aria-expanded={showTray}
      aria-label={label} title={summary.total > 0 ? `${label}. Open the Attention Center.` : label}
      onClick={() => setOpen((current) => !current)}>
      <BellIcon size={16} />{summary.total > 0 && <span className="attention-count" aria-hidden="true">{summary.total}</span>}
    </button>
    {showTray && <Popover anchor={trigger} label="Attention Center" onClose={() => setOpen(false)} width={360}>
      <div className="attention-tray">
        <header className="attention-tray-head">
          <h2>Attention Center</h2>
          <span>{label}</span>
        </header>
        {groups.length === 0 ? <p className="attention-empty">Nothing needs you.</p> : groups.map((group) => (
          <section key={group.projectId} className="attention-group" aria-label={`${group.projectName} Attention`}>
            <h3>{group.projectName}</h3>
            <ul>
              {group.items.map((item) => (
                <li key={item.threadId}>
                  <button className="attention-item" onClick={() => { setOpen(false); onJump(item.target); }}>
                    <span className="attention-item-head">
                      <span className="attention-item-title">{item.title}</span>
                      {item.branch && <span className="attention-item-branch"><GitBranchIcon size={12} /> {item.branch}</span>}
                    </span>
                    <span className="attention-item-reason">
                      <span className={`badge attention-reason ${item.reason.kind}`}>{reasonLabel(item.reason)}</span>
                      {item.reason.kind === "approval" && <span className="attention-item-summary">{item.reason.summary}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length > 0 && <footer className="attention-tray-foot">
          <button className="btn" onClick={() => { setOpen(false); onActivate(); }}>Go to most urgent</button>
        </footer>}
      </div>
    </Popover>}
  </>;
}

function reasonLabel(reason: AttentionReason): string {
  switch (reason.kind) {
    case "approval": return "Pending Approval";
    case "needs-input": return "Needs Input";
    case "error": return "Failed Turn";
    case "interrupted": return "Interrupted";
  }
}
