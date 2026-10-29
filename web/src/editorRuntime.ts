import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { editorAppearance } from "./editorAppearance";

monaco.languages.register({ id: "diff" });
monaco.languages.setMonarchTokensProvider("diff", { tokenizer: { root: [
  [/^@@.*$/, "diff.header"],
  [/^(---|\+\+\+).*$/, "diff.header"],
  [/^\+.*$/, "diff.added"],
  [/^-.*$/, "diff.removed"],
] } });

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
const applyEditorAppearance = () => {
  monaco.editor.defineTheme("oxide", editorAppearance());
  monaco.editor.setTheme("oxide");
};
applyEditorAppearance();
window.addEventListener("oxide-appearance-changed", applyEditorAppearance);
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
