import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type AppError, type Project, type Thread, type ThreadStatus } from "./bindings";
import { GitBranchIcon } from "@primer/octicons-react";
import { BoardView } from "./BoardView";
import { isBoardThread } from "./dispatch";
import { DiffOpenContext } from "./diffOpen";
import { defaultDiffScope, type PanelScope } from "./diffScope";
import { GitHeader } from "./GitHeader";
import { ProjectPalette } from "./ProjectPalette";
import { QuitDialog } from "./QuitDialog";
import { ThreadView } from "./ThreadView";
import { SettingsView } from "./SettingsView";
import { isNewThreadShortcut, isProjectPaletteShortcut, toggleForKey } from "./shortcuts";
import { getDraft, setDraft } from "./threadDrafts";
import { splitThreads, threadTitle } from "./threadList";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };
type TerminalContext = { key: string; projectId: number; threadId: number | null };
const terminalContextKey = (projectId: number, threadId: number | null) =>
  `${projectId}:${threadId ?? "draft"}`;

const DiffPanel = lazy(() => import("./DiffPanel").then((module) => ({ default: module.DiffPanel })));
const PullRequestPanel = lazy(() =>
  import("./PullRequestPanel").then((module) => ({ default: module.PullRequestPanel })),
);
const FilesPanel = lazy(() => import("./FilesPanel").then((module) => ({ default: module.FilesPanel })));
const IssuesSurface = lazy(() =>
  import("./IssuesSurface").then((module) => ({ default: module.IssuesSurface })),
);
const TOOL_TABS = ["Terminal", "Files", "Diff", "Pull request", "Issues"];

export function App() {
  const [showTools, setShowTools] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [activeTool, setActiveTool] = useState<string | null>("Files");
  // The user's pick, for the Thread it was made in: elsewhere that Thread's default applies.
  const [chosenDiffScope, setChosenDiffScope] = useState<{ threadId: number | null; scope: PanelScope } | null>(null);
  const [diffFocus, setDiffFocus] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // A Project picked in the palette that should get a new Thread once its Threads have loaded.
  const pendingNewThread = useRef<number | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [prefill, setPrefill] = useState<{ threadId: number; text: string } | null>(null);
  // The Project and Thread of the last session: `undefined` until read, `null` once applied.
  const restore = useRef<{ projectId: number; threadId: number | null } | null | undefined>(undefined);
  const [terminalContexts, setTerminalContexts] = useState<TerminalContext[]>([]);
  const rememberTerminalContext = useCallback((projectId: number, threadId: number | null) => {
    const context = { key: terminalContextKey(projectId, threadId), projectId, threadId };
    setTerminalContexts((previous) => previous.some((item) => item.key === context.key)
      ? previous
      : [...previous, context]);
  }, []);

  const [defaultParentFolder, setDefaultParentFolder] = useState("~/Developer");
  useEffect(() => {
    if (!showPalette) return;
    void commands.getSettings().then((s) => {
      if (s.settings.scanRoots[0]) setDefaultParentFolder(s.settings.scanRoots[0]);
    });
  }, [showPalette]);

  // Derived, so it always reflects the latest list (missing badge) and
  // disappears when the Project is hidden.
  const selected = projects?.find((p) => p.id === selectedId && !p.hidden) ?? null;
  const currentThreadId = threads?.some((thread) => thread.id === selectedThreadId)
    ? selectedThreadId
    : null;
  const diffThread = {
    board: threads?.some((thread) => thread.id === currentThreadId && isBoardThread(thread)) ?? false,
  };
  const diffScope =
    chosenDiffScope && chosenDiffScope.threadId === currentThreadId
      ? chosenDiffScope.scope
      : defaultDiffScope(diffThread);
  // Read by the stable `openDiff`.
  const currentThreadRef = useRef(currentThreadId);
  useEffect(() => {
    currentThreadRef.current = currentThreadId;
  });
  const currentTerminalContext = useMemo<TerminalContext | null>(
    () => selected && threads !== null
      ? {
          key: terminalContextKey(selected.id, currentThreadId),
          projectId: selected.id,
          threadId: currentThreadId,
        }
      : null,
    [selected, threads, currentThreadId],
  );
  const terminalContextsToRender = currentTerminalContext &&
      !terminalContexts.some((context) => context.key === currentTerminalContext.key)
    ? [...terminalContexts, currentTerminalContext]
    : terminalContexts;

  // Changes whenever a Thread's status does, so Git views refresh after a Turn.
  // A commit or push bumps it too, so the header and the Diff Surface reload.
  const [gitRevision, setGitRevision] = useState(0);
  const onGitChanged = useCallback(() => setGitRevision((n) => n + 1), []);
  const threadsKey =
    (threads?.map((t) => `${t.id}:${t.status}`).join(",") ?? "") + `#${gitRevision}`;

  // Stable: it reaches memoized TurnViews through context.
  const openDiff = useCallback((hint?: string) => {
    setShowTools(true);
    setActiveTool("Diff");
    setChosenDiffScope({ threadId: currentThreadRef.current, scope: "uncommitted" });
    setDiffFocus(hint ?? null);
  }, []);

  // The pull request whose files the Diff Surface's PR scope shows.
  const [reviewedPr, setReviewedPr] = useState<{ projectId: number; number: number } | null>(null);
  const reviewPullRequestFiles = useCallback((projectId: number, number: number) => {
    setReviewedPr({ projectId, number });
    setShowTools(true);
    setActiveTool("Diff");
    setChosenDiffScope({ threadId: currentThreadRef.current, scope: "pr" });
    setDiffFocus(null);
  }, []);

  const openPullRequest = useCallback(() => {
    setShowTools(true);
    setActiveTool("Pull request");
  }, []);

  useEffect(() => {
    void commands.lastSelection().then((res) => {
      const last = res.status === "ok" ? res.data : null;
      restore.current = last && { projectId: last.projectId, threadId: last.threadId };
      // Projects may have loaded first.
      if (last) setSelectedId((current) => current ?? last.projectId);
    });
  }, []);

  useEffect(() => {
    const target = restore.current;
    if (target && selectedId === null && projects?.some((p) => p.id === target.projectId && !p.hidden)) {
      setSelectedId(target.projectId);
    }
  }, [projects, selectedId]);

  // Remember what is open, once the last session has been restored.
  useEffect(() => {
    const pending = restore.current;
    if (pending === undefined || !selected || threads === null) return;
    if (pending !== null) {
      if (pending.projectId !== selected.id) return;
      restore.current = null;
    }
    void commands.rememberSelection(selected.id, currentThreadId);
  }, [selected, threads, currentThreadId]);

  // ⌘N, even from a hidden window: start a new Thread.
  useEffect(() => {
    const unlisten = listen("new-thread", () => {
      setShowSettings(false);
      setShowBoard(false);
      setSelectedThreadId(null);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Stable, since ThreadView resubscribes whenever it changes.
  const onThreadStatusChange = useCallback((threadId: number, status: ThreadStatus) => {
    setThreads(
      (prev) =>
        prev?.map((t) => (t.id === threadId && t.status !== status ? { ...t, status } : t)) ?? null
    );
  }, []);

  const onThreadTitleChange = useCallback((threadId: number, title: string) => {
    setThreads(
      (prev) => prev?.map((t) => (t.id === threadId ? { ...t, title } : t)) ?? null
    );
  }, []);

  const onThreadUpdated = useCallback((updated: Thread) => {
    setThreads(
      (prev) => prev?.map((t) => (t.id === updated.id ? updated : t)) ?? null
    );
  }, []);

  /** A new Thread in the Project with Settings defaults; `null` if it could not be created. */
  const createThreadIn = useCallback(async (projectId: number): Promise<Thread | null> => {
    const settingsRes = await commands.getSettings();
    const provider = settingsRes.settings.defaultProvider || "claude";
    const provKey = provider as keyof typeof settingsRes.settings.providers;
    const provSettings = settingsRes.settings.providers[provKey];
    const created = await commands.createThread(
      projectId,
      provider,
      provSettings?.model ?? null,
      provSettings?.effort ?? null,
      provSettings?.permissionMode ?? null
    );
    return created.status === "ok" ? created.data : null;
  }, []);

  const startNewThread = useCallback(async () => {
    if (!selected) return;
    const created = await createThreadIn(selected.id);
    if (created) {
      setShowBoard(false);
      setThreads((prev) => [created, ...(prev || [])]);
      setSelectedThreadId(created.id);
      rememberTerminalContext(selected.id, created.id);
    }
  }, [selected, createThreadIn, rememberTerminalContext]);

  const openProject = useCallback((project: Project) => {
    restore.current = null;
    setShowSettings(false);
    setShowBoard(false);
    setProjects((prev) => [project, ...(prev?.filter((p) => p.id !== project.id) ?? [])]);
    if (project.id !== selectedId) {
      setSelectedId(project.id);
      setThreads(null);
      setSelectedThreadId(null);
    }
  }, [selectedId]);

  // The palette's search pick: ⌘⇧N plus Enter is a new Thread in that Project.
  const startThreadIn = useCallback((project: Project) => {
    setShowSettings(false);
    if (project.id === selectedId) {
      void startNewThread();
      return;
    }
    pendingNewThread.current = project.id;
    openProject(project);
  }, [selectedId, startNewThread, openProject]);

  const openCheckout = useCallback(async (how: "editor" | "finder") => {
    if (!selected) return;
    const res = how === "editor"
      ? await commands.openInEditor(selected.id, currentThreadId)
      : await commands.revealInFinder(selected.id, currentThreadId);
    setOpenError(res.status === "error" ? res.error.message : null);
  }, [selected, currentThreadId]);

  const onPromptSent = useCallback((threadId: number) => {
    setThreads((prev) =>
      prev?.map((t) => (t.id === threadId && t.archived ? { ...t, archived: false } : t)) ?? null);
  }, []);

  const setThreadArchived = useCallback(async (threadId: number, archived: boolean) => {
    let res = await commands.setThreadArchived(threadId, archived, false);
    if (res.status === "ok" && res.data === "needs-confirmation") {
      const proceed = window.confirm(
        "This Thread's worktree has uncommitted changes. Archiving removes the worktree and discards them; the branch is kept. Archive anyway?",
      );
      if (!proceed) return;
      res = await commands.setThreadArchived(threadId, archived, true);
    }
    if (res.status === "ok") {
      setThreads((prev) => prev?.map((t) => (t.id === threadId ? { ...t, archived } : t)) ?? null);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isProjectPaletteShortcut(e)) {
        e.preventDefault();
        setShowPalette(true);
        return;
      }
      if (isNewThreadShortcut(e)) {
        if (selected) {
          e.preventDefault();
          void startNewThread();
        }
        return;
      }
      const toggle = toggleForKey(e);
      if (!toggle) return;
      e.preventDefault();
      if (toggle === "tools") setShowTools((v) => !v);
      else if (toggle === "terminal") setShowTerminal((v) => !v);
      else if (toggle === "board") setShowBoard((v) => !v);
      else setShowSettings(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, startNewThread]);

  // Listen for low-rate thread status changes from backend
  useEffect(() => {
    const unlisten = listen<{ threadId: number; status: ThreadStatus }>(
      "thread-status-changed",
      (event) => {
        setThreads((prev) =>
          prev?.map((t) =>
            t.id === event.payload.threadId ? { ...t, status: event.payload.status } : t
          ) ?? null
        );
      }
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // When selected project changes, fetch its threads
  useEffect(() => {
    let active = true;

    void (async () => {
      if (!selected) {
        if (active) {
          setThreads(null);
          setSelectedThreadId(null);
        }
        return;
      }

      const res = await commands.listThreads(selected.id);
      if (active && res.status === "ok" && pendingNewThread.current === selected.id) {
        const created = await createThreadIn(selected.id);
        // Cleared only once applied: a re-run mid-await must still start the Thread.
        if (!active) return;
        pendingNewThread.current = null;
        setThreads(created ? [created, ...res.data] : res.data);
        const initialThreadId = created?.id ?? res.data[0]?.id ?? null;
        setSelectedThreadId(initialThreadId);
        rememberTerminalContext(selected.id, initialThreadId);
      } else if (active && res.status === "ok") {
        setThreads(res.data);
        const wanted = restore.current;
        const restored =
          wanted?.projectId === selected.id && res.data.some((t) => t.id === wanted.threadId)
            ? wanted.threadId
            : null;
        const initialThreadId = restored ?? res.data[0]?.id ?? null;
        setSelectedThreadId(initialThreadId);
        rememberTerminalContext(selected.id, initialThreadId);
      }
    })();

    return () => {
      active = false;
    };
  }, [selected, rememberTerminalContext, createThreadIn]);

  return (
    <div className="window">
      <QuitDialog />
      {showPalette && (
        <ProjectPalette
          projects={projects ?? []}
          defaultParent={defaultParentFolder}
          onClose={() => setShowPalette(false)}
          onStartThread={startThreadIn}
          onOpenProject={openProject}
        />
      )}
      <header className="header">
        {selected ? (
          <span className="title">
            <strong>{selected.name}</strong> <span className="path">{selected.path}</span>
            {selected.missing && <span className="badge">missing</span>}
          </span>
        ) : (
          <span className="title">Oxide</span>
        )}
        {selected && !selected.missing && (
          <GitHeader
            projectId={selected.id}
            threadsKey={threadsKey}
            onOpenDiff={() => openDiff()}
            onOpenPullRequest={openPullRequest}
            onChanged={onGitChanged}
          />
        )}
        <div className="toggles">
          {selected && !selected.missing && (
            <>
              {openError && <span className="error" role="alert">{openError}</span>}
              <button title="Open in editor" onClick={() => void openCheckout("editor")}>
                Open in editor
              </button>
              <button title="Reveal in Finder" onClick={() => void openCheckout("finder")}>
                Reveal in Finder
              </button>
            </>
          )}
          {selected && (
            <span role="group" aria-label="View" className="view-toggle">
              <button aria-pressed={!showBoard} title="Chat (⌘B)" onClick={() => setShowBoard(false)}>
                Chat
              </button>
              <button aria-pressed={showBoard} title="Board (⌘B)" onClick={() => setShowBoard(true)}>
                Board
              </button>
            </span>
          )}
          <button aria-pressed={showTools} title="Toggle tools panel (⌘\)" onClick={() => setShowTools((v) => !v)}>
            Tools
          </button>
          <button aria-pressed={showTerminal} title="Toggle Terminal (⌘J)" onClick={() => setShowTerminal((v) => !v)}>
            Terminal
          </button>
        </div>
      </header>
      <div className="body">
        <Sidebar
          projects={projects}
          onProjects={setProjects}
          selected={selected}
          onSelect={(p) => {
            restore.current = null;
            setSelectedId(p.id);
            setThreads(null);
            setSelectedThreadId(null);
          }}
          threads={threads}
          selectedThreadId={selectedThreadId}
          onSelectThread={(threadId) => {
            setShowBoard(false);
            setSelectedThreadId(threadId);
            if (selected) rememberTerminalContext(selected.id, threadId);
          }}
          onArchiveThread={(threadId, archived) => void setThreadArchived(threadId, archived)}
          onNewThread={() => {
            void startNewThread();
          }}
          onRenameThread={onThreadTitleChange}
        />
        <div className="centre-column">
          {showSettings ? (
            <SettingsView onClose={() => setShowSettings(false)} />
          ) : selected && showBoard ? (
            <BoardView
              key={selected.id}
              projectId={selected.id}
              onOpenThread={(id) => {
                setShowBoard(false);
                setSelectedThreadId(id);
                rememberTerminalContext(selected.id, id);
              }}
              onArchiveThread={(id) => void setThreadArchived(id, true)}
              onDispatched={(thread) =>
                setThreads((prev) => [thread, ...(prev ?? []).filter((t) => t.id !== thread.id)])
              }
            />
          ) : selected ? (
            <main className="centre" aria-label="Thread">
              <DiffOpenContext.Provider value={openDiff}>
                <ThreadView
                  threadId={selectedThreadId}
                  projectId={selected.id}
                  draft={getDraft(drafts, selectedThreadId)}
                  onDraftChange={(text) =>
                    setDrafts((prev) => setDraft(prev, selectedThreadId, text))
                  }
                  onClearThread={() => {
                    void startNewThread();
                  }}
                  onThreadCreated={(newThread) => {
                    setThreads((prev) => [newThread, ...(prev || [])]);
                    setSelectedThreadId(newThread.id);
                    rememberTerminalContext(selected.id, newThread.id);
                  }}
                  onThreadUpdated={onThreadUpdated}
                  onStatusChange={onThreadStatusChange}
                  onPromptSent={onPromptSent}
                  onThreadTitleChange={onThreadTitleChange}
                  prefill={prefill}
                  onPrefillUsed={() => setPrefill(null)}
                  onOpenThread={(id) => {
                    setSelectedThreadId(id);
                    rememberTerminalContext(selected.id, id);
                  }}
                  onThreadContinued={(continued, from) => {
                    setThreads((prev) => [
                      continued.thread,
                      ...(prev?.map((t) => (t.id === from ? { ...t, continuedIn: continued.thread.id } : t)) ?? []),
                    ]);
                    setPrefill({ threadId: continued.thread.id, text: continued.recap });
                    setSelectedThreadId(continued.thread.id);
                    rememberTerminalContext(selected.id, continued.thread.id);
                  }}
                />
              </DiffOpenContext.Provider>
            </main>
          ) : (
            <main className="centre empty-thread" aria-label="Thread">
              <p>Pick a Project to begin.</p>
            </main>
          )}
          {terminalContextsToRender.map((context) => (
            <Suspense key={context.key} fallback={context.key === currentTerminalContext?.key && showTerminal ? <section className="terminal" aria-label="Terminal" /> : null}>
              <TerminalPanel
                projectId={context.projectId}
                threadId={context.threadId}
                contextKey={context.key}
                visible={showTerminal && context.key === currentTerminalContext?.key}
              />
            </Suspense>
          ))}
        </div>
        {showTools && (
          <aside className="tools" aria-label="Tools panel">
            <nav className="tool-tabs">
              {TOOL_TABS.map((t) => (
                <button
                  key={t}
                  title={t}
                  aria-label={t}
                  aria-pressed={activeTool === t}
                  onClick={() => setActiveTool(t)}
                >
                  {t[0]}
                </button>
              ))}
            </nav>
            {activeTool === "Diff" && selected && (
              <Suspense fallback={null}>
                <DiffPanel
                  projectId={selected.id}
                  threadId={currentThreadId}
                  board={diffThread.board}
                  scope={diffScope}
                  reviewedPr={reviewedPr?.projectId === selected.id ? reviewedPr.number : null}
                  onScopeChange={(scope) => {
                    setChosenDiffScope({ threadId: currentThreadId, scope });
                    setDiffFocus(null);
                  }}
                  focus={diffFocus}
                  refreshKey={threadsKey}
                  onChanged={onGitChanged}
                  onOpenPullRequest={openPullRequest}
                />
              </Suspense>
            )}
            {activeTool === "Pull request" && selected && (
              <Suspense fallback={null}>
                <PullRequestPanel
                  projectId={selected.id}
                  refreshKey={gitRevision}
                  onChanged={onGitChanged}
                  onReviewFiles={(number) => reviewPullRequestFiles(selected.id, number)}
                />
              </Suspense>
            )}
            {activeTool === "Files" && selected && (
              <Suspense fallback={null}>
                <FilesPanel projectId={selected.id} threadId={currentThreadId} />
              </Suspense>
            )}
            {activeTool === "Issues" && selected && (
              <Suspense fallback={null}>
                <IssuesSurface
                  projectId={selected.id}
                  onDispatched={(thread) =>
                    setThreads((prev) => [thread, ...(prev ?? []).filter((t) => t.id !== thread.id)])
                  }
                />
              </Suspense>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

interface SidebarProps {
  projects: Project[] | null;
  onProjects: (projects: Project[]) => void;
  selected: Project | null;
  onSelect: (p: Project) => void;
  threads: Thread[] | null;
  selectedThreadId: number | null;
  onSelectThread: (threadId: number) => void;
  onArchiveThread: (threadId: number, archived: boolean) => void;
  onNewThread: () => void;
  onRenameThread?: (threadId: number, newTitle: string) => void;
}

function Sidebar({
  projects,
  onProjects,
  selected,
  onSelect,
  threads,
  selectedThreadId,
  onSelectThread,
  onArchiveThread,
  onNewThread,
  onRenameThread,
}: SidebarProps) {
  const [threadQuery, setThreadQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");

  const finishRename = async (threadId: number) => {
    setEditingThreadId(null);
    const trimmed = renameText.trim();
    if (!trimmed) return;
    await commands.renameThread(threadId, trimmed);
    onRenameThread?.(threadId, trimmed);
  };

  const apply = (r: Result<Project[], AppError>) => {
    if (r.status === "ok") {
      onProjects(r.data);
      setError(null);
    } else setError(r.error.message);
  };

  const rescan = async () => {
    setScanning(true);
    apply(await commands.rescanProjects());
    setScanning(false);
  };

  // Show what's known right away, then scan on launch. Sequential, so the
  // scan result can't be overwritten by the earlier, staler list.
  useEffect(() => {
    void (async () => {
      const known = await commands.listProjects();
      if (known.status === "ok") onProjects(known.data);
      const scanned = await commands.rescanProjects();
      if (scanned.status === "ok") onProjects(scanned.data);
      else setError(scanned.error.message);
      setScanning(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hide = async (p: Project, hidden: boolean) => {
    const r = await commands.setProjectHidden(p.id, hidden);
    if (r.status === "error") setError(r.error.message);
    else apply(await commands.listProjects());
  };

  const visible = projects?.filter((p) => !p.hidden) ?? [];
  const hidden = projects?.filter((p) => p.hidden) ?? [];
  const { active: activeThreads, archived: archivedThreads } = splitThreads(threads ?? [], threadQuery);
  const renderThread = (t: Thread, archived: boolean) => (
    <li key={t.id}>
      {editingThreadId === t.id ? (
        <input
          className="thread-rename-input"
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onBlur={() => void finishRename(t.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void finishRename(t.id);
            if (e.key === "Escape") setEditingThreadId(null);
          }}
          autoFocus
          aria-label={`Rename thread ${threadTitle(t)}`}
        />
      ) : (
        <button
          className="thread-item"
          aria-current={t.id === selectedThreadId}
          onClick={() => onSelectThread(t.id)}
          onDoubleClick={(e) => {
            e.preventDefault();
            setEditingThreadId(t.id);
            setRenameText(threadTitle(t));
          }}
          title={`${threadTitle(t)} (${t.status})`}
        >
          <span
            className={`status-dot ${t.status}`}
            aria-label={`Status: ${t.status}`}
            title={`Status: ${t.status}`}
          />
          {isBoardThread(t) && (
            <span className="thread-item-branch" title={`Worktree on ${t.branch}`} aria-label="Board Thread">
              <GitBranchIcon size={12} />
            </span>
          )}
          <span className="thread-item-title">{threadTitle(t)}</span>
        </button>
      )}
      <button
        className="row-action"
        onClick={() => onArchiveThread(t.id, !archived)}
        aria-label={`${archived ? "Unarchive" : "Archive"} ${threadTitle(t)}`}
        title={archived ? "Unarchive" : "Archive"}
      >
        {archived ? "Unarchive" : "Archive"}
      </button>
    </li>
  );

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar-actions">
        <button onClick={rescan} disabled={scanning} title="Rescan for repositories">
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {projects && visible.length === 0 && !scanning && <p className="empty">No projects found</p>}
      <ul>
        {visible.map((p) => (
          <li key={p.id} className={p.missing ? "missing" : undefined}>
            <button className="project" aria-current={p.id === selected?.id} onClick={() => onSelect(p)} title={p.path}>
              {p.name}
              {p.missing && <span className="badge">missing</span>}
            </button>
            <button className="row-action" onClick={() => hide(p, true)} aria-label={`Hide ${p.name}`} title="Hide">
              ✕
            </button>
          </li>
        ))}
      </ul>
      {hidden.length > 0 && (
        <section>
          <button className="hidden-toggle" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
            Hidden ({hidden.length})
          </button>
          {showHidden && (
            <ul aria-label="Hidden projects">
              {hidden.map((p) => (
                <li key={p.id} className={p.missing ? "missing" : undefined}>
                  <span className="project" title={p.path}>
                    {p.name}
                  </span>
                  <button className="row-action" onClick={() => hide(p, false)} aria-label={`Unhide ${p.name}`}>
                    Unhide
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {selected && (
        <section className="threads-section" aria-label="Threads">
          <div className="threads-header">
            <span>Threads</span>
            <button className="new-thread-btn" onClick={onNewThread} title="Start a new Thread">
              + New
            </button>
          </div>
          <input
            type="search"
            className="thread-search"
            placeholder="Search Threads"
            aria-label="Search Threads by title"
            value={threadQuery}
            onChange={(e) => setThreadQuery(e.target.value)}
          />
          {threads && activeThreads.length === 0 && (
            <p className="empty" style={{ padding: "4px 6px", margin: 0 }}>
              {threads.length === 0 ? "No threads yet" : "No matching threads"}
            </p>
          )}
          <ul aria-label="Thread list">{activeThreads.map((t) => renderThread(t, false))}</ul>
          {archivedThreads.length > 0 && (
            <>
              <button className="hidden-toggle" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
                Archived ({archivedThreads.length})
              </button>
              {showArchived && (
                <ul aria-label="Archived threads">{archivedThreads.map((t) => renderThread(t, true))}</ul>
              )}
            </>
          )}
        </section>
      )}
    </nav>
  );
}
