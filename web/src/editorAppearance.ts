import { activeTheme, isColor, themeColor } from "./appearance";
import type { editor } from "monaco-editor";
export function editorAppearance(): editor.IStandaloneThemeData {
  const theme = activeTheme();
  const css = getComputedStyle(document.documentElement);
  const color = (token: string, variable: string, fallback: string) =>
    themeColor(token, css.getPropertyValue(variable).trim() || fallback);
  const syntax = theme.style.syntax as
    | Record<
        string,
        { color?: string; font_style?: string; font_weight?: number }
      >
    | undefined;
  const foreground = (value: string) => {
    const raw = value.slice(1);
    return (
      raw.length <= 4 ? [...raw].map((char) => char + char).join("") : raw
    ).slice(0, 6);
  };
  return {
    base: theme.appearance === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: Object.entries(syntax ?? {}).map(([token, rule]) => ({
      token,
      ...(isColor(rule.color) ? { foreground: foreground(rule.color) } : {}),
      fontStyle: [
        rule.font_style === "italic" ? "italic" : "",
        (rule.font_weight ?? 400) >= 600 ? "bold" : "",
      ]
        .filter(Boolean)
        .join(" "),
    })),
    colors: {
      "editor.background": color("editor.background", "--bg", "#0f1115"),
      "editor.foreground": color("editor.foreground", "--fg", "#d7dbe4"),
      "editorGutter.background": color(
        "editor.gutter.background",
        "--bg",
        "#0f1115",
      ),
      "editor.lineHighlightBackground": color(
        "editor.active_line.background",
        "--bg2",
        "#151820",
      ),
      "editorLineNumber.foreground": color(
        "editor.line_number",
        "--faint",
        "#8994a9",
      ),
      "editorLineNumber.activeForeground": color(
        "editor.active_line_number",
        "--fg",
        "#d7dbe4",
      ),
      "editor.selectionBackground": color(
        "editor.selection.background",
        "--bg4",
        "#264f78",
      ),
      "editorCursor.foreground": color("editor.cursor", "--acc2", "#58a6ff"),
      "editorIndentGuide.background1": color(
        "editor.indent_guide",
        "--line",
        "#2a3040",
      ),
      "editorWidget.background": color(
        "editor.widget.background",
        "--bg2",
        "#151820",
      ),
      "editorWidget.border": color("editor.widget.border", "--line", "#2a3040"),
      "editorSuggestWidget.background": color(
        "editor.widget.background",
        "--bg2",
        "#151820",
      ),
      "editorSuggestWidget.selectedBackground": color(
        "editor.selection.background",
        "--bg4",
        "#232836",
      ),
    },
  };
}
