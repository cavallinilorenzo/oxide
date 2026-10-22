import type { BoardCard, BoardEvent } from "./bindings";
import { threadTitle } from "./threadList";

export type BoardColumns = { needsInput: BoardCard[]; working: BoardCard[]; completed: BoardCard[] };

/** Cards grouped by Thread status, newest activity first. Error and interrupted wait on the user too. */
export function groupBoard(cards: BoardCard[], query: string): BoardColumns {
  const needle = query.trim().toLowerCase();
  const sorted = cards
    .filter((c) => !c.thread.archived && threadTitle(c.thread).toLowerCase().includes(needle))
    .sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt) || b.thread.id - a.thread.id);
  const columns: BoardColumns = { needsInput: [], working: [], completed: [] };
  for (const c of sorted) {
    if (c.thread.status === "working") columns.working.push(c);
    else if (c.thread.status === "completed") columns.completed.push(c);
    else columns.needsInput.push(c);
  }
  return columns;
}

export function applyBoardEvent(cards: BoardCard[], event: BoardEvent): BoardCard[] {
  const next = event.payload;
  return cards.some((c) => c.thread.id === next.thread.id)
    ? cards.map((c) => (c.thread.id === next.thread.id ? next : c))
    : [...cards, next];
}
