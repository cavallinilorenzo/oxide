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

function isPrimaryModifier(e: KeyPress): boolean {
  return (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
}

/** Esc in the composer stops a running Turn. */
export function stopsTurn(e: KeyPress, status: ThreadStatus): boolean {
  if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return turnIsRunning(status);
}

/** ⌘\ / Ctrl+\ toggles the tools panel, ⌘J / Ctrl+J toggles the Terminal area, ⌘B / Ctrl+B switches Chat / Board, ⌘, / Ctrl+, opens Settings. */
export function toggleForKey(e: KeyPress): LayoutToggle | null {
  if (!isPrimaryModifier(e) || e.altKey || e.shiftKey) return null;
  if (e.key === "\\") return "tools";
  if (e.key === "j") return "terminal";
  if (e.key === "b") return "board";
  if (e.key === ",") return "settings";
  return null;
}

/** ⌘⇧N / Ctrl+Shift+N opens the Project palette. */
export function isProjectPaletteShortcut(e: KeyPress): boolean {
  if (!isPrimaryModifier(e) || e.altKey || !e.shiftKey) return false;
  return e.key === "n" || e.key === "N";
}

/** ⌘N / Ctrl+N starts a new Thread in the current Project. (⌘⇧N / Ctrl+Shift+N is the Project palette). */
export function isNewThreadShortcut(e: KeyPress): boolean {
  if (!isPrimaryModifier(e) || e.altKey || e.shiftKey) return false;
  return e.key === "n" || e.key === "N";
}

/** /clear starts a new Thread and keeps the previous one in history. */
export function isClearCommand(input: string): boolean {
  return ["/clear", "/reset", "/new"].includes(input.trim());
}

/** ⌘⇧M / Ctrl+Shift+M opens or closes the Model picker. */
export function isModelPickerShortcut(e: KeyPress): boolean {
  if (!isPrimaryModifier(e) || e.altKey || !e.shiftKey) return false;
  return e.key === "m" || e.key === "M";
}

/** The digit 1..9 on the physical digit row, so layouts where digits need Shift still work. */
function physicalDigit(e: { code: string }): number | null {
  const match = /^Digit([1-9])$/.exec(e.code);
  return match ? parseInt(match[1], 10) : null;
}

/** ⌘1..9 / Ctrl+1..9 (no Alt, no Shift): picks the nth model, or switches to the nth Favourite Model. */
export function modelDigitShortcut(e: KeyPress & { code: string }): number | null {
  if (!isPrimaryModifier(e) || e.altKey || e.shiftKey) return null;
  return physicalDigit(e);
}

/** A platform-appropriate primary modifier for shortcut labels. */
export const shortcutLabel = typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform) ? "\u2318" : "Ctrl+";
