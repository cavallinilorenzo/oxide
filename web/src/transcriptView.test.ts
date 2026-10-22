import { describe, expect, it } from "vitest";
import type { ItemSnapshot } from "./bindings";
import { groupTurnItems, splitHeadline, formatTime, modelEffortLabel } from "./transcriptView";

let nextId = 1;
function item(
  itemIndex: number,
  kind: ItemSnapshot["kind"],
  content = "",
  parentItemIndex: number | null = null,
): ItemSnapshot {
  return { id: nextId++, itemIndex, kind, content, parentItemIndex, createdAt: "2026-10-22T10:00:00Z" };
}

describe("groupTurnItems", () => {
  it("groups consecutive tool calls into one collapsible group", () => {
    const blocks = groupTurnItems([
      item(0, "tool_call", "Read a"),
      item(1, "tool_call", "Run b"),
      item(2, "agent_message", "done"),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["tools", "message"]);
    expect(blocks[0].type === "tools" && blocks[0].items).toHaveLength(2);
  });

  it("marks only the last top-level agent message as the final answer", () => {
    const blocks = groupTurnItems([
      item(0, "agent_message", "thinking out loud"),
      item(1, "tool_call", "Read a"),
      item(2, "agent_message", "final"),
    ]);
    const messages = blocks.filter((b) => b.type === "message");
    expect(messages.map((m) => m.type === "message" && m.final)).toEqual([false, true]);
  });

  it("nests children under their Subagent and keeps them out of the top level", () => {
    const blocks = groupTurnItems([
      item(0, "subagent", "Explore"),
      item(1, "tool_call", "Grep", 0),
      item(2, "agent_message", "found", 0),
      item(3, "agent_message", "final"),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["subagent", "message"]);
    const sub = blocks[0];
    expect(sub.type === "subagent" && sub.children.map((c) => c.type)).toEqual(["tools", "message"]);
    // A nested message never counts as the Turn's final answer.
    expect(blocks[1].type === "message" && blocks[1].final).toBe(true);
    expect(sub.type === "subagent" && sub.children[1].type === "message" && sub.children[1].final).toBe(false);
  });

  it("renders reasoning only when such an Item exists", () => {
    expect(groupTurnItems([item(0, "agent_message", "hi")]).some((b) => b.type === "reasoning")).toBe(false);
    expect(groupTurnItems([item(0, "reasoning", "hmm")])[0].type).toBe("reasoning");
  });

  it("keeps file changes as their own compact blocks", () => {
    const blocks = groupTurnItems([item(0, "tool_call", "x"), item(1, "file_change", "src/a.rs")]);
    expect(blocks.map((b) => b.type)).toEqual(["tools", "file"]);
  });

  it("treats an orphaned child (parent missing) as top level", () => {
    const blocks = groupTurnItems([item(5, "tool_call", "x", 99)]);
    expect(blocks.map((b) => b.type)).toEqual(["tools"]);
  });
});

describe("splitHeadline", () => {
  it("splits the first line from the detail", () => {
    expect(splitHeadline("Read a\nline1\nline2")).toEqual({ headline: "Read a", detail: "line1\nline2" });
    expect(splitHeadline("only")).toEqual({ headline: "only", detail: "" });
  });
});

describe("labels", () => {
  it("formats Model · Effort, omitting what is unknown", () => {
    expect(modelEffortLabel("Opus 5.5", "high")).toBe("Opus 5.5 · high");
    expect(modelEffortLabel("Opus 5.5", null)).toBe("Opus 5.5");
    expect(modelEffortLabel(null, null)).toBe("default model");
  });

  it("formats an ISO time as HH:MM", () => {
    expect(formatTime("2026-10-22T10:05:00Z")).toMatch(/\d{1,2}:05/);
  });
});

describe("empty reasoning", () => {
  it("renders nothing for a reasoning Item without text", () => {
    expect(groupTurnItems([item(0, "reasoning", "  ")])).toEqual([]);
  });
});
