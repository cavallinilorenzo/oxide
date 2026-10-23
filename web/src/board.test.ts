import { describe, expect, it } from "vitest";
import type { BoardCard, BranchPullRequest, Thread } from "./bindings";
import { applyBoardEvent, groupBoard, pullRequestSummary, suggestsArchive } from "./board";

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

const withPr = (over: Partial<BranchPullRequest> = {}): BoardCard =>
  ({
    ...card(1),
    pullRequest: { number: 9, url: "u", phase: "open", checksPassed: 0, checksFailed: 0, checksPending: 0, ...over },
  }) as BoardCard;

describe("pullRequestSummary", () => {
  it("says nothing for a card without a pull request", () => {
    expect(pullRequestSummary(null)).toBeNull();
    expect(pullRequestSummary(undefined)).toBeNull();
  });

  it("names the number, state and a tally of the checks that ran", () => {
    expect(pullRequestSummary(withPr().pullRequest)).toBe("PR #9 · Open");
    expect(
      pullRequestSummary(withPr({ phase: "draft", checksPassed: 2, checksFailed: 1, checksPending: 1 }).pullRequest),
    ).toBe("PR #9 · Draft · 2 passed, 1 failed, 1 pending");
  });
});

describe("suggestsArchive", () => {
  it("suggests archiving once the pull request is merged, and not before", () => {
    expect(suggestsArchive(withPr({ phase: "merged" }))).toBe(true);
    expect(suggestsArchive(withPr({ phase: "open" }))).toBe(false);
    expect(suggestsArchive(card(1))).toBe(false);
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

  it("ignores a card older than the one held", () => {
    const start = [card(1, { status: "working", updatedAt: "2026-01-02T00:00:00Z" })];
    const next = applyBoardEvent(start, { type: "ThreadChanged", payload: card(1, { updatedAt: "2026-01-01T00:00:00Z" }) });
    expect(next[0].thread.status).toBe("working");
  });
});
