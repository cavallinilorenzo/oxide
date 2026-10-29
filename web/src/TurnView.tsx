import { memo, useState } from "react";
import { PersonIcon } from "@primer/octicons-react";
import type { ApprovalDecision, ApprovalSnapshot } from "./bindings";
import { AttachmentChip } from "./AttachmentChip";
import { ItemContent } from "./ItemContent";
import { ProviderMark } from "./ProviderMark";
import { ActivityView } from "./ActivityView";
import { liveStatus } from "./activity";
import type { TranscriptTurn } from "./transcript";
import { formatTime, groupTurnItems, modelEffortLabel, type Block } from "./transcriptView";

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "message":
      return (
        <div className={block.final ? "agent-message final" : "agent-message"}>
          <ItemContent content={block.item.content} markdown />
        </div>
      );
    case "command":
      return (
        <div className="command-output" aria-label="Command output">
          <ItemContent content={block.item.content} />
        </div>
      );
    case "activity":
      return null; // drawn by TurnView, which knows whether the Turn is live
  }
}

export const ApprovalView = memo(function ApprovalView({
  approval,
  onRespond,
  disabled,
}: {
  approval: ApprovalSnapshot;
  onRespond: (approvalId: string, decision: ApprovalDecision) => void;
  disabled?: boolean;
}) {
  const isPending = !approval.decision;
  const kindLabel =
    approval.kind === "file-change" || approval.kind === "file_change"
      ? "file change"
      : approval.kind;

  return (
    <div
      className={`approval-card ${isPending ? "pending" : "decided"}`}
      aria-label="Approval"
    >
      <div className="approval-header">
        <span className="approval-kind-badge">{kindLabel}</span>
        <span className="approval-title">Approval request</span>
        {approval.createdAt && (
          <span className="approval-time">
            {new Date(approval.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>

      <div className="approval-summary">{approval.summary}</div>

      {isPending ? (
        <div className="approval-actions">
          <button
            type="button"
            className="approval-btn allow"
            disabled={disabled}
            onClick={() => onRespond(approval.approvalId, "allow")}
          >
            Allow
          </button>
          <button
            type="button"
            className="approval-btn deny"
            disabled={disabled}
            onClick={() => onRespond(approval.approvalId, "deny")}
          >
            Deny
          </button>
          {approval.options?.map((opt) => (
            <button
              key={opt}
              type="button"
              className="approval-btn option"
              disabled={disabled}
              onClick={() => onRespond(approval.approvalId, "allow")}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <div className="approval-decision-bar">
          <span className={`approval-decision ${approval.decision}`}>
            {approval.decision === "allow" ? "Allowed" : "Denied"}
          </span>
          {approval.decidedAt && (
            <span className="approval-decision-time">
              at{" "}
              {new Date(approval.decidedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

/** A Turn sent this moment, as opposed to one scrolled back into view. */
const JUST_SENT_MS = 1500;

export const TurnView = memo(function TurnView({
  turn,
  provider,
  onRespond,
  isWorking,
  instant = false,
}: {
  turn: TranscriptTurn;
  provider: string;
  onRespond: (approvalId: string, decision: ApprovalDecision) => void;
  isWorking: boolean;
  /** Skips the send animation: the prompt is already on screen as the outgoing Turn. */
  instant?: boolean;
}) {
  const [justSent] = useState(
    () => !instant && turn.status === "running" && Date.now() - Date.parse(turn.startedAt) < JUST_SENT_MS
  );
  const blocks = groupTurnItems(turn.items);
  const approvals = turn.approvals ?? [];
  const activityBlock = blocks.find((b) => b.type === "activity");
  const activity = activityBlock?.type === "activity" ? activityBlock.activity : null;
  const waitingOnApproval = approvals.some((a) => !a.decision);
  const live = turn.status === "running" && !waitingOnApproval ? liveStatus(activity) : null;
  const ended = turn.completedAt ? Date.parse(turn.completedAt) - Date.parse(turn.startedAt) : NaN;
  const workedMs = turn.status !== "running" && !Number.isNaN(ended) ? ended : null;
  return (
    <section className="turn">
      <div className={justSent ? "user-message just-sent" : "user-message"}>
        <div className="user-meta">
          <PersonIcon size={12} /> You · {formatTime(turn.startedAt)}
        </div>
        <div className="user-bubble">
          {turn.segments.map((segment, i) =>
            segment.kind === "text" ? (
              <span key={i}>{segment.text}</span>
            ) : (
              <AttachmentChip key={i} name={segment.name} kind={segment.attachmentKind} sizeBytes={segment.sizeBytes} />
            ),
          )}
        </div>
      </div>
      {(blocks.length > 0 || approvals.length > 0 || turn.status === "running") && (
        <div className="agent-turn">
          <div className="agent-header">
            <ProviderMark provider={provider} />
            <span>{modelEffortLabel(turn.model ?? null, turn.effort ?? null)}</span>
          </div>
          {(activity || live || waitingOnApproval) && (
            <ActivityView
              activity={activity}
              live={live}
              waiting={turn.status === "running" && waitingOnApproval}
              startedAt={turn.startedAt}
              workedMs={workedMs}
            />
          )}
          {blocks.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
          {approvals.map((approval) => (
            <ApprovalView
              key={`${approval.id}-${approval.approvalId}`}
              approval={approval}
              onRespond={onRespond}
              disabled={!isWorking && turn.status !== "running"}
            />
          ))}
        </div>
      )}
      {turn.status === "running" && turn.retryNotice && (
        <div className="turn-notice" role="status">
          {turn.retryNotice}
        </div>
      )}
      {turn.status === "interrupted" && <div className="turn-notice">Interrupted</div>}
      {turn.status === "error" && (
        <div className="turn-error" role="alert">
          <div>{turn.error?.message ?? "The Turn failed"}</div>
          {turn.error?.stderrTail && <pre className="turn-stderr">{turn.error.stderrTail}</pre>}
        </div>
      )}
    </section>
  );
});
