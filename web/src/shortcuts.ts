export type LayoutToggle = "tools" | "terminal" | "settings";

/** ⌘\ toggles the tools panel, ⌘J toggles the Terminal area, ⌘, opens Settings. */
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
  if (e.key === ",") return "settings";
  return null;
}
