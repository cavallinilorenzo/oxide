import { useMemo, useRef, useState } from "react";
import { DownloadIcon, UploadIcon } from "@primer/octicons-react";
import {
  DEFAULT_APPEARANCE,
  getAppearance,
  parseThemePack,
  saveAppearance,
  type Appearance,
} from "./appearance";
import { Dropdown } from "./Dropdown";

export function AppearanceSettings() {
  const [draft, setDraft] = useState(getAppearance);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const importer = useRef<HTMLInputElement>(null);
  const variants = useMemo(() => {
    try {
      return parseThemePack(draft.themeJson).themes;
    } catch {
      return [];
    }
  }, [draft.themeJson]);
  const edit = (patch: Partial<Appearance>) => {
    setDraft((value) => ({ ...value, ...patch }));
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
        <p>Choose a font for each workspace and define your own JSON themes.</p>
      </header>
      <div className="settings-card">
        <div className="settings-fields appearance-fonts">
          {(
            [
              ["ui", "Interface"],
              ["chat", "Chat"],
              ["code", "Code editor"],
              ["terminal", "Terminal"],
            ] as const
          ).map(([key, label]) => (
            <label className="settings-field" key={key}>
              {label} font
              <input
                aria-label={`${label} font`}
                value={draft.fonts[key]}
                list={`appearance-font-${key}`}
                onChange={(event) =>
                  edit({ fonts: { ...draft.fonts, [key]: event.target.value } })
                }
              />
              <datalist id={`appearance-font-${key}`}>
                {[
                  "Segoe UI",
                  "Inter",
                  "Arial",
                  "Cascadia Code",
                  "Consolas",
                  "JetBrains Mono",
                  "Fira Code",
                  "SFMono-Regular",
                  "Menlo",
                  "monospace",
                  "system-ui",
                ].map((font) => (
                  <option key={font} value={font} />
                ))}
              </datalist>
              <span
                className={`appearance-font-preview ${key}`}
                style={{ fontFamily: draft.fonts[key] }}
              >
                {key === "code" || key === "terminal"
                  ? "const answer = 42;  ~/project"
                  : "The quick brown fox — Oxide"}
              </span>
            </label>
          ))}
        </div>
        <p className="settings-note">
          Use fonts installed on your system. Comma-separated fallback families
          are supported. Choose a monospace family for Code and Terminal.
        </p>
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
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="appearance-actions">
          <button className="btn primary" onClick={() => apply()}>
            Apply appearance
          </button>
          <button
            className="btn"
            onClick={() => apply(structuredClone(DEFAULT_APPEARANCE))}
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
