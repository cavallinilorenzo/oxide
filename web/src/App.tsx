import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { commands, type Project, type Thread, type ThreadStatus } from "./bindings";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  FileDirectoryIcon,
  FileIcon,
  GearIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  IssueOpenedIcon,
  PlusIcon,
  ProjectIcon,
  RepoIcon,
  SearchIcon,
  TerminalIcon,
  ToolsIcon,
  XIcon,
  type Icon,
  TrashIcon,
} from "@primer/octicons-react";
import { BoardView } from "./BoardView";
import { isBoardThread } from "./dispatch";
import { DiffOpenContext } from "./diffOpen";
import { defaultDiffScope, type PanelScope } from "./diffScope";
import { performThreadDelete, selectionAfterDelete, threadsAfterDelete } from "./deleteThread";
import { GitHeader } from "./GitHeader";
import { ProjectPalette } from "./ProjectPalette";
import { QuitDialog } from "./QuitDialog";
import { ThreadView } from "./ThreadView";
import { SettingsView } from "./SettingsView";
import { ResizeHandle } from "./ResizeHandle";
import { workspaceLayout } from "./panelLayout";
import { useElementSize, usePanelSize } from "./usePanelSize";
import { readablePath } from "./headerLines";
import { EditorMark } from "./EditorMark";
import { isNewThreadShortcut, isProjectPaletteShortcut, toggleForKey } from "./shortcuts";
import { getDraft, setDraft } from "./threadDrafts";
import { filterThreads, relativeAge, sidebarProjects, threadTitle } from "./threadList";
import oxideMark from "../../assets/brand/oxide/oxide-mark.svg";

const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform);

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const shortcut = isMac ? "\u2318" : "Ctrl+";
const shortcutShift = isMac ? "\u2318\u21e7" : "Ctrl+Shift+";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

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
const TOOL_TABS: { name: string; Icon: Icon }[] = [
  { name: "Files", Icon: FileIcon },
  { name: "Diff", Icon: FileDiffIcon },
  { name: "Pull request", Icon: GitPullRequestIcon },
  { name: "Issues", Icon: IssueOpenedIcon },
];

export function App() {
  const [showTools, setShowTools] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>("Files");
  // The user's pick, for the Thread it was made in: elsewhere that Thread's default applies.
  const [chosenDiffScope, setChosenDiffScope] = useState<{ threadId: number | null; scope: PanelScope } | null>(null);
  const [diffFocus, setDiffFocus] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodySize = useElementSize(bodyRef, { width: window.innerWidth, height: window.innerHeight - 44 });
  const sidebarSize = usePanelSize("sidebar");
  const toolsSize = usePanelSize("tools");
  const terminalSize = usePanelSize("terminal");
  const layout = workspaceLayout(bodySize.width, bodySize.height, {
    sidebar: sidebarSize.preferred, tools: toolsSize.preferred, terminal: terminalSize.preferred,
  }, showTools && !showSettings);
  const [editorBundleId, setEditorBundleId] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const overlays = useRef<WorkspaceOverlaysHandle>(null);
  // A Project picked in the palette that should get a new Thread once its Threads have loaded.
  const pendingNewThread = useRef<number | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const onProjectsScanned = useCallback((next: Project[]) => {
    setProjects((previous) => previous && previous.length === next.length && previous.every((project, index) => {
      const other = next[index];
      return project.id === other.id && project.name === other.name && project.path === other.path &&
        project.open === other.open && project.hidden === other.hidden && project.missing === other.missing;
    }) ? previous : next);
  }, []);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [lastSelectionLoaded, setLastSelectionLoaded] = useState(false);
  const [startupThreadLoaded, setStartupThreadLoaded] = useState(false);
  const onStartupThreadLoaded = useCallback(() => setStartupThreadLoaded(true), []);
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

  useEffect(() => {
    void (async () => {
      try {
        const known = await commands.listProjects();
        if (known.status === "ok") setProjects(known.data);
        else setOpenError(known.error.message);

        const scanned = await commands.rescanProjects();
        if (scanned.status === "ok") setProjects(scanned.data);
        else setOpenError(scanned.error.message);
      } catch (cause) {
        setOpenError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setProjectsLoaded(true);
      }
    })();
  }, []);

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
      setLastSelectionLoaded(true);
    }).catch((cause: unknown) => {
      restore.current = null;
      setOpenError(cause instanceof Error ? cause.message : String(cause));
      setLastSelectionLoaded(true);
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
    const opened = { ...project, open: true, hidden: false };
    setProjects((prev) => [opened, ...(prev?.filter((p) => p.id !== project.id) ?? [])]);
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

  // The editor "Open in editor" uses: the configured one if detected, else the first detected.
  useEffect(() => {
    if (showSettings) return;
    void (async () => {
      const settingsRes = await commands.getSettings();
      const editorsRes = await commands.detectedEditors();
      const detected = editorsRes.status === "ok" ? editorsRes.data : [];
      const chosen = detected.find((e) => e.bundleId === settingsRes.settings.editor) ?? detected[0];
      setEditorBundleId(chosen?.bundleId ?? "");
    })();
  }, [showSettings]);

  const openCheckout = useCallback(async (how: "editor" | "finder") => {
    if (!selected) return;
    const res = how === "editor"
      ? await commands.openInEditor(selected.id, currentThreadId)
      : await commands.revealInFinder(selected.id, currentThreadId);
    setOpenError(res.status === "error" ? res.error.message : null);
  }, [selected, currentThreadId]);

  const deleteThread = useCallback((threadId: number) => {
    const title = threadTitle(threads?.find((t) => t.id === threadId) ?? { id: threadId, title: null });
    overlays.current?.openDelete(threadId, title);
  }, [threads]);

  const onThreadDeleted = useCallback((deletedId: number) => {
    setThreads((prev) => threadsAfterDelete(prev, deletedId));
    setSelectedThreadId((current) => selectionAfterDelete(current, deletedId));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isProjectPaletteShortcut(e)) {
        e.preventDefault();
        overlays.current?.openPalette();
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
      if (toggle === "tools") setShowTools(showSettings || !showTools);
      else if (toggle === "terminal") setShowTerminal(showSettings || !showTerminal);
      else if (toggle === "board") setShowBoard((v) => !v);
      setShowSettings(toggle === "settings");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, startNewThread, showSettings, showTools, showTerminal]);

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
        const initialThreadId = wanted?.projectId === selected.id
          ? (res.data.some((thread) => thread.id === wanted.threadId) ? wanted.threadId : null)
          : res.data[0]?.id ?? null;
        setSelectedThreadId(initialThreadId);
        rememberTerminalContext(selected.id, initialThreadId);
      }
    })();

    return () => {
      active = false;
    };
  }, [selected, rememberTerminalContext, createThreadIn]);

  const starting = !projectsLoaded || !lastSelectionLoaded || (selected !== null && threads === null);

  useEffect(() => {
    if (!starting && (!selected || startupThreadLoaded)) document.documentElement.dataset.appReady = "true";
  }, [starting, selected, startupThreadLoaded]);

  if (starting) {
    return (
      <div className="startup-screen" aria-hidden="true">
        <div className="startup-content">
          <div className="startup-emblem" aria-hidden="true">
            <span className="startup-orbit"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="45" pathLength="360" /></svg></span>
            <img src={oxideMark} alt="" />
          </div>
          <div className="startup-copy">
            <span className="startup-wordmark">oxide</span>
            <p>Preparing your workspace</p>
            <span className="startup-detail">Loading Projects and Threads</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`window ${isMac ? "macos" : "windows"}`}>
      {isWindows && <WindowResizeHandles />}
      <QuitDialog />
      <WorkspaceOverlays ref={overlays} projects={projects ?? []} onProjectsScanned={onProjectsScanned}
        onStartThread={startThreadIn} onOpenProject={openProject} onThreadDeleted={onThreadDeleted} />
      <header className="header" data-tauri-drag-region>
        {isWindows && <AppMenu onNewThread={() => { setShowSettings(false); setShowBoard(false); setSelectedThreadId(null); }} />}
        <div className="header-project" data-tauri-drag-region>
        {selected ? (
          <span className="title" data-tauri-drag-region>
            <strong title={readablePath(selected.path)}>{selected.name}</strong>
            {selected.missing && <span className="badge">missing</span>}
          </span>
        ) : !isWindows ? (
          <span className="title" data-tauri-drag-region>
            <strong>Oxide</strong>
          </span>
        ) : null}
        {selected && !selected.missing && (
          <GitHeader
            projectId={selected.id}
            threadsKey={threadsKey}
            onOpenDiff={() => openDiff()}
            onOpenPullRequest={openPullRequest}
            onChanged={onGitChanged}
          />
        )}
        </div>
        {!isWindows && <span className="grow" data-tauri-drag-region />}
        <div className="header-actions" data-tauri-drag-region>
        {openError && <span className="error header-error" role="alert">{openError}</span>}
        {selected && !selected.missing && (
          <>
            <button className="icon-btn" title={`Open in editor`} aria-label="Open in editor" onClick={() => void openCheckout("editor")}>
              <EditorMark bundleId={editorBundleId} />
            </button>
            <button className="icon-btn" title={`Reveal in Finder`} aria-label="Reveal in Finder" onClick={() => void openCheckout("finder")}>
              <FileDirectoryIcon size={16} />
            </button>
          </>
        )}
        {selected && (
          <span role="group" aria-label="View" className="seg">
            <button aria-pressed={!showBoard && !showSettings} title={`Chat (${shortcut}B)`} onClick={() => { setShowBoard(false); setShowSettings(false); }}>
              <CommentDiscussionIcon size={14} /> Chat
            </button>
            <button aria-pressed={showBoard && !showSettings} title={`Thread Board (${shortcut}B)`} onClick={() => { setShowBoard(true); setShowSettings(false); }}>
              <ProjectIcon size={14} /> Board
            </button>
          </span>
        )}
        <button
          className="icon-btn"
          aria-pressed={showTools && !showSettings}
          title={`Tools: Files, Diff, Pull request, Issues (${shortcut}\\)`}
          aria-label="Toggle tools panel"
          onClick={() => { setShowTools(showSettings || !showTools); setShowSettings(false); }}
        >
          <ToolsIcon size={16} />
        </button>
        <button
          className="icon-btn"
          aria-pressed={showTerminal && !showSettings}
          title={`Terminal (${shortcut}J)`}
          aria-label="Toggle Terminal"
          onClick={() => { setShowTerminal(showSettings || !showTerminal); setShowSettings(false); }}
        >
          <TerminalIcon size={16} />
        </button>
        {isWindows && <WindowControls />}
        </div>
      </header>
      <div className="body" ref={bodyRef} style={{
        "--sidebar-width": `${layout.sidebar.value}px`,
        "--tools-width": `${layout.tools.value}px`,
        "--terminal-height": `${layout.terminal.value}px`,
      } as CSSProperties}>
        <div className="sidebar-region" id="workspace-sidebar">
          <Sidebar
            projects={projects}
            selected={selected}
            onCloseProject={async (projectId) => {
              const closed = await commands.setProjectOpen(projectId, false);
              if (closed.status === "error") return closed.error.message;
              const listed = await commands.listProjects();
              const updatedProjects = listed.status === "ok"
                ? listed.data
                : (projects ?? []).map((project) => project.id === projectId ? { ...project, open: false } : project);
              setProjects(updatedProjects);
              if (selectedId === projectId) {
                const next = sidebarProjects(updatedProjects).find((project) => project.id !== projectId);
                restore.current = null;
                setSelectedId(next?.id ?? null);
                setThreads(null);
                setSelectedThreadId(null);
                setShowBoard(false);
              }
              return listed.status === "error" ? listed.error.message : null;
            }}
            onSelect={(p) => {
              restore.current = null;
              setShowSettings(false);
              setSelectedId(p.id);
              setThreads(null);
              setSelectedThreadId(null);
            }}
            threads={threads}
            selectedThreadId={selectedThreadId}
            onSelectThread={(threadId) => {
              setShowSettings(false);
              setShowBoard(false);
              setSelectedThreadId(threadId);
              if (selected) rememberTerminalContext(selected.id, threadId);
            }}
            onDeleteThread={(threadId) => void deleteThread(threadId)}
            onNewThread={() => {
              void startNewThread();
            }}
            onRenameThread={onThreadTitleChange}
            onOpenPalette={() => overlays.current?.openPalette()}
            onOpenBoard={(p) => {
              if (p.id !== selected?.id) {
                restore.current = null;
                setSelectedId(p.id);
                setThreads(null);
                setSelectedThreadId(null);
              }
              setShowSettings(false);
              setShowBoard(true);
            }}
            onOpenSettings={() => setShowSettings(true)}
            settingsOpen={showSettings}
          />
          <ResizeHandle label="Resize sidebar" controls="workspace-sidebar" axis="x" edge="end"
            {...layout.sidebar} onResize={sidebarSize.resize} onCommit={sidebarSize.commit} onReset={sidebarSize.reset} onCancel={sidebarSize.cancel} />
        </div>
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
              onDeleteThread={(id) => void deleteThread(id)}
              onDispatched={(thread) =>
                setThreads((prev) => [thread, ...(prev ?? []).filter((t) => t.id !== thread.id)])
              }
            />
          ) : selected ? (
            <main className="centre" aria-label="Thread">
              <DiffOpenContext.Provider value={openDiff}>
                <ThreadView
                  onInitialLoad={onStartupThreadLoaded}
                  threadId={selectedThreadId}
                  projectId={selected.id}
                  projectPath={selected.path}
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
              <div className="empty-state">
                <RepoIcon size={24} />
                <p>Open a Project to begin.</p>
                <button className="btn primary" onClick={() => overlays.current?.openPalette()}>
                  Open a Project <kbd>{shortcutShift}N</kbd>
                </button>
              </div>
            </main>
          )}
          <div className="terminal-region" id="workspace-terminal" hidden={!showTerminal || showSettings || !currentTerminalContext}>
            {showTerminal && !showSettings && currentTerminalContext && <ResizeHandle label="Resize Terminal" controls="workspace-terminal" axis="y" edge="start" direction={-1}
              {...layout.terminal} onResize={terminalSize.resize} onCommit={terminalSize.commit} onReset={terminalSize.reset} onCancel={terminalSize.cancel} />}
            {terminalContextsToRender.map((context) => (
              <Suspense key={context.key} fallback={context.key === currentTerminalContext?.key && showTerminal && !showSettings ? <section className="terminal" aria-label="Terminal" /> : null}>
                <TerminalPanel
                  projectId={context.projectId}
                  threadId={context.threadId}
                  contextKey={context.key}
                  visible={showTerminal && !showSettings && context.key === currentTerminalContext?.key}
                  onClose={() => setShowTerminal(false)}
                />
              </Suspense>
            ))}
          </div>
        </div>
        {showTools && !showSettings && (
          <aside className="tools" aria-label="Tools panel" id="workspace-tools">
            <ResizeHandle label="Resize Tools" controls="workspace-tools" axis="x" edge="start" direction={-1}
              {...layout.tools} onResize={toolsSize.resize} onCommit={toolsSize.commit} onReset={toolsSize.reset} onCancel={toolsSize.cancel} />
            <nav className="tabs" role="tablist" aria-label="Surfaces">
              {TOOL_TABS.map(({ name, Icon }) => (
                <button
                  key={name}
                  role="tab"
                  className="tab"
                  aria-label={name}
                  title={name}
                  aria-selected={activeTool === name}
                  onClick={() => setActiveTool(name)}
                >
                  <Icon size={14} /> <span className="tool-tab-label">{name}</span>
                </button>
              ))}
              <span className="grow" />
              <button className="icon-btn sm" title={`Close panel (${shortcut}\\)`} aria-label="Close tools panel" onClick={() => setShowTools(false)}>
                <XIcon size={14} />
              </button>
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
  selected: Project | null;
  onCloseProject: (projectId: number) => Promise<string | null>;
  onSelect: (p: Project) => void;
  threads: Thread[] | null;
  selectedThreadId: number | null;
  onSelectThread: (threadId: number) => void;
  onDeleteThread: (threadId: number) => void;
  onNewThread: () => void;
  onRenameThread?: (threadId: number, newTitle: string) => void;
  /** ⌘⇧N: every known Project, scanned ones included, is found there. */
  onOpenPalette: () => void;
  onOpenBoard: (p: Project) => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
}

/** Open Projects, each with its Threads. Scanned repositories stay out until opened from ⌘⇧N. */
function Sidebar({
  projects,
  selected,
  onCloseProject,
  onSelect,
  threads,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onNewThread,
  onRenameThread,
  onOpenPalette,
  onOpenBoard,
  onOpenSettings,
  settingsOpen,
}: SidebarProps) {
  const [threadQuery, setThreadQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [closingProjectId, setClosingProjectId] = useState<number | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");

  const finishRename = async (threadId: number) => {
    setEditingThreadId(null);
    const trimmed = renameText.trim();
    if (!trimmed) return;
    await commands.renameThread(threadId, trimmed);
    onRenameThread?.(threadId, trimmed);
  };

  const close = async (p: Project) => {
    if (closingProjectId !== null) return;
    setClosingProjectId(p.id);
    try {
      const message = await onCloseProject(p.id);
      if (message) setError(message);
      else setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setClosingProjectId(null);
    }
  };

  // The selected Project always shows, even before the Core has marked it open.
  const listed = sidebarProjects(projects ?? []);
  const shown = selected && !listed.some((p) => p.id === selected.id) ? [selected, ...listed] : listed;
  const activeThreads = filterThreads(threads ?? [], threadQuery);
  const now = new Date();

  const renderThread = (t: Thread) => (
    <li key={t.id} className="thread-row">
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
          title={`${threadTitle(t)} (${t.status}). Double-click to rename.`}
        >
          <span className={`status-dot ${t.status}`} aria-label={`Status: ${t.status}`} />
          <span className="thread-item-title">{threadTitle(t)}</span>
          {isBoardThread(t) && (
            <span className="thread-item-branch" title={`Board Thread: own worktree on ${t.branch}`} aria-label="Board Thread">
              <GitBranchIcon size={12} />
            </span>
          )}
          <span className="thread-item-age">{relativeAge(t.updatedAt, now)}</span>
        </button>
      )}
      <button
        className="row-action"
        onClick={() => onDeleteThread(t.id)}
        aria-label={`Delete ${threadTitle(t)}`}
        title={`Delete`}
      >
        <TrashIcon size={12} />
      </button>
    </li>
  );

  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar-actions">
        <button className="btn grow" onClick={onNewThread} disabled={!selected} title={`New Thread in this Project (${shortcut}N)`}>
          <PlusIcon size={14} /> New Thread <kbd>{shortcut}N</kbd>
        </button>
        <button className="btn" onClick={onOpenPalette} title={`Open a Project, or a new Thread in another one (${shortcutShift}N)`} aria-label="Open a Project">
          <RepoIcon size={14} />
        </button>
      </div>
      {selected && (
        <label className="sidebar-search">
          <SearchIcon size={12} />
          <input
            type="search"
            placeholder="Search Threads"
            aria-label="Search Threads by title"
            value={threadQuery}
            onChange={(e) => setThreadQuery(e.target.value)}
          />
        </label>
      )}
      {error && <p className="error sidebar-note">{error}</p>}
      <div className="sidebar-scroll">
        {projects && shown.length === 0 && (
          <div className="sidebar-empty">
            <RepoIcon className="sidebar-empty-icon" size={18} />
            <div className="sidebar-empty-copy">
              <p className="sidebar-empty-title">No open Projects</p>
              <p className="sidebar-empty-hint">Open a project to see its Threads here.</p>
            </div>
            <button className="btn primary sidebar-empty-action" onClick={onOpenPalette} title={`Open a Project (${shortcutShift}N)`}>
              <RepoIcon size={14} /> Open a Project <kbd>{shortcutShift}N</kbd>
            </button>
          </div>
        )}
        <ul className="project-list">
          {shown.map((p) => {
            const isSelected = p.id === selected?.id;
            return (
              <li key={p.id} className={`project-node${p.missing ? " missing" : ""}`}>
                <div className="project-row">
                  <button className="project" aria-current={isSelected} aria-expanded={isSelected} onClick={() => onSelect(p)} title={readablePath(p.path)}>
                    {isSelected ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    <RepoIcon size={13} />
                    <span className="project-name">{p.name}</span>
                    {p.missing && <span className="badge">missing</span>}
                  </button>
                  <button className="row-action" onClick={() => onOpenBoard(p)} aria-label={`Thread Board of ${p.name}`} title={`Thread Board`}>
                    <ProjectIcon size={13} />
                  </button>
                  <button className="row-action" onClick={() => void close(p)} disabled={closingProjectId === p.id} aria-busy={closingProjectId === p.id} aria-label={`Close ${p.name}`} title={closingProjectId === p.id ? "Closing Project…" : `Close Project (it stays in ${shortcutShift}N)`}>
                    <XIcon size={13} />
                  </button>
                </div>
                {isSelected && (
                  <ul className="thread-list" aria-label="Thread list">
                    {threads && activeThreads.length === 0 && (
                      <li className="sidebar-note">{threads.length === 0 ? "No Threads yet" : "No matching Threads"}</li>
                    )}
                    {activeThreads.map((t) => renderThread(t))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <button className="sidebar-footer" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings} title={`Settings (${shortcut},)`}>
        <GearIcon size={14} /> Settings
      </button>
    </nav>
  );
}

function AppMenu({ onNewThread }: { onNewThread: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open]);
  const win = getCurrentWindow();
  const menus: Record<string, { label: string; action: () => void }[]> = {
    Oxide: [{ label: "Quit Oxide", action: () => { void win.close(); } }],
    File: [{ label: "New Thread", action: onNewThread }],
    Edit: ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"].map((label) => ({ label, action: () => { document.execCommand(label === "Select All" ? "selectAll" : label.toLowerCase()); } })),
    Window: [{ label: "Minimize", action: () => { void win.minimize(); } }, { label: "Maximize / Restore", action: () => { void win.toggleMaximize(); } }],
  };
  return <nav ref={root} className="app-menu" aria-label="Application menu">
    {Object.entries(menus).map(([name, items]) => <div className="app-menu-item" key={name}>
      <button type="button" aria-haspopup="menu" aria-expanded={open === name} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(open === name ? null : name)}>{name}</button>
      {open === name && <div className="app-menu-popup" role="menu">
        {items.map(({ label, action }) => <button key={label} role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { action(); setOpen(null); }}>{label}</button>)}
      </div>}
    </div>)}
  </nav>;
}

function WindowControls() {
  const window = getCurrentWindow();
  return <div className="window-controls" role="group" aria-label="Window controls">
    <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void window.minimize()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" /></svg>
    </button>
    <button type="button" aria-label="Maximize or restore" title="Maximize or restore" onClick={() => void window.toggleMaximize()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
    </button>
    <button type="button" className="window-close" aria-label="Close window" title="Close" onClick={() => void window.close()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2L2 10" /></svg>
    </button>
  </div>;
}

function WindowResizeHandles() {
  const directions = ["North", "NorthEast", "East", "SouthEast", "South", "SouthWest", "West", "NorthWest"] as const;
  return <div className="window-resize-handles" aria-hidden="true">
    {directions.map((direction) => <div key={direction} className={`window-resize window-resize-${direction.toLowerCase()}`}
      onMouseDown={(event) => { if (event.button === 0) void getCurrentWindow().startResizeDragging(direction); }} />)}
  </div>;
}

type WorkspaceOverlaysHandle = { openPalette: () => void; openDelete: (id: number, title: string) => void };

function WorkspaceOverlays({ ref, projects, onProjectsScanned, onStartThread, onOpenProject, onThreadDeleted }: {
  ref: Ref<WorkspaceOverlaysHandle>;
  projects: Project[];
  onProjectsScanned: (projects: Project[]) => void;
  onStartThread: (project: Project) => void;
  onOpenProject: (project: Project) => void;
  onThreadDeleted: (id: number) => void;
}) {
  const [showPalette, setShowPalette] = useState(false);
  const [pending, setPending] = useState<{ id: number; title: string; discardChanges: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({
    openPalette: () => setShowPalette(true),
    openDelete: (id, title) => { setError(null); setPending({ id, title, discardChanges: false }); },
  }), []);
  useEffect(() => {
    if (!showPalette) return;
    let active = true;
    void commands.rescanProjects().then((result) => {
      if (active && result.status === "ok") onProjectsScanned(result.data);
    });
    return () => { active = false; };
  }, [showPalette, onProjectsScanned]);
  async function confirmDelete() {
    if (!pending || deleting) return;
    setDeleting(true); setError(null);
    try {
      const result = await performThreadDelete(pending.id, pending.discardChanges, commands.deleteThread);
      if (result.status === "error") setError(result.message);
      else if (result.status === "needs-confirmation") setPending((current) => current ? { ...current, discardChanges: true } : null);
      else { onThreadDeleted(pending.id); setPending(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeleting(false); }
  }
  return <>
    {pending && <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-thread-title">
        <h2 id="delete-thread-title">{pending.discardChanges ? "Discard worktree changes and delete?" : `Delete “${pending.title}”?`}</h2>
        <p>{pending.discardChanges ? "This Thread's worktree has uncommitted changes. Deleting removes the worktree and discards them; the branch is kept." : "Its conversation is removed permanently."}</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button autoFocus onClick={() => setPending(null)} disabled={deleting}>Cancel</button>
          <button onClick={() => void confirmDelete()} disabled={deleting}>{deleting ? "Deleting…" : "Delete Thread"}</button>
        </div>
      </div>
    </div>}
    {showPalette && <ProjectPalette projects={projects} defaultParent="~/Developer" onClose={() => setShowPalette(false)}
      onStartThread={onStartThread} onOpenProject={onOpenProject} />}
  </>;
}
