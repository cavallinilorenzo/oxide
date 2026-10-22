import type { DiffScope } from "./bindings";

/** The scopes the Diff Surface offers: Git's two, a Turn between its Checkpoints, and a pull request under review. */
export type PanelScope = DiffScope | "turn" | "pr";

/** What kind of Thread the Diff Surface is showing. Board Threads get their own worktree. */
export interface DiffThreadKind {
  board: boolean;
}

/** A chat Thread opens on its Turn; a Board Thread on its Branch. */
export function defaultDiffScope(thread: DiffThreadKind): PanelScope {
  return thread.board ? "branch" : "turn";
}

/** Chat Threads share the checkout, so a Turn's diff may hold other Threads' edits. */
export function showsConcurrencyNote(scope: PanelScope, thread: DiffThreadKind): boolean {
  return scope === "turn" && !thread.board;
}
