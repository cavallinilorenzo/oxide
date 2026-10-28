import { Skeleton } from "./Skeleton";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FileDirectoryIcon,
  GitBranchIcon,
  LightBulbIcon,
  LockIcon,
  PaperclipIcon,
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
  type Detection,
  type ModelInfo,
  type PermissionMode,
  type SequencedThreadEvent,
  type SlashCommand,
  type Thread,
  type ThreadCapabilities,
  type ThreadStatus,
  type ProviderCapabilities,
} from "./bindings";
import { TurnView } from "./TurnView";
import { ThreadHeader } from "./ThreadHeader";
import { isBoardThread } from "./dispatch";
import { getClaudeCodeHint } from "./providerHints";
import { createFrameBatcher } from "./frameBatcher";
import { pageRequest, pagesToLoad, turnAt, type TranscriptPages } from "./transcriptPages";
import { isClearCommand, isEffortMenuShortcut, isModelPickerShortcut, modelDigitShortcut, shortcutLabel, stopsTurn } from "./shortcuts";
import { ProviderMark } from "./ProviderMark";
import { Dropdown } from "./Dropdown";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { loadDraftModel, saveDraftModel } from "./draftModel";
import { parseSlashCommand, resolveDefaultModel, resolveFavourite } from "./modelPicker";
import { cachedCatalogs } from "./modelCatalogCache";
import { readableModel } from "./headerLines";
import { filterSlashCommands, pickSlashCommand, slashQuery } from "./slashMenu";
import {
  applyThreadEvent,
  initialTranscriptState,
  SESSION_LOST_MESSAGE,
  turnIsRunning,
  type TranscriptState,
  type TranscriptTurn,
} from "./transcript";

/** How close to the bottom (px) still counts as following the stream. */
const STICK_TO_BOTTOM = 48;
/** How long (ms) the visible range must hold still before paging older Turns in. */
const PAGE_LOAD_DELAY = 80;

interface ThreadViewProps {
  onOpenDefaultDiff?: () => void;
  onInitialLoad?: () => void;
  threadId: number | null;
  projectId: number;
  /** The Project's checkout, shown in the header for a Thread that has no worktree of its own. */
  projectPath: string;
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

interface Outgoing {
  threadId: number | null;
  prompt: string;
  attachments: string[];
  /** Turns present when it was sent; the real Turn lands at this index. */
  baseCount: number;
  startedAt: string;
}

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
  onOpenDefaultDiff,
  onInitialLoad,
  threadId,
  projectId,
  projectPath,
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
  const [settledThreadId, setSettledThreadId] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(initialTranscriptState(null));
  const [pages, setPages] = useState<TranscriptPages>(new Map());
  const [input, setInput] = useState(draft ?? "");
  const [sending, setSending] = useState(false);
  // The prompt just sent, shown before Core confirms the Turn so sending feels instant.
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [newThreadCaps, setNewThreadCaps] = useState<ThreadCapabilities | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const effortPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const permissionControlRef = useRef<HTMLButtonElement>(null);
  const [openPermissionsWhenReady, setOpenPermissionsWhenReady] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<PermissionMode>("auto-edit");
  const [draftProvider, setDraftProvider] = useState<string>("claude");
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerMode, setModelPickerMode] = useState<"model" | "effort">("model");
  const [providerCapsEntry, setProviderCaps] = useState<{ provider: string; caps: ProviderCapabilities } | null>(null);
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

  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const slashGeneration = useRef({ active: true });
  const [slashRevision, setSlashRevision] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashOpen = slashQuery(input) !== null;
  const slashMatches = slashOpen ? filterSlashCommands(slashCommands, slashQuery(input) ?? "") : [];
  const slashProvider = transcript.thread?.provider || draftProvider;

  // Show the cached catalog first, then refresh for the active Thread's directory.
  useEffect(() => {
    if (threadId && transcript.thread?.id !== threadId) return;
    let active = true;
    const generation = { active: true };
    slashGeneration.current = generation;
    setSlashCommands([]);
    void (async () => {
      const cached = await commands.listSlashCommands(slashProvider, projectId, threadId, false);
      if (!active) return;
      if (cached.status === "ok") setSlashCommands(cached.data);
      const refreshed = await commands.listSlashCommands(slashProvider, projectId, threadId, true);
      if (!active) return;
      if (refreshed.status === "ok") setSlashCommands(refreshed.data);
      else setCommandError("Could not refresh the Slash command catalog. Any previous cache remains available.");
    })();
    return () => {
      active = false;
      generation.active = false;
    };
  }, [threadId, transcript.thread?.id, slashProvider, projectId]);

  // Codex can change its available skills while the menu is open.
  useEffect(() => {
    if (!slashOpen || slashProvider !== "codex") return;
    let active = true;
    const update = () => {
      void commands.listSlashCommands(slashProvider, projectId, threadId, true).then((res) => {
        if (active && res.status === "ok") setSlashCommands(res.data);
      });
    };
    update();
    const timer = window.setInterval(update, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [slashOpen, slashProvider, projectId, threadId, slashRevision]);

  const handleInputChange = (val: string) => {
    setSlashIndex(0);
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
      const saved = loadDraftModel(localStorage, projectId);
      const defProvider = saved?.provider ?? s.settings.defaultProvider;
      setDraftProvider(defProvider);
      const provSettings = s.settings.providers[defProvider as keyof typeof s.settings.providers];
      const defMode = provSettings?.permissionMode || "auto-edit";
      setDraftMode(defMode);
      setDraftModel(saved ? saved.model : provSettings?.model ?? null);
      setDraftEffort(saved ? saved.effort : provSettings?.effort ?? null);

      const capsRes = await commands.getProviderCapabilities(defProvider);
      if (active && capsRes.status === "ok") {
        setTranscript((prev) => ({
          ...prev,
          supportedPermissionModes: capsRes.data.supportedPermissionModes,
        }));
      }
    })().finally(() => { if (active) onInitialLoad?.(); });
    return () => {
      active = false;
    };
  }, [threadId, projectId, onInitialLoad]);

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
    const channel = new Channel<SequencedThreadEvent>();
    channel.onmessage = (event) => {
      if (event.event.type === "SlashCommandsChanged") setSlashRevision((n) => n + 1);
      if (snapshotApplied) batcher.push(event);
      else early.push(event);
    };

    void (async () => {
      const res = await commands.subscribeThread(threadId, channel);
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
    })().finally(() => { if (active) { setSettledThreadId(threadId); onInitialLoad?.(); } });

    return () => {
      active = false;
      batcher.cancel();
    };
  }, [threadId, onStatusChange, onThreadTitleChange, onInitialLoad]);

  // A continued Thread opens with its recap in the composer.
  useEffect(() => {
    if (prefill && prefill.threadId === threadId) {
      setInput(prefill.text);
      onPrefillUsed();
    }
  }, [prefill, threadId, onPrefillUsed]);

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
  // Until the real Turn arrives, the sent prompt stands in for it.
  const pendingOutgoing =
    outgoing && outgoing.threadId === threadId && turnCount <= outgoing.baseCount ? outgoing : null;
  const outgoingTurn: TranscriptTurn | null = pendingOutgoing && {
    id: 0,
    turnIndex: pendingOutgoing.baseCount,
    prompt: pendingOutgoing.prompt,
    model: null,
    effort: null,
    attachments: pendingOutgoing.attachments,
    status: "running",
    startedAt: pendingOutgoing.startedAt,
    completedAt: null,
    items: [],
    error: null,
    retryNotice: null,
    approvals: [],
    unknownEvents: [],
  };
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
  }, [transcript.turns, totalSize, pendingOutgoing]);

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
      const result = await commands.setThreadPermissionMode(threadId, newMode);
      if (result.status !== "ok") {
        setCommandError("Could not change the Permission mode.");
        return;
      }
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

  const saveRename = async (title: string) => {
    setIsEditingTitle(false);
    const trimmed = title.trim();
    if (!trimmed || !threadId) return;
    const result = await commands.renameThread(threadId, trimmed);
    if (result.status !== "ok") {
      setCommandError("Could not rename the Thread.");
      return;
    }
    setTranscript((prev) =>
      prev.thread ? { ...prev, thread: { ...prev.thread, title: trimmed } } : prev
    );
    onThreadTitleChange?.(threadId, trimmed);
  };
  const handleSaveRename = () => saveRename(editTitle);

  const currentMode = transcript.thread?.permissionMode || draftMode;
  const currentProvider = transcript.thread?.provider || draftProvider;
  const providerCaps = providerCapsEntry?.provider === currentProvider ? providerCapsEntry.caps : null;
  useEffect(() => {
    if (openPermissionsWhenReady && providerCaps) {
      permissionControlRef.current?.click();
      setOpenPermissionsWhenReady(false);
    }
  }, [openPermissionsWhenReady, providerCaps]);
  const [catalog, setCatalog] = useState<{ provider: string; models: ModelInfo[] } | null>(null);
  useEffect(() => {
    let active = true;
    void commands.getModelCatalog(currentProvider, false).then((res) => {
      if (active && res.status === "ok") setCatalog({ provider: currentProvider, models: res.data });
    });
    return () => {
      active = false;
    };
  }, [currentProvider]);
  const catalogModels = catalog?.provider === currentProvider ? catalog.models : null;
  const { model: currentModel, effort: currentEffort } = resolveDefaultModel(
    catalogModels,
    threadId ? transcript.thread?.model ?? null : draftModel,
    threadId ? transcript.thread?.effort ?? null : draftEffort
  );
  const displayModel = currentModel ? readableModel(currentModel, catalogModels) : currentProvider;

  useEffect(() => {
    let active = true;
    void commands.getProviderCapabilities(currentProvider).then((res) => {
      if (active && res.status === "ok") {
        setProviderCaps({ provider: currentProvider, caps: res.data });
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
      saveDraftModel(localStorage, projectId, { provider: newProvider, model: newModel, effort: newEffort });
    }
  };

  const closeModelPicker = useCallback(() => setModelPickerOpen(false), []);
  /** Where focus was when a shortcut opened the picker, so closing it by keyboard hands focus back. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (modelPickerOpen) return;
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target?.isConnected) target.focus();
  }, [modelPickerOpen]);

  // Model and Effort shortcuts act on the latest state without re-subscribing on every render.
  const modelShortcutRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    modelShortcutRef.current = (e) => {
      const toggle = isModelPickerShortcut(e) ? "model" : isEffortMenuShortcut(e) ? "effort" : null;
      if (toggle) {
        e.preventDefault();
        if (isTurnActive || sending) return;
        if (modelPickerOpen && modelPickerMode === toggle) {
          setModelPickerOpen(false);
          return;
        }
        if (!modelPickerOpen && document.activeElement instanceof HTMLElement) {
          restoreFocusRef.current = document.activeElement;
        }
        setModelPickerMode(toggle);
        setModelPickerOpen(true);
        return;
      }
      const index = modelDigitShortcut(e);
      if (index === null || modelPickerOpen) return;
      e.preventDefault();
      if (isTurnActive || sending) return;
      void (async () => {
        const [favourites, catalogs] = await Promise.all([
          commands.getFavouriteModels(),
          cachedCatalogs(["claude", "codex", "antigravity", ...(currentProvider === "fake" ? ["fake"] : [])]),
        ]);
        if (favourites.status !== "ok") return;
        const target = resolveFavourite(index, catalogs, favourites.data, currentEffort, currentProvider);
        if (!target) return;
        const locked = turnCount > 0 && !(providerCaps?.midThreadModelSwitch ?? true);
        if (target.provider === currentProvider && locked) return;
        await handleSelectModelAndEffort(target.provider, target.model, target.effort);
      })();
    };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => modelShortcutRef.current(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
    providerCaps?.supportedPermissionModes ?? (threadId && transcript.thread ? transcript.supportedPermissionModes : []),
    currentProvider
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || sending || turnIsRunning(transcript.status)) return;
    setCommandError(null);

    if (isClearCommand(input)) {
      handleInputChange("");
      onClearThread?.();
      return;
    }

    const slash = parseSlashCommand(input);
    if (slash.type === "reload-cache") {
      handleInputChange("");
      const generation = slashGeneration.current;
      const result = await commands.listSlashCommands(slashProvider, projectId, threadId, true);
      if (!generation.active) return;
      if (result.status === "ok") setSlashCommands(result.data);
      else setCommandError("Could not refresh the Slash command catalog. Any previous cache remains available.");
      return;
    }
    if (slash.type === "rename") {
      if (!threadId) setCommandError("Create a Thread before renaming it.");
      else if (slash.arg) void saveRename(slash.arg);
      else handleStartRename();
      handleInputChange("");
      return;
    }
    if (slash.type === "diff") {
      onOpenDefaultDiff?.();
      handleInputChange("");
      return;
    }
    if (slash.type === "permissions") {
      if (!slash.arg) {
        if (providerCaps) permissionControlRef.current?.click();
        else {
          const result = await commands.getProviderCapabilities(currentProvider);
          if (result.status === "ok") {
            setProviderCaps({ provider: currentProvider, caps: result.data });
            setOpenPermissionsWhenReady(true);
          } else setCommandError("Could not load permission modes for this Provider.");
        }
      } else {
        const modes: Record<string, PermissionMode> = { ask: "ask", "auto-edit": "auto-edit", full: "full-access" };
        const mode = modes[slash.arg];
        if (!mode) setCommandError("Choose ask, auto-edit, or full.");
        else {
          const result = providerCaps ? null : await commands.getProviderCapabilities(currentProvider);
          const supported = providerCaps?.supportedPermissionModes ?? (result?.status === "ok" ? result.data.supportedPermissionModes : null);
          if (!supported) setCommandError("Could not load permission modes for this Provider.");
          else if (!supported.includes(mode)) setCommandError(`${PERMISSION_CONFIG[mode].label} is not offered by this Provider.`);
          else void handlePermissionChange(mode);
        }
      }
      handleInputChange("");
      return;
    }
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
    followRef.current = true;
    setOutgoing({
      threadId,
      prompt,
      attachments: pendingImages.map((i) => i.path),
      baseCount: turnCount,
      startedAt: new Date().toISOString(),
    });

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
          currentModel ?? provSettings?.model ?? null,
          currentEffort ?? provSettings?.effort ?? null,
          draftMode
        );
        if (created.status === "ok") {
          targetThreadId = created.data.id;
          setOutgoing((o) => o && { ...o, threadId: targetThreadId });
          onThreadCreated(created.data);
        } else {
          console.error("Failed to create thread:", created.error);
          setOutgoing(null);
          setSending(false);
          return;
        }
      }

      const attachments = pendingImages.map((i) => i.path);
      pendingImages.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      setPendingImages([]);

      const sent = await commands.sendPrompt(targetThreadId, prompt, attachments);
      if (sent.status !== "ok") setOutgoing(null);
    } catch (err) {
      setOutgoing(null);
      throw err;
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
      <ThreadHeader
        threadId={threadId}
        thread={thread}
        title={threadTitle}
        provider={currentProvider}
        model={currentModel}
        effort={currentEffort}
        projectPath={projectPath}
        reportsUsage={providerCaps?.reportsUsageLimits ?? false}
        editing={isEditingTitle}
        editTitle={editTitle}
        onEditTitleChange={setEditTitle}
        onStartRename={handleStartRename}
        onSaveRename={() => void handleSaveRename()}
        onCancelRename={() => setIsEditingTitle(false)}
      />
      {transcript.thread?.setupOutput != null && (
        <details className="setup-output" open={transcript.thread.status === "needs-input" && turnCount === 0}>
          <summary>
            Setup command{transcript.thread.status === "needs-input" && turnCount === 0 ? " failed" : ""}
          </summary>
          <pre>{transcript.thread.setupOutput || "(no output)"}</pre>
        </details>
      )}
      <div className="transcript" aria-label="Transcript" ref={scrollRef} onScroll={onScroll}>
        {threadId !== null && transcript.thread?.id !== threadId && settledThreadId !== threadId ? (
          <Skeleton kind="conversation" label="Loading Transcript…" />
        ) : turnCount === 0 && !outgoingTurn ? (
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
                      instant={
                        outgoing?.threadId === threadId && row.index === outgoing.baseCount
                      }
                      provider={transcript.thread?.provider ?? draftProvider}
                      onRespond={handleRespond}
                      isWorking={isTurnActive}
                    />
                  ) : (
                    <div className="turn-placeholder"><Skeleton kind="conversation" label="Loading earlier Turn…" /></div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {outgoingTurn && (
          <div className="transcript-outgoing">
            <TurnView
              turn={outgoingTurn}
              provider={transcript.thread?.provider ?? draftProvider}
              onRespond={handleRespond}
              isWorking
            />
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
      {commandError && <div className="provider-hint missing" role="alert">{commandError}</div>}
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
        {slashMatches.length > 0 && (
          <ul className="slash-menu" role="listbox" aria-label="Slash commands">
            {slashMatches.map((c, i) => (
              <li
                key={c.name}
                role="option"
                aria-selected={i === slashIndex}
                className={i === slashIndex ? "active" : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleInputChange(`/${c.name} `);
                }}
              >
                <span className="n">/{c.name}</span>
                {c.argumentHint && <span className="h">{c.argumentHint}</span>}
                {c.description && <span className="d">{c.description}</span>}
              </li>
            ))}
          </ul>
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
            if (slashMatches.length > 0 && !e.nativeEvent.isComposing) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : slashMatches.length - 1;
                setSlashIndex((slashIndex + step) % slashMatches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const pick = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
                const action = pickSlashCommand(pick, e.key === "Tab" ? "Tab" : "Enter", input);
                if ("insert" in action) {
                  e.preventDefault();
                  handleInputChange(action.insert);
                  return;
                }
                e.currentTarget.form?.requestSubmit();
                return;
              }
            }
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
              aria-label={`Model: ${displayModel}`}
              title={`Model: ${displayModel} (${shortcutLabel}⇧M, /model)`}
            >
              <ProviderMark provider={currentProvider} size={14} />
              <span className="t">{displayModel}</span>
              <ChevronDownIcon size={12} />
            </button>
            <button
              type="button"
              className="cbtn compact"
              ref={effortPickerTriggerRef}
              onClick={() => {
                if (modelPickerOpen && modelPickerMode === "effort") {
                  setModelPickerOpen(false);
                } else {
                  setModelPickerMode("effort");
                  setModelPickerOpen(true);
                }
              }}
              disabled={isTurnActive || sending}
              aria-label="Effort"
              aria-expanded={modelPickerOpen && modelPickerMode === "effort"}
              title={`Effort: ${currentEffort || "Default"} (${shortcutLabel}⇧E, /effort)`}
            >
              <LightBulbIcon size={14} />
              <span className="t">{currentEffort ? currentEffort[0].toUpperCase() + currentEffort.slice(1) : "Default"}</span>
              <ChevronDownIcon size={12} className="cv" />
            </button>
            <Dropdown
              triggerRef={permissionControlRef}
              label="Permission mode"
              triggerClassName="cbtn compact"
              minMenuWidth={200}
              disabled={isTurnActive || sending}
              value={currentMode}
              options={offeredModes.map((item) => {
                const PermIcon = PERMISSION_ICONS[item.icon];
                return { value: item.mode, label: item.label, icon: <PermIcon size={14} /> };
              })}
              onChange={(mode) => void handlePermissionChange(mode)}
            />
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
          onClose={closeModelPicker}
          currentProvider={currentProvider}
          currentModel={currentModel}
          currentEffort={currentEffort}
          turnCount={turnCount}
          midThreadModelSwitch={providerCaps?.midThreadModelSwitch ?? true}
          onSelectModelAndEffort={handleSelectModelAndEffort}
          initialMode={modelPickerMode}
          anchorElement={modelPickerMode === "effort" ? effortPickerTriggerRef.current : null}
        />
      )}
    </div>
  );
}
