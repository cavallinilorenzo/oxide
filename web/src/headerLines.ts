import type { ModelInfo } from "./bindings";
import { modelFamilyId } from "./modelPicker";

/** The home directory shortened to `~`. */
export const displayPath = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

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

function readableModel(model: string, catalog: ModelInfo[] | null): string {
  const exact = catalog?.find((m) => m.id === model);
  if (exact) return exact.name;
  const family = modelFamilyId(model);
  return catalog?.find((m) => modelFamilyId(m.id) === family)?.name ?? model;
}

export function threadHeaderLines(input: ThreadHeaderInput): ThreadHeaderLines {
  const name = input.model ? readableModel(input.model, input.catalog) : providerName(input.provider);
  const path = input.thread?.worktreePath ?? input.projectPath;
  return {
    modelLine: input.effort ? `${name} · ${input.effort}` : name,
    folder: {
      path,
      text: middleEllipsis(displayPath(path), FOLDER_MAX),
      branch: input.thread?.worktreePath ? (input.thread.branch ?? null) : null,
    },
  };
}
