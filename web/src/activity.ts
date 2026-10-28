import type { ItemSnapshot } from "./bindings";

/** The macro kind of a run of Items; `pondering` only ever names the live status. */
export type PhaseKind = "reasoning" | "explore" | "edit" | "run" | "delegate" | "other";

/** One Item of an Activity; a Subagent's nested Items hang off `children`. */
export interface ActivityItem {
  item: ItemSnapshot;
  children: ItemSnapshot[];
}

/** A run of consecutive Items of the same macro kind. */
export interface Phase {
  kind: PhaseKind;
  items: ActivityItem[];
}

export interface SummaryChip {
  kind: Exclude<PhaseKind, "reasoning">;
  count: number;
  label: string;
}

/** The compressed record of what the Provider did in one Turn. */
export interface Activity {
  phases: Phase[];
  chips: SummaryChip[];
}

/** By convention the first line of a tool call, file change or Subagent is its headline. */
function headlineOf(content: string): string {
  const nl = content.indexOf("\n");
  return nl < 0 ? content : content.slice(0, nl);
}

/**
 * The Phase an Item belongs to, or null when it is not part of an Activity (agent messages and
 * Slash command output). Items stored before categories existed fall back on their kind.
 */
export function phaseKindOf(item: ItemSnapshot): PhaseKind | null {
  switch (item.kind) {
    case "reasoning":
      return item.content.trim() ? "reasoning" : null; // no empty reasoning UI
    case "file_change":
      return "edit";
    case "subagent":
      return "delegate";
    case "tool_call":
      return item.category ?? "other";
    default:
      return null;
  }
}

/** Builds the Activity of a Turn's top-level Items (Subagent children are nested, not top-level). */
export function buildActivity(
  topLevel: ItemSnapshot[],
  childrenOf: Map<number, ItemSnapshot[]>,
): Activity | null {
  const phases: Phase[] = [];
  for (const item of topLevel) {
    const kind = phaseKindOf(item);
    if (!kind) continue;
    const entry: ActivityItem = { item, children: childrenOf.get(item.itemIndex) ?? [] };
    const last = phases[phases.length - 1];
    if (last?.kind === kind) last.items.push(entry);
    else phases.push({ kind, items: [entry] });
  }
  if (phases.length === 0) return null;
  return { phases, chips: summarize(phases) };
}

const CHIP_ORDER: SummaryChip["kind"][] = ["explore", "edit", "run", "delegate", "other"];

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Macro actions with counts: files read and edited are counted by distinct target. */
function summarize(phases: Phase[]): SummaryChip[] {
  const distinct = (kind: PhaseKind) =>
    new Set(
      phases.filter((p) => p.kind === kind).flatMap((p) => p.items.map((i) => headlineOf(i.item.content))),
    ).size;
  const total = (kind: PhaseKind) =>
    phases.filter((p) => p.kind === kind).reduce((n, p) => n + p.items.length, 0);

  const counts: Record<SummaryChip["kind"], { n: number; text: (n: number) => string }> = {
    explore: { n: distinct("explore"), text: (n) => `Explored ${plural(n, "file", "files")}` },
    edit: { n: distinct("edit"), text: (n) => `Edited ${plural(n, "file", "files")}` },
    run: { n: total("run"), text: (n) => `Ran ${plural(n, "command", "commands")}` },
    delegate: { n: total("delegate"), text: (n) => `Delegated ${plural(n, "task", "tasks")}` },
    other: { n: total("other"), text: (n) => `Used ${plural(n, "tool", "tools")}` },
  };
  return CHIP_ORDER.filter((k) => counts[k].n > 0).map((kind) => ({
    kind,
    count: counts[kind].n,
    label: counts[kind].text(counts[kind].n),
  }));
}

export const PHASE_LABELS: Record<PhaseKind, string> = {
  reasoning: "Reasoning",
  explore: "Explored",
  edit: "Edited",
  run: "Ran",
  delegate: "Delegated",
  other: "Used tools",
};

/** The one-line recap of an Activity: "Explored 4 files · Edited 2 files". */
export function summaryText(activity: Activity): string {
  if (activity.chips.length === 0) return PHASE_LABELS.reasoning;
  return activity.chips.map((c) => c.label).join(" · ");
}

/** What the live line names: a macro action, or `pondering` before anything has happened. */
export type LiveCategory = PhaseKind | "pondering";

export interface LiveStatus {
  category: LiveCategory;
  /** The target of the latest step (a file or command), when it has one. */
  subline: string | null;
}

/** The status of a running Turn, from the latest step of its Activity. */
export function liveStatus(activity: Activity | null): LiveStatus {
  const lastPhase = activity?.phases[activity.phases.length - 1];
  const latest = lastPhase?.items[lastPhase.items.length - 1];
  if (!lastPhase || !latest || lastPhase.kind === "reasoning") {
    return { category: "pondering", subline: null };
  }
  return { category: lastPhase.kind, subline: headlineOf(latest.item.content) || null };
}

/** Abstract, truthful phrases per kind of work; static, no model call. */
export const STATUS_PHRASES: Record<LiveCategory, readonly string[]> = {
  pondering: ["Pondering", "Untangling the problem", "Weighing options"],
  reasoning: ["Pondering", "Untangling the problem", "Weighing options"],
  explore: ["Surveying the codebase", "Tracing the code", "Mapping the terrain"],
  edit: ["Forging changes", "Shaping the code", "Weaving edits"],
  run: ["Putting it to the test", "Firing up the terminal", "Running the gauntlet"],
  delegate: ["Calling in a specialist", "Briefing a subagent"],
  other: ["Working on it"],
};

/** The phrase for a kind of work; `rotation` advances it slowly within the same kind. */
export function statusPhrase(category: LiveCategory, rotation: number): string {
  const pool = STATUS_PHRASES[category];
  return pool[((rotation % pool.length) + pool.length) % pool.length];
}

/** "42s", "3m 05s": how long a Turn took. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
