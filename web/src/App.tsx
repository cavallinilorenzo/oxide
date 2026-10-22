import { useEffect, useState } from "react";
import { commands, type AppError, type Project } from "./bindings";

type Result<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };
import { SettingsView } from "./SettingsView";
import { toggleForKey } from "./shortcuts";

const TOOL_TABS = ["Terminal", "Files", "Diff", "Pull request", "Issues"];

export function App() {
  const [showTools, setShowTools] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [selected, setSelected] = useState<Project | null>(null);

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
        <Sidebar selected={selected} onSelect={setSelected} />
        <div className="centre-column">
          {showSettings ? (
            <SettingsView onClose={() => setShowSettings(false)} />
          ) : (
            <main className="centre" aria-label="Thread" />
          )}
          {showTerminal && <section className="terminal" aria-label="Terminal" />}
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

function Sidebar({ selected, onSelect }: { selected: Project | null; onSelect: (p: Project | null) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [showHidden, setShowHidden] = useState(false);

  const apply = (r: Result<Project[], AppError>) => {
    if (r.status === "ok") {
      setProjects(r.data);
      setError(null);
      // Keep the selection current, and drop it if the Project got hidden.
      onSelect(r.data.find((p) => p.id === selected?.id && !p.hidden) ?? null);
    } else setError(r.error.message);
  };

  const rescan = async () => {
    setScanning(true);
    apply(await commands.rescanProjects());
    setScanning(false);
  };

  // Show what's known right away, then scan on launch.
  useEffect(() => {
    void commands.listProjects().then((r) => r.status === "ok" && setProjects(r.data));
    void commands.rescanProjects().then((r) => {
      apply(r);
      setScanning(false);
    });
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
    </nav>
  );
}
