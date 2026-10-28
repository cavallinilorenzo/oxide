import { Skeleton } from "./Skeleton";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FileDirectoryIcon,
  GitBranchIcon,
  LockIcon,
  PaperclipIcon,
  RepoIcon,
  ShieldCheckIcon,
  SquareFillIcon,
  UnlockIcon,
  type Icon,
} from "@primer/octicons-react";
import {
  commands,
  type ApprovalDecision,
  type Attachment,
  type ContinuedThread,
  type Detection,
  type ModelInfo,
  type PermissionMode,
  type SequencedThreadEvent,
  type PromptSegment,
  type SlashCommand,
  type Thread,
  type ThreadStatus,
  type ProviderCapabilities,
} from "./bindings";
import { TurnView } from "./TurnView";
import { ComposerInput, type ComposerHandle } from "./ComposerInput";
import {
  MAX_ATTACHMENTS,
  TOO_MANY_MESSAGE,
  baseName,
  busyChip,
  chipFor,
  chipsOf,
  decodeDraft,
  encodeDraft,
  hasAttachments,
  hasContent,
  isBusy,
  normalize,
  plainText,
  replaceChip,
  toPromptInput,
  toPromptSegments,
  typedText,
  type ComposerSegment,
} from "./attachments";
import { ThreadHeader } from "./ThreadHeader";
import { isBoardThread } from "./dispatch";
import { getClaudeCodeHint } from "./providerHints";
import { createFrameBatcher } from "./frameBatcher";
import { pageRequest, pagesToLoad, turnAt, type TranscriptPages } from "./transcriptPages";
import { formatAccelerator, isClearCommand, matchesAccelerator, modelDigitShortcut, stopsTurn } from "./shortcuts";
import { useShortcuts } from "./useShortcuts";
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
  visible?: boolean;
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


interface Outgoing {
  threadId: number | null;
  segments: PromptSegment[];
  /** Turns present when it was sent; the real Turn lands at this index. */
  baseCount: number;
  startedAt: string;
}

/** How a file offered as an Attachment fares once Core has looked at it. */
type Stored = { attachment: Attachment } | { error: string };

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "The file could not be attached.";
}

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
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
  visible = true,
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
  const [value, setValue] = useState<ComposerSegment[]>(() => decodeDraft(draft ?? ""));
  const valueRef = useRef(value);
  valueRef.current = value;
  const [sending, setSending] = useState(false);
  // The prompt just sent, shown before Core confirms the Turn so sending feels instant.
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const [dropActive, setDropActive] = useState(false);
  /** Attachments taken out of the prompt, forgotten by Core once the prompt is sent. */
  const removedAttachments = useRef(new Set<string>());
  const permissionControlRef = useRef<HTMLButtonElement>(null);
  const [openPermissionsWhenReady, setOpenPermissionsWhenReady] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<PermissionMode>("auto-edit");
  const [draftProvider, setDraftProvider] = useState<string>("claude");
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<string | null>(null);
  const shortcuts = useShortcuts();
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
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
    if (draft !== undefined && draft !== encodeDraft(valueRef.current)) {
      setValue(decodeDraft(draft));
    }
  }, [draft, threadId]);

  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const slashGeneration = useRef({ active: true });
  const [slashRevision, setSlashRevision] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const input = plainText(value);
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

  /** The prompt changed (typing, a chip removed, a file stored): keep it and tell the parent. */
  const commit = (next: ComposerSegment[]) => {
    valueRef.current = next;
    setValue(next);
    onDraftChange?.(encodeDraft(next));
  };

  /** The user edited the prompt in the editor. */
  const handleComposerChange = (next: ComposerSegment[]) => {
    const before = new Set(chipsOf(valueRef.current).flatMap((c) => (c.id ? [c.id] : [])));
    const after = new Set(chipsOf(next).flatMap((c) => (c.id ? [c.id] : [])));
    for (const id of before) if (!after.has(id)) removedAttachments.current.add(id);
    for (const id of after) removedAttachments.current.delete(id);
    setSlashIndex(0);
    commit(next);
  };

  /** Replaces the whole prompt with text and puts the caret at its end. */
  const handleInputChange = (text: string) => {
    setSlashIndex(0);
    const next = normalize([{ kind: "text", text }]);
    composerRef.current?.replace(next);
    commit(next);
  };

  const attach = (
    entries: { label: string; store: () => Promise<Stored> }[],
    at?: number,
  ) => {
    if (entries.length === 0) return;
    const room = Math.max(0, MAX_ATTACHMENTS - chipsOf(valueRef.current).length);
    const accepted = entries.slice(0, room);
    const failures: string[] = [];
    if (accepted.length < entries.length) failures.push(TOO_MANY_MESSAGE);
    if (accepted.length === 0) {
      setCommandError(failures.join(" "));
      return;
    }
    setCommandError(null);
    const chips = accepted.map((e) => busyChip(e.label));
    composerRef.current?.insert(chips, at);
    let pending = accepted.length;
    accepted.forEach((entry, i) => {
      const chip = chips[i];
      void entry.store().then((result) => {
        if ("attachment" in result) {
          commit(replaceChip(valueRef.current, chip.key, chipFor(result.attachment, chip.key)));
        } else {
          composerRef.current?.discardChip(chip.key);
          commit(replaceChip(valueRef.current, chip.key, null));
          failures.push(result.error);
        }
        pending -= 1;
        if (pending === 0 && failures.length > 0) setCommandError(failures.join(" "));
      });
    });
  };

  const attachPaths = (paths: string[], at?: number) => {
    if (paths.length === 0) return;
    // Only as many as fit are stored; `attach` reports the rest as too many.
    const room = Math.max(0, MAX_ATTACHMENTS - chipsOf(valueRef.current).length);
    const batch = room > 0 ? commands.attachPaths(paths.slice(0, room)) : null;
    attach(
      paths.map((path, i) => ({
        label: baseName(path),
        store: async (): Promise<Stored> => {
          const res = await batch;
          if (!res) return { error: TOO_MANY_MESSAGE };
          if (res.status !== "ok") return { error: res.error.message };
          const outcome = res.data[i];
          return outcome?.attachment
            ? { attachment: outcome.attachment }
            : { error: outcome?.error ?? "The file could not be attached." };
        },
      })),
      at,
    );
  };

  const attachFiles = (files: File[], at?: number) => {
    attach(
      files.map((file) => ({
        label: file.name || "pasted image",
        store: async (): Promise<Stored> => {
          try {
            const bytes = await readBytes(file);
            const attachment = await invoke<Attachment>("attach_bytes", bytes, {
              headers: { "x-oxide-name": encodeURIComponent(file.name) },
            });
            return { attachment };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
      })),
      at,
    );
  };

  const pickFiles = async () => {
    const at = composerRef.current?.caret() ?? undefined;
    let picked: string | string[] | null;
    try {
      picked = await openFileDialog({ multiple: true, directory: false, title: "Attach files" });
    } catch (error) {
      setCommandError(errorMessage(error));
      return;
    }
    if (!picked) return;
    attachPaths(Array.isArray(picked) ? picked : [picked], at);
  };

  // Files dropped on the window arrive as native paths; only drops on the composer attach.
  const dropHandler = useRef<(paths: string[]) => void>(() => {});
  dropHandler.current = (paths) => {
    if (!visible) return;
    const composer = composerRef.current;
    attachPaths(paths, composer?.isFocused() ? (composer.caret() ?? undefined) : undefined);
  };
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const overComposer = (position: { x: number; y: number }) => {
      const rect = composerFormRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const x = position.x / window.devicePixelRatio;
      const y = position.y / window.devicePixelRatio;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const drag = event.payload;
          if (drag.type === "leave") setDropActive(false);
          else if (drag.type === "drop") {
            setDropActive(false);
            if (overComposer(drag.position) && drag.paths.length > 0) dropHandler.current(drag.paths);
          } else setDropActive(overComposer(drag.position));
        })
        .then((stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        })
        .catch(() => {});
    } catch {
      // No webview (tests, a plain browser): drag & drop is simply unavailable.
    }
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
      setValue(decodeDraft(prefill.text));
      onPrefillUsed();
    }
  }, [prefill, threadId, onPrefillUsed]);

  const turnCount = transcript.turnOffset + transcript.turns.length;
  // Until the real Turn arrives, the sent prompt stands in for it.
  const pendingOutgoing =
    outgoing && outgoing.threadId === threadId && turnCount <= outgoing.baseCount ? outgoing : null;
  const outgoingTurn: TranscriptTurn | null = pendingOutgoing && {
    id: 0,
    turnIndex: pendingOutgoing.baseCount,
    prompt: plainText(pendingOutgoing.segments),
    model: null,
    effort: null,
    segments: pendingOutgoing.segments,
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
  const effortName = currentEffort ? currentEffort[0].toUpperCase() + currentEffort.slice(1) : null;

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
  /** Where focus was when the picker opened, so closing it hands focus back. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openModelPicker = () => {
    if (!modelPickerOpen && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    setModelPickerOpen(true);
  };
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
      if (!visible) return;
      if (matchesAccelerator(e, shortcuts.modelPicker)) {
        e.preventDefault();
        if (isTurnActive || sending) return;
        if (modelPickerOpen) {
          setModelPickerOpen(false);
          return;
        }
        openModelPicker();
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
    if (!hasContent(value) || isBusy(value) || sending || turnIsRunning(transcript.status)) return;
    setCommandError(null);

    const typed = typedText(value);
    const slash = parseSlashCommand(typed);
    if (hasAttachments(value) && (isClearCommand(typed) || (slash.type !== "none" && slash.type !== "other"))) {
      setCommandError(`Attachments can't be sent with ${slash.command || typed.trim()}. Remove them or send the command alone.`);
      return;
    }

    if (isClearCommand(typed)) {
      handleInputChange("");
      onClearThread?.();
      return;
    }

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
        openModelPicker();
      }
      handleInputChange("");
      return;
    }
    if (slash.type === "effort") {
      if (slash.arg) {
        void handleSelectModelAndEffort(currentProvider, currentModel, slash.arg);
      } else {
        openModelPicker();
      }
      handleInputChange("");
      return;
    }

    // Kept until Core takes the prompt, so a failure can give it back untouched.
    const sentValue = value;
    const segments = toPromptInput(value);
    setSending(true);
    handleInputChange("");
    followRef.current = true;
    setOutgoing({
      threadId,
      segments: toPromptSegments(value),
      baseCount: turnCount,
      startedAt: new Date().toISOString(),
    });
    const giveBack = (message: string) => {
      setOutgoing(null);
      composerRef.current?.replace(sentValue);
      commit(sentValue);
      setCommandError(message);
    };

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
          giveBack(created.error.message);
          setSending(false);
          return;
        }
      }

      const sent = await commands.sendPrompt(targetThreadId, segments);
      if (sent.status !== "ok") giveBack(sent.error.message);
      else {
        for (const id of removedAttachments.current) void commands.discardAttachment(id);
        removedAttachments.current.clear();
      }
    } catch (err) {
      giveBack(errorMessage(err));
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
      <form
        ref={composerFormRef}
        className={dropActive ? "composer drop-target" : "composer"}
        onSubmit={handleSubmit}
      >
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
        <ComposerInput
          ref={composerRef}
          ariaLabel="Message to agent"
          value={value}
          onChange={handleComposerChange}
          onPasteFiles={(files) => attachFiles(files, composerRef.current?.caret() ?? undefined)}
          placeholder={
            isTurnActive
              ? "Working… (Esc to stop)"
              : turnCount === 0
                ? "Ask for changes, or attach files  (/model, /effort, /clear)"
                : "Send a follow-up  (/clear starts a new Thread)"
          }
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
                  handleInputChange(action.insert);
                  return;
                }
                e.currentTarget.closest("form")?.requestSubmit();
                return;
              }
            }
            if (stopsTurn(e, transcript.status)) {
              e.preventDefault();
              stop();
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.closest("form")?.requestSubmit();
            }
          }}
          disabled={sending}
        />
        <div className="composer-bar">
          <div className="ctl">
            <button
              type="button"
              className="cbtn"
              onClick={openModelPicker}
              disabled={isTurnActive || sending}
              aria-label={`Model: ${displayModel}${effortName ? `, Effort: ${effortName}` : ""}`}
              title={`Model: ${displayModel}${effortName ? `, Effort: ${effortName}` : ""} (${formatAccelerator(shortcuts.modelPicker)}, /model)`}
            >
              <ProviderMark provider={currentProvider} size={14} />
              <span className="t">{displayModel}{effortName && ` · ${effortName}`}</span>
              <ChevronDownIcon size={12} />
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
          <button
            type="button"
            className="cbtn"
            aria-label="Attach files"
            title="Attach files"
            disabled={isTurnActive || sending}
            onClick={() => void pickFiles()}
          >
            <PaperclipIcon size={16} />
          </button>
          {isTurnActive ? (
            <button type="button" className="send stop" onClick={stop} aria-label="Stop" title="Stop (Esc)">
              <SquareFillIcon size={12} />
            </button>
          ) : (
            <button type="submit" className="send" disabled={!hasContent(value) || isBusy(value) || sending} aria-label="Send" title="Send (↩)">
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
        />
      )}
    </div>
  );
}
