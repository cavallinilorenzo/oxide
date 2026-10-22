const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  rs: "rust",
  py: "python",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  md: "markdown",
  html: "html",
  css: "css",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  diff: "diff",
  patch: "diff",
  go: "go",
};

const BY_FILENAME: Record<string, string> = {
  Dockerfile: "docker",
  Makefile: "makefile",
};

/** Highlighted HTML is ~10x its source; past this a file is shown as plain text. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

/** The highlighter language for a file path; unknown ones render as plain text. */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name in BY_FILENAME) return BY_FILENAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "text";
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "text";
}

export function shouldHighlight(content: string): boolean {
  return content.length <= MAX_HIGHLIGHT_CHARS;
}
