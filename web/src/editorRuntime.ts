import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new HtmlWorker();
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};
monaco.editor.defineTheme("oxide", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0f1117",
    "editor.foreground": "#d7dbe4",
    "editor.lineHighlightBackground": "#151922",
    "editorLineNumber.foreground": "#687386",
    "editorLineNumber.activeForeground": "#c9d1d9",
    "editor.selectionBackground": "#264f78",
    "editorCursor.foreground": "#58a6ff",
    "editorIndentGuide.background1": "#252c39",
    "editorWidget.background": "#161b22",
    "editorWidget.border": "#30363d",
    "editorSuggestWidget.background": "#161b22",
    "editorSuggestWidget.selectedBackground": "#263247",
  },
});
export { monaco };

export function editorLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    (
      {
        py: "python",
        rs: "rust",
        c: "c",
        h: "c",
        cc: "cpp",
        cpp: "cpp",
        cxx: "cpp",
        hpp: "cpp",
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        json: "json",
        css: "css",
        scss: "scss",
        html: "html",
        md: "markdown",
        yaml: "yaml",
        yml: "yaml",
        toml: "ini",
        sh: "shell",
        ps1: "powershell",
        sql: "sql",
        go: "go",
        java: "java",
      } as Record<string, string>
    )[ext] ?? "plaintext"
  );
}
export function serverLanguage(language: string): string | null {
  if (["c", "cpp"].includes(language)) return "cpp";
  if (["javascript", "typescript"].includes(language)) return "typescript";
  return ["python", "rust"].includes(language) ? language : null;
}
