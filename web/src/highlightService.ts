import {
  bundledLanguages,
  bundledLanguagesAlias,
  createHighlighter,
  createJavaScriptRegexEngine,
  type BundledLanguage,
} from "shiki";

/** Grammars compiled at startup, so the first code block doesn't wait on them. */
export const COMMON_LANGUAGES: BundledLanguage[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "rust",
  "python",
  "shellscript",
  "markdown",
  "html",
  "css",
  "toml",
  "yaml",
  "diff",
  "go",
];

const THEMES = { light: "github-light", dark: "github-dark" } as const;

export interface HighlightService {
  highlight: (code: string, lang: string) => Promise<string>;
}

/**
 * Shiki, meant to run inside the highlight worker. Grammars outside `warm`
 * load on first use; unknown languages render as plain text.
 */
export function createHighlightService(warm: BundledLanguage[] = COMMON_LANGUAGES): HighlightService {
  const highlighter = createHighlighter({
    themes: Object.values(THEMES),
    langs: warm,
    // The JS regex engine needs no WASM download and starts faster.
    engine: createJavaScriptRegexEngine(),
  });

  return {
    async highlight(code, lang) {
      const h = await highlighter;
      const name = lang.toLowerCase();
      const known = name in bundledLanguages || name in bundledLanguagesAlias;
      if (known && !h.getLoadedLanguages().includes(name)) {
        await h.loadLanguage(name as BundledLanguage);
      }
      return h.codeToHtml(code, {
        lang: known ? name : "text",
        themes: THEMES,
        // Light colours inline, dark ones as --shiki-dark (switched in CSS).
        defaultColor: "light",
      });
    },
  };
}
