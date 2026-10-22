import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type AppError, type Project, type Thread, type ThreadStatus } from "./bindings";
import { GitHeader } from "./GitHeader";
import { ThreadView } from "./ThreadView";
import { SettingsView } from "./SettingsView";
import { isNewThreadShortcut, toggleForKey } from "./shortcuts";
import { getDraft, setDraft } from "./threadDrafts";

const TerminalPanel = lazy(() => import("./TerminalPanel").then((module) => ({ default: module.TerminalPanel })));

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };
type TerminalContext = { key: string; projectId: number; threadId: number | null };
const terminalContextKey = (projectId: number, threadId: number | null) =>
  `${projectId}:${threadId ?? "draft"}`;

const FilesPanel = lazy(() => import("./FilesPanel").then((module) => ({ default: module.FilesPanel })));
const TOOL_TABS = ["Terminal", "Files", "Diff", "Pull request", "Issues"];

export function App() {
  const [showTools, setShowTools] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [activeTool, setActiveTool] = useState<string | null>("Files");
  const [showSettings, setShowSettings] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
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

  const startNewThread = useCallback(async () => {
    if (!selected) return;
    const settingsRes = await commands.getSettings();
    const provider = settingsRes.settings.defaultProvider || "claude";
    const provKey = provider as keyof typeof settingsRes.settings.providers;
    const provSettings = settingsRes.settings.providers[provKey];
    const created = await commands.createThread(
      selected.id,
      provider,
      provSettings?.model ?? null,
      provSettings?.effort ?? null,
      provSettings?.permissionMode ?? null
    );
    if (created.status === "ok") {
      setThreads((prev) => [created.data, ...(prev || [])]);
      setSelectedThreadId(created.data.id);
      rememberTerminalContext(selected.id, created.data.id);
    }
  }, [selected, rememberTerminalContext]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      if (active && res.status === "ok") {
        setThreads(res.data);
        const initialThreadId = res.data[0]?.id ?? null;
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
            threadsKey={threads?.map((t) => `${t.id}:${t.status}`).join(",") ?? ""}
            onOpenDiff={() => {
              setShowTools(true);
              setActiveTool("Diff");
            }}
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
            void startNewThread();
          }}
          onRenameThread={onThreadTitleChange}
        />
        <div className="centre-column">
          {showSettings ? (
            <SettingsView onClose={() => setShowSettings(false)} />
          ) : selected ? (
            <main className="centre" aria-label="Thread">
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
                onThreadTitleChange={onThreadTitleChange}
              />
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
  onNewThread,
  onRenameThread,
}: SidebarProps) {
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
                    aria-label={`Rename thread ${t.title || `Thread #${t.id}`}`}
                  />
                ) : (
                  <button
                    className="thread-item"
                    aria-current={t.id === selectedThreadId}
                    onClick={() => onSelectThread(t.id)}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      setEditingThreadId(t.id);
                      setRenameText(t.title || `Thread #${t.id}`);
                    }}
                    title={`${t.title || `Thread #${t.id}`} (${t.status})`}
                  >
                    <span
                      className={`status-dot ${t.status}`}
                      aria-label={`Status: ${t.status}`}
                      title={`Status: ${t.status}`}
                    />
                    <span className="thread-item-title">{t.title || `Thread #${t.id}`}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
