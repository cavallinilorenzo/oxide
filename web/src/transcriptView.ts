import type { ItemSnapshot } from "./bindings";
import { buildActivity, type Activity } from "./activity";

export type Block =
  | { type: "activity"; activity: Activity }
  | { type: "message"; item: ItemSnapshot; final: boolean }
  | { type: "command"; item: ItemSnapshot };

/**
 * Arranges a Turn's flat Items into what the Transcript draws: one Activity (everything the
 * Provider did, Subagent children nested) above the agent's messages and Slash command output.
 */
export function groupTurnItems(items: ItemSnapshot[]): Block[] {
  const known = new Set(items.map((i) => i.itemIndex));
  const childrenOf = new Map<number, ItemSnapshot[]>();
  const top: ItemSnapshot[] = [];
  for (const it of items) {
    const parent = it.parentItemIndex ?? null;
    if (parent !== null && known.has(parent)) {
      const list = childrenOf.get(parent);
      if (list) list.push(it);
      else childrenOf.set(parent, [it]);
    } else {
      top.push(it);
    }
  }

  const blocks: Block[] = [];
  const activity = buildActivity(top, childrenOf);
  if (activity) blocks.push({ type: "activity", activity });
  for (const it of top) {
    if (it.kind === "agent_message") blocks.push({ type: "message", item: it, final: false });
    else if (it.kind === "slash_command_output") blocks.push({ type: "command", item: it });
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "message") {
      b.final = true;
      break;
    }
  }
  return blocks;
}

/** By convention the first line of a tool call, file change or Subagent is its headline. */
export function splitHeadline(content: string): { headline: string; detail: string } {
  const nl = content.indexOf("\n");
  if (nl < 0) return { headline: content, detail: "" };
  return { headline: content.slice(0, nl), detail: content.slice(nl + 1) };
}

export function modelEffortLabel(model: string | null, effort: string | null): string {
  if (!model) return "default model";
  return effort ? `${model} · ${effort}` : model;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
