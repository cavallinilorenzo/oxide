import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpIcon,
  BugIcon,
  ChevronDownIcon,
  FileDirectoryIcon,
  GitBranchIcon,
  LightBulbIcon,
  LockIcon,
  PaperclipIcon,
  PencilIcon,
  RepoIcon,
  ShieldCheckIcon,
  SquareFillIcon,
  UnlockIcon,
  XIcon,
  type Icon,
} from "@primer/octicons-react";
import {
  commands,
  type ApprovalDecision,
  type ContinuedThread,
  type DebugSequencedThreadEvent,
  type Detection,
  type PermissionMode,
  type SequencedThreadEvent,
  type Thread,
  type ThreadCapabilities,
  type ThreadStatus,
  type ProviderCapabilities,
} from "./bindings";
import { TurnView } from "./TurnView";
import { isBoardThread } from "./dispatch";
import { getClaudeCodeHint } from "./providerHints";
import { createFrameBatcher } from "./frameBatcher";
import { pageRequest, pagesToLoad, turnAt, type TranscriptPages } from "./transcriptPages";
import { isClearCommand, stopsTurn } from "./shortcuts";
import { ProviderMark } from "./ProviderMark";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { parseSlashCommand } from "./modelPicker";
import {
  applyThreadEvent,
  initialTranscriptState,
  SESSION_LOST_MESSAGE,
  turnIsRunning,
  type TranscriptState,
} from "./transcript";

/** How close to the bottom (px) still counts as following the stream. */
const STICK_TO_BOTTOM = 48;
/** How long (ms) the visible range must hold still before paging older Turns in. */
const PAGE_LOAD_DELAY = 80;

interface ThreadViewProps {
  threadId: number | null;
  projectId: number;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onClearThread?: () => void;
  onThreadCreated: (thread: Thread) => void;
  onThreadUpdated?: (thread: Thread) => void;
  onStatusChange: (threadId: number, status: ThreadStatus) => void;
  onThreadTitleChange?: (threadId: number, title: string) => void;
  /** Text to put in this Thread's composer once, e.g. the recap of a continued Thread. */
  prefill: { threadId: number; text: string } | null;
  onPrefillUsed: () => void;
  onOpenThread: (threadId: number) => void;
  onThreadContinued: (continued: ContinuedThread, from: number) => void;
}


const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

interface PendingImage {
  path: string;
  previewUrl: string;
}

/** Octicon names: lock = Ask, shield = Auto-edit, open lock = Full access. */
export type PermissionIcon = "lock" | "shield-check" | "unlock";

export const PERMISSION_CONFIG: Record<
  PermissionMode,
  { icon: PermissionIcon; label: string; softDenyLabel: string }
> = {
  ask: { icon: "lock", label: "Ask", softDenyLabel: "Ask" },
  "auto-edit": { icon: "shield-check", label: "Auto-edit", softDenyLabel: "Auto-edit (soft-deny)" },
  "full-access": { icon: "unlock", label: "Full access", softDenyLabel: "Full access" },
};

const PERMISSION_ICONS: Record<PermissionIcon, Icon> = {
  lock: LockIcon,
  "shield-check": ShieldCheckIcon,
  unlock: UnlockIcon,
};

export function getOfferedPermissionModes(
  supportedModes: PermissionMode[],
  provider: string
): { mode: PermissionMode; label: string; icon: PermissionIcon }[] {
  const isAgy = provider === "antigravity" || provider === "agy";
  return supportedModes
    .filter((m) => PERMISSION_CONFIG[m])
    .map((m) => ({
      mode: m,
      label: isAgy ? PERMISSION_CONFIG[m].softDenyLabel : PERMISSION_CONFIG[m].label,
      icon: PERMISSION_CONFIG[m].icon,
    }));
}

export function ThreadView({
  threadId,
  projectId,
  draft,
  onDraftChange,
  onClearThread,
  onThreadCreated,
  onThreadUpdated,
  onStatusChange,
  onThreadTitleChange,
  prefill,
  onPrefillUsed,
  onOpenThread,
  onThreadContinued,
}: ThreadViewProps) {
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscriptState(null));
  const [pages, setPages] = useState<TranscriptPages>(new Map());
  const [input, setInput] = useState(draft ?? "");
  const [sending, setSending] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [newThreadCaps, setNewThreadCaps] = useState<ThreadCapabilities | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugState, setDebugState] = useState<{
    threadId: number | null;
    events: DebugSequencedThreadEvent[];
  }>({ threadId: null, events: [] });
  const [draftMode, setDraftMode] = useState<PermissionMode>("auto-edit");
  const [draftProvider, setDraftProvider] = useState<string>("claude");
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerMode, setModelPickerMode] = useState<"model" | "effort">("model");
  const [providerCaps, setProviderCaps] = useState<ProviderCapabilities | null>(null);
  const [providerDetection, setProviderDetection] = useState<Detection | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  /** Where the view was last pinned to the bottom; null before the first pin. */
  const pinnedAtRef = useRef<number | null>(null);
  const requestedPagesRef = useRef(new Set<number>());

  useEffect(() => {
    if (draft !== undefined) {
      setInput(draft);
    }
  }, [draft, threadId]);

  const handleInputChange = (val: string) => {
    setInput(val);
    onDraftChange?.(val);
  };

  useEffect(() => {
    let active = true;
    void commands.gitStatus(projectId).then((res) => {
      if (active && res.status === "ok") {
        setGitBranch(res.data.branch ?? "detached HEAD");
      }
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  // Load defaults from settings for a fresh thread
  useEffect(() => {
    if (threadId) return;
    let active = true;
    void (async () => {
      const s = await commands.getSettings();
      if (!active) return;
      const defProvider = s.settings.defaultProvider;
      setDraftProvider(defProvider);
      const provSettings = s.settings.providers[defProvider];
      const defMode = provSettings?.permissionMode || "auto-edit";
      setDraftMode(defMode);
      setDraftModel(provSettings?.model ?? null);
      setDraftEffort(provSettings?.effort ?? null);

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
        if (next.thread?.title !== prev.thread?.title && next.thread?.title) {
          onThreadTitleChange?.(threadId, next.thread.title);
        }
        return next;
      });
    });
    // Events can reach the channel before the subscribe call returns its snapshot;
    // hold them back and replay them on top of it instead of losing them.
    let snapshotApplied = false;
    const early: SequencedThreadEvent[] = [];
    const channel = new Channel<SequencedThreadEvent | DebugSequencedThreadEvent>();
    channel.onmessage = (event) => {
      if ("rawPayload" in event) {
        setDebugState((previous) => ({
          threadId,
          events: [...(previous.threadId === threadId ? previous.events : []).slice(-199), event],
        }));
      }
      if (snapshotApplied) batcher.push(event as SequencedThreadEvent);
      else early.push(event as SequencedThreadEvent);
    };

    void (async () => {
      const res = debugOpen
        ? await commands.subscribeThreadDebug(threadId, channel as Channel<DebugSequencedThreadEvent>)
        : await commands.subscribeThread(threadId, channel as Channel<SequencedThreadEvent>);
      if (active && res.status === "ok") {
        const initial = early.reduce(applyThreadEvent, initialTranscriptState(res.data));
        snapshotApplied = true;
        setTranscript(initial);
        setPages(new Map());
        onStatusChange(threadId, initial.status);
        if (initial.thread?.title) {
          onThreadTitleChange?.(threadId, initial.thread.title);
        }
      }
    })();

    return () => {
      active = false;
      batcher.cancel();
    };
  }, [threadId, onStatusChange, debugOpen, onThreadTitleChange]);

  // A continued Thread opens with its recap in the composer.
  useEffect(() => {
    if (prefill && prefill.threadId === threadId) {
      setInput(prefill.text);
      onPrefillUsed();
    }
  }, [prefill, threadId, onPrefillUsed]);

  const debugEvents = debugState.threadId === threadId ? debugState.events : [];

  // Before a Thread exists, ask what the Provider it will use supports.
  useEffect(() => {
    if (threadId) return;
    let active = true;
    void commands.providerCapabilities(draftProvider).then((caps) => {
      if (active) setNewThreadCaps(caps);
    });
    return () => {
      active = false;
    };
  }, [threadId, draftProvider]);

  const imagesOffered = (threadId ? transcript.capabilities : newThreadCaps)?.imageAttachments ?? false;

  const addImage = async (file: File) => {
    const ext = IMAGE_EXTENSIONS[file.type];
    if (!ext) return;
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const saved = await commands.saveAttachment(bytes, ext);
    if (saved.status !== "ok") {
      console.error("Failed to store image:", saved.error);
      return;
    }
    setPendingImages((prev) => [...prev, { path: saved.data, previewUrl: URL.createObjectURL(file) }]);
  };

  const removeImage = (path: string) => {
    setPendingImages((prev) => {
      const gone = prev.find((i) => i.path === path);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((i) => i.path !== path);
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!imagesOffered) return;
    const files = Array.from(e.clipboardData.files).filter((f) => f.type in IMAGE_EXTENSIONS);
    if (files.length === 0) return;
    e.preventDefault();
    files.forEach((f) => void addImage(f));
  };

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

  // Page in older Turns under the visible rows, however far back the jump.
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

  const handleProviderChange = async (newProvider: string) => {
    if (turnCount > 0 || isTurnActive || sending) return;
    const s = await commands.getSettings();
    const provKey = newProvider as keyof typeof s.settings.providers;
    const provSettings = s.settings.providers[provKey];
    const newMode = provSettings?.permissionMode || "auto-edit";

    if (threadId) {
      const res = await commands.setThreadProvider(threadId, newProvider);
      if (res.status === "ok") {
        setTranscript((prev) =>
          prev.thread ? { ...prev, thread: res.data } : prev
        );
        onThreadUpdated?.(res.data);
      }
    } else {
      setDraftProvider(newProvider);
      setDraftMode(newMode);
      setDraftModel(provSettings?.model ?? null);
      setDraftEffort(provSettings?.effort ?? null);
    }

    const capsRes = await commands.getProviderCapabilities(newProvider);
    if (capsRes.status === "ok") {
      setTranscript((prev) => ({
        ...prev,
        supportedPermissionModes: capsRes.data.supportedPermissionModes,
      }));
    }
  };

  const threadTitle =
    transcript.thread?.title || (threadId ? `Thread #${threadId}` : "New Thread");

  const handleStartRename = () => {
    if (!threadId) return;
    setEditTitle(transcript.thread?.title || `Thread #${threadId}`);
    setIsEditingTitle(true);
  };

  const handleSaveRename = async () => {
    setIsEditingTitle(false);
    const trimmed = editTitle.trim();
    if (!trimmed || !threadId) return;
    await commands.renameThread(threadId, trimmed);
    setTranscript((prev) =>
      prev.thread ? { ...prev, thread: { ...prev.thread, title: trimmed } } : prev
    );
    onThreadTitleChange?.(threadId, trimmed);
  };

  const currentMode = transcript.thread?.permissionMode || draftMode;
  const currentProvider = transcript.thread?.provider || draftProvider;
  const currentModel = threadId ? transcript.thread?.model ?? null : draftModel;
  const currentEffort = threadId ? transcript.thread?.effort ?? null : draftEffort;

  useEffect(() => {
    let active = true;
    void commands.getProviderCapabilities(currentProvider).then((res) => {
      if (active && res.status === "ok") {
        setProviderCaps(res.data);
      }
    });
    return () => {
      active = false;
    };
  }, [currentProvider]);

  const handleSelectModelAndEffort = async (
    newProvider: string,
    newModel: string | null,
    newEffort: string | null
  ) => {
    if (newProvider !== currentProvider && turnCount > 0) {
      // A Thread keeps its Provider: another Provider's model starts a new Thread.
      const created = await commands.createThread(
        projectId,
        newProvider,
        newModel,
        newEffort,
        currentMode
      );
      if (created.status === "ok") onThreadCreated(created.data);
      else console.error("Failed to create thread:", created.error);
      return;
    }
    if (newProvider !== currentProvider && turnCount === 0) {
      await handleProviderChange(newProvider);
    }
    if (threadId) {
      const res = await commands.setThreadModelAndEffort(threadId, newModel, newEffort);
      if (res.status === "ok") {
        setTranscript((prev) =>
          prev.thread
            ? {
                ...prev,
                thread: {
                  ...prev.thread,
                  model: newModel,
                  effort: newEffort,
                },
              }
            : prev
        );
      }
    } else {
      setDraftModel(newModel);
      setDraftEffort(newEffort);
    }
  };

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
    if (!prompt || sending || turnIsRunning(transcript.status)) return;

    if (isClearCommand(input)) {
      handleInputChange("");
      onClearThread?.();
      return;
    }

    const slash = parseSlashCommand(input);
    if (slash.type === "model") {
      if (slash.arg) {
        void handleSelectModelAndEffort(currentProvider, slash.arg, currentEffort);
      } else {
        setModelPickerMode("model");
        setModelPickerOpen(true);
      }
      handleInputChange("");
      return;
    }
    if (slash.type === "effort") {
      if (slash.arg) {
        void handleSelectModelAndEffort(currentProvider, currentModel, slash.arg);
      } else {
        setModelPickerMode("effort");
        setModelPickerOpen(true);
      }
      handleInputChange("");
      return;
    }

    setSending(true);
    handleInputChange("");

    try {
      let targetThreadId = threadId;
      if (!targetThreadId) {
        // Create new thread for this project with selected permission mode
        const settings = await commands.getSettings();
        const providerName = draftProvider || settings.settings.defaultProvider || "claude";
        const provKey = providerName as keyof typeof settings.settings.providers;
        const provSettings = settings.settings.providers[provKey];
        const created = await commands.createThread(
          projectId,
          providerName,
          draftModel ?? provSettings?.model ?? null,
          draftEffort ?? provSettings?.effort ?? null,
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

      const attachments = pendingImages.map((i) => i.path);
      pendingImages.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      setPendingImages([]);

      await commands.sendPrompt(targetThreadId, prompt, attachments);
    } finally {
      setSending(false);
    }
  };

  const isTurnActive = turnIsRunning(transcript.status);
  const thread = transcript.thread;

  const continueInNewThread = async () => {
    if (!threadId) return;
    const res = await commands.continueThread(threadId);
    if (res.status === "ok") onThreadContinued(res.data, threadId);
    else console.error("Failed to continue thread:", res.error);
  };

  const stop = () => {
    if (threadId) void commands.interruptThread(threadId);
  };

  return (
    <div className="thread-container">
      <div className="thread-header-bar">
        {isEditingTitle ? (
          <input
            className="thread-title-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => void handleSaveRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSaveRename();
              if (e.key === "Escape") setIsEditingTitle(false);
            }}
            autoFocus
            aria-label="Rename thread title"
          />
        ) : (
          <div className="thread-title-display">
            {thread && <span className={`status-dot ${thread.status}`} aria-label={`Status: ${thread.status}`} />}
            <h2 className="thread-title" onClick={handleStartRename} title="Click to rename">
              {threadTitle}
            </h2>
            {thread?.issueNumber != null && (
              <span className="chip" title={`Started from issue #${thread.issueNumber}`}>
                #{thread.issueNumber}
              </span>
            )}
            {threadId && (
              <button
                type="button"
                className="icon-btn sm rename-thread-btn"
                aria-label="Rename thread"
                title="Rename thread"
                onClick={handleStartRename}
              >
                <PencilIcon size={12} />
              </button>
            )}
          </div>
        )}
        {thread && isBoardThread(thread) && (
          <span className="thread-kind" title={`Works in its own worktree on ${thread.branch}`}>
            <GitBranchIcon size={12} /> Board Thread · own worktree
          </span>
        )}
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => setDebugOpen((open) => !open)}
          aria-pressed={debugOpen}
          aria-label={debugOpen ? "Close raw event debug" : "Open raw event debug"}
          title={debugOpen ? "Close raw event debug" : "Raw event debug"}
        >
          <BugIcon size={14} />
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
      {transcript.thread?.setupOutput != null && (
        <details className="setup-output" open={transcript.thread.status === "needs-input" && turnCount === 0}>
          <summary>
            Setup command{transcript.thread.status === "needs-input" && turnCount === 0 ? " failed" : ""}
          </summary>
          <pre>{transcript.thread.setupOutput || "(no output)"}</pre>
        </details>
      )}
      <div className="transcript" aria-label="Transcript" ref={scrollRef} onScroll={onScroll}>
        {turnCount === 0 ? (
          <div className="empty-thread">
            <p>Type a prompt below and watch the agent's answer stream in.</p>
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
                    <TurnView
                      turn={turn}
                      provider={transcript.thread?.provider ?? draftProvider}
                      onRespond={handleRespond}
                      isWorking={isTurnActive}
                    />
                  ) : (
                    <div className="turn-placeholder" aria-busy />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {thread?.continuedFrom != null && (
        <div className="thread-link">
          Continued from{" "}
          <button type="button" onClick={() => onOpenThread(thread.continuedFrom!)}>
            Thread #{thread.continuedFrom}
          </button>
        </div>
      )}
      {thread?.sessionLost && (
        <div className="provider-hint missing" role="alert">
          <span className="hint-message">{SESSION_LOST_MESSAGE}</span>
          {thread.continuedIn != null && (
            <span className="thread-link">
              Continued in{" "}
              <button type="button" onClick={() => onOpenThread(thread.continuedIn!)}>
                Thread #{thread.continuedIn}
              </button>
            </span>
          )}
        </div>
      )}

      {providerHint && providerHint.type !== "ok" && (
        <div className={`provider-hint ${providerHint.type}`} role="alert">
          <span className="hint-message">{providerHint.message}</span>
          {providerHint.command && (
            <code className="hint-command">{providerHint.command}</code>
          )}
        </div>
      )}

      <div className="composer-wrap">
      {thread?.sessionLost ? (
        <div className="composer composer-lost">
          <button
            type="button"
            className="btn primary"
            disabled={thread.continuedIn != null}
            onClick={() => void continueInNewThread()}
          >
            Continue in new Thread
          </button>
        </div>
      ) : (
      <form className="composer" onSubmit={handleSubmit}>
        {pendingImages.length > 0 && (
          <div className="pending-images">
            {pendingImages.map((img) => (
              <div className="pending-image" key={img.path}>
                <img src={img.previewUrl} alt="Pending attachment" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => removeImage(img.path)}
                >
                  <XIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="composer-input"
          aria-label="Message to agent"
          rows={Math.max(2, Math.min(10, input.split("\n").length))}
          placeholder={
            isTurnActive
              ? "Working… (Esc to stop)"
              : turnCount === 0
                ? "Ask for changes, or attach images  (/model, /effort, /clear)"
                : "Send a follow-up  (/clear starts a new Thread)"
          }
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (stopsTurn(e, transcript.status)) {
              e.preventDefault();
              stop();
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={sending}
        />
        <div className="composer-bar">
          <div className="ctl">
            <button
              type="button"
              className="cbtn"
              onClick={() => {
                setModelPickerMode("model");
                setModelPickerOpen(true);
              }}
              disabled={isTurnActive || sending}
              aria-label="Model"
              title="Model (/model)"
            >
              <ProviderMark provider={currentProvider} size={14} />
              <span className="t">{currentModel || currentProvider}</span>
              <ChevronDownIcon size={12} />
            </button>
            <button
              type="button"
              className="cbtn compact"
              onClick={() => {
                setModelPickerMode("effort");
                setModelPickerOpen(true);
              }}
              disabled={isTurnActive || sending}
              aria-label="Effort"
              title="Effort (/effort)"
            >
              <LightBulbIcon size={14} />
              <span className="t">{currentEffort ? currentEffort[0].toUpperCase() + currentEffort.slice(1) : "Default"}</span>
              <ChevronDownIcon size={12} className="cv" />
            </button>
            <label className="cbtn compact" title={`Permission mode: ${currentModeConfig.label}`}>
              {(() => {
                const PermIcon = PERMISSION_ICONS[currentModeConfig.icon];
                return <PermIcon size={14} />;
              })()}
              <select
                id="permission-mode-select"
                className="t permission-chip-select"
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
              <ChevronDownIcon size={12} className="cv" />
            </label>
          </div>
          {imagesOffered && (
            <>
              <button
                type="button"
                className="cbtn"
                aria-label="Attach image"
                title="Attach image"
                disabled={isTurnActive || sending}
                onClick={() => fileInputRef.current?.click()}
              >
                <PaperclipIcon size={16} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  Array.from(e.target.files ?? []).forEach((f) => void addImage(f));
                  e.target.value = "";
                }}
              />
            </>
          )}
          {isTurnActive ? (
            <button type="button" className="send stop" onClick={stop} aria-label="Stop" title="Stop (Esc)">
              <SquareFillIcon size={12} />
            </button>
          ) : (
            <button type="submit" className="send" disabled={!input.trim() || sending} aria-label="Send" title="Send (↩)">
              <ArrowUpIcon size={16} />
            </button>
          )}
        </div>
      </form>
      )}
      <div className="composer-footer" aria-label="Thread checkout and branch">
        {thread && isBoardThread(thread) ? (
          <span className="checkout-badge" title={thread.worktreePath ?? undefined}>
            <FileDirectoryIcon size={12} /> Own worktree
          </span>
        ) : (
          <span className="checkout-badge">
            <RepoIcon size={12} /> Main checkout
          </span>
        )}
        <span className="grow" />
        <span className="branch-badge mono" title={(thread && isBoardThread(thread) ? thread.branch : gitBranch) ?? "main"}>
          <GitBranchIcon size={12} /> <span className="branch-badge-text">{(thread && isBoardThread(thread) ? thread.branch : gitBranch) ?? "main"}</span>
        </span>
      </div>
      </div>

      {modelPickerOpen && (
        <ModelEffortPicker
          open={modelPickerOpen}
          onClose={() => setModelPickerOpen(false)}
          currentProvider={currentProvider}
          currentModel={currentModel}
          currentEffort={currentEffort}
          turnCount={turnCount}
          midThreadModelSwitch={providerCaps?.midThreadModelSwitch ?? true}
          onSelectModelAndEffort={handleSelectModelAndEffort}
          initialMode={modelPickerMode}
        />
      )}
    </div>
  );
}
