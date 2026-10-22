/** Key used when no thread has been created yet. */
const DRAFT_KEY = 0;

export function getDraft(drafts: Record<number, string>, threadId: number | null): string {
  const key = threadId ?? DRAFT_KEY;
  return drafts[key] ?? "";
}

export function setDraft(
  drafts: Record<number, string>,
  threadId: number | null,
  text: string
): Record<number, string> {
  const key = threadId ?? DRAFT_KEY;
  if (drafts[key] === text) return drafts;
  return { ...drafts, [key]: text };
}

export function clearDraft(
  drafts: Record<number, string>,
  threadId: number | null
): Record<number, string> {
  const key = threadId ?? DRAFT_KEY;
  if (!drafts[key]) return drafts;
  const next = { ...drafts };
  delete next[key];
  return next;
}
