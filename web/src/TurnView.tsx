import { memo, useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  LightBulbIcon,
  PersonIcon,
  ToolsIcon,
} from "@primer/octicons-react";
import {
  commands,
  type ApprovalDecision,
  type ApprovalSnapshot,
  type ItemSnapshot,
} from "./bindings";
import { useOpenDiff } from "./diffOpen";
import { ItemContent } from "./ItemContent";
import { ProviderMark } from "./ProviderMark";
import type { TranscriptTurn } from "./transcript";
import {
  formatTime,
  groupTurnItems,
  modelEffortLabel,
  splitHeadline,
  type Block,
} from "./transcriptView";

function Collapsible({
  label,
  icon,
  defaultOpen = false,
  className,
  children,
}: {
  label: React.ReactNode;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapsible ${className ?? ""}`}>
      <button
        type="button"
        className="collapsible-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        {icon}
        <span className="collapsible-label">{label}</span>
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

function ToolCall({ item }: { item: ItemSnapshot }) {
  const { headline, detail } = splitHeadline(item.content);
  if (!detail) {
    return <div className="tool-call tool-call-plain">{headline}</div>;
  }
  return (
    <Collapsible label={headline} icon={<ToolsIcon size={12} />} className="tool-call">
      <pre className="tool-detail">{detail}</pre>
    </Collapsible>
  );
}

function BlockView({ block }: { block: Block }) {
  const openDiff = useOpenDiff();
  switch (block.type) {
    case "tools":
      return (
        <Collapsible
          label={`${block.items.length} tool call${block.items.length === 1 ? "" : "s"}`}
          icon={<ToolsIcon size={12} />}
          className="tool-group"
        >
          <div className="rail">
            {block.items.map((it) => (
              <ToolCall key={it.id || it.itemIndex} item={it} />
            ))}
          </div>
        </Collapsible>
      );
    case "message":
      return (
        <div className={block.final ? "agent-message final" : "agent-message"}>
          <ItemContent content={block.item.content} />
        </div>
      );
    case "command":
      return (
        <div className="command-output" aria-label="Command output">
          <ItemContent content={block.item.content} />
        </div>
      );
    case "reasoning":
      return (
        <Collapsible label="Reasoning" icon={<LightBulbIcon size={12} />} className="reasoning">
          <div className="reasoning-text">{block.item.content}</div>
        </Collapsible>
      );
    case "file":
      return (
        <button
          type="button"
          className="file-change"
          onClick={() => openDiff(splitHeadline(block.item.content).headline)}
          aria-label={`Open diff for ${splitHeadline(block.item.content).headline}`}
        >
          <FileDiffIcon size={12} />
          <span>{splitHeadline(block.item.content).headline}</span>
        </button>
      );
    case "subagent": {
      const { headline, detail } = splitHeadline(block.item.content);
      return (
        <Collapsible
          label={headline}
          icon={<CommentDiscussionIcon size={12} />}
          className="subagent"
          defaultOpen
        >
          {detail && <div className="subagent-task">{detail}</div>}
          <div className="rail">
            {block.children.map((child, i) => (
              <BlockView key={i} block={child} />
            ))}
          </div>
        </Collapsible>
      );
    }
  }
}

function AttachmentImage({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked: string | null = null;
    let active = true;
    void commands.readAttachment(path).then((res) => {
      if (!active || res.status !== "ok") return;
      revoked = URL.createObjectURL(new Blob([new Uint8Array(res.data)]));
      setUrl(revoked);
    });
    return () => {
      active = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [path]);
  if (!url) return null;
  return <img className="attachment" src={url} alt="Attached" />;
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

export const TurnView = memo(function TurnView({
  turn,
  provider,
  onRespond,
  isWorking,
}: {
  turn: TranscriptTurn;
  provider: string;
  onRespond: (approvalId: string, decision: ApprovalDecision) => void;
  isWorking: boolean;
}) {
  const blocks = groupTurnItems(turn.items);
  const approvals = turn.approvals ?? [];
  return (
    <section className="turn">
      <div className="user-message">
        <div className="user-meta">
          <PersonIcon size={12} /> You · {formatTime(turn.startedAt)}
        </div>
        <div className="user-bubble">
          {turn.attachments.length > 0 && (
            <div className="attachments">
              {turn.attachments.map((p) => (
                <AttachmentImage key={p} path={p} />
              ))}
            </div>
          )}
          {turn.prompt}
        </div>
      </div>
      {(blocks.length > 0 || approvals.length > 0 || turn.status === "running") && (
        <div className="agent-turn">
          <div className="agent-header">
            <ProviderMark provider={provider} />
            <span>{modelEffortLabel(turn.model ?? null, turn.effort ?? null)}</span>
          </div>
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
