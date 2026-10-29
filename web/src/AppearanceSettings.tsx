import { useEffect, useId, useMemo, useRef, useState } from "react";
import { commands } from "./bindings";
import { CodeIcon, DownloadIcon, UploadIcon } from "@primer/octicons-react";
import {
  DEFAULT_APPEARANCE,
  getAppearance,
  parseThemePack,
  saveAppearance,
  type Appearance,
} from "./appearance";
import { Dropdown } from "./Dropdown";

export function AppearanceSettings({ onDraftChange }: { onDraftChange?: (value: Appearance) => void } = {}) {
  const [draft, setDraft] = useState(getAppearance);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [editingJson, setEditingJson] = useState(false);
  const jsonId = useId();
  const [fonts, setFonts] = useState<string[]>([]);
  const [fontError, setFontError] = useState<string | null>(null);
  const [fontRevision, setFontRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void commands.systemFonts().then((result) => {
      if (!active) return;
      if (result.status === "error") throw new Error(result.error.message);
      setFonts(result.data);
      setFontError(null);
    }).catch((error) => { if (active) setFontError(String(error)); });
    return () => { active = false; };
  }, [fontRevision]);
  const importer = useRef<HTMLInputElement>(null);
  const variants = useMemo(() => {
    try {
      return parseThemePack(draft.themeJson).themes;
    } catch {
      return [];
    }
  }, [draft.themeJson]);
  const edit = (patch: Partial<Appearance>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDraftChange?.(next);
    setSaved(false);
    setError(null);
  };
  const apply = (value = draft) => {
    try {
      saveAppearance(value);
      setDraft(value);
      setSaved(true);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section
      className="settings-section appearance-settings"
      aria-labelledby="settings-appearance"
    >
      <header className="settings-section-header">
        <h2 id="settings-appearance">Appearance</h2>
        <p>Make each area comfortable to read. Preview your choices before applying.</p>
      </header>
      <div className="settings-card">
        <h3>Typography</h3>
        <p className="settings-note">{fonts.length ? `${fonts.length} installed fonts available.` : fontError ? "Installed fonts are unavailable." : "Loading installed fonts…"} Monospace fonts work best for code and commands.</p>
        {fontError && <p className="error" role="alert">Could not read installed fonts. <button className="btn sm" onClick={() => setFontRevision((v) => v + 1)}>Retry</button></p>}
        <div className="appearance-fonts">
          {(
            [
              ["ui", "Interface"],
              ["chat", "Chat"],
              ["code", "Code editor"],
              ["terminal", "Terminal"],
            ] as const
          ).map(([key, label]) => {
            const style = draft.typography?.[key] ?? DEFAULT_APPEARANCE.typography![key];
            const setStyle = (patch: Partial<typeof style>) => edit({ typography: { ...DEFAULT_APPEARANCE.typography!, ...draft.typography, [key]: { ...style, ...patch } } });
            return <div className="appearance-font-row" key={key}>
              <strong>{label}</strong>
              <label className="settings-field">Font family
              <select
                aria-label={`${label} font`}
                value={draft.fonts[key]}
                onChange={(event) =>
                  edit({ fonts: { ...draft.fonts, [key]: event.target.value } })
                }
              >
                {!fonts.includes(draft.fonts[key]) && <option value={draft.fonts[key]}>{draft.fonts[key] === DEFAULT_APPEARANCE.fonts[key] ? "System default" : `Saved: ${draft.fonts[key]}`}</option>}
                {fonts.map((font) => <option key={font} value={font}>{font}</option>)}
              </select></label>
              <label className="settings-field">Weight
                <select aria-label={`${label} weight`} value={style.weight} onChange={(e) => setStyle({ weight: Number(e.target.value) })}>
                  {[[400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"]].map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                </select>
              </label>
              <label className="settings-field">Size
                <select aria-label={`${label} size`} value={style.size} onChange={(e) => setStyle({ size: Number(e.target.value) })}>
                  {Array.from({ length: 23 }, (_, i) => i + 10).map((size) => <option key={size} value={size}>{size} px</option>)}
                </select>
              </label>
              <span
                className={`appearance-font-preview ${key}`}
                style={{ fontFamily: draft.fonts[key], fontSize: style.size, fontWeight: style.weight }}
              >
                {key === "code" || key === "terminal"
                  ? "const answer = 42;  ~/project"
                  : "The quick brown fox — Oxide"}
              </span>
            </div>;
          })}
        </div>
        <h3>Theme</h3>
        <div className="appearance-theme-controls">
          <label className="settings-field">
            Theme
            <Dropdown
              label="Theme variant"
              value={draft.themeName}
              options={variants.map((theme) => ({
                value: theme.name,
                label: theme.name,
              }))}
              onChange={(themeName) => edit({ themeName })}
            />
          </label>
          <span className="grow" />
          <button className="btn sm" onClick={() => importer.current?.click()}>
            <UploadIcon size={14} /> Import JSON
          </button>
          <button
            className="btn sm"
            onClick={() => {
              try {
                parseThemePack(draft.themeJson);
                const blob = new Blob([draft.themeJson], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "oxide-theme.json";
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 0);
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          >
            <DownloadIcon size={14} /> Export JSON
          </button>
          <input
            ref={importer}
            hidden
            type="file"
            accept=".json,application/json"
            aria-label="Import theme JSON"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > 1024 * 1024) {
                setError("Theme JSON must be smaller than 1 MiB.");
                return;
              }
              void file
                .text()
                .then((themeJson) => {
                  const pack = parseThemePack(themeJson);
                  edit({ themeJson, themeName: pack.themes[0].name });
                })
                .catch((error) =>
                  setError(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
            }}
          />
        </div>
        <div className="appearance-advanced"><div className="appearance-advanced-header"><div><strong>Custom theme</strong><p className="settings-note">Edit the theme’s color and syntax tokens.</p></div><button type="button" className="btn appearance-json-toggle" aria-expanded={editingJson} aria-controls={jsonId} onClick={() => setEditingJson((value) => !value)}><CodeIcon size={16} />{editingJson ? "Close JSON editor" : "Edit JSON"}</button></div>
        <div id={jsonId} hidden={!editingJson}>
        <label className="appearance-json-label">
          Theme JSON
          <textarea
            className="appearance-json"
            aria-label="Theme JSON"
            spellCheck={false}
            rows={12}
            value={draft.themeJson}
            onChange={(event) => edit({ themeJson: event.target.value })}
          />
        </label>
        <p className="settings-note">
          Zed-style theme packs contain a name, a themes array, an appearance
          and style tokens. See <code>docs/themes.md</code> for the supported
          tokens and examples.
        </p>
        </div></div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="appearance-actions">
          {!onDraftChange && <button className="btn primary" onClick={() => apply()}>
            Apply appearance
          </button>}
          <button
            className="btn"
            onClick={() => onDraftChange ? edit(structuredClone(DEFAULT_APPEARANCE)) : apply(structuredClone(DEFAULT_APPEARANCE))}
          >
            Restore defaults
          </button>
          {saved && (
            <span className="dim" role="status">
              Appearance saved
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
