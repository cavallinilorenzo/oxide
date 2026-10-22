import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type AppError, type DiffScope, type Project, type Thread, type ThreadStatus } from "./bindings";
import { DiffOpenContext } from "./diffOpen";
import { GitHeader } from "./GitHeader";
import { QuitDialog } from "./QuitDialog";
import { ThreadView } from "./ThreadView";
import { SettingsView } from "./SettingsView";
import { toggleForKey } from "./shortcuts";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };
type TerminalContext = { key: string; projectId: number; threadId: number | null };
const terminalContextKey = (projectId: number, threadId: number | null) =>
  `${projectId}:${threadId ?? "draft"}`;

const DiffPanel = lazy(() => import("./DiffPanel").then((module) => ({ default: module.DiffPanel })));
const FilesPanel = lazy(() => import("./FilesPanel").then((module) => ({ default: module.FilesPanel })));
const TOOL_TABS = ["Terminal", "Files", "Diff", "Pull request", "Issues"];

export function App() {
  const [showTools, setShowTools] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [activeTool, setActiveTool] = useState<string | null>("Files");
  const [diffScope, setDiffScope] = useState<DiffScope>("uncommitted");
  const [diffFocus, setDiffFocus] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
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
    setDiffScope("uncommitted");
    setDiffFocus(hint ?? null);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const toggle = toggleForKey(e);
      if (!toggle) return;
      e.preventDefault();
      if (toggle === "tools") setShowTools((v) => !v);
      else if (toggle === "terminal") setShowTerminal((v) => !v);
      else setShowSettings(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      if (active && res.status === "ok") {
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
  }, [selected, rememberTerminalContext]);

  return (
    <div className="window">
      <QuitDialog />
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
            onChanged={onGitChanged}
          />
        )}
        <div className="toggles">
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
            setSelectedThreadId(threadId);
            if (selected) rememberTerminalContext(selected.id, threadId);
          }}
          onNewThread={() => {
            setSelectedThreadId(null);
            if (selected) rememberTerminalContext(selected.id, null);
          }}
        />
        <div className="centre-column">
          {showSettings ? (
            <SettingsView onClose={() => setShowSettings(false)} />
          ) : selected ? (
            <main className="centre" aria-label="Thread">
              <DiffOpenContext.Provider value={openDiff}>
                <ThreadView
                  threadId={selectedThreadId}
                  projectId={selected.id}
                  onThreadCreated={(newThread) => {
                    setThreads((prev) => [newThread, ...(prev || [])]);
                    setSelectedThreadId(newThread.id);
                    rememberTerminalContext(selected.id, newThread.id);
                  }}
                  onStatusChange={onThreadStatusChange}
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
                  scope={diffScope}
                  onScopeChange={(scope) => {
                    setDiffScope(scope);
                    setDiffFocus(null);
                  }}
                  focus={diffFocus}
                  refreshKey={threadsKey}
                  onChanged={onGitChanged}
                />
              </Suspense>
            )}
            {activeTool === "Files" && selected && (
              <Suspense fallback={null}>
                <FilesPanel projectId={selected.id} threadId={currentThreadId} />
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
  onNewThread: () => void;
}

function Sidebar({
  projects,
  onProjects,
  selected,
  onSelect,
  threads,
  selectedThreadId,
  onSelectThread,
  onNewThread,
}: SidebarProps) {
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [showHidden, setShowHidden] = useState(false);

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
          {threads && threads.length === 0 && (
            <p className="empty" style={{ padding: "4px 6px", margin: 0 }}>
              No threads yet
            </p>
          )}
          <ul aria-label="Thread list">
            {threads?.map((t) => (
              <li key={t.id}>
                <button
                  className="thread-item"
                  aria-current={t.id === selectedThreadId}
                  onClick={() => onSelectThread(t.id)}
                  title={`Thread #${t.id} (${t.status})`}
                >
                  <span
                    className={`status-dot ${t.status}`}
                    aria-label={`Status: ${t.status}`}
                    title={`Status: ${t.status}`}
                  />
                  <span>Thread #{t.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
