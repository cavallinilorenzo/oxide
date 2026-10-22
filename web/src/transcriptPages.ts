import type { TurnSnapshot } from "./bindings";
import type { TranscriptState } from "./transcript";

/** Turns per page of older Turns. Page `n` holds positions `n * PAGE_SIZE` onward. */
export const PAGE_SIZE = 50;

/** Loaded pages of Turns older than the live tail, by page number. */
export type TranscriptPages = ReadonlyMap<number, TurnSnapshot[]>;

/**
 * The pages covering positions `first..=last` that still need loading. Only
 * Turns before `turnOffset` are paged; the live tail is always present.
 */
export function pagesToLoad(
  first: number,
  last: number,
  turnOffset: number,
  isLoadedOrLoading: (page: number) => boolean
): number[] {
  const end = Math.min(last, turnOffset - 1);
  const pages: number[] = [];
  for (let page = Math.floor(first / PAGE_SIZE); page * PAGE_SIZE <= end; page++) {
    if (!isLoadedOrLoading(page)) pages.push(page);
  }
  return pages;
}

/** The `list_turns` arguments for `page`, stopping where the live tail begins. */
export function pageRequest(page: number, turnOffset: number): { offset: number; limit: number } {
  const offset = page * PAGE_SIZE;
  return { offset, limit: Math.min(PAGE_SIZE, turnOffset - offset) };
}

/** The Turn at `position`, or undefined while its page is not loaded. */
export function turnAt(
  position: number,
  transcript: TranscriptState,
  pages: TranscriptPages
): TurnSnapshot | undefined {
  if (position >= transcript.turnOffset) {
    return transcript.turns[position - transcript.turnOffset];
  }
  return pages.get(Math.floor(position / PAGE_SIZE))?.[position % PAGE_SIZE];
}
