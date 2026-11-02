/** Tab policy of the open-files bar, kept pure so every close path shares it. */

/** The tab that becomes active after `closing` goes: its right neighbour, else its left, else none. */
export function neighborAfterClose(order: string[], closing: string): string | null {
  const index = order.indexOf(closing);
  if (index < 0) return null;
  return order[index + 1] ?? order[index - 1] ?? null;
}

/** The unmodified preview a newly previewed file takes the place of; dirty or kept files are never replaced. */
export function previewToReplace(docs: { path: string; preview: boolean; dirty: boolean }[]): string | null {
  return docs.find((doc) => doc.preview && !doc.dirty)?.path ?? null;
}

/** Paths a "close others" or "close all" removes, in tab order. */
export function batchCloseTargets(order: string[], mode: "others" | "all", keep: string | null): string[] {
  return mode === "all" ? [...order] : order.filter((path) => path !== keep);
}

/** The next tab for roving keyboard navigation (ArrowLeft, ArrowRight, Home, End). */
export function rovingTab(
  order: string[],
  current: string | null,
  key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
): string | null {
  if (order.length === 0) return null;
  const index = current === null ? -1 : order.indexOf(current);
  if (key === "Home") return order[0];
  if (key === "End") return order[order.length - 1];
  if (index === -1) return order[0];
  const delta = key === "ArrowRight" ? 1 : -1;
  return order[(index + delta + order.length) % order.length];
}
