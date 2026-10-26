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
  const current: ModelInfo[] = [];
  const legacy: ModelInfo[] = [];
  for (const m of models) {
    if (
      q &&
      !m.id.toLowerCase().includes(q) &&
      !m.name.toLowerCase().includes(q) &&
      (!m.description || !m.description.toLowerCase().includes(q))
    ) {
      continue;
    }
    if (m.isLegacy) {
      legacy.push(m);
    } else {
      current.push(m);
    }
  }

  return { current, legacy };
}

/**
 * Antigravity lists each selectable effort as a separate catalog entry. Treat
 * those entries as one model in the picker; the effort selector still owns
 * which variant is sent to the provider.
 */
export function modelFamilyId(modelId: string): string {
  return modelId.replace(/-(low|medium|high)$/i, "");
}

export function collapseEffortVariants(
  models: ModelInfo[],
  effort: string | null
): ModelInfo[] {
  const families = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const family = modelFamilyId(model.id);
    const variants = families.get(family) ?? [];
    variants.push(model);
    families.set(family, variants);
  }

  return Array.from(families.values()).map((variants) => {
    if (variants.length === 1) {
      const onlyVariant = variants[0];
      return {
        ...onlyVariant,
        name:
          modelFamilyId(onlyVariant.id) === onlyVariant.id
            ? onlyVariant.name
            : onlyVariant.name.replace(/\s*\((low|medium|high)\)$/i, ""),
      };
    }

    const selected =
      variants.find((model) => model.id.toLowerCase().endsWith(`-${effort?.toLowerCase()}`)) ??
      variants.find((model) => model.id.toLowerCase().endsWith(`-${model.defaultEffort?.toLowerCase()}`)) ??
      variants[0]!;
    const supportedEfforts = Array.from(
      new Set(variants.flatMap((model) => model.supportedEfforts))
    );

    return {
      ...selected,
      name: selected.name.replace(/\s*\((low|medium|high)\)$/i, ""),
      supportedEfforts,
    };
  });
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

/**
 * The Model and Effort a Thread runs with when none was picked: the Provider's
 * first current Model and its default Effort, so the composer names them
 * instead of showing the Provider and "Default".
 */
export function resolveDefaultModel(
  catalog: ModelInfo[] | null,
  model: string | null,
  effort: string | null
): { model: string | null; effort: string | null } {
  if (!catalog || catalog.length === 0) return { model, effort };
  const collapsed = collapseEffortVariants(catalog, effort);
  const chosen = model
    ? collapsed.find((m) => modelFamilyId(m.id) === modelFamilyId(model))
    : (collapsed.find((m) => !m.isLegacy) ?? collapsed[0]);
  if (!chosen) return { model, effort };
  return {
    model: model ?? chosen.id,
    effort: effort ?? chosen.defaultEffort ?? chosen.supportedEfforts[0] ?? null,
  };
}
