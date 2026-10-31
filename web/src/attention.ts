import type { BoardCard } from "./bindings";

export type CardsByProject = Record<number, BoardCard[]>;
export type AttentionSummary = { approvals: number; needsInput: number; error: number; interrupted: number; total: number };
export type AttentionTarget = { kind: "approval" | "answer" | "recovery"; projectId: number; threadId: number; approvalId: string | null };

/** Counts Threads waiting on the user across Projects; `approvals` is the subset holding a pending Approval. */
export function summarizeAttention(cards: CardsByProject): AttentionSummary {
  const sum: AttentionSummary = { approvals: 0, needsInput: 0, error: 0, interrupted: 0, total: 0 };
  for (const list of Object.values(cards)) {
    for (const { thread, pendingApprovals } of list) {
      if (thread.status === "needs-input") { sum.needsInput++; if (pendingApprovals.length > 0) sum.approvals++; }
      else if (thread.status === "error") sum.error++;
      else if (thread.status === "interrupted") sum.interrupted++;
      else continue;
      sum.total++;
    }
  }
  return sum;
}

export function attentionLabel(sum: AttentionSummary): string {
  if (sum.total === 0) return "Nothing needs you";
  const parts = [
    sum.needsInput && `${sum.needsInput} waiting for input${sum.approvals ? ` (${sum.approvals} Approval${sum.approvals === 1 ? "" : "s"})` : ""}`,
    sum.error && `${sum.error} error`,
    sum.interrupted && `${sum.interrupted} interrupted`,
  ].filter(Boolean);
  return `${sum.total} Thread${sum.total === 1 ? "" : "s"} need${sum.total === 1 ? "s" : ""} you: ${parts.join(", ")}`;
}

/**
 * Where the primary activation goes: the earliest pending Approval (by Thread activity, then lowest id),
 * else a needs-input Thread, else an error/interrupted one, each in `order` (sidebar) of Projects.
 * Core's pending Approval carries no request time, so Thread activity stands in for it.
 */
export function attentionTarget(cards: CardsByProject, order: number[]): AttentionTarget | null {
  const all = order.flatMap((projectId) => (cards[projectId] ?? []).map((card) => ({ projectId, card })));
  const approvals = all.filter(({ card }) => card.pendingApprovals.length > 0 && card.thread.status === "needs-input")
    .sort((a, b) => a.card.thread.updatedAt.localeCompare(b.card.thread.updatedAt) || a.card.thread.id - b.card.thread.id);
  if (approvals[0]) {
    const { projectId, card } = approvals[0];
    return { kind: "approval", projectId, threadId: card.thread.id, approvalId: card.pendingApprovals[0].approvalId };
  }
  for (const [kind, statuses] of [["answer", ["needs-input"]], ["recovery", ["error", "interrupted"]]] as const) {
    const found = all.find(({ card }) => (statuses as readonly string[]).includes(card.thread.status));
    if (found) return { kind, projectId: found.projectId, threadId: found.card.thread.id, approvalId: null };
  }
  return null;
}
