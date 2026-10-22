import { lazy, Suspense, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type AppError, type Project, type Thread, type ThreadStatus } from "./bindings";
import { ThreadView } from "./ThreadView";
import { SettingsView } from "./SettingsView";
import { toggleForKey } from "./shortcuts";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };

const TOOL_TABS = ["Terminal", "Files", "Diff", "Pull request", "Issues"];

export function App() {
  const [showTools, setShowTools] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);

  // Derived, so it always reflects the latest list (missing badge) and
  // disappears when the Project is hidden.
  const selected = projects?.find((p) => p.id === selectedId && !p.hidden) ?? null;

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
        if (res.data.length > 0) {
          setSelectedThreadId(res.data[0].id);
        } else {
          setSelectedThreadId(null);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [selected]);

  return (
    <div className="window">
      <header className="header">
        {selected ? (
          <span className="title">
            <strong>{selected.name}</strong> <span className="path">{selected.path}</span>
            {selected.missing && <span className="badge">missing</span>}
          </span>
        ) : (
          <span className="title">Oxide</span>
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
          onSelect={(p) => setSelectedId(p.id)}
          threads={threads}
          selectedThreadId={selectedThreadId}
          onSelectThread={setSelectedThreadId}
          onNewThread={() => setSelectedThreadId(null)}
        />
        <div className="centre-column">
          {showSettings ? (
            <SettingsView onClose={() => setShowSettings(false)} />
          ) : selected ? (
            <main className="centre" aria-label="Thread">
              <ThreadView
                threadId={selectedThreadId}
                projectId={selected.id}
                onThreadCreated={(newThread) => {
                  setThreads((prev) => [newThread, ...(prev || [])]);
                  setSelectedThreadId(newThread.id);
                }}
                onStatusChange={(threadId, status) => {
                  setThreads((prev) =>
                    prev?.map((t) => (t.id === threadId ? { ...t, status } : t)) ?? null
                  );
                }}
              />
            </main>
          ) : (
            <main className="centre empty-thread" aria-label="Thread">
              <p>Pick a Project to begin.</p>
            </main>
          )}
          {selected && (
            <Suspense fallback={showTerminal ? <section className="terminal" aria-label="Terminal" /> : null}>
              <TerminalPanel
                projectId={selected.id}
                contextKey={`${selected.id}:${selectedThreadId ?? "draft"}`}
                visible={showTerminal}
              />
            </Suspense>
          )}
        </div>
        {showTools && (
          <aside className="tools" aria-label="Tools panel">
            <nav className="tool-tabs">
              {TOOL_TABS.map((t) => (
                <button key={t} title={t} aria-label={t}>
                  {t[0]}
                </button>
              ))}
            </nav>
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
