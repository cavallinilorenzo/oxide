import { useEffect, useState } from "react";
import { commands, type Project } from "./bindings";
import { SettingsView } from "./SettingsView";
import { toggleForKey } from "./shortcuts";

const TOOL_TABS = ["Terminal", "Files", "Diff", "Pull request", "Issues"];

export function App() {
  const [showTools, setShowTools] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

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
        <span className="title">Oxide</span>
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
        <Sidebar />
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

function Sidebar() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    commands.listProjects().then((r) => {
      if (r.status === "ok") setProjects(r.data);
      else setError(r.error.message);
    });
  }, []);

  return (
    <nav className="sidebar" aria-label="Projects">
      {error && <p className="error">{error}</p>}
      {projects?.length === 0 && <p className="empty">No projects yet</p>}
      <ul>
        {projects?.map((p) => (
          <li key={p.id}>{p.name}</li>
        ))}
      </ul>
    </nav>
  );
}
