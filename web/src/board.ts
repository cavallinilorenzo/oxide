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

/** Adds or replaces a card, unless the one held is newer (events and the snapshot can arrive out of order). */
export function mergeCard(cards: BoardCard[], next: BoardCard): BoardCard[] {
  const held = cards.find((c) => c.thread.id === next.thread.id);
  if (!held) return [...cards, next];
  if (held.thread.updatedAt > next.thread.updatedAt) return cards;
  return cards.map((c) => (c === held ? next : c));
}

export function applyBoardEvent(cards: BoardCard[], event: BoardEvent): BoardCard[] {
  return mergeCard(cards, event.payload);
}
