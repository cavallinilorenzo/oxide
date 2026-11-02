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

/** How the Turn picker names a Turn: its position and the start of its prompt. */
export function turnLabel(turn: { turnIndex: number; prompt: string }): string {
  const prompt = turn.prompt.replace(/\s+/g, " ").trim();
  return `Turn ${turn.turnIndex + 1} · ${prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt}`;
}

/** Chat Threads share the checkout, so a Turn's diff may hold other Threads' edits. */
export function showsConcurrencyNote(scope: PanelScope, thread: DiffThreadKind): boolean {
  return scope === "turn" && !thread.board;
}
