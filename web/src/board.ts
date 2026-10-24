import type { BoardCard, BoardEvent, BranchPullRequest } from "./bindings";
import { threadTitle } from "./threadList";

export type BoardColumns = { needsInput: BoardCard[]; working: BoardCard[]; completed: BoardCard[] };

/** Cards grouped by Thread status, newest activity first. Error and interrupted wait on the user too. */
export function groupBoard(cards: BoardCard[], query: string): BoardColumns {
  const needle = query.trim().toLowerCase();
  const sorted = cards
    .filter((c) => !needle || threadTitle(c.thread).toLowerCase().includes(needle))
    .sort((a, b) => {
      if (b.thread.updatedAt > a.thread.updatedAt) return 1;
      if (b.thread.updatedAt < a.thread.updatedAt) return -1;
      return b.thread.id - a.thread.id;
    });
  const columns: BoardColumns = { needsInput: [], working: [], completed: [] };
  for (const c of sorted) {
    if (c.thread.status === "working") columns.working.push(c);
    else if (c.thread.status === "completed") columns.completed.push(c);
    else columns.needsInput.push(c);
  }
  return columns;
}

/** Adds or replaces a card, unless the one held is newer (events and the snapshot can arrive out of order). */
export function mergeCard(cards: BoardCard[], next: BoardCard): BoardCard[] {
  const held = cards.find((c) => c.thread.id === next.thread.id);
  if (!held) return [...cards, next];
  if (held.thread.updatedAt > next.thread.updatedAt) return cards;
  return cards.map((c) => (c === held ? next : c));
}

export function applyBoardEvent(cards: BoardCard[], event: BoardEvent): BoardCard[] {
  if (event.type === "ThreadDeleted") return cards.filter((c) => c.thread.id !== event.payload);
  return mergeCard(cards, event.payload);
}

const PHASE_LABEL = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" } as const;

/** What a card says about its pull request, e.g. "PR #9 · Open · 2 passed, 1 failed"; `null` without one. */
export function pullRequestSummary(pr: BranchPullRequest | null | undefined): string | null {
  if (!pr) return null;
  const checks = [
    pr.checksPassed && `${pr.checksPassed} passed`,
    pr.checksFailed && `${pr.checksFailed} failed`,
    pr.checksPending && `${pr.checksPending} pending`,
  ].filter(Boolean);
  return [`PR #${pr.number}`, PHASE_LABEL[pr.phase], ...(checks.length ? [checks.join(", ")] : [])].join(" · ");
}

/** A merged pull request means the work landed: the card offers to delete the Thread. */
export function suggestsDelete(card: BoardCard): boolean {
  return card.pullRequest?.phase === "merged";
}
