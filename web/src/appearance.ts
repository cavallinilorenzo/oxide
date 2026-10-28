export interface ThemeVariant {
  name: string;
  appearance: "dark" | "light";
  style: Record<string, unknown>;
}
export interface ThemePack {
  name: string;
  author?: string;
  themes: ThemeVariant[];
}
export interface Appearance {
  fonts: { ui: string; chat: string; code: string; terminal: string };
  themeJson: string;
  themeName: string;
}
const SYSTEM =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif';
const MONO = '"Cascadia Code", "SFMono-Regular", Consolas, Menlo, monospace';
export const DEFAULT_APPEARANCE: Appearance = {
  fonts: { ui: SYSTEM, chat: SYSTEM, code: MONO, terminal: MONO },
  themeJson: JSON.stringify(
    {
      name: "Oxide",
      themes: [{ name: "Oxide Dark", appearance: "dark", style: {} }],
    },
    null,
    2,
  ),
  themeName: "Oxide Dark",
};
const KEY = "oxide:appearance:v1";
export const COLOR_TOKENS: Record<string, string> = {
  background: "--bg",
  "surface.background": "--bg2",
  "elevated_surface.background": "--bg3",
  "element.background": "--bg4",
  text: "--fg",
  "text.bright": "--fg-bright",
  "text.muted": "--dim",
  "text.disabled": "--faint",
  "text.accent": "--acc2",
  border: "--line",
  "border.focused": "--line-strong",
  "element.border": "--gh-border",
  "element.hover": "--gh-btn-hover",
  "element.active": "--gh-btn-active",
  accent: "--acc",
  "accent.hover": "--acc-hover",
  "accent.foreground": "--acc-fg",
  error: "--red",
  success: "--green",
  warning: "--yellow",
  hint: "--purple",
};
const LIGHT: Record<string, string> = {
  background: "#ffffff",
  "surface.background": "#f5f7fa",
  "elevated_surface.background": "#e9edf3",
  "element.background": "#e0e6ee",
  text: "#202732",
  "text.bright": "#101720",
  "text.muted": "#4f5e70",
  "text.disabled": "#677587",
  border: "#d1d9e0",
  "border.focused": "#8c9bad",
  "element.border": "#c2cbd5",
  "element.hover": "#e2e8f0",
  "element.active": "#d4dde8",
  "text.accent": "#0969da",
  error: "#cf222e",
  success: "#116329",
  warning: "#7d4e00",
};
export function isColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
  );
}
export function parseThemePack(raw: string): ThemePack {
  if (raw.length > 1024 * 1024)
    throw new Error("Theme JSON must be smaller than 1 MiB.");
  const pack = JSON.parse(raw) as ThemePack;
  if (
    !pack ||
    typeof pack.name !== "string" ||
    !pack.name.trim() ||
    !Array.isArray(pack.themes) ||
    !pack.themes.length || pack.themes.length > 64
  )
    throw new Error("Provide a name and a nonempty themes array.");
  const names = new Set<string>();
  for (const theme of pack.themes) {
    if (
      !theme ||
      typeof theme.name !== "string" ||
      !theme.name.trim() ||
      names.has(theme.name)
    )
      throw new Error("Each theme needs a unique name.");
    names.add(theme.name);
    if (theme.appearance !== "dark" && theme.appearance !== "light")
      throw new Error(`${theme.name}: appearance must be dark or light.`);
    if (
      !theme.style ||
      typeof theme.style !== "object" ||
      Array.isArray(theme.style)
    )
      throw new Error(`${theme.name}: style must be an object.`);
    for (const [key, value] of Object.entries(theme.style)) {
      if (
        (key in COLOR_TOKENS ||
          key.startsWith("terminal.") ||
          key.startsWith("editor.")) &&
        value !== null &&
        !isColor(value)
      )
        throw new Error(
          `${theme.name}: ${key} must be a hex color (#RGB, #RGBA, #RRGGBB or #RRGGBBAA).`,
        );
      if (key === "syntax") {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("syntax must be an object.");
        for (const [token, rule] of Object.entries(value)) {
          if (
            !/^[\w.-]+$/.test(token) ||
            !rule ||
            typeof rule !== "object" ||
            Array.isArray(rule)
          )
            throw new Error(`Invalid syntax rule: ${token}.`);
          const r = rule as Record<string, unknown>;
          if (r.color !== undefined && r.color !== null && !isColor(r.color))
            throw new Error(`Invalid syntax color: ${token}.`);
          if (
            r.font_style !== undefined &&
            r.font_style !== null &&
            !["normal", "italic"].includes(String(r.font_style))
          )
            throw new Error(`Invalid font_style: ${token}.`);
          if (
            r.font_weight !== undefined &&
            r.font_weight !== null &&
            (typeof r.font_weight !== "number" ||
              r.font_weight < 100 ||
              r.font_weight > 900)
          )
            throw new Error(`Invalid font_weight: ${token}.`);
        }
      }
    }
  }
  return pack;
}
function load(): Appearance {
  try {
    const stored = JSON.parse(
      localStorage.getItem(KEY) ?? "null",
    ) as Appearance | null;
    if (!stored) return structuredClone(DEFAULT_APPEARANCE);
    validateAppearance(stored);
    return stored;
  } catch {
    return structuredClone(DEFAULT_APPEARANCE);
  }
}
function validateAppearance(value: Appearance) {
  if (
    !value.fonts ||
    Object.keys(DEFAULT_APPEARANCE.fonts).some(
      (key) =>
        typeof value.fonts[key as keyof Appearance["fonts"]] !== "string" ||
        !value.fonts[key as keyof Appearance["fonts"]].trim() ||
        value.fonts[key as keyof Appearance["fonts"]].length > 300,
    )
  )
    throw new Error(
      "Each font needs a family name or fallback list (up to 300 characters).",
    );
  if (
    !parseThemePack(value.themeJson).themes.some(
      (theme) => theme.name === value.themeName,
    )
  )
    throw new Error("Select a theme from this theme pack.");
}
let current = load();
let cachedTheme = parseThemePack(current.themeJson).themes.find(
  (theme) => theme.name === current.themeName,
)!;
export function getAppearance(): Appearance {
  return structuredClone(current);
}
export function activeTheme(): ThemeVariant {
  return cachedTheme;
}
export function themeColor(key: string, fallback: string): string {
  const color = activeTheme().style[key];
  return isColor(color) ? color : fallback;
}
export function applyAppearance(): void {
  const theme = activeTheme();
  const root = document.documentElement;
  for (const variable of Object.values(COLOR_TOKENS))
    root.style.removeProperty(variable);
  const colors = {
    ...(theme.appearance === "light" ? LIGHT : {}),
    ...Object.fromEntries(Object.entries(theme.style).filter(([,value])=>value!==null)),
  };
  for (const [key, variable] of Object.entries(COLOR_TOKENS)) {
    if (isColor(colors[key])) root.style.setProperty(variable, colors[key]);
  }
  root.style.removeProperty("--gh-btn");
  root.style.removeProperty("--gh-blue");
  if(theme.appearance==="light"||Object.keys(theme.style).length)root.style.setProperty("--gh-btn", "var(--bg3)");
  if(isColor(theme.style.accent))root.style.setProperty("--gh-blue", "var(--acc)");
  root.style.colorScheme = theme.appearance;
  root.dataset.appearance = theme.appearance;
  root.style.setProperty(
    "--terminal-background",
    themeColor("terminal.background", String(colors.background ?? "#0f1115")),
  );
  for (const [key, family] of Object.entries(current.fonts))
    root.style.setProperty(`--font-${key}`, family);
}
export function saveAppearance(value: Appearance) {
  validateAppearance(value);
  localStorage.setItem(KEY, JSON.stringify(value));
  current = structuredClone(value);
  cachedTheme = parseThemePack(current.themeJson).themes.find(
    (theme) => theme.name === current.themeName,
  )!;
  applyAppearance();
  window.dispatchEvent(new Event("oxide-appearance-changed"));
}
export function terminalAppearance() {
  const light = activeTheme().appearance === "light";
  return {
    fontFamily: current.fonts.terminal,
    theme: {
      background: themeColor(
        "terminal.background",
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim() || "#0f1115",
      ),
      foreground: themeColor(
        "terminal.foreground",
        light ? "#202732" : "#d7dbe4",
      ),
      cursor: themeColor("terminal.cursor", light ? "#0969da" : "#58a6ff"),
      selectionBackground: themeColor(
        "terminal.selection.background",
        light ? "#b6d7ff" : "#264f78",
      ),
      ...Object.fromEntries(
        [
          "black",
          "red",
          "green",
          "yellow",
          "blue",
          "magenta",
          "cyan",
          "white",
          "brightBlack",
          "brightRed",
          "brightGreen",
          "brightYellow",
          "brightBlue",
          "brightMagenta",
          "brightCyan",
          "brightWhite",
        ].map((key) => [
          key,
          themeColor(
            `terminal.ansi.${key.replace(/[A-Z]/g, letter=>`_${letter.toLowerCase()}`)}`,
            (
              {
                black: "#1b1f29",
                red: "#f06a6a",
                green: "#4cc38a",
                yellow: "#e6b450",
                blue: "#58a6ff",
                magenta: "#a98bff",
                cyan: "#56d4dd",
                white: "#d7dbe4",
                brightBlack: "#8994a9",
                brightRed: "#ff8b8b",
                brightGreen: "#7ee2ae",
                brightYellow: "#f7ce7a",
                brightBlue: "#90c8ff",
                brightMagenta: "#cbb5ff",
                brightCyan: "#8deaf1",
                brightWhite: "#ffffff",
              } as Record<string, string>
            )[key],
          ),
        ]),
      ),
    },
  };
}
