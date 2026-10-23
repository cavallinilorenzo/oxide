import type { Project, Thread } from "./bindings";

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

/** The sidebar lists only Projects the user opened; a scan just makes them findable in ⌘⇧N. */
export const sidebarProjects = (projects: Project[]) => projects.filter((p) => p.open && !p.hidden);

/** "now", "5m", "3h", "yesterday", "4d", then a short date: how long ago a Thread last moved. */
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  const days = Math.floor(minutes / (24 * 60));
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return then.toLocaleDateString([], { day: "numeric", month: "short" });
}
