import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type SettingsState, type Settings_Deserialize as Settings } from "./bindings";

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

  useEffect(() => {
    // A valid change on disk replaces the draft (the file is the source of
    // truth); an invalid one keeps the draft so unsaved edits aren't lost.
    const apply = (s: SettingsState) => {
      setState(s);
      setDraft((d) => (d && s.errors.length > 0 ? d : s.settings));
    };
    commands.getSettings().then(apply);
    const unlisten = listen<SettingsState>("settings-changed", (e) => apply(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  if (!state || !draft) return <main className="settings" aria-label="Settings" />;

  const errorsFor = (path: string) => state.errors.filter((e) => e.path === path);
  const fileErrors = state.errors;
  const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const setProvider = (p: Provider, patch: Partial<Settings["providers"][Provider]>) =>
    setDraft({ ...draft, providers: { ...draft.providers, [p]: { ...draft.providers[p], ...patch } } });

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
      <h1>Settings</h1>
      {fileErrors.length > 0 && (
        <section className="error-summary" role="alert">
          <p>
            <strong>settings.json has errors.</strong> Oxide is using the last valid settings.
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

      <label>
        Default Provider
        <select value={draft.defaultProvider} onChange={(e) => set({ defaultProvider: e.target.value as Provider })}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {fieldErrors("defaultProvider")}
      </label>

      {PROVIDERS.map((p) => (
        <fieldset key={p.id}>
          <legend>{p.label}</legend>
          <label>
            Model
            <input
              value={draft.providers[p.id].model ?? ""}
              placeholder="Provider default"
              onChange={(e) => setProvider(p.id, { model: orNull(e.target.value) })}
            />
            {fieldErrors(`providers.${p.id}.model`)}
          </label>
          <label>
            Effort
            <input
              value={draft.providers[p.id].effort ?? ""}
              placeholder="Provider default"
              onChange={(e) => setProvider(p.id, { effort: orNull(e.target.value) })}
            />
            {fieldErrors(`providers.${p.id}.effort`)}
          </label>
          <label>
            Permission mode
            <select
              value={draft.providers[p.id].permissionMode}
              onChange={(e) => setProvider(p.id, { permissionMode: e.target.value as PermissionMode })}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {fieldErrors(`providers.${p.id}.permissionMode`)}
          </label>
        </fieldset>
      ))}

      <label>
        Scan roots (one per line)
        <textarea
          rows={3}
          value={draft.scanRoots.join("\n")}
          onChange={(e) => set({ scanRoots: e.target.value.split("\n").filter((l) => l.trim() !== "") })}
        />
        {fieldErrors("scanRoots")}
      </label>

      <label className="inline">
        <input type="checkbox" checked={draft.confirmQuit} onChange={(e) => set({ confirmQuit: e.target.checked })} />
        Confirm before quitting
        {fieldErrors("confirmQuit")}
      </label>

      <label>
        Editor for “Open in editor”
        <input value={draft.editor} onChange={(e) => set({ editor: e.target.value })} />
        {fieldErrors("editor")}
      </label>

      {saveError && <p className="error">{saveError}</p>}
      <div className="actions">
        <button onClick={save}>Save</button>
        <button onClick={onClose}>Close</button>
      </div>
    </main>
  );
}
