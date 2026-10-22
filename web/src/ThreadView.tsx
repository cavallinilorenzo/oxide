import { memo, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  commands,
  type ApprovalDecision,
  type ApprovalSnapshot,
  type ItemSnapshot,
  type PermissionMode,
  type SequencedThreadEvent,
  type Thread,
  type ThreadStatus,
  type TurnSnapshot,
} from "./bindings";
import { applyThreadEvent, initialTranscriptState, type TranscriptState } from "./transcript";

interface ThreadViewProps {
  threadId: number | null;
  projectId: number;
  onThreadCreated: (thread: Thread) => void;
  onStatusChange: (threadId: number, status: ThreadStatus) => void;
}

export const PERMISSION_CONFIG: Record<
  PermissionMode,
  { icon: string; label: string; softDenyLabel: string }
> = {
  ask: { icon: "🔒", label: "Ask", softDenyLabel: "Ask" },
  "auto-edit": { icon: "🛡️", label: "Auto-edit", softDenyLabel: "Auto-edit (soft-deny)" },
  "full-access": { icon: "🔓", label: "Full access", softDenyLabel: "Full access" },
};

export function getOfferedPermissionModes(
  supportedModes: PermissionMode[],
  provider: string
): { mode: PermissionMode; label: string; icon: string }[] {
  const isAgy = provider === "antigravity" || provider === "agy";
  return supportedModes
    .filter((m) => PERMISSION_CONFIG[m])
    .map((m) => ({
      mode: m,
      label: isAgy ? PERMISSION_CONFIG[m].softDenyLabel : PERMISSION_CONFIG[m].label,
      icon: PERMISSION_CONFIG[m].icon,
    }));
}

const ItemView = memo(function ItemView({ item }: { item: ItemSnapshot }) {
  return (
    <div className="message agent">
      <div className="message-header">
        Agent {item.kind !== "agent_message" && `(${item.kind})`}
      </div>
      <div className="message-content">{item.content}</div>
    </div>
  );
});

const ApprovalView = memo(function ApprovalView({
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

const TurnView = memo(function TurnView({
  turn,
  onRespond,
  isWorking,
}: {
  turn: TurnSnapshot;
  onRespond: (approvalId: string, decision: ApprovalDecision) => void;
  isWorking: boolean;
}) {
  const entries = [
    ...(turn.items || []).map((item) => ({
      type: "item" as const,
      id: `item-${item.id}-${item.itemIndex}`,
      time: item.createdAt,
      data: item,
    })),
    ...(turn.approvals || []).map((app) => ({
      type: "approval" as const,
      id: `appr-${app.id}-${app.approvalId}`,
      time: app.createdAt,
      data: app,
    })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <div className="turn">
      <div className="message user">
        <div className="message-header">You</div>
        <div className="message-content">{turn.prompt}</div>
      </div>
      {entries.map((entry) =>
        entry.type === "item" ? (
          <ItemView key={entry.id} item={entry.data} />
        ) : (
          <ApprovalView
            key={entry.id}
            approval={entry.data}
            onRespond={onRespond}
            disabled={!isWorking && turn.status !== "running"}
          />
        )
      )}
    </div>
  );
});

export function ThreadView({
  threadId,
  projectId,
  onThreadCreated,
  onStatusChange,
}: ThreadViewProps) {
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscriptState(null));
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [draftMode, setDraftMode] = useState<PermissionMode>("auto-edit");
  const bottomRef = useRef<HTMLDivElement>(null);
  const pendingEventsRef = useRef<SequencedThreadEvent[]>([]);
  const rafIdRef = useRef<number>(0);

  // Load defaults from settings for a fresh thread
  useEffect(() => {
    if (threadId) return;
    let active = true;
    void (async () => {
      const s = await commands.getSettings();
      if (!active) return;
      const defProvider = s.settings.defaultProvider;
      const defMode = s.settings.providers[defProvider]?.permissionMode || "auto-edit";
      setDraftMode(defMode);

      const capsRes = await commands.getProviderCapabilities(defProvider);
      if (active && capsRes.status === "ok") {
        setTranscript((prev) => ({
          ...prev,
          supportedPermissionModes: capsRes.data.supportedPermissionModes,
        }));
      }
    })();
    return () => {
      active = false;
    };
  }, [threadId]);

  // Subscribe to the thread when threadId changes
  useEffect(() => {
    let active = true;

    if (!threadId) {
      void Promise.resolve().then(() => {
        if (active) setTranscript(initialTranscriptState(null));
      });
      return () => {
        active = false;
      };
    }

    const channel = new Channel<SequencedThreadEvent>();
    channel.onmessage = (event) => {
      pendingEventsRef.current.push(event);
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = 0;
          const batch = pendingEventsRef.current;
          pendingEventsRef.current = [];
          if (!active || batch.length === 0) return;
          setTranscript((prev) => {
            let next = prev;
            for (const evt of batch) {
              next = applyThreadEvent(next, evt);
            }
            if (next.status !== prev.status) {
              onStatusChange(threadId, next.status);
            }
            return next;
          });
        });
      }
    };

    void (async () => {
      const res = await commands.subscribeThread(threadId, channel);
      if (active && res.status === "ok") {
        const initial = initialTranscriptState(res.data);
        setTranscript(initial);
        onStatusChange(threadId, initial.status);
      }
    })();

    return () => {
      active = false;
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      pendingEventsRef.current = [];
    };
  }, [threadId, onStatusChange]);

  // Auto-scroll to bottom as messages stream in
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript.turns]);

  const handleRespond = async (approvalId: string, decision: ApprovalDecision) => {
    if (!threadId) return;
    await commands.respondToApproval(threadId, approvalId, decision);
  };

  const handlePermissionChange = async (newMode: PermissionMode) => {
    if (threadId) {
      await commands.setThreadPermissionMode(threadId, newMode);
      setTranscript((prev) =>
        prev.thread
          ? { ...prev, thread: { ...prev.thread, permissionMode: newMode } }
          : prev
      );
    } else {
      setDraftMode(newMode);
    }
  };

  const currentMode = transcript.thread?.permissionMode || draftMode;
  const currentProvider = transcript.thread?.provider || "claude";
  const offeredModes = getOfferedPermissionModes(
    transcript.supportedPermissionModes || ["ask", "auto-edit", "full-access"],
    currentProvider
  );
  const currentModeConfig = PERMISSION_CONFIG[currentMode] || PERMISSION_CONFIG["auto-edit"];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || sending) return;

    setSending(true);
    setInput("");

    try {
      let targetThreadId = threadId;
      if (!targetThreadId) {
        // Create new thread for this project with selected permission mode
        const settings = await commands.getSettings();
        const providerName = settings.settings.defaultProvider || "fake";
        const created = await commands.createThread(
          projectId,
          providerName,
          null,
          null,
          draftMode
        );
        if (created.status === "ok") {
          targetThreadId = created.data.id;
          onThreadCreated(created.data);
        } else {
          console.error("Failed to create thread:", created.error);
          setSending(false);
          return;
        }
      }

      await commands.sendPrompt(targetThreadId, prompt);
    } finally {
      setSending(false);
    }
  };

  const isWorking = transcript.status === "working";

  return (
    <div className="thread-container">
      <div className="transcript" aria-label="Transcript">
        {transcript.turns.length === 0 ? (
          <div className="empty-thread">
            <p>Pick a Project, type a prompt, and watch the agent message stream in.</p>
          </div>
        ) : (
          transcript.turns.map((turn, tIdx) => (
            <TurnView
              key={turn.id || tIdx}
              turn={turn}
              onRespond={handleRespond}
              isWorking={isWorking}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <div className="permission-chip-wrapper" title="Permission mode">
          <label className="permission-chip" htmlFor="permission-mode-select">
            <span className="permission-chip-icon">{currentModeConfig.icon}</span>
            <select
              id="permission-mode-select"
              className="permission-chip-select"
              value={currentMode}
              disabled={isWorking}
              onChange={(e) => handlePermissionChange(e.target.value as PermissionMode)}
              aria-label="Permission mode"
            >
              {offeredModes.map((item) => (
                <option key={item.mode} value={item.mode}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <input
          type="text"
          className="composer-input"
          placeholder={isWorking ? "Agent is working…" : "Type a prompt…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isWorking || sending}
        />
        <button
          type="submit"
          className="composer-submit"
          disabled={!input.trim() || isWorking || sending}
        >
          Send
        </button>
      </form>
    </div>
  );
}
