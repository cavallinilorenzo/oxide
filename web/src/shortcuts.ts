export type LayoutToggle = "tools" | "terminal";

/** ⌘\ toggles the tools panel, ⌘J toggles the Terminal area. */
export function toggleForKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): LayoutToggle | null {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === "\\") return "tools";
  if (e.key === "j") return "terminal";
  return null;
}
