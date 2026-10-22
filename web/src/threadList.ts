import type { Thread } from "./bindings";

export const threadTitle = (thread: Pick<Thread, "id" | "title">) => thread.title || `Thread #${thread.id}`;

/** Splits Threads into the sidebar list and the Archived list, both filtered by title only. */
export function splitThreads(threads: Thread[], query: string) {
  const needle = query.trim().toLowerCase();
  const matching = threads.filter((t) => threadTitle(t).toLowerCase().includes(needle));
  return {
    active: matching.filter((t) => !t.archived),
    archived: matching.filter((t) => t.archived),
  };
}
