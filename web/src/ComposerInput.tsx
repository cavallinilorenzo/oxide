import { useDictationTarget } from "./dictation";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentChip } from "./AttachmentChip";
import { attachmentPreview } from "./attachmentPreview";
import {
  insertAt,
  isChip,
  lengthOf,
  normalize,
  type ComposerChip,
  type ComposerSegment,
} from "./attachments";

/** What the parent can ask of the editor. */
export interface ComposerHandle {
  focus: () => void;
  isFocused: () => boolean;
  /** The caret, in caret units: the live one while focused, else where it was last. */
  caret: () => number | null;
  /** Puts `segments` at caret unit `at`, or at the end. */
  insert: (segments: ComposerSegment[], at?: number) => void;
  /** Replaces the whole prompt and leaves the caret at its end. */
  replace: (value: ComposerSegment[]) => void;
  /** Forgets a chip that never made it, so undo doesn't bring it back. */
  discardChip: (key: string) => void;
}

interface ComposerInputProps {
  value: ComposerSegment[];
  onChange: (value: ComposerSegment[]) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Files on the clipboard; text is inserted by the editor itself. */
  onPasteFiles?: (files: File[]) => void;
  className?: string;
}

interface Snapshot {
  value: ComposerSegment[];
  caret: number;
  /** Which chips it holds; edits that keep this the same are typing and merge into one step. */
  shape: string;
  at: number;
}

const HISTORY_LIMIT = 200;
const TYPING_MERGE_MS = 1000;
const CHIP_KEY = "data-chip-key";
/** Zero-width spaces some browsers leave around chips; they are not part of the prompt. */
const ZERO_WIDTH = new RegExp(String.fromCharCode(0x200b), "g");

function serialize(value: ComposerSegment[]): string {
  return JSON.stringify(normalize(value));
}

function shapeOf(value: ComposerSegment[]): string {
  return value.map((s) => (isChip(s) ? s.key : "t")).join("|");
}

function chipHost(chip: ComposerChip): HTMLElement {
  const host = document.createElement("span");
  host.setAttribute("contenteditable", "false");
  host.setAttribute(CHIP_KEY, chip.key);
  host.className = "chip-host";
  host.innerHTML = renderToStaticMarkup(
    <AttachmentChip name={chip.name} kind={chip.attachmentKind} sizeBytes={chip.sizeBytes} busy={chip.id === null} removable />,
  );
  if (chip.id && chip.attachmentKind === "image") {
    const image = host.querySelector("img");
    if (image) {
      image.onerror = () => { image.hidden = true; };
      void attachmentPreview(chip.id).then((src) => { if (src) image.src = src; });
    }
  }
  return host;
}

function isChipHost(node: Node | null): boolean {
  return node instanceof HTMLElement && node.hasAttribute(CHIP_KEY);
}

/** Draws `value` into `root`: text, `<br>` for line breaks, a host per chip. */
function renderInto(root: HTMLElement, value: ComposerSegment[]) {
  root.textContent = "";
  const fragment = document.createDocumentFragment();
  let endsWithBreak = false;
  for (const segment of value) {
    if (isChip(segment)) {
      // A caret next to a non-editable element isn't drawn; a zero-width text node on each side
      // gives it somewhere to sit. They are ignored when the editor is read back.
      fragment.append(document.createTextNode("​"), chipHost(segment), document.createTextNode("​"));
      endsWithBreak = false;
      continue;
    }
    segment.text.split("\n").forEach((line, i) => {
      if (i > 0) fragment.append(document.createElement("br"));
      if (line) fragment.append(document.createTextNode(line));
    });
    if (segment.text) endsWithBreak = segment.text.endsWith("\n");
  }
  // A line break at the very end only shows when something follows it.
  if (endsWithBreak) fragment.append(document.createElement("br"));
  root.append(fragment);
}

type Token = { t: "text"; text: string } | { t: "br" } | { t: "chip"; key: string };

function tokens(node: Node, out: Token[], isRoot: boolean) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? "").replace(ZERO_WIDTH, "");
      if (text) out.push({ t: "text", text });
    } else if (child instanceof HTMLElement) {
      if (child.tagName === "BR") out.push({ t: "br" });
      else if (isChipHost(child)) out.push({ t: "chip", key: child.getAttribute(CHIP_KEY) ?? "" });
      else {
        const block = child.tagName === "DIV" || child.tagName === "P";
        // A block starts a new line, unless it is only the placeholder of an empty line.
        if (block && out.length > 0 && out[out.length - 1].t !== "br") out.push({ t: "br" });
        const onlyBreak = child.childNodes.length === 1 && child.firstChild?.nodeName === "BR";
        if (!onlyBreak) tokens(child, out, false);
      }
    }
  }
  void isRoot;
}

/** Reads the editor back into a prompt. A final `<br>` is the caret placeholder, not a break. */
function parse(root: HTMLElement, chips: Map<string, ComposerChip>): ComposerSegment[] {
  const found: Token[] = [];
  tokens(root, found, true);
  if (found[found.length - 1]?.t === "br") found.pop();
  const out: ComposerSegment[] = [];
  for (const token of found) {
    if (token.t === "text") out.push({ kind: "text", text: token.text });
    else if (token.t === "br") out.push({ kind: "text", text: "\n" });
    else {
      const chip = chips.get(token.key);
      if (chip) out.push(chip);
    }
  }
  return normalize(out);
}

/** Caret units in a piece of DOM: a character, a line break or a chip each count one. */
function unitsIn(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(ZERO_WIDTH, "").length;
  if (isChipHost(node)) return 1;
  if (node.nodeName === "BR") return 1;
  return Array.from(node.childNodes).reduce((n, c) => n + unitsIn(c), 0);
}

function caretIn(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return unitsIn(before.cloneContents());
}

function placeCaret(root: HTMLElement, units: number) {
  const selection = window.getSelection();
  if (!selection) return;
  let left = units;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  const children = Array.from(root.childNodes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const size = unitsIn(child);
    if (child.nodeType === Node.TEXT_NODE && left <= size) {
      range.setStart(child, left);
      range.collapse(true);
      break;
    }
    if (left === 0) {
      range.setStart(root, i);
      range.collapse(true);
      break;
    }
    left -= size;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Plain text of a copied selection: chips read `[name]`. */
function plainFromFragment(fragment: DocumentFragment, chips: Map<string, ComposerChip>): string {
  const out: Token[] = [];
  tokens(fragment, out, true);
  return out
    .map((t) => (t.t === "text" ? t.text : t.t === "br" ? "\n" : `[${chips.get(t.key)?.name ?? ""}]`))
    .join("");
}

/**
 * The prompt editor: text with Attachment chips inline. Typing, IME and the caret are the
 * browser's; chips are non-editable inline elements, removed whole by Backspace or Delete, and
 * the editor keeps its own undo history so removing a chip can be undone.
 */
export const ComposerInput = forwardRef<ComposerHandle, ComposerInputProps>(function ComposerInput(
  { value, onChange, disabled, placeholder, ariaLabel, onKeyDown, onPasteFiles, className },
  ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const shown = useRef<ComposerSegment[]>([]);
  const chips = useRef(new Map<string, ComposerChip>());
  const latest = useRef(new Map<string, ComposerChip>());
  const dead = useRef(new Set<string>());
  const composing = useRef(false);
  const lastCaret = useRef<number | null>(null);
  const history = useRef<{ stack: Snapshot[]; index: number }>({ stack: [], index: -1 });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const remember = (next: ComposerSegment[]) => {
    chips.current = new Map();
    for (const s of next) {
      if (isChip(s)) {
        chips.current.set(s.key, s);
        latest.current.set(s.key, s);
      }
    }
  };

  const record = (next: ComposerSegment[], caret: number, reset = false) => {
    const h = history.current;
    const snapshot: Snapshot = { value: next, caret, shape: shapeOf(next), at: Date.now() };
    if (reset || h.index < 0) {
      h.stack = [snapshot];
      h.index = 0;
      return;
    }
    const top = h.stack[h.index];
    if (h.index === h.stack.length - 1 && top.shape === snapshot.shape && snapshot.at - top.at < TYPING_MERGE_MS) {
      h.stack[h.index] = { ...snapshot, at: snapshot.at };
      return;
    }
    h.stack = [...h.stack.slice(0, h.index + 1), snapshot].slice(-HISTORY_LIMIT);
    h.index = h.stack.length - 1;
  };

  /** Reads the DOM after the user (or the browser) changed it, and tells the parent. */
  const sync = () => {
    const el = root.current;
    if (!el) return;
    const next = parse(el, chips.current);
    if (next.length === 0 && el.childNodes.length > 0) el.textContent = "";
    if (serialize(next) === serialize(shown.current)) return;
    shown.current = next;
    remember(next);
    record(next, caretIn(el) ?? lengthOf(next));
    onChangeRef.current(next);
  };

  /** Replaces what the editor shows, keeping the caret near where it was. */
  const show = (next: ComposerSegment[], caret: number | null) => {
    const el = root.current;
    if (!el) return;
    shown.current = next;
    remember(next);
    renderInto(el, next);
    if (caret !== null) placeCaret(el, Math.min(caret, lengthOf(next)));
  };

  const restore = (snapshot: Snapshot) => {
    const alive = snapshot.value.flatMap((s): ComposerSegment[] => {
      if (!isChip(s)) return [s];
      if (dead.current.has(s.key)) return [];
      return [latest.current.get(s.key) ?? s];
    });
    const next = normalize(alive);
    show(next, snapshot.caret);
    onChangeRef.current(next);
  };

  const undo = () => {
    const h = history.current;
    if (h.index <= 0) return;
    h.index -= 1;
    restore(h.stack[h.index]);
  };

  const redo = () => {
    const h = history.current;
    if (h.index >= h.stack.length - 1) return;
    h.index += 1;
    restore(h.stack[h.index]);
  };

  // The parent's value changed: draw it unless the editor already shows it.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || composing.current) return;
    const incoming = normalize(value);
    if (serialize(incoming) === serialize(shown.current)) return;
    const focused = document.activeElement === el;
    const sameLayout = shapeOf(incoming) === shapeOf(shown.current) &&
      incoming.every((s, i) => isChip(s) || (shown.current[i] as { text?: string }).text === s.text);
    if (sameLayout) {
      // Only chip details changed (a file finished storing): patch the chips, leave the caret.
      shown.current = incoming;
      remember(incoming);
      for (const s of incoming) {
        if (!isChip(s)) continue;
        const host = el.querySelector(`[${CHIP_KEY}="${CSS.escape(s.key)}"]`);
        if (host) host.replaceWith(chipHost(s));
      }
      const h = history.current;
      if (h.index >= 0) h.stack[h.index] = { ...h.stack[h.index], value: incoming };
      return;
    }
    const caret = focused ? (caretIn(el) ?? null) : null;
    show(incoming, focused ? (caret === null ? lengthOf(incoming) : caret) : null);
    record(incoming, lengthOf(incoming), true);
    // `show` and `record` only touch refs, so the effect needs nothing but the incoming value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const caretNow = () => {
    const el = root.current;
    if (!el) return null;
    // The selection stays in the editor when a button takes focus, so it is still the caret.
    return caretIn(el) ?? lastCaret.current;
  };

  useImperativeHandle(ref, () => ({
    focus: () => root.current?.focus(),
    isFocused: () => document.activeElement === root.current,
    caret: caretNow,
    insert: (segments, at) => {
      const el = root.current;
      if (!el) return;
      const base = shown.current;
      const point = Math.min(at ?? lengthOf(base), lengthOf(base));
      const next = insertAt(base, point, segments);
      show(next, null);
      record(next, point + lengthOf(segments));
      el.focus();
      placeCaret(el, point + lengthOf(segments));
      onChangeRef.current(next);
    },
    replace: (next) => {
      const el = root.current;
      if (!el) return;
      show(normalize(next), lengthOf(normalize(next)));
      record(normalize(next), lengthOf(normalize(next)), true);
    },
    discardChip: (key) => {
      dead.current.add(key);
    },
  }));

  /** Puts nodes at the selection (replacing it), or at the end if the caret is elsewhere. */
  const insertNodes = (nodes: Node[]) => {
    const el = root.current;
    if (!el) return;
    const selection = window.getSelection();
    let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !el.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) {
      // A break at the very end needs its placeholder, or the new line never shows.
      if (last.nodeName === "BR" && el.lastChild === last) el.append(document.createElement("br"));
      range.setStartAfter(last);
      range.collapse(true);
    }
    el.normalize();
    selection?.removeAllRanges();
    selection?.addRange(range);
    sync();
  };

  const insertText = (text: string) => {
    const nodes: Node[] = [];
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .forEach((line, i) => {
        if (i > 0) nodes.push(document.createElement("br"));
        if (line) nodes.push(document.createTextNode(line));
      });
    insertNodes(nodes);
  };

  /** Removes the chip next to a collapsed caret, if there is one. */
  const removeAdjacentChip = (direction: -1 | 1): boolean => {
    const el = root.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !el.contains(range.startContainer)) return false;
    const { startContainer: node, startOffset: offset } = range;
    let neighbour: Node | null = null;
    if (node === el) {
      neighbour = el.childNodes[direction < 0 ? offset - 1 : offset] ?? null;
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (direction < 0 && text.slice(0, offset).replace(ZERO_WIDTH, "") === "") neighbour = node.previousSibling;
      if (direction > 0 && text.slice(offset).replace(ZERO_WIDTH, "") === "") neighbour = node.nextSibling;
    }
    // Skip empty text left behind by earlier edits, and the zero-width spacers around chips.
    while (neighbour?.nodeType === Node.TEXT_NODE && !(neighbour.textContent ?? "").replace(ZERO_WIDTH, "")) {
      neighbour = direction < 0 ? neighbour.previousSibling : neighbour.nextSibling;
    }
    if (!neighbour || !isChipHost(neighbour)) return false;
    const at = document.createRange();
    at.setStartBefore(neighbour);
    at.collapse(true);
    (neighbour as HTMLElement).remove();
    selection.removeAllRanges();
    selection.addRange(at);
    sync();
    return true;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.nativeEvent.isComposing || composing.current) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.ctrlKey && !e.metaKey && key === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) insertNodes([document.createElement("br")]);
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !mod && !e.altKey) {
      if (removeAdjacentChip(e.key === "Backspace" ? -1 : 1)) e.preventDefault();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      onPasteFiles?.(files);
      return;
    }
    const text = e.clipboardData?.getData("text/plain");
    if (text) insertText(text);
  };

  const handleCopy = (e: React.ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const el = root.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !el.contains(range.commonAncestorContainer)) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", plainFromFragment(range.cloneContents(), chips.current));
    if (cut) {
      range.deleteContents();
      sync();
    }
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const remove = target.closest?.("[data-chip-remove]");
    if (!remove || disabled) return;
    const host = remove.closest(`[${CHIP_KEY}]`);
    if (!host) return;
    e.preventDefault();
    host.remove();
    sync();
    root.current?.focus();
  };

  useDictationTarget(root, insertText, !disabled);

  return (
    <div
      ref={root}
      className={className ?? "composer-input"}
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      onInput={() => {
        if (!composing.current) sync();
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        sync();
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={() => {
        lastCaret.current = caretNow();
      }}
      onMouseUp={() => {
        lastCaret.current = caretNow();
      }}
      onBlur={() => {
        const el = root.current;
        // Read the caret before the selection moves away with focus.
        if (el) lastCaret.current = caretIn(el) ?? lastCaret.current;
      }}
      onPaste={handlePaste}
      onCopy={(e) => handleCopy(e, false)}
      onCut={(e) => handleCopy(e, true)}
      onClick={handleClick}
      onDrop={(e) => e.preventDefault()}
    />
  );
});
