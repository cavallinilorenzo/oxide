import type { ThreadStatus } from "./bindings";
import { turnIsRunning } from "./transcript";

export type LayoutToggle = "tools" | "terminal" | "settings";

type KeyPress = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** Esc in the composer stops a running Turn. */
export function stopsTurn(e: KeyPress, status: ThreadStatus): boolean {
  if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return turnIsRunning(status);
}

/** ⌘\ toggles the tools panel, ⌘J toggles the Terminal area, ⌘, opens Settings. */
export function toggleForKey(e: KeyPress): LayoutToggle | null {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === "\\") return "tools";
  if (e.key === "j") return "terminal";
  if (e.key === ",") return "settings";
  return null;
}
