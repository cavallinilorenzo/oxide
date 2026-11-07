import { describe, expect, it } from "vitest";
import type { BoardCard } from "./bindings";
import { attentionGroups, attentionItem, attentionLabel, attentionTarget, summarizeAttention, type CardsByProject } from "./attention";

const card = (id: number, projectId: number, status: string, updatedAt = "2026-01-01T00:00:00Z", approvals = 0): BoardCard =>
  ({
    thread: { id, projectId, status, updatedAt, title: null },
    pendingApprovals: Array.from({ length: approvals }, (_, i) => ({ approvalId: `a${id}-${i}`, kind: "command", summary: "ls", options: [] })),
    pullRequest: null,
  }) as unknown as BoardCard;

describe("attention", () => {
  const cards: CardsByProject = {
    1: [card(1, 1, "working"), card(2, 1, "needs-input", "2026-01-02T00:00:00Z", 1), card(3, 1, "completed")],
    2: [card(4, 2, "error"), card(5, 2, "interrupted"), card(6, 2, "needs-input")],
  };

  it("counts every open Project's needs-input, error and interrupted Threads", () => {
    expect(summarizeAttention(cards)).toEqual({ approvals: 1, needsInput: 2, error: 1, interrupted: 1, total: 4 });
  });

  it("explains the breakdown", () => {
    expect(attentionLabel(summarizeAttention(cards))).toBe("4 Threads need you: 2 waiting for input (1 Approval), 1 error, 1 interrupted");
    expect(attentionLabel(summarizeAttention({}))).toBe("Nothing needs you");
  });

  it("goes to the earliest pending Approval, then the lowest Thread id", () => {
    const withTwo: CardsByProject = { ...cards, 2: [...cards[2], card(7, 2, "needs-input", "2026-01-01T00:00:00Z", 1)] };
    expect(attentionTarget(withTwo, [1, 2])).toMatchObject({ kind: "approval", projectId: 2, threadId: 7 });
    const tie: CardsByProject = { 1: [card(9, 1, "needs-input", "2026-01-01T00:00:00Z", 1)], 2: [card(8, 2, "needs-input", "2026-01-01T00:00:00Z", 1)] };
    expect(attentionTarget(tie, [1, 2])).toMatchObject({ threadId: 8 });
  });

  it("without an Approval prefers needs-input, then error/interrupted in Project order", () => {
    const none: CardsByProject = { 1: [card(4, 1, "error")], 2: [card(6, 2, "needs-input")] };
    expect(attentionTarget(none, [1, 2])).toMatchObject({ kind: "answer", threadId: 6 });
    expect(attentionTarget({ 1: [card(5, 1, "interrupted")], 2: [card(4, 2, "error")] }, [2, 1])).toMatchObject({ kind: "recovery", threadId: 4 });
    expect(attentionTarget({ 1: [card(1, 1, "working")] }, [1])).toBeNull();
  });

  it("describes one Thread waiting on the user, with the reason and the jump target", () => {
    expect(attentionItem(1, card(2, 1, "needs-input", "2026-01-02T00:00:00Z", 1))).toEqual({
      projectId: 1,
      threadId: 2,
      title: "Thread #2",
      branch: null,
      reason: { kind: "approval", summary: "ls", approvalId: "a2-0" },
      target: { kind: "approval", projectId: 1, threadId: 2, approvalId: "a2-0" },
    });
    expect(attentionItem(2, card(6, 2, "needs-input"))?.reason).toEqual({ kind: "needs-input" });
    expect(attentionItem(2, card(4, 2, "error"))?.reason).toEqual({ kind: "error" });
    expect(attentionItem(2, card(5, 2, "interrupted"))?.reason).toEqual({ kind: "interrupted" });
    expect(attentionItem(1, card(1, 1, "working"))).toBeNull();
    expect(attentionItem(1, card(3, 1, "completed"))).toBeNull();
  });

  it("keeps a Thread's branch and title for the tray", () => {
    const branched = {
      ...card(7, 1, "needs-input"),
      thread: { ...card(7, 1, "needs-input").thread, title: "Fix the bell", branch: "feat/attention" },
    } as BoardCard;
    expect(attentionItem(1, branched)).toMatchObject({ title: "Fix the bell", branch: "feat/attention" });
  });

  it("groups the waiting Threads by Project in sidebar order, omitting quiet Projects", () => {
    const quiet: CardsByProject = {
      1: [card(1, 1, "working")],
      2: [card(4, 2, "error"), card(6, 2, "needs-input")],
    };
    const groups = attentionGroups(quiet, [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }]);
    expect(groups.map(({ projectId, projectName }) => [projectId, projectName])).toEqual([[2, "Beta"]]);
    expect(groups[0].items.map(({ threadId, reason }) => [threadId, reason.kind])).toEqual([[4, "error"], [6, "needs-input"]]);
    expect(attentionGroups(cards, [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }]).map(({ projectName }) => projectName)).toEqual(["Alpha", "Beta"]);
  });
});
