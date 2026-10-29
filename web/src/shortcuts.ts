import type { ThreadStatus } from "./bindings";
import { turnIsRunning } from "./transcript";

type KeyPress = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

/** Every rebindable action; the names are the keys of `settings.shortcuts`. */
export type ShortcutAction =
  | "dictation"
  | "newThread"
  | "openProject"
  | "modelPicker"
  | "pullRequests"
  | "issues"
  | "terminal"
  | "files"
  | "diff"
  | "previousThread"
  | "nextThread"
  | "closeThread"
  | "toggleTools"
  | "toggleBoard"
  | "openSettings";

/** An accelerator such as `Mod+Shift+M`: `Mod` is ⌘ on macOS and Ctrl elsewhere. */
export type Shortcuts = Record<ShortcutAction, string>;

/** Mirrors the defaults of the Core's Settings, for the moment before Settings have loaded. */
export const DEFAULT_SHORTCUTS: Shortcuts = {
  dictation: "Mod+Shift+R",
  newThread: "Mod+N",
  openProject: "Mod+Shift+N",
  modelPicker: "Mod+Shift+M",
  pullRequests: "Mod+Shift+P",
  issues: "Mod+Shift+I",
  terminal: "Mod+Shift+T",
  files: "Mod+Shift+F",
  diff: "Mod+Shift+D",
  previousThread: "Mod+ArrowUp",
  nextThread: "Mod+ArrowDown",
  closeThread: "Mod+Shift+W",
  toggleTools: "Mod+\\",
  toggleBoard: "Mod+B",
  openSettings: "Mod+,",
};

/** The actions in the order Settings lists them, with their labels. */
export const SHORTCUT_ACTIONS: { action: ShortcutAction; label: string; group: string }[] = [
  { action: "dictation", label: "Start / stop dictation", group: "Input" },
  { action: "newThread", label: "New Thread", group: "Threads" },
  { action: "previousThread", label: "Previous Thread", group: "Threads" },
  { action: "nextThread", label: "Next Thread", group: "Threads" },
  { action: "closeThread", label: "Close Thread", group: "Threads" },
  { action: "openProject", label: "Open a Project", group: "Threads" },
  { action: "modelPicker", label: "Model picker", group: "Threads" },
  { action: "files", label: "Files", group: "Panels" },
  { action: "diff", label: "Diff", group: "Panels" },
  { action: "pullRequests", label: "Pull requests", group: "Panels" },
  { action: "issues", label: "Issues", group: "Panels" },
  { action: "terminal", label: "Terminal", group: "Panels" },
  { action: "toggleTools", label: "Tools panel", group: "Panels" },
  { action: "toggleBoard", label: "Chat / Board", group: "Panels" },
  { action: "openSettings", label: "Settings", group: "Panels" },
];

export const isMacPlatform =
  typeof navigator !== "undefined" && /Mac|iP(hone|od|ad)/i.test(navigator.userAgent || navigator.platform);

function isPrimaryModifier(e: KeyPress): boolean {
  return (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
}

/** What punctuation keys type unmodified, so Shift or Alt does not change which key was pressed. */
const UNSHIFTED_SYMBOLS: Record<string, string> = {
  Backslash: "\\", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`",
};

/**
 * The key an event stands for, as written in an accelerator. Digits follow the physical digit
 * row and Alt follows the physical letter key, so layouts where those produce other characters
 * still work.
 */
function eventKey(e: KeyPress): string {
  const digit = /^Digit(\d)$/.exec(e.code ?? "");
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(e.code ?? "");
  if (letter && e.altKey) return letter[1];
  const symbol = e.code ? UNSHIFTED_SYMBOLS[e.code] : undefined;
  if (symbol && (e.shiftKey || e.altKey)) return symbol;
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

type Parsed = { alt: boolean; shift: boolean; key: string };

function parseAccelerator(accelerator: string): Parsed | null {
  const literalPlus = accelerator.endsWith("++");
  const parts = (literalPlus ? accelerator.slice(0, -2) : accelerator).split("+");
  const key = literalPlus ? "+" : parts.pop();
  if (!key || !parts.includes("Mod")) return null;
  return { alt: parts.includes("Alt"), shift: parts.includes("Shift"), key: key.length === 1 ? key.toUpperCase() : key };
}

/** Whether a key press is exactly this accelerator (⌘ or Ctrl, not both, for `Mod`). */
export function matchesAccelerator(e: KeyPress, accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator);
  if (!parsed || !isPrimaryModifier(e)) return false;
  return e.altKey === parsed.alt && e.shiftKey === parsed.shift && eventKey(e) === parsed.key;
}

/** The action a key press triggers, or `null`. */
export function actionForKey(e: KeyPress, shortcuts: Shortcuts): ShortcutAction | null {
  for (const { action } of SHORTCUT_ACTIONS) {
    if (matchesAccelerator(e, shortcuts[action])) return action;
  }
  return null;
}

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "AltGraph", "CapsLock", "OS"]);
const BINDABLE_NAMED_KEYS = /^(Arrow(Up|Down|Left|Right)|F([1-9]|1[0-2]))$/;

/**
 * The accelerator a key press spells, or `null` while it is only a modifier or not bindable
 * (no ⌘/Ctrl, or a key the Core rejects). Used to record a new shortcut in Settings.
 */
export function acceleratorFromEvent(e: KeyPress): string | null {
  if (!isPrimaryModifier(e) || MODIFIER_KEYS.has(e.key)) return null;
  const key = eventKey(e);
  if (key.length !== 1 ? !BINDABLE_NAMED_KEYS.test(key) : !/^[\x21-\x7e]$/.test(key)) return null;
  return ["Mod", e.altKey && "Alt", e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

const GLYPHS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

/** How an accelerator reads on this platform: `⌘⇧M` on macOS, `Ctrl+Shift+M` elsewhere. */
export function formatAccelerator(accelerator: string, mac: boolean = isMacPlatform): string {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return accelerator;
  const key = mac ? (GLYPHS[parsed.key] ?? parsed.key) : parsed.key.replace(/^Arrow/, "");
  return mac
    ? `⌘${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${key}`
    : `Ctrl+${parsed.alt ? "Alt+" : ""}${parsed.shift ? "Shift+" : ""}${key}`;
}

/** The Thread to move to from `currentId`, one step up or down the sidebar list; clamps at the ends. */
export function adjacentThreadId(ids: number[], currentId: number | null, step: -1 | 1): number | null {
  if (ids.length === 0) return null;
  const index = currentId === null ? -1 : ids.indexOf(currentId);
  if (index === -1) return ids[step === 1 ? 0 : ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, index + step))];
}

/** Esc in the composer stops a running Turn. */
export function stopsTurn(e: KeyPress, status: ThreadStatus): boolean {
  if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return turnIsRunning(status);
}

/** /clear starts a new Thread and keeps the previous one in history. */
export function isClearCommand(input: string): boolean {
  return ["/clear", "/reset", "/new"].includes(input.trim());
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
export const shortcutLabel = isMacPlatform ? "\u2318" : "Ctrl+";
