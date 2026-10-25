import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  type Detection,
  type Editor,
  type ModelInfo,
  type SettingsState,
  type Settings_Deserialize as Settings,
} from "./bindings";
import {
  getClaudeCodeHint,
  CLAUDE_30_DAY_RETENTION_WARNING,
} from "./providerHints";

import { Dropdown } from "./Dropdown";
import { ProviderMark } from "./ProviderMark";

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

/** Retain saved values when catalogs change or a Provider is offline. */
const withSavedValue = (options: { value: string; label: string }[], value: string | null | undefined) =>
  value && !options.some((option) => option.value === value)
    ? [...options, { value, label: value }]
    : options;

export function SettingsView({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [claudeDetection, setClaudeDetection] = useState<Detection | null>(null);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [catalogs, setCatalogs] = useState<Partial<Record<Provider, ModelInfo[]>>>({});

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
    let active = true;
    for (const provider of PROVIDERS) {
      commands.getModelCatalog(provider.id, false).then((result) => {
        if (active && result.status === "ok") {
          setCatalogs((previous) => ({ ...previous, [provider.id]: result.data }));
        }
      }).catch(() => { /* Offline Providers retain their saved defaults. */ });
    }
    const unlisten = listen<SettingsState>("settings-changed", (e) => apply(e.payload));
    return () => {
      active = false;
      void unlisten.then((f) => f());
    };
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

      <div className="settings-field">
        <span>Default Provider</span>
        <Dropdown label="Default Provider" value={draft.defaultProvider}
          options={PROVIDERS.map((p) => ({ value: p.id, label: p.label, icon: <ProviderMark provider={p.id} /> }))}
          onChange={(defaultProvider) => set({ defaultProvider })} />
        {fieldErrors("defaultProvider")}
      </div>

      {PROVIDERS.map((p) => {
        const models = catalogs[p.id] ?? [];
        const current = draft.providers[p.id];
        const model = models.find((m) => m.id === current.model);
        const efforts = model?.supportedEfforts ?? [...new Set(models.flatMap((m) => m.supportedEfforts))];
        const hint = p.id === "claude" ? getClaudeCodeHint(claudeDetection) : null;
        return (
          <fieldset key={p.id}>
            <legend>{p.label}</legend>
            {p.id === "claude" && hint && hint.type !== "ok" && (
              <div className={`provider-hint ${hint.type}`} role="alert">
                <span>{hint.message}</span>
                {hint.command && <code>{hint.command}</code>}
              </div>
            )}
            {p.id === "claude" && (
              <div className="provider-warning" role="note" aria-label="Retention warning">
                <strong>Session retention warning:</strong> {CLAUDE_30_DAY_RETENTION_WARNING}
              </div>
            )}
            <div className="settings-field">
              <span>Model</span>
              <Dropdown label={`${p.label} Model`} value={current.model ?? ""}
                options={withSavedValue([
                  { value: "", label: "Provider default" },
                  ...models.map((m) => ({ value: m.id, label: m.name })),
                ], current.model)}
                onChange={(value) => setProvider(p.id, { model: value || null })} />
              {fieldErrors(`providers.${p.id}.model`)}
            </div>
            <div className="settings-field">
              <span>Effort</span>
              <Dropdown label={`${p.label} Effort`} value={current.effort ?? ""}
                options={withSavedValue([
                  { value: "", label: "Provider default" },
                  ...efforts.map((effort) => ({ value: effort, label: effort })),
                ], current.effort)}
                onChange={(value) => setProvider(p.id, { effort: value || null })} />
              {fieldErrors(`providers.${p.id}.effort`)}
            </div>
            <div className="settings-field">
              <span>Permission mode</span>
              <Dropdown label={`${p.label} Permission mode`} value={current.permissionMode}
                options={MODES.map((m) => ({ value: m.id, label: m.label }))}
                onChange={(permissionMode) => setProvider(p.id, { permissionMode })} />
              {fieldErrors(`providers.${p.id}.permissionMode`)}
            </div>
          </fieldset>
        );
      })}

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

      <label className="inline">
        <input
          type="checkbox"
          checked={draft.claudeCustomizations}
          onChange={(e) => set({ claudeCustomizations: e.target.checked })}
        />
        Load Claude Code’s own CLAUDE.md, skills, plugins, hooks and MCP servers
        {fieldErrors("claudeCustomizations")}
      </label>
      <p className="hint">Off keeps a new Thread’s context window clean. Applies to Threads started after saving.</p>

      <div className="settings-field">
        <span>Editor for "Open in editor"</span>
        <Dropdown label="Editor for Open in editor" value={draft.editor}
          options={withSavedValue([
            { value: "", label: "First detected editor" },
            ...editors.map((editor) => ({ value: editor.bundleId, label: editor.name })),
          ], draft.editor)}
          onChange={(editor) => set({ editor })} />
        {fieldErrors("editor")}
      </div>

      {saveError && <p className="error">{saveError}</p>}
      <div className="actions">
        <button onClick={save}>Save</button>
        <button onClick={onClose}>Close</button>
      </div>
    </main>
  );
}
