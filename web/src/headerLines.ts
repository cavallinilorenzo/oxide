import type { ModelInfo } from "./bindings";
import { modelFamilyId } from "./modelPicker";

/** Remove Windows extended-length syntax only for presentation. */
export function readablePath(path: string): string {
  const slash = String.fromCharCode(92);
  const prefix = slash + slash + "?" + slash;
  if (path.startsWith(prefix + "UNC" + slash)) return slash + slash + path.slice(8);
  if (path.startsWith(prefix) && /^[A-Za-z]:/.test(path.slice(4))) return path.slice(4);
  return path;
}

/** The home directory shortened to `~`. */
export const displayPath = (path: string) => readablePath(path).replace(/^\/(Users|home)\/[^/]+/, "~");

/** Cuts a long path in the middle so the start and, above all, the folder name survive. */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor((max - 1) / 3);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
  antigravity: "Antigravity",
};

export const providerName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;

/** How many characters of the folder path the header shows before cutting its middle. */
const FOLDER_MAX = 52;

export interface ThreadHeaderInput {
  provider: string;
  model: string | null;
  effort: string | null;
  /** The Thread's own worktree and branch, for a Board Thread. */
  thread: { worktreePath?: string | null; branch?: string | null } | null;
  projectPath: string;
  catalog: ModelInfo[] | null;
}

export interface ThreadHeaderLines {
  /** "Opus 5.5 · high", or the Provider's name while no Model is picked. */
  modelLine: string;
  folder: {
    /** The full path, for the tooltip. */
    path: string;
    /** The shortened path shown in the header. */
    text: string;
    branch: string | null;
  };
}

/** A catalog name can spell out the Effort, "Gemini 3.8 Flash (High)"; the Effort has its own place. */
const EFFORT_SUFFIX = /\s*\((low|medium|high|xhigh|max)\)$/i;

export function readableModel(model: string, catalog: ModelInfo[] | null): string {
  const exact = catalog?.find((m) => m.id === model);
  const family = modelFamilyId(model);
  const name = exact?.name ?? catalog?.find((m) => modelFamilyId(m.id) === family)?.name ?? model;
  return name.replace(EFFORT_SUFFIX, "");
}

export function threadHeaderLines(input: ThreadHeaderInput): ThreadHeaderLines {
  const name = input.model ? readableModel(input.model, input.catalog) : providerName(input.provider);
  const path = input.thread?.worktreePath ?? input.projectPath;
  return {
    modelLine: input.effort ? `${name} · ${input.effort}` : name,
    folder: {
      path: readablePath(path),
      text: middleEllipsis(displayPath(path), FOLDER_MAX),
      branch: input.thread?.worktreePath ? (input.thread.branch ?? null) : null,
    },
  };
}
