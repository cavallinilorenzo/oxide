import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PaperclipIcon, XIcon } from "@primer/octicons-react";
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
} from "./bindings";
import { TurnView } from "./TurnView";
import { getClaudeCodeHint } from "./providerHints";
import { createFrameBatcher } from "./frameBatcher";
import { pageRequest, pagesToLoad, turnAt, type TranscriptPages } from "./transcriptPages";
import { stopsTurn } from "./shortcuts";
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
  onThreadCreated: (thread: Thread) => void;
  onStatusChange: (threadId: number, status: ThreadStatus) => void;
  /** Text to put in this Thread's composer once, e.g. the recap of a continued Thread. */
  prefill: { threadId: number; text: string } | null;
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

export function ThreadView({
  threadId,
  projectId,
  onThreadCreated,
  onStatusChange,
  prefill,
  onOpenThread,
  onThreadContinued,
}: ThreadViewProps) {
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscriptState(null));
  const [pages, setPages] = useState<TranscriptPages>(new Map());
  const [input, setInput] = useState("");
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

  // A continued Thread opens with its recap in the composer.
  useEffect(() => {
    if (prefill && prefill.threadId === threadId) setInput(prefill.text);
  }, [prefill, threadId]);

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
    if (!prompt || sending || turnIsRunning(transcript.status)) return;

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

      {thread?.sessionLost ? (
        <div className="composer">
          <button
            type="button"
            className="composer-submit"
            disabled={thread.continuedIn != null}
            onClick={() => void continueInNewThread()}
          >
            Continue in new Thread
          </button>
        </div>
      ) : (
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
        <div className="composer-row">
          {imagesOffered && (
            <>
              <button
                type="button"
                className="composer-attach"
                aria-label="Attach image"
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
          <textarea
            className="composer-input"
            rows={Math.min(8, input.split("\n").length)}
            placeholder={isTurnActive ? "Working… (Esc to stop)" : "Type a prompt…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
          {isTurnActive ? (
            <button type="button" className="composer-submit" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="composer-submit" disabled={!input.trim() || sending}>
              Send
            </button>
          )}
        </div>
      </form>
      )}
    </div>
  );
}
