import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ProviderMark } from "./ProviderMark";
import {
  commands,
  type Detection,
  type Editor,
  type SettingsState,
  type Settings_Deserialize as Settings,
} from "./bindings";
import {
  getClaudeCodeHint,
  CLAUDE_30_DAY_RETENTION_WARNING,
} from "./providerHints";

type Provider = Settings["defaultProvider"];
type PermissionMode = Settings["providers"]["claude"]["permissionMode"];

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity CLI" },
];
const MODES: { id: PermissionMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "auto-edit", label: "Auto-edit" },
  { id: "full-access", label: "Full access" },
];

/** Empty input means "the Provider's own default". */
const orNull = (v: string) => (v.trim() === "" ? null : v);

export function SettingsView({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [claudeDetection, setClaudeDetection] = useState<Detection | null>(
    null,
  );
  const [editors, setEditors] = useState<Editor[]>([]);

  useEffect(() => {
    // A valid change on disk replaces the draft (the file is the source of
    // truth); an invalid one keeps the draft so unsaved edits aren't lost.
    const apply = (s: SettingsState) => {
      setState(s);
      setDraft((d) => (d && s.errors.length > 0 ? d : s.settings));
    };
    commands.getSettings().then(apply);
    commands.detectProvider("claude").then((res) => {
      if (res.status === "ok") {
        setClaudeDetection(res.data);
      }
    });
    commands.detectedEditors().then((res) => {
      if (res.status === "ok") setEditors(res.data);
    });
    const unlisten = listen<SettingsState>("settings-changed", (e) =>
      apply(e.payload),
    );
    return () => void unlisten.then((f) => f());
  }, []);

  if (!state || !draft)
    return <main className="settings" aria-label="Settings" />;

  const errorsFor = (path: string) =>
    state.errors.filter((e) => e.path === path);
  const fileErrors = state.errors;
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const setProvider = (
    p: Provider,
    patch: Partial<Settings["providers"][Provider]>,
  ) =>
    setDraft({
      ...draft,
      providers: {
        ...draft.providers,
        [p]: { ...draft.providers[p], ...patch },
      },
    });

  const save = async () => {
    const r = await commands.saveSettings(draft);
    setSaveError(r.status === "error" ? r.error.message : null);
  };

  const fieldErrors = (path: string) =>
    errorsFor(path).map((e) => (
      <p key={e.message} className="error" role="alert">
        {e.message}
      </p>
    ));

  return (
    <main className="settings" aria-label="Settings">
      <header className="settings-header">
        <h1>Settings</h1>
        <p>Manage your defaults, Providers and Projects.</p>
      </header>
      {fileErrors.length > 0 && (
        <section className="error-summary" role="alert">
          <p>
            <strong>settings.json has errors.</strong> Oxide is using the last
            valid settings.
          </p>
          <ul>
            {fileErrors.map((e) => (
              <li key={`${e.path}:${e.message}`}>
                {e.path ? <code>{e.path}</code> : "file"}: {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="settings-section" aria-labelledby="settings-general">
        <header className="settings-section-header">
          <h2 id="settings-general">General</h2>
          <p>Defaults for new Threads and the app.</p>
        </header>
        <div className="settings-card">
          <div className="settings-fields settings-general-fields">
            <label>
              Default Provider
              <select
                value={draft.defaultProvider}
                onChange={(e) =>
                  set({ defaultProvider: e.target.value as Provider })
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              {fieldErrors("defaultProvider")}
            </label>

            <label>
              Editor for “Open in editor”
              <select
                value={draft.editor}
                onChange={(e) => set({ editor: e.target.value })}
              >
                <option value="">First detected editor</option>
                {editors.map((editor) => (
                  <option key={editor.bundleId} value={editor.bundleId}>
                    {editor.name}
                  </option>
                ))}
              </select>
              {fieldErrors("editor")}
            </label>
          </div>
          <label className="inline">
            <input
              type="checkbox"
              checked={draft.confirmQuit}
              onChange={(e) => set({ confirmQuit: e.target.checked })}
            />
            Confirm before quitting
            {fieldErrors("confirmQuit")}
          </label>
        </div>
      </section>

      <section
        className="settings-section"
        aria-labelledby="settings-providers"
      >
        <header className="settings-section-header">
          <h2 id="settings-providers">Providers</h2>
          <p>Leave Model and Effort blank to use the Provider’s defaults.</p>
        </header>
        {PROVIDERS.map((p) => {
          const hint =
            p.id === "claude" ? getClaudeCodeHint(claudeDetection) : null;
          return (
            <section
              className="settings-card"
              key={p.id}
              aria-labelledby={`settings-provider-${p.id}`}
            >
              <h3
                className="settings-provider-title"
                id={`settings-provider-${p.id}`}
              >
                <span aria-hidden="true">
                  <ProviderMark provider={p.id} size={20} />
                </span>
                {p.label}
              </h3>
              {p.id === "claude" && hint && hint.type !== "ok" && (
                <div className={`provider-hint ${hint.type}`} role="alert">
                  <span>{hint.message}</span>
                  {hint.command && <code>{hint.command}</code>}
                </div>
              )}
              {p.id === "claude" && (
                <div
                  className="provider-warning"
                  role="note"
                  aria-label="Retention warning"
                >
                  <strong>Session retention warning:</strong>{" "}
                  {CLAUDE_30_DAY_RETENTION_WARNING}
                </div>
              )}
              <div className="settings-fields">
                <label>
                  Model
                  <input
                    value={draft.providers[p.id].model ?? ""}
                    placeholder="Provider default"
                    onChange={(e) =>
                      setProvider(p.id, { model: orNull(e.target.value) })
                    }
                  />
                  {fieldErrors(`providers.${p.id}.model`)}
                </label>
                <label>
                  Effort
                  <input
                    value={draft.providers[p.id].effort ?? ""}
                    placeholder="Provider default"
                    onChange={(e) =>
                      setProvider(p.id, { effort: orNull(e.target.value) })
                    }
                  />
                  {fieldErrors(`providers.${p.id}.effort`)}
                </label>
                <label>
                  Permission mode
                  <select
                    value={draft.providers[p.id].permissionMode}
                    onChange={(e) =>
                      setProvider(p.id, {
                        permissionMode: e.target.value as PermissionMode,
                      })
                    }
                  >
                    {MODES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {fieldErrors(`providers.${p.id}.permissionMode`)}
                </label>
              </div>
              {p.id === "claude" && (
                <div className="settings-customizations">
                  <label className="inline">
                    <input
                      type="checkbox"
                      aria-describedby="settings-customizations-hint"
                      checked={draft.claudeCustomizations}
                      onChange={(e) =>
                        set({ claudeCustomizations: e.target.checked })
                      }
                    />
                    Load Claude Code’s own CLAUDE.md, skills, plugins, hooks and
                    MCP servers
                    {fieldErrors("claudeCustomizations")}
                  </label>
                  <p className="hint" id="settings-customizations-hint">
                    Off keeps a new Thread’s context window clean. Applies to
                    Threads started after saving.
                  </p>
                </div>
              )}
            </section>
          );
        })}
      </section>

      <section className="settings-section" aria-labelledby="settings-projects">
        <header className="settings-section-header">
          <h2 id="settings-projects">Projects</h2>
          <p>Choose where Oxide looks for Git repositories.</p>
        </header>
        <div className="settings-card">
          <label>
            Scan roots (one per line)
            <textarea
              rows={3}
              value={draft.scanRoots.join("\n")}
              onChange={(e) =>
                set({
                  scanRoots: e.target.value
                    .split("\n")
                    .filter((l) => l.trim() !== ""),
                })
              }
            />
            {fieldErrors("scanRoots")}
          </label>
        </div>
      </section>

      {saveError && <p className="error">{saveError}</p>}
      <div className="actions">
        <button className="primary" onClick={save}>
          Save
        </button>
        <button onClick={onClose}>Close</button>
      </div>
    </main>
  );
}
