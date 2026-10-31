import { DictationController } from "./dictation";
import { Skeleton } from "./Skeleton";
import { Fragment, lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { invalidateQueries } from "./queryCache";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { commands, type Project, type Thread, type ThreadStatus, type DiffFile } from "./bindings";
import type { CodeOpenRequest } from "./codeOpen";
import {
  ChevronDownIcon,
  ChevronRightIcon,
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
import {
  allTabsOfThread, closeTab, describeAffectedTabs, emptyTerminals, focusCheckoutTab, openTab, removeThreadTabsEverywhere, selectTab, setRunning,
  type TerminalsByProject,
} from "./terminalTabs";
import { performThreadDelete, selectionAfterDelete, threadsAfterDelete } from "./deleteThread";
import { GitHeader } from "./GitHeader";
import { ProjectOverview } from "./ProjectOverview";
import { ProjectPalette } from "./ProjectPalette";
import { QuitDialog } from "./QuitDialog";
import { ThreadView } from "./ThreadView";
import { SettingsView } from "./SettingsView";
import { ResizeHandle } from "./ResizeHandle";
import { workspaceLayout } from "./panelLayout";
import { useElementSize, usePanelSize } from "./usePanelSize";
import { readablePath } from "./headerLines";
import { actionForKey, adjacentThreadId, formatAccelerator, type ShortcutAction } from "./shortcuts";
import { useShortcuts } from "./useShortcuts";
import { getDraft, setDraft } from "./threadDrafts";
import { createDefaultThread } from "./createDefaultThread";
import { filterThreads, relativeAge, sidebarProjects, threadTitle } from "./threadList";


const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform);

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

const TerminalSurface = lazy(() => import("./TerminalSurface").then((module) => ({ default: module.TerminalSurface })));
const CodeWorkbench = lazy(() => import("./CodeWorkbench").then((module) => ({ default: module.CodeWorkbench })));
type WorkbenchContext = { key: string; projectId: number; threadId: number | null; rootPath: string };

const DiffPanel = lazy(() => import("./DiffPanel").then((module) => ({ default: module.DiffPanel })));
const PullRequestPanel = lazy(() =>
  import("./PullRequestPanel").then((module) => ({ default: module.PullRequestPanel })),
);
const IssuesSurface = lazy(() =>
  import("./IssuesSurface").then((module) => ({ default: module.IssuesSurface })),
);
const TOOL_TABS: { name: string; Icon: Icon }[] = [
  { name: "Diff", Icon: FileDiffIcon },
  { name: "Files", Icon: FileIcon },
  { name: "Terminal", Icon: TerminalIcon },
  { name: "Pull request", Icon: GitPullRequestIcon },
  { name: "Issues", Icon: IssueOpenedIcon },
];

const TOOL_TAB_ACTION: Record<string, ShortcutAction> = {
  Files: "files", Diff: "diff", Terminal: "terminal", "Pull request": "pullRequests", Issues: "issues",
};

export function App() {
  const legacySurface = useRef<string | null>((() => {
    try { const mode = localStorage.getItem("oxide:work-mode"); return mode === "code" ? "Files" : mode === "terminal" ? "Terminal" : null; }
    catch { return null; }
  })());
  const [showSidebar, setShowSidebar] = useState(true);
  const [regionPriority, setRegionPriority] = useState<"sidebar" | "tools">("tools");
  const [maximized, setMaximized] = useState(false);
  const [workbenches, setWorkbenches] = useState<WorkbenchContext[]>([]);
  const [installCommand, setInstallCommand] = useState<{ id: number; command: string } | null>(null);
  const installSequence = useRef(0);
  const shortcuts = useShortcuts();
  const keys = (action: ShortcutAction) => formatAccelerator(shortcuts[action]);
  const [showTools, setShowTools] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>("Diff");
  // The user's pick, for the Thread it was made in: elsewhere that Thread's default applies.
  const [chosenDiffScope, setChosenDiffScope] = useState<{ threadId: number | null; scope: PanelScope } | null>(null);
  const [diffFocus, setDiffFocus] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodySize = useElementSize(bodyRef, { width: window.innerWidth, height: window.innerHeight - 44 });
  const sidebarSize = usePanelSize("sidebar");
  const toolsSize = usePanelSize("tools");
  const [openError, setOpenError] = useState<string | null>(null);
  const overlays = useRef<WorkspaceOverlaysHandle>(null);
  // A Project picked in the palette that should get a new Thread once its Threads have loaded.
  const pendingNewThread = useRef<number | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [createPrRequest, setCreatePrRequest] = useState(0);
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
  const [threadLoadError, setThreadLoadError] = useState<{ projectId: number; message: string } | null>(null);
  const [threadReload, setThreadReload] = useState(0);
  const [codeRequest, setCodeRequest] = useState<(CodeOpenRequest & { contextKey: string }) | null>(null);
  const codeSequence = useRef(0);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [prefill, setPrefill] = useState<{ threadId: number; text: string } | null>(null);
  // The Project and Thread of the last session: `undefined` until read, `null` once applied.
  const restore = useRef<{ projectId: number; threadId: number | null } | null | undefined>(undefined);
  // Derived, so it always reflects the latest list (missing badge) and
  // disappears when the Project is hidden.
  const selected = projects?.find((p) => p.id === selectedId && !p.hidden) ?? null;
  const currentThreadId = threads?.some((thread) => thread.id === selectedThreadId)
    ? selectedThreadId
    : null;
  const selectedThread = threads?.find((thread) => thread.id === currentThreadId);
  const workbenchContext = useMemo<WorkbenchContext | null>(() => selected && currentThreadId !== null ? {
    key: `${selected.id}:${selectedThread?.worktreePath ? currentThreadId : "main"}`,
    projectId: selected.id, threadId: selectedThread?.worktreePath ? currentThreadId : null,
    rootPath: selectedThread?.worktreePath ?? selected.path,
  } : null, [selected, currentThreadId, selectedThread?.worktreePath]);
  const dockRequested = showTools && !showSettings && !showBoard;
  const layout = workspaceLayout(bodySize.width, bodySize.height, {
    sidebar: sidebarSize.preferred, tools: toolsSize.preferred, terminal: null,
  }, dockRequested, { sidebarVisible: showSidebar, priority: regionPriority, maximized });
  const dockVisible = layout.toolsVisible;
  const [openedSurfaces, setOpenedSurfaces] = useState<Record<string, { files?: boolean }>>({});
  const [terminals, setTerminals] = useState<TerminalsByProject>({});
  const [visitedTools, setVisitedTools] = useState<Record<string, boolean>>({});
  if (dockRequested && activeTool && selected && !visitedTools[`${selected.id}:${activeTool}`]) {
    setVisitedTools({ ...visitedTools, [`${selected.id}:${activeTool}`]: true });
  }
  if (dockRequested && activeTool === "Files" && workbenchContext && !openedSurfaces[workbenchContext.key]?.files) {
    setOpenedSurfaces({ ...openedSurfaces, [workbenchContext.key]: { ...openedSurfaces[workbenchContext.key], files: true } });
  }
  if (workbenchContext && openedSurfaces[workbenchContext.key] && !workbenches.some((context) => context.key === workbenchContext.key)) {
    setWorkbenches([...workbenches, workbenchContext]);
  }
  const selectSurface = useCallback((name: string, explicit = true) => {
    setActiveTool(name); setShowTools(true); setShowSettings(false); setShowBoard(false); setRegionPriority("tools");
    // The first explicit visit opens the Project's first shell; later visits and Thread changes never spawn one.
    if (name === "Terminal" && explicit && workbenchContext) {
      setTerminals((previous) => (previous[workbenchContext.projectId]?.tabs.length ?? 0) > 0 ? previous : openTab(previous, workbenchContext.projectId, workbenchContext));
    }
  }, [workbenchContext]);
  // A Project's shells stay mounted while hidden; the selected Project shows the empty state once visited.
  const terminalSurfaces: TerminalsByProject = Object.fromEntries(
    Object.entries(terminals).filter(([, state]) => state.tabs.length > 0)
      .concat(selected && activeTool === "Terminal" ? [[String(selected.id), terminals[selected.id] ?? emptyTerminals]] : []),
  );
  const openTerminalTab = useCallback(() => {
    if (workbenchContext) setTerminals((previous) => openTab(previous, workbenchContext.projectId, workbenchContext));
  }, [workbenchContext]);
  const runInstallCommand = (command: string) => {
    setInstallCommand({ id: ++installSequence.current, command }); selectSurface("Terminal");
    // The command belongs in the selected Thread's checkout, never in a tab opened elsewhere.
    if (workbenchContext) setTerminals((previous) => focusCheckoutTab(previous, workbenchContext.projectId, workbenchContext));
  };
  const openCodeFile = (path: string, diff?: DiffFile, remote = false) => {
    if (!workbenchContext) return;
    setCodeRequest({ id: ++codeSequence.current, path, diff, remote, contextKey: workbenchContext.key });
    selectSurface("Files");
  };
  useEffect(() => {
    if (!selected || threads === null) return;
    if (legacySurface.current) { setActiveTool(legacySurface.current); setShowTools(true); legacySurface.current = null; }
    try { localStorage.removeItem("oxide:work-mode"); } catch { /* Presentation still migrates without storage. */ }
  }, [selected, threads]);
  const diffThread = {
    board: threads?.some((thread) => thread.id === currentThreadId && isBoardThread(thread)) ?? false,
  };
  const diffScope =
    chosenDiffScope && chosenDiffScope.threadId === currentThreadId
      ? chosenDiffScope.scope
      : defaultDiffScope(diffThread);
  // Read by the stable `openDiff`.
  const currentThreadRef = useRef(currentThreadId);
  const currentProjectRef = useRef(selectedId);
  useEffect(() => {
    currentThreadRef.current = currentThreadId;
    currentProjectRef.current = selectedId;
  });
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
  const onGitChanged = useCallback(() => {
    setGitRevision((n) => n + 1);
    // The user's own commit, push, pull or checkout: what Git views remember is now wrong.
    if (selectedId !== null) {
      invalidateQueries(`p${selectedId}:diff:`, { drop: true });
      invalidateQueries(`p${selectedId}:branches`);
      invalidateQueries(`p${selectedId}:prs:`);
    }
  }, [selectedId]);
  const threadStatuses = threads?.map((t) => `${t.id}:${t.status}`).join(",") ?? "";
  const threadsKey = `${threadStatuses}#${gitRevision}`;
  // An agent can open a pull request during a Turn, which no change the user makes reports,
  // so the Pull request tab reloads whenever a Thread changes status.
  const [turnRevision, setTurnRevision] = useState({ statuses: threadStatuses, count: 0 });
  if (turnRevision.statuses !== threadStatuses) {
    setTurnRevision({ statuses: threadStatuses, count: turnRevision.count + 1 });
  }

  // Stable: it reaches memoized TurnViews through context.
  const openDiff = useCallback((hint?: string) => {
    setShowTools(true);
    setRegionPriority("tools");
    setActiveTool("Diff");
    setChosenDiffScope({ threadId: currentThreadRef.current, scope: "uncommitted" });
    setDiffFocus(hint ?? null);
  }, []);

  // The pull request whose files the Diff Surface's PR scope shows.
  const [reviewedPr, setReviewedPr] = useState<{ projectId: number; number: number } | null>(null);
  const reviewPullRequestFiles = useCallback((projectId: number, number: number) => {
    setReviewedPr({ projectId, number });
    setShowTools(true);
    setRegionPriority("tools");
    setActiveTool("Diff");
    setChosenDiffScope({ threadId: currentThreadRef.current, scope: "pr" });
    setDiffFocus(null);
  }, []);

  const openPullRequest = useCallback(() => {
    setShowSettings(false);
    setShowTools(true);
    setRegionPriority("tools");
    setActiveTool("Pull request");
    setCreatePrRequest((n) => n + 1);
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
    const created = await createDefaultThread(projectId);
    return created.status === "ok" ? created.data : null;
  }, []);

  const fixPullRequest = async (projectId: number, prompt: string) => {
    const created = await createDefaultThread(projectId);
    if (created.status === "error") throw new Error(created.error.message);
    const thread = created.data;
    // Keep the request recoverable if sending fails, and open after sending so the
    // Transcript's initial snapshot includes the Turn even if its events arrived early.
    setDrafts((prev) => setDraft(prev, thread.id, prompt));
    try {
      const sent = await commands.sendPrompt(thread.id, [{ kind: "text", text: prompt }]);
      if (sent.status === "error") throw new Error(sent.error.message);
      setDrafts((prev) => setDraft(prev, thread.id, ""));
    } finally {
      if (currentProjectRef.current === projectId) {
        setThreads((prev) => [thread, ...(prev ?? [])]);
        setSelectedThreadId(thread.id);

        setMaximized(false);
        setShowBoard(false);
      }
    }
  };

  // Only one empty Thread (no Turn yet) at a time: asking for another reopens it.
  const startNewThread = useCallback(async () => {
    if (!selected) return;
    setMaximized(false);
    const counts = await Promise.all((threads ?? []).map((t) => commands.listTurns(t.id, 0, 1)));
    const empty = threads?.find((_, i) => {
      const r = counts[i];
      return r.status === "ok" && r.data.turnCount === 0;
    });
    if (empty) {
      setShowBoard(false);
      setSelectedThreadId(empty.id);

      return;
    }
    const created = await createThreadIn(selected.id);
    if (created) {
      setMaximized(false);
      setShowBoard(false);
      setThreads((prev) => [created, ...(prev || [])]);
      setSelectedThreadId(created.id);

    }
  }, [selected, threads, createThreadIn]);

  // The native menu follows the same creation path as the sidebar and shortcut.
  useEffect(() => {
    const unlisten = listen("new-thread", () => {
      setShowSettings(false);
      void startNewThread();
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [startNewThread]);

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

  const revealCheckout = useCallback(async () => {
    if (!selected) return;
    const res = await commands.revealInFinder(selected.id, currentThreadId);
    setOpenError(res.status === "error" ? res.error.message : null);
  }, [selected, currentThreadId]);

  const deleteThread = useCallback((threadId: number) => {
    const title = threadTitle(threads?.find((t) => t.id === threadId) ?? { id: threadId, title: null });
    const affected = describeAffectedTabs(allTabsOfThread(terminals, threadId));
    overlays.current?.openDelete(threadId, title, affected);
  }, [threads, terminals]);

  const onThreadDeleted = useCallback((deletedId: number) => {
    setWorkbenches((contexts) => contexts.filter((context) => context.threadId !== deletedId));
    setTerminals((previous) => removeThreadTabsEverywhere(previous, deletedId));
    setThreads((prev) => threadsAfterDelete(prev, deletedId));
    setSelectedThreadId((current) => selectionAfterDelete(current, deletedId));
  }, []);

  // An empty Thread (no Turn yet) closes at once; any other one asks first.
  const closeThread = useCallback(async (threadId: number) => {
    const turns = await commands.listTurns(threadId, 0, 1);
    const ownsShells = allTabsOfThread(terminals, threadId).length > 0;
    if (turns.status === "ok" && turns.data.turnCount === 0 && !ownsShells) {
      const result = await performThreadDelete(threadId, false, commands.deleteThread);
      if (result.status === "deleted") {
        onThreadDeleted(threadId);
        return;
      }
    }
    deleteThread(threadId);
  }, [deleteThread, onThreadDeleted, terminals]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = actionForKey(e, shortcuts);
      // The Model picker belongs to the open Thread, which handles it.
      if (!action || action === "modelPicker") return;
      if (action === "newThread") {
        if (selected) {
          e.preventDefault();
          void startNewThread();
        }
        return;
      }
      e.preventDefault();
      if (action === "closeThread") {
        if (currentThreadId !== null && !showSettings && !showBoard) void closeThread(currentThreadId);
      } else if (action === "openProject") {
        overlays.current?.openPalette();
      } else if (action === "previousThread" || action === "nextThread") {
        const next = adjacentThreadId(threads?.map((thread) => thread.id) ?? [], currentThreadId, action === "nextThread" ? 1 : -1);
        if (next === null || next === currentThreadId) return;
        setShowSettings(false);
        setShowBoard(false);
        setMaximized(false);
        setSelectedThreadId(next);

      } else if (action === "files" || action === "diff" || action === "pullRequests" || action === "issues" || action === "terminal") {
        const tool = { files: "Files", diff: "Diff", pullRequests: "Pull request", issues: "Issues", terminal: "Terminal" }[action];
        selectSurface(tool);
      } else if (action === "toggleTools") {
        setShowTools(showSettings || !showTools);
        setRegionPriority("tools");
        setShowBoard(false);
        setShowSettings(false);
      } else if (action === "toggleBoard") {
        setMaximized(false);
        setShowBoard((v) => !v);
        setShowSettings(false);
      } else {
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts, selected, startNewThread, closeThread, showBoard, showSettings, showTools, activeTool, currentThreadId, threads, selectSurface]);

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

      const res = await commands.listThreads(selected.id).catch((cause: unknown) => ({ status: "error" as const, error: { message: cause instanceof Error ? cause.message : String(cause) } }));
      if (active) setThreadLoadError(res.status === "error" ? { projectId: selected.id, message: res.error.message } : null);
      if (active && res.status === "ok" && pendingNewThread.current === selected.id) {
        const created = await createThreadIn(selected.id);
        // Cleared only once applied: a re-run mid-await must still start the Thread.
        if (!active) return;
        pendingNewThread.current = null;
        setThreads(created ? [created, ...res.data] : res.data);
        const initialThreadId = created?.id ?? res.data[0]?.id ?? null;
        setSelectedThreadId(initialThreadId);

      } else if (active && res.status === "ok") {
        setThreads(res.data);
        const wanted = restore.current;
        const initialThreadId = wanted?.projectId === selected.id
          ? (res.data.some((thread) => thread.id === wanted.threadId) ? wanted.threadId : null)
          : res.data[0]?.id ?? null;
        setSelectedThreadId(initialThreadId);

      }
    })();

    return () => {
      active = false;
    };
  }, [selected, createThreadIn, threadReload]);

  const starting = !projectsLoaded || !lastSelectionLoaded || (selected !== null && threads === null);

  useEffect(() => {
    document.documentElement.dataset.appReady = "true";
  }, []);

  return (
    <div className={`window ${isMac ? "macos" : "windows"}`}>
      {isWindows && <WindowResizeHandles />}
      <QuitDialog />
      <DictationController />
      <WorkspaceOverlays ref={overlays} projects={projects ?? []} onProjectsScanned={onProjectsScanned}
        onStartThread={startThreadIn} onOpenProject={openProject} onThreadDeleted={onThreadDeleted} />
      <header className="header" data-tauri-drag-region>
        {isWindows && <AppMenu onNewThread={() => { setShowSettings(false); void startNewThread(); }} />}
        <button className="icon-btn" aria-label="Toggle sidebar" title="Toggle sidebar" aria-pressed={layout.sidebarVisible}
          onClick={() => { setShowSidebar(!layout.sidebarVisible); setRegionPriority("sidebar"); setMaximized(false); }}><RepoIcon size={16} /></button>
        <button className="icon-btn" aria-label="Open a Project" title={`Open a Project (${keys("openProject")})`} onClick={() => overlays.current?.openPalette()}><PlusIcon size={16} /></button>
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
        {selected && !selected.missing && currentThreadId !== null && !showBoard && (
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
        {selected && !selected.missing && currentThreadId !== null && !showBoard && (
          <button className="icon-btn" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void revealCheckout()}>
            <FileDirectoryIcon size={16} />
          </button>
        )}
        <button
          className="icon-btn"
          aria-pressed={dockVisible}
          title={`Surfaces: Diff, Files, Terminal, Pull request, Issues (${keys("toggleTools")})`}
          aria-label="Toggle tools panel"
          onClick={() => { setShowTools(!dockVisible); setRegionPriority("tools"); setShowSettings(false); setShowBoard(false); }}
        >
          <ToolsIcon size={16} />
        </button>
        {isWindows && <WindowControls />}
        </div>
      </header>
      <div className="body" ref={bodyRef} style={{
        "--sidebar-width": `${layout.sidebar.value}px`,
        "--tools-width": `${layout.tools.value}px`,
      } as CSSProperties}>
        <div className="sidebar-region" id="workspace-sidebar" hidden={!layout.sidebarVisible}>
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
              setMaximized(false);
              setShowSettings(false);
              setShowBoard(false);
              setSelectedThreadId(threadId);

            }}
            onDeleteThread={(threadId) => void deleteThread(threadId)}
            onNewThread={() => {
              void startNewThread();
            }}
            onRenameThread={onThreadTitleChange}
            onOpenPalette={() => overlays.current?.openPalette()}
            onOpenBoard={(p) => {
              setMaximized(false);
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
        {maximized && dockVisible && <button className="thread-restore-handle" aria-label="Restore Thread" title="Restore Thread" onClick={() => setMaximized(false)}><ChevronRightIcon size={16} /></button>}
        <div className="centre-column" hidden={maximized && dockVisible}>
          {showSettings && <SettingsView onClose={() => setShowSettings(false)} />}
          <div className="chat-workbench" hidden={showSettings}>
          {threadLoadError && threadLoadError.projectId === selected?.id ? (
            <main className="centre empty-thread" aria-label="Project load error"><p className="error" role="alert">Could not load Threads for {selected?.name}: {threadLoadError.message}</p><button className="btn" onClick={() => { setThreadLoadError(null); setThreadReload((value) => value + 1); }}>Retry</button></main>
          ) : starting ? (
            <main className="centre thread-loading" aria-label="Loading Project"><Skeleton kind="conversation" label="Loading Threads…" /></main>
          ) : selected && showBoard ? (
            <BoardView
              key={selected.id}
              projectId={selected.id}
              onOpenThread={(id) => {
                setShowBoard(false);
                setSelectedThreadId(id);

              }}
              onDeleteThread={(id) => void deleteThread(id)}
              onDispatched={(thread) =>
                setThreads((prev) => [thread, ...(prev ?? []).filter((t) => t.id !== thread.id)])
              }
            />
          ) : selected && currentThreadId === null ? (
            <ProjectOverview project={selected} threads={threads ?? []}
              onNewThread={() => void startNewThread()}
              onOpenThread={(id) => { setSelectedThreadId(id); }}
              onOpenBoard={() => setShowBoard(true)} onOpenDiff={openDiff}
              onOpenPullRequest={() => { setShowTools(true); setActiveTool("Pull request"); }} />
          ) : selected ? (
            <main className="centre" aria-label="Thread">
              <DiffOpenContext.Provider value={openDiff}>
                <ThreadView
                  visible={!showSettings && !showBoard && !(maximized && dockVisible)}
                  onOpenDefaultDiff={() => {
                    setShowTools(true);
                    setActiveTool("Diff");
                    setChosenDiffScope(null);
                    setDiffFocus(null);
                  }}
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

                  }}
                  onThreadUpdated={onThreadUpdated}
                  onStatusChange={onThreadStatusChange}
                  onThreadTitleChange={onThreadTitleChange}
                  prefill={prefill}
                  onPrefillUsed={() => setPrefill(null)}
                  onOpenThread={(id) => {
                    setSelectedThreadId(id);

                  }}
                  onThreadContinued={(continued, from) => {
                    setThreads((prev) => [
                      continued.thread,
                      ...(prev?.map((t) => (t.id === from ? { ...t, continuedIn: continued.thread.id } : t)) ?? []),
                    ]);
                    setPrefill({ threadId: continued.thread.id, text: continued.recap });
                    setSelectedThreadId(continued.thread.id);

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
                  Open a Project <kbd>{keys("openProject")}</kbd>
                </button>
              </div>
            </main>
          )}
          </div>
        </div>
          <aside className="tools" aria-label="Tools panel" id="workspace-tools" hidden={!dockVisible}>
            {!maximized && <ResizeHandle label="Resize Tools" controls="workspace-tools" axis="x" edge="start" direction={-1}
              {...layout.tools} onResize={toolsSize.resize} onCommit={toolsSize.commit} onReset={toolsSize.reset} onCancel={toolsSize.cancel} />}
            <nav className="tabs" role="tablist" aria-label="Surfaces">
              {TOOL_TABS.map(({ name, Icon }) => (
                <button
                  key={name}
                  role="tab"
                  className="tab"
                  aria-label={name}
                  title={`${name} (${keys(TOOL_TAB_ACTION[name])})`}
                  aria-selected={activeTool === name}
                  onClick={() => selectSurface(name)}
                >
                  <Icon size={14} /> <span className="tool-tab-label">{name}</span>
                </button>
              ))}
              <span className="grow" />
              <button className="icon-btn sm" title={maximized ? "Restore Surface" : "Maximize Surface"} aria-label={maximized ? "Restore Surface" : "Maximize Surface"} onClick={() => setMaximized(!maximized)}><ProjectIcon size={14} /></button>
              <button className="icon-btn sm" title={`Close panel (${keys("toggleTools")})`} aria-label="Close tools panel" onClick={() => setShowTools(false)}>
                <XIcon size={14} />
              </button>
            </nav>
            {selected && visitedTools[`${selected.id}:Diff`] && (
              <div className="surface-content" hidden={activeTool !== "Diff"}><Suspense fallback={<Skeleton kind="diff" label="Loading changes…" />}>
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
                  onOpenFile={(file) => openCodeFile(file.path, file, diffScope === "pr")}
                />
              </Suspense></div>
            )}
            {selected && visitedTools[`${selected.id}:Pull request`] && (
              <div className="surface-content" hidden={activeTool !== "Pull request"}><Suspense fallback={<Skeleton kind="list" label="Loading pull requests…" />}>
                <PullRequestPanel
                  createRequest={createPrRequest}
                  onCreateHandled={() => setCreatePrRequest(0)}
                  projectId={selected.id}
                  refreshKey={gitRevision + turnRevision.count}
                  onChanged={onGitChanged}
                  onReviewFiles={(number) => reviewPullRequestFiles(selected.id, number)}
                  onFixPullRequest={(prompt) => fixPullRequest(selected.id, prompt)}
                />
              </Suspense></div>
            )}
            {workbenches.map((context) => <Fragment key={context.key}>
              {openedSurfaces[context.key]?.files && <Suspense fallback={dockVisible && activeTool === "Files" && context.key === workbenchContext?.key ? <Skeleton kind="code" label="Loading Files…" /> : null}><CodeWorkbench {...context} contextKey={context.key} visible={dockVisible && activeTool === "Files" && context.key === workbenchContext?.key} onChanged={onGitChanged} onRunCommand={runInstallCommand} onBackToDiff={() => selectSurface("Diff")} openRequest={codeRequest?.contextKey === context.key ? codeRequest : null} /></Suspense>}
            </Fragment>)}
            {Object.entries(terminalSurfaces).map(([id, state]) => {
              const projectId = Number(id); const isSelectedProject = projectId === selected?.id;
              return <Suspense key={id} fallback={isSelectedProject && dockVisible && activeTool === "Terminal" ? <Skeleton kind="code" label="Loading Terminal…" /> : null}>
                <TerminalSurface projectId={projectId} terminals={state} checkout={isSelectedProject ? workbenchContext : null}
                  visible={isSelectedProject && dockVisible && activeTool === "Terminal"}
                  queuedCommand={isSelectedProject ? installCommand : null} onCommandConsumed={() => setInstallCommand(null)}
                  onOpenTab={openTerminalTab}
                  onSelectTab={(tabId) => setTerminals((previous) => selectTab(previous, projectId, tabId))}
                  onCloseTab={(tabId) => setTerminals((previous) => closeTab(previous, projectId, tabId))}
                  onRunningChange={(tabId, command) => setTerminals((previous) => setRunning(previous, projectId, tabId, command))} />
              </Suspense>;
            })}
            {selected && currentThreadId === null && activeTool === "Files" && <section className="empty-state surface-empty"><p>Select a Thread to open files in its checkout.</p><button className="btn primary" onClick={() => void startNewThread()}>New Thread</button></section>}
            {!selected && <section className="empty-state surface-empty"><p>Open a Project to use its tools.</p><button className="btn primary" onClick={() => overlays.current?.openPalette()}>Open a Project</button></section>}
            {selected && visitedTools[`${selected.id}:Issues`] && (
              <div className="surface-content" hidden={activeTool !== "Issues"}><Suspense fallback={<Skeleton kind="list" label="Loading issues…" />}>
                <IssuesSurface
                  projectId={selected.id}
                  onDispatched={(thread) =>
                    setThreads((prev) => [thread, ...(prev ?? []).filter((t) => t.id !== thread.id)])
                  }
                />
              </Suspense></div>
            )}
          </aside>
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
  const shortcuts = useShortcuts();
  const keys = (action: ShortcutAction) => formatAccelerator(shortcuts[action]);
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
        <button className="btn grow" onClick={onNewThread} disabled={!selected} title={`New Thread in this Project (${keys("newThread")})`}>
          <PlusIcon size={14} /> New Thread <kbd>{keys("newThread")}</kbd>
        </button>
        <button className="btn" onClick={onOpenPalette} title={`Open a Project, or a new Thread in another one (${keys("openProject")})`} aria-label="Open a Project">
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
            <button className="btn primary sidebar-empty-action" onClick={onOpenPalette} title={`Open a Project (${keys("openProject")})`}>
              <RepoIcon size={14} /> Open a Project <kbd>{keys("openProject")}</kbd>
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
                  <button className="row-action" onClick={() => void close(p)} disabled={closingProjectId === p.id} aria-busy={closingProjectId === p.id} aria-label={`Close ${p.name}`} title={closingProjectId === p.id ? "Closing Project…" : `Close Project (it stays in ${keys("openProject")})`}>
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
      <button className="sidebar-footer" aria-current={settingsOpen ? "page" : undefined} onClick={onOpenSettings} title={`Settings (${keys("openSettings")})`}>
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
    Edit: ["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"].map((label) => ({ label, action: () => {
      const command = label === "Select All" ? "selectAll" : label.toLowerCase();
      if (window.dispatchEvent(new CustomEvent("oxide-editor-edit", { detail: command, cancelable: true }))) document.execCommand(command);
    } })),
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

type WorkspaceOverlaysHandle = { openPalette: () => void; openDelete: (id: number, title: string, shells: string[]) => void };

function WorkspaceOverlays({ ref, projects, onProjectsScanned, onStartThread, onOpenProject, onThreadDeleted }: {
  ref: Ref<WorkspaceOverlaysHandle>;
  projects: Project[];
  onProjectsScanned: (projects: Project[]) => void;
  onStartThread: (project: Project) => void;
  onOpenProject: (project: Project) => void;
  onThreadDeleted: (id: number) => void;
}) {
  const [showPalette, setShowPalette] = useState(false);
  const [pending, setPending] = useState<{ id: number; title: string; discardChanges: boolean; shells: string[] } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({
    openPalette: () => setShowPalette(true),
    openDelete: (id, title, shells) => { setError(null); setPending({ id, title, discardChanges: false, shells }); },
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
        {pending.shells.length > 0 && <>
          <p>Deleting also closes the terminals in its worktree:</p>
          <ul className="delete-shells">{pending.shells.map((shell, index) => <li key={index} className="mono">{shell}</li>)}</ul>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button onClick={() => setPending(null)} disabled={deleting}>Cancel</button>
          <button autoFocus className="danger" onClick={() => void confirmDelete()} disabled={deleting}>{deleting ? "Deleting…" : "Delete Thread"}</button>
        </div>
      </div>
    </div>}
    {showPalette && <ProjectPalette projects={projects} defaultParent="~/Developer" onClose={() => setShowPalette(false)}
      onStartThread={onStartThread} onOpenProject={onOpenProject} />}
  </>;
}
