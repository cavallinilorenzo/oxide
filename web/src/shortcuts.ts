import type { ThreadStatus } from "./bindings";
import { turnIsRunning } from "./transcript";

export type LayoutToggle = "tools" | "terminal" | "board" | "settings";

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

/** ⌘\ toggles the tools panel, ⌘J toggles the Terminal area, ⌘B switches Chat / Board, ⌘, opens Settings. */
export function toggleForKey(e: KeyPress): LayoutToggle | null {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === "\\") return "tools";
  if (e.key === "j") return "terminal";
  if (e.key === "b") return "board";
  if (e.key === ",") return "settings";
  return null;
}

/** ⌘N starts a new Thread in the current Project. (⌘⇧N is Project palette). */
export function isNewThreadShortcut(e: KeyPress): boolean {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return e.key === "n" || e.key === "N";
}

/** /clear starts a new Thread and keeps the previous one in history. */
export function isClearCommand(input: string): boolean {
  return input.trim() === "/clear";
}

/** ⌘1..9 / Ctrl 1..9 picks visible model in picker. */
export function isModelShortcut(e: KeyPress): number | null {
  if ((!e.metaKey && !e.ctrlKey) || e.altKey || e.shiftKey) return null;
  const match = /^[1-9]$/.exec(e.key);
  return match ? parseInt(match[0], 10) : null;
}
