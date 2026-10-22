import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  commands,
  type ApprovalDecision,
  type ApprovalSnapshot,
  type DebugSequencedThreadEvent,
  type Detection,
  type ItemSnapshot,
  type PermissionMode,
  type SequencedThreadEvent,
  type Thread,
  type ThreadStatus,
  type TurnSnapshot,
} from "./bindings";
import { getClaudeCodeHint } from "./providerHints";
import { createFrameBatcher } from "./frameBatcher";
import { pageRequest, pagesToLoad, turnAt, type HistoryPages } from "./history";
import { ItemContent } from "./ItemContent";
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

/** How close to the bottom (px) still counts as following the stream. */
const STICK_TO_BOTTOM = 48;
/** How long (ms) the visible range must hold still before paging history in. */
const PAGE_LOAD_DELAY = 80;

const ItemView = memo(function ItemView({ item }: { item: ItemSnapshot }) {
  return (
    <div className="message agent">
      <div className="message-header">
        Agent {item.kind !== "agent_message" && `(${item.kind})`}
      </div>
      <ItemContent content={item.content} />
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
  const [pages, setPages] = useState<HistoryPages>(new Map());
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugState, setDebugState] = useState<{
    threadId: number | null;
    events: DebugSequencedThreadEvent[];
  }>({ threadId: null, events: [] });
  const [draftMode, setDraftMode] = useState<PermissionMode>("auto-edit");
  const [draftProvider, setDraftProvider] = useState<string>("claude");
  const [providerDetection, setProviderDetection] = useState<Detection | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  /** Where the view was last pinned to the bottom; null before the first pin. */
  const pinnedAtRef = useRef<number | null>(null);
  const requestedPagesRef = useRef(new Set<number>());

  // Load defaults from settings for a fresh thread
  useEffect(() => {
    if (threadId) return;
    let active = true;
    void (async () => {
      const s = await commands.getSettings();
      if (!active) return;
      const defProvider = s.settings.defaultProvider;
      setDraftProvider(defProvider);
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
    followRef.current = true;
    pinnedAtRef.current = null;
    requestedPagesRef.current = new Set();

    if (!threadId) {
      void Promise.resolve().then(() => {
        if (active) {
          setTranscript(initialTranscriptState(null));
          setPages(new Map());
        }
      });
      return () => {
        active = false;
      };
    }

    // Per-token deltas never reach React directly: at most one update per frame.
    const batcher = createFrameBatcher<SequencedThreadEvent>((batch) => {
      if (!active) return;
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
    const channel = new Channel<SequencedThreadEvent | DebugSequencedThreadEvent>();
    channel.onmessage = (event) => {
      if ("rawPayload" in event) {
        setDebugState((previous) => ({
          threadId,
          events: [...(previous.threadId === threadId ? previous.events : []).slice(-199), event],
        }));
      }
      batcher.push(event as SequencedThreadEvent);
    };

    void (async () => {
      const res = debugOpen
        ? await commands.subscribeThreadDebug(threadId, channel as Channel<DebugSequencedThreadEvent>)
        : await commands.subscribeThread(threadId, channel as Channel<SequencedThreadEvent>);
      if (active && res.status === "ok") {
        const initial = initialTranscriptState(res.data);
        setTranscript(initial);
        setPages(new Map());
        onStatusChange(threadId, initial.status);
      }
    })();

    return () => {
      active = false;
      batcher.cancel();
    };
  }, [threadId, onStatusChange, debugOpen]);

  const debugEvents = debugState.threadId === threadId ? debugState.events : [];

  const turnCount = transcript.turnOffset + transcript.turns.length;
  const virtualizer = useVirtualizer({
    count: turnCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    overscan: 6,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const firstVisible = virtualRows[0]?.index ?? 0;
  const lastVisible = virtualRows[virtualRows.length - 1]?.index ?? -1;

  // Page in older history under the visible rows, however far back the jump.
  // Waits for the range to settle, so dragging the scrollbar across thousands
  // of Turns only loads where it stops.
  useEffect(() => {
    if (!threadId || lastVisible < 0) return;
    const requested = requestedPagesRef.current;
    const timer = setTimeout(() => {
      const missing = pagesToLoad(firstVisible, lastVisible, transcript.turnOffset, (page) =>
        requested.has(page)
      );
      for (const page of missing) {
        requested.add(page);
        const { offset, limit } = pageRequest(page, transcript.turnOffset);
        void commands.listTurns(threadId, offset, limit).then((res) => {
          if (requestedPagesRef.current !== requested) return; // Thread changed.
          if (res.status === "ok") {
            setPages((prev) => new Map(prev).set(page, res.data.turns));
          } else {
            requested.delete(page);
          }
        });
      }
    }, PAGE_LOAD_DELAY);
    return () => clearTimeout(timer);
  }, [threadId, firstVisible, lastVisible, transcript.turnOffset]);

  // Open on the newest Turn and follow the stream while scrolled to the
  // bottom, including when measuring rows changes the total height.
  const totalSize = virtualizer.getTotalSize();
  // The virtualizer re-renders synchronously inside its own scroll listener,
  // possibly before `onScroll` runs, so a moved scrollTop also means the user
  // scrolled away.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    const pinnedAt = pinnedAtRef.current;
    if (pinnedAt !== null && Math.abs(el.scrollTop - pinnedAt) > 1) return;
    el.scrollTop = el.scrollHeight;
    pinnedAtRef.current = el.scrollTop;
  }, [transcript.turns, totalSize]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM;
    if (followRef.current) pinnedAtRef.current = el.scrollTop;
  };

  // Stable, so memoized TurnViews skip re-rendering while another Turn streams.
  const handleRespond = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      if (!threadId) return;
      await commands.respondToApproval(threadId, approvalId, decision);
    },
    [threadId]
  );

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
  const currentProvider = transcript.thread?.provider || draftProvider;

  useEffect(() => {
    let active = true;
    if (currentProvider === "claude") {
      void commands.detectProvider("claude").then((res) => {
        if (active && res.status === "ok") {
          setProviderDetection(res.data);
        }
      });
    } else {
      void Promise.resolve().then(() => {
        if (active) setProviderDetection(null);
      });
    }
    return () => {
      active = false;
    };
  }, [currentProvider]);

  const providerHint = currentProvider === "claude" ? getClaudeCodeHint(providerDetection) : null;

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

  const isTurnActive = transcript.status === "working" || transcript.status === "needs-input";

  return (
    <div className="thread-container">
      <div className="thread-debug-toolbar">
        <button type="button" onClick={() => setDebugOpen((open) => !open)} aria-pressed={debugOpen}>
          {debugOpen ? "Close raw event debug" : "Open raw event debug"}
        </button>
      </div>
      {debugOpen && (
        <section className="thread-debug-view" aria-label="Raw event debug view">
          <h3>Raw provider events</h3>
          {transcript.turns.flatMap((turn) => turn.unknownEvents ?? []).map((unknown) => (
            <pre key={`persisted-${unknown.id}`}><strong>Persisted Unknown</strong>{"\n"}{unknown.raw}</pre>
          ))}
          {debugEvents.map((entry) => (
            <pre key={entry.seq}>
              <strong>#{entry.seq} {entry.event.type}</strong>{"\n"}
              {entry.rawPayload ?? "No provider payload (synthetic event)"}
            </pre>
          ))}
          {debugEvents.length === 0 && transcript.turns.every((turn) => !(turn.unknownEvents?.length)) && (
            <p>Raw provider events will appear while a Turn is running.</p>
          )}
        </section>
      )}
      <div className="transcript" aria-label="Transcript" ref={scrollRef} onScroll={onScroll}>
        {turnCount === 0 ? (
          <div className="empty-thread">
            <p>Pick a Project, type a prompt, and watch the agent message stream in.</p>
          </div>
        ) : (
          <div className="transcript-rows" style={{ height: totalSize }}>
            {virtualRows.map((row) => {
              const turn = turnAt(row.index, transcript, pages);
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="transcript-row"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {turn ? (
                    <TurnView turn={turn} onRespond={handleRespond} isWorking={isTurnActive} />
                  ) : (
                    <div className="turn-placeholder" aria-busy />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {providerHint && providerHint.type !== "ok" && (
        <div className={`provider-hint ${providerHint.type}`} role="alert">
          <span className="hint-message">{providerHint.message}</span>
          {providerHint.command && (
            <code className="hint-command">{providerHint.command}</code>
          )}
        </div>
      )}

      <form className="composer" onSubmit={handleSubmit}>
        <div className="permission-chip-wrapper" title="Permission mode">
          <label className="permission-chip" htmlFor="permission-mode-select">
            <span className="permission-chip-icon">{currentModeConfig.icon}</span>
            <select
              id="permission-mode-select"
              className="permission-chip-select"
              value={currentMode}
              disabled={isTurnActive || sending}
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
          placeholder={isTurnActive ? "Agent is working…" : "Type a prompt…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isTurnActive || sending}
        />
        <button
          type="submit"
          className="composer-submit"
          disabled={!input.trim() || isTurnActive || sending}
        >
          Send
        </button>
      </form>
    </div>
  );
}
