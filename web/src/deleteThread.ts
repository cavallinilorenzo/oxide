import type { AppError, DeleteOutcome } from "./bindings";

type DeleteCommand = (threadId: number, discardChanges: boolean) => Promise<
  | { status: "ok"; data: DeleteOutcome }
  | { status: "error"; error: AppError }
>;

export type DeleteAttempt =
  | { status: "deleted" }
  | { status: "needs-confirmation" }
  | { status: "error"; message: string };

export async function performThreadDelete(
  threadId: number,
  discardChanges: boolean,
  deleteCommand: DeleteCommand,
): Promise<DeleteAttempt> {
  try {
    const result = await deleteCommand(threadId, discardChanges);
    if (result.status === "error") return { status: "error", message: result.error.message };
    return result.data === "needs-confirmation" ? { status: "needs-confirmation" } : { status: "deleted" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function threadsAfterDelete<T extends { id: number }>(threads: T[] | null, threadId: number): T[] | null {
  return threads?.filter((thread) => thread.id !== threadId) ?? null;
}

export function selectionAfterDelete(selectedThreadId: number | null, deletedThreadId: number): number | null {
  return selectedThreadId === deletedThreadId ? null : selectedThreadId;
}
