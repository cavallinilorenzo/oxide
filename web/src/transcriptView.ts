import type { ItemSnapshot } from "./bindings";

export type Block =
  | { type: "tools"; items: ItemSnapshot[] }
  | { type: "message"; item: ItemSnapshot; final: boolean }
  | { type: "reasoning"; item: ItemSnapshot }
  | { type: "file"; item: ItemSnapshot }
  | { type: "command"; item: ItemSnapshot }
  | { type: "subagent"; item: ItemSnapshot; children: Block[] };

/** Arranges a Turn's flat Items into what the Transcript draws, nesting Subagent children. */
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
  return toBlocks(top, childrenOf, true);
}

function toBlocks(
  items: ItemSnapshot[],
  childrenOf: Map<number, ItemSnapshot[]>,
  markFinal: boolean,
): Block[] {
  const blocks: Block[] = [];
  for (const it of items) {
    switch (it.kind) {
      case "tool_call": {
        const last = blocks[blocks.length - 1];
        if (last?.type === "tools") last.items.push(it);
        else blocks.push({ type: "tools", items: [it] });
        break;
      }
      case "agent_message":
        blocks.push({ type: "message", item: it, final: false });
        break;
      case "reasoning":
        if (!it.content.trim()) break; // no empty reasoning UI
        blocks.push({ type: "reasoning", item: it });
        break;
      case "file_change":
        blocks.push({ type: "file", item: it });
        break;
      case "slash_command_output":
        blocks.push({ type: "command", item: it });
        break;
      case "subagent":
        blocks.push({
          type: "subagent",
          item: it,
          children: toBlocks(childrenOf.get(it.itemIndex) ?? [], childrenOf, false),
        });
        break;
    }
  }
  if (markFinal) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type === "message") {
        b.final = true;
        break;
      }
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
