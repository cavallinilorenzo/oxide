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

/** Truncates prompt to match Core's title truncation: first non-empty line up to 60 characters. */
export function truncateTitle(prompt: string): string {
  let start = 0;
  while (start < prompt.length) {
    const end = prompt.indexOf("\n", start);
    const line = (end === -1 ? prompt.slice(start) : prompt.slice(start, end)).trim();
    if (line.length > 0) {
      return line.length > 60 ? line.slice(0, 60) : line;
    }
    if (end === -1) break;
    start = end + 1;
  }
  return "";
}

