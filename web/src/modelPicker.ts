import type { ModelInfo as BindingsModelInfo } from "./bindings";

export type ModelInfo = BindingsModelInfo;

export interface SlashCommandParseResult {
  type: "model" | "effort" | "other" | "none";
  command: string;
  arg?: string;
}

/**
 * Parses user composer input for /model, /effort, or other slash commands.
 */
export function parseSlashCommand(input: string): SlashCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { type: "none", command: "" };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const arg = spaceIdx === -1 ? undefined : trimmed.slice(spaceIdx + 1).trim();

  if (command === "/model") {
    return { type: "model", command, arg: arg || undefined };
  }
  if (command === "/effort") {
    return { type: "effort", command, arg: arg || undefined };
  }

  return { type: "other", command, arg: arg || undefined };
}

/**
 * Filters a list of models according to search query and partitions into current vs legacy.
 */
export function filterModels(
  models: ModelInfo[],
  search: string
): { current: ModelInfo[]; legacy: ModelInfo[] } {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          (m.description && m.description.toLowerCase().includes(q))
      )
    : models;

  return {
    current: filtered.filter((m) => !m.isLegacy),
    legacy: filtered.filter((m) => m.isLegacy),
  };
}

/**
 * Maps a 1-based shortcut index (1-9) to the corresponding model from visible models.
 */
export function applyModelShortcut(
  index: number,
  visibleModels: ModelInfo[]
): ModelInfo | null {
  if (index < 1 || index > visibleModels.length) {
    return null;
  }
  return visibleModels[index - 1] ?? null;
}
