import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ProviderMark } from "./ProviderMark";
import { Dropdown } from "./Dropdown";
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

type Provider = Settings["defaultProvider"];
type PermissionMode = Settings["providers"]["claude"]["permissionMode"];

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity CLI" },
];
const CUSTOMIZATIONS: { key: keyof Settings["claudeCustomizations"]; label: string }[] = [
  { key: "claudeMd", label: "CLAUDE.md and memory files" },
  { key: "skills", label: "Skills and slash commands" },
  { key: "plugins", label: "Plugins" },
  { key: "mcpServers", label: "MCP servers" },
  { key: "hooks", label: "Hooks" },
];

const MODES: { id: PermissionMode; label: string; description: string }[] = [
  { id: "ask", label: "Ask", description: "Asks before file edits and commands." },
  { id: "auto-edit", label: "Auto-edit", description: "Edits files in the Thread’s folder; asks before other actions." },
  { id: "full-access", label: "Full access", description: "Allows all actions without asking for approval." },
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
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const editVersion = useRef(0);
  const [claudeDetection, setClaudeDetection] = useState<Detection | null>(
    null,
  );
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

  if (!state || !draft)
    return <main className="settings" aria-label="Settings" />;

  const errorsFor = (path: string) =>
    state.errors.filter((e) => e.path === path);
  const fileErrors = state.errors;
  const set = (patch: Partial<Settings>) => {
    editVersion.current++;
    setSaveStatus((status) => status === "saving" ? status : "idle");
    setDraft({ ...draft, ...patch });
  };
  const setProvider = (
    p: Provider,
    patch: Partial<Settings["providers"][Provider]>,
  ) => {
    editVersion.current++;
    setSaveStatus((status) => status === "saving" ? status : "idle");
    setDraft({
      ...draft,
      providers: {
        ...draft.providers,
        [p]: { ...draft.providers[p], ...patch },
      },
    });
  };

  const save = async () => {
    const savingVersion = editVersion.current;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const r = await commands.saveSettings(draft);
      setSaveError(r.status === "error" ? r.error.message : null);
      setSaveStatus(r.status === "ok" && editVersion.current === savingVersion ? "saved" : "idle");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      setSaveStatus("idle");
    }
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
            <div className="settings-field">
              <span>Default Provider</span>
              <Dropdown label="Default Provider" value={draft.defaultProvider}
                options={PROVIDERS.map((p) => ({ value: p.id, label: p.label, icon: <ProviderMark provider={p.id} /> }))}
                onChange={(defaultProvider) => set({ defaultProvider })} />
              {fieldErrors("defaultProvider")}
            </div>

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
          <p>Choose Provider default for Model and Effort to use the Provider’s defaults.</p>
        </header>
        {PROVIDERS.map((p) => {
          const models = catalogs[p.id] ?? [];
          const current = draft.providers[p.id];
          const model = models.find((m) => m.id === current.model);
          const efforts = model?.supportedEfforts ?? [...new Set(models.flatMap((m) => m.supportedEfforts))];
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
                  <span>Default Permission mode</span>
                  <Dropdown label={`${p.label} Permission mode`} value={current.permissionMode}
                    options={MODES.filter((m) => p.id !== "antigravity" || m.id !== "ask").map((m) => ({
                      value: m.id,
                      label: p.id === "antigravity" && m.id === "auto-edit" ? "Auto-edit (soft-deny)" : m.label,
                      description: p.id === "antigravity" && m.id === "auto-edit"
                        ? "Edits files in the Thread’s folder; other actions are denied." : m.description,
                    }))}
                    onChange={(permissionMode) => setProvider(p.id, { permissionMode })} />
                  {fieldErrors(`providers.${p.id}.permissionMode`)}
                  <p className="hint">Applies to new Threads after saving.</p>
                </div>
              </div>
              {current.permissionMode === "full-access" && (
                <div className="provider-warning" role="alert" aria-label={`${p.label} Full access warning`}>
                  <strong>Full access:</strong> {p.label} can modify or delete files and run commands without asking for approval. Only use this with Projects you trust.
                </div>
              )}
              {p.id === "claude" && (
                <fieldset className="settings-customizations">
                  <legend>Claude Code customizations</legend>
                  {CUSTOMIZATIONS.map(({ key, label }) => (
                    <label className="inline" key={key}>
                      <input
                        type="checkbox"
                        aria-describedby="settings-customizations-hint"
                        checked={draft.claudeCustomizations[key]}
                        onChange={(e) =>
                          set({
                            claudeCustomizations: {
                              ...draft.claudeCustomizations,
                              [key]: e.target.checked,
                            },
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                  {fieldErrors("claudeCustomizations")}
                  <p className="hint" id="settings-customizations-hint">
                    Everything off keeps a new Thread’s context window clean.
                    Applies to Threads started after saving.
                  </p>
                </fieldset>
              )}
            </section>
          );
        })}
      </section>

      {saveError && <p className="error" role="alert">{saveError}</p>}
      <div className="actions">
        <button className="primary" onClick={save} disabled={saveStatus === "saving"}>
          {saveStatus === "saving" ? "Saving…" : "Save"}
        </button>
        <button onClick={onClose}>Close</button>
        <span className="settings-save-status" role="status">
          {saveStatus === "saved" ? "Settings saved." : ""}
        </span>
      </div>
    </main>
  );
}
