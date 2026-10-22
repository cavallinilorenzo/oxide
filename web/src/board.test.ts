import { describe, expect, it } from "vitest";
import type { BoardCard, Thread } from "./bindings";
import { applyBoardEvent, groupBoard } from "./board";

const card = (id: number, over: Partial<Thread> = {}): BoardCard =>
  ({
    thread: { id, status: "completed", archived: false, title: `T${id}`, updatedAt: `2026-01-01T00:00:0${id}Z`, ...over },
    pendingApprovals: [],
  }) as BoardCard;

describe("groupBoard", () => {
  it("puts error and interrupted Threads in needs input with the others waiting on the user", () => {
    const cards = [
      card(1, { status: "needs-input" }),
      card(2, { status: "error" }),
      card(3, { status: "interrupted" }),
      card(4, { status: "working" }),
      card(5, { status: "completed" }),
    ];
    const g = groupBoard(cards, "");
    expect(g.needsInput.map((c) => c.thread.id).sort()).toEqual([1, 2, 3]);
    expect(g.working.map((c) => c.thread.id)).toEqual([4]);
    expect(g.completed.map((c) => c.thread.id)).toEqual([5]);
  });

  it("sorts each column by last activity, newest first", () => {
    const g = groupBoard([card(1), card(3), card(2)], "");
    expect(g.completed.map((c) => c.thread.id)).toEqual([3, 2, 1]);
  });

  it("leaves Archived Threads off and filters by title", () => {
    const g = groupBoard([card(1, { archived: true }), card(2, { title: "Fix login" }), card(3)], "LOGIN");
    expect(g.completed.map((c) => c.thread.id)).toEqual([2]);
  });
});

describe("applyBoardEvent", () => {
  it("replaces a changed card and adds a new one", () => {
    const start = [card(1), card(2)];
    const changed = applyBoardEvent(start, { type: "ThreadChanged", payload: card(1, { status: "working" }) });
    expect(changed.map((c) => c.thread.status)).toEqual(["working", "completed"]);
    const added = applyBoardEvent(changed, { type: "ThreadChanged", payload: card(3) });
    expect(added.map((c) => c.thread.id)).toEqual([1, 2, 3]);
  });
});
