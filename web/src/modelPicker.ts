import type { ModelInfo as BindingsModelInfo } from "./bindings";

export type ModelInfo = BindingsModelInfo;

export interface SlashCommandParseResult {

  type: "model" | "effort" | "rename" | "diff" | "permissions" | "reload-cache" | "other" | "none";

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

  if (command === "/reload-cache") {
    return { type: "reload-cache", command, arg: arg || undefined };
  }

  if (command === "/rename" || command === "/diff" || command === "/permissions") {
    return { type: command.slice(1) as "rename" | "diff" | "permissions", command, arg: arg || undefined };
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

/** Resolve capabilities within the current provider; unknown models must not inherit another model's levels. */
export function selectedModelInfo(models: ModelInfo[], modelId: string | null): ModelInfo | undefined {
  if (!modelId) return undefined;
  const family = modelFamilyId(modelId);
  return collapseEffortVariants(models.filter((model) => modelFamilyId(model.id) === family), null)[0];
}

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

/** Provider order used wherever catalogs are merged, so the Favourites list is stable. */
const PROVIDER_ORDER = ["claude", "codex", "antigravity"];

/** The models the Favourites tab shows, in its order: current ones first, then legacy ones. */
export function favouriteModelList(
  catalogs: Record<string, ModelInfo[]>,
  favourites: string[],
  effort: string | null
): ModelInfo[] {
  const providers = Object.keys(catalogs).sort((a, b) => {
    const rank = (p: string) => (PROVIDER_ORDER.includes(p) ? PROVIDER_ORDER.indexOf(p) : PROVIDER_ORDER.length);
    return rank(a) - rank(b);
  });
  const favouriteModels = providers
    .flatMap((p) => catalogs[p] ?? [])
    .filter((model) => favourites.some((id) => modelFamilyId(id) === modelFamilyId(model.id)));
  const { current, legacy } = filterModels(collapseEffortVariants(favouriteModels, effort), "");
  return [...current, ...legacy];
}

/** The Effort `model` ends up with: the wanted one if it supports it, else its default, else its first level. */
export function effortFor(model: ModelInfo, wanted: string | null): string | null {
  return model.supportedEfforts.includes(wanted || "")
    ? wanted
    : model.defaultEffort ?? (model.supportedEfforts[0] || null);
}

/** What choosing `model` means: its Provider, and the current Effort if it supports it, else its default. */
export function chooseModel(
  model: ModelInfo,
  catalogs: Record<string, ModelInfo[]>,
  currentEffort: string | null,
  fallbackProvider: string
): { provider: string; model: string; effort: string | null } {
  const provider =
    Object.entries(catalogs).find(([, list]) => list.some((m) => m.id === model.id))?.[0] ?? fallbackProvider;
  return { provider, model: model.id, effort: effortFor(model, currentEffort) };
}

/** Favourite number `index` (1-based) as a Provider, model and Effort, or null when there is no such Favourite. */
export function resolveFavourite(
  index: number,
  catalogs: Record<string, ModelInfo[]>,
  favourites: string[],
  currentEffort: string | null,
  fallbackProvider: string
): { provider: string; model: string; effort: string | null } | null {
  const model = applyModelShortcut(index, favouriteModelList(catalogs, favourites, currentEffort));
  return model ? chooseModel(model, catalogs, currentEffort, fallbackProvider) : null;
}

// ---- Model picker state: Provider tab, search, highlighted Model and pending Effort ----

export interface PickerContext {
  /** Provider ids in Tab-key order. */
  tabs: string[];
  catalogs: Record<string, ModelInfo[]>;
  currentProvider: string;
  currentModel: string | null;
  /** The Thread has Turns and its Provider can't switch Model mid-Thread. */
  locked: boolean;
  favourites?: string[];
  unavailable?: string[];
}

export interface PickerState {
  tab: string;
  /** Family id of the highlighted Model. */
  highlighted: string | null;
  effort: string | null;
}

export type PickerAction =
  | { type: "move"; delta: 1 | -1 }
  | { type: "step-effort"; delta: 1 | -1 }
  | { type: "cycle-tab"; delta: 1 | -1 }
  | { type: "set-tab"; tab: string }
  | { type: "hover"; family: string }
  | { type: "set-effort"; effort: string }
  /** Re-aim the highlight after the rows changed underneath it (catalogs or Favourites arriving). */
  | { type: "sync" };

export interface PickerRow {
  model: ModelInfo;
  provider: string;
  /** Can't be picked: same-Provider Model in a Thread whose Provider can't switch Model mid-Thread. */
  locked: boolean;
  isCurrent: boolean;
}

/** The rows of Provider `tab`, current Models first then legacy ones. `effort` picks the variant of effort-split Models. */
export function pickerRows(
  ctx: PickerContext,
  tab: string,
  effort: string | null
): { current: PickerRow[]; legacy: PickerRow[] } {
  if (tab === "favourites") {
    const providers = [...PROVIDER_ORDER, ...Object.keys(ctx.catalogs).filter((p) => !PROVIDER_ORDER.includes(p))];
    const rows = providers.flatMap((provider) => {
      const group = pickerRows(ctx, provider, effort);
      return [...group.current, ...group.legacy].filter((row) =>
        ctx.favourites?.some((id) => modelFamilyId(id) === modelFamilyId(row.model.id)));
    });
    return { current: rows.filter((r) => !r.model.isLegacy), legacy: rows.filter((r) => r.model.isLegacy) };
  }
  const models = collapseEffortVariants(ctx.catalogs[tab] ?? [], effort);
  const toRow = (model: ModelInfo): PickerRow => {
    const provider = tab;
    const isCurrent =
      provider === ctx.currentProvider &&
      ctx.currentModel !== null &&
      modelFamilyId(model.id) === modelFamilyId(ctx.currentModel);
    return { model, provider, isCurrent, locked: !!ctx.unavailable?.includes(provider) || (provider === ctx.currentProvider && ctx.locked && !isCurrent) };
  };
  const { current, legacy } = filterModels(models, "");
  return { current: current.map(toRow), legacy: legacy.map(toRow) };
}

function flatRows(ctx: PickerContext, state: PickerState): PickerRow[] {
  const { current, legacy } = pickerRows(ctx, state.tab, state.effort);
  return [...current, ...legacy];
}

function highlightedRow(ctx: PickerContext, state: PickerState): PickerRow | undefined {
  return flatRows(ctx, state).find((r) => !r.locked && modelFamilyId(r.model.id) === state.highlighted);
}

/** Highlight `family` (or nothing); the pending Effort stays when that Model supports it, else resets to its default. */
function highlight(ctx: PickerContext, state: PickerState, family: string | null): PickerState {
  if (family === null) return { ...state, highlighted: null };
  const row = flatRows(ctx, state).find((r) => modelFamilyId(r.model.id) === family);
  return { ...state, highlighted: family, effort: row ? effortFor(row.model, state.effort) : state.effort };
}

/** The Thread's current Model when the tab has it, else the first selectable row. */
function startingFamily(ctx: PickerContext, state: PickerState): string | null {
  const rows = flatRows(ctx, state).filter((r) => !r.locked);
  const row = rows.find((r) => r.isCurrent) ?? rows[0];
  return row ? modelFamilyId(row.model.id) : null;
}

/** A freshly opened picker: pending Effort is the Thread's, highlight starts on its Model. */
export function openPicker(ctx: PickerContext, tab: string, effort: string | null): PickerState {
  const state: PickerState = { tab, highlighted: null, effort };
  return highlight(ctx, state, startingFamily(ctx, state));
}

export function pickerReduce(state: PickerState, action: PickerAction, ctx: PickerContext): PickerState {
  switch (action.type) {
    case "move": {
      const rows = flatRows(ctx, state).filter((r) => !r.locked);
      if (rows.length === 0) return state;
      const at = rows.findIndex((r) => modelFamilyId(r.model.id) === state.highlighted);
      const next =
        at === -1 ? (action.delta === 1 ? 0 : rows.length - 1) : (at + action.delta + rows.length) % rows.length;
      return highlight(ctx, state, modelFamilyId(rows[next]!.model.id));
    }
    case "step-effort": {
      const efforts = highlightedRow(ctx, state)?.model.supportedEfforts ?? [];
      if (efforts.length === 0) return state;
      const at = efforts.indexOf(state.effort ?? "");
      const next = Math.min(efforts.length - 1, Math.max(0, (at === -1 ? 0 : at) + action.delta));
      return { ...state, effort: efforts[next]! };
    }
    case "set-effort": {
      const efforts = highlightedRow(ctx, state)?.model.supportedEfforts ?? [];
      return efforts.includes(action.effort) ? { ...state, effort: action.effort } : state;
    }
    case "cycle-tab": {
      const at = Math.max(0, ctx.tabs.indexOf(state.tab));
      const tab = ctx.tabs[(at + action.delta + ctx.tabs.length) % ctx.tabs.length]!;
      return pickerReduce(state, { type: "set-tab", tab }, ctx);
    }
    case "set-tab": {
      if (!ctx.tabs.includes(action.tab)) return state;
      const moved = { ...state, tab: action.tab };
      return highlight(ctx, moved, startingFamily(ctx, moved));
    }
    case "hover": {
      const row = flatRows(ctx, state).find((r) => modelFamilyId(r.model.id) === action.family);
      return !row || row.locked || state.highlighted === action.family ? state : highlight(ctx, state, action.family);
    }
    case "sync":
      if (!ctx.tabs.includes(state.tab)) return openPicker(ctx, ctx.tabs[0] ?? "favourites", state.effort);
      return highlightedRow(ctx, state) ? state : highlight(ctx, state, startingFamily(ctx, state));
  }
}

/** What Enter would apply: the highlighted Model (the variant matching the pending Effort) and that Effort. */
export function resolvePickerChoice(
  state: PickerState,
  ctx: PickerContext
): { provider: string; model: string; effort: string | null } | null {
  const row = highlightedRow(ctx, state);
  return row ? { provider: row.provider, model: row.model.id, effort: effortFor(row.model, state.effort) } : null;
}
