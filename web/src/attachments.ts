import type { Attachment, AttachmentKind, PromptInput, PromptSegment } from "./bindings";

/** The most Attachments one prompt can carry; Core enforces the same cap. */
export const MAX_ATTACHMENTS = 10;

export const TOO_MANY_MESSAGE = `A prompt can carry at most ${MAX_ATTACHMENTS} attachments.`;

/**
 * An Attachment in the composer. `id` is null while its file is still being stored: the chip is
 * shown busy and the prompt can't be sent.
 */
export interface ComposerChip {
  kind: "attachment";
  /** Identifies the chip in the composer before the file has an id. */
  key: string;
  id: string | null;
  name: string;
  attachmentKind: AttachmentKind;
  mediaType: string;
  sizeBytes: number;
  path: string;
}

export type ComposerSegment = { kind: "text"; text: string } | ComposerChip;

let chipSeq = 0;

export function newChipKey(): string {
  chipSeq += 1;
  return `chip-${chipSeq}`;
}

/** A chip for a file being stored. */
export function busyChip(name: string): ComposerChip {
  return {
    kind: "attachment",
    key: newChipKey(),
    id: null,
    name,
    attachmentKind: kindFromName(name),
    mediaType: "",
    sizeBytes: 0,
    path: "",
  };
}

export function chipFor(attachment: Attachment, key: string = newChipKey()): ComposerChip {
  return { kind: "attachment", key, ...attachment };
}

export function isChip(segment: ComposerSegment): segment is ComposerChip {
  return segment.kind === "attachment";
}

export function chipsOf(value: ComposerSegment[]): ComposerChip[] {
  return value.filter(isChip);
}

/** Joins neighbouring text and drops empty text, so equal prompts compare equal. */
export function normalize(value: ComposerSegment[]): ComposerSegment[] {
  const out: ComposerSegment[] = [];
  for (const segment of value) {
    if (segment.kind === "text") {
      if (!segment.text) continue;
      const last = out[out.length - 1];
      if (last?.kind === "text") out[out.length - 1] = { kind: "text", text: last.text + segment.text };
      else out.push(segment);
    } else out.push(segment);
  }
  return out;
}

/** The prompt as plain text, each Attachment reading `[name]`. */
export function plainText(value: ComposerSegment[] | PromptSegment[]): string {
  return value.map((s) => (s.kind === "text" ? s.text : `[${s.name}]`)).join("");
}

/** The same prompt for the Slash command checks, which only look at what the user typed. */
export function typedText(value: ComposerSegment[]): string {
  return value.map((s) => (s.kind === "text" ? s.text : "")).join("");
}

export function hasAttachments(value: ComposerSegment[]): boolean {
  return value.some(isChip);
}

export function isBusy(value: ComposerSegment[]): boolean {
  return chipsOf(value).some((c) => c.id === null);
}

/** Whether there is anything to send: an Attachment, or text that isn't blank. */
export function hasContent(value: ComposerSegment[]): boolean {
  return value.some((s) => (s.kind === "text" ? s.text.trim() !== "" : true));
}

/** What `send_prompt` takes: surrounding whitespace trimmed, Attachments by id. */
export function toPromptInput(value: ComposerSegment[]): PromptInput[] {
  const parts = normalize(value);
  const first = parts[0];
  if (first?.kind === "text") parts[0] = { kind: "text", text: first.text.trimStart() };
  const last = parts[parts.length - 1];
  if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text.trimEnd() };
  return normalize(parts).flatMap((s): PromptInput[] =>
    s.kind === "text" ? [{ kind: "text", text: s.text }] : s.id ? [{ kind: "attachment", id: s.id }] : [],
  );
}

/** The Transcript form of a prompt about to be sent, for the "sending…" Turn. */
export function toPromptSegments(value: ComposerSegment[]): PromptSegment[] {
  const sent = toPromptInput(value);
  const byId = new Map(chipsOf(value).map((c) => [c.id, c]));
  return sent.flatMap((s): PromptSegment[] => {
    if (s.kind === "text") return [s];
    const c = byId.get(s.id);
    return c
      ? [{ kind: "attachment", id: s.id, name: c.name, attachmentKind: c.attachmentKind, mediaType: c.mediaType, sizeBytes: c.sizeBytes, path: c.path }]
      : [];
  });
}

/** Replaces the chip with `key` by `replacement`, or removes it when that is null. */
export function replaceChip(value: ComposerSegment[], key: string, replacement: ComposerChip | null): ComposerSegment[] {
  return normalize(
    value.flatMap((s): ComposerSegment[] => (isChip(s) && s.key === key ? (replacement ? [replacement] : []) : [s])),
  );
}

/** Length of a prompt in caret units: a character, a line break or a chip each count one. */
export function lengthOf(value: ComposerSegment[]): number {
  return value.reduce((n, s) => n + (s.kind === "text" ? s.text.length : 1), 0);
}

/** `value` with `inserted` put at caret unit `offset`. */
export function insertAt(value: ComposerSegment[], offset: number, inserted: ComposerSegment[]): ComposerSegment[] {
  const out: ComposerSegment[] = [];
  let at = 0;
  let done = false;
  const put = () => {
    if (!done) out.push(...inserted);
    done = true;
  };
  for (const s of value) {
    if (s.kind === "text") {
      const end = at + s.text.length;
      if (!done && offset >= at && offset <= end) {
        const cut = offset - at;
        out.push({ kind: "text", text: s.text.slice(0, cut) });
        put();
        out.push({ kind: "text", text: s.text.slice(cut) });
      } else out.push(s);
      at = end;
    } else {
      if (!done && offset <= at) put();
      out.push(s);
      at += 1;
    }
  }
  put();
  return normalize(out);
}

// --- Drafts -------------------------------------------------------------------------------
// A Thread's draft is kept by the parent as one string. Plain text stays plain; a draft that
// holds Attachments is stored behind a marker no typed text starts with.

const DRAFT_MARKER = "\u0000oxide-composer:";

export function encodeDraft(value: ComposerSegment[]): string {
  const parts = normalize(value);
  if (!parts.some(isChip)) return parts.map((s) => (s.kind === "text" ? s.text : "")).join("");
  return DRAFT_MARKER + JSON.stringify(parts);
}

export function decodeDraft(draft: string): ComposerSegment[] {
  if (draft.startsWith(DRAFT_MARKER)) {
    try {
      const parsed = JSON.parse(draft.slice(DRAFT_MARKER.length)) as ComposerSegment[];
      if (Array.isArray(parsed)) return normalize(parsed);
    } catch {
      // Fall through: treat it as text rather than lose the draft.
    }
  }
  return normalize([{ kind: "text", text: draft }]);
}

// --- Chip display -------------------------------------------------------------------------

/** The icon family for a file name, from its extension. */
export type ChipIcon = "image" | "pdf" | "markdown" | "text" | "code" | "table" | "archive" | "file";

const ICONS_BY_EXTENSION: Record<string, ChipIcon> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", heic: "image", tiff: "image", ico: "image",
  pdf: "pdf",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  txt: "text", log: "text", rtf: "text",
  csv: "table", tsv: "table", xls: "table", xlsx: "table", ods: "table", numbers: "table",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive", xz: "archive", "7z": "archive", rar: "archive",
  json: "code", yaml: "code", yml: "code", toml: "code", xml: "code", html: "code", css: "code", js: "code", jsx: "code", ts: "code", tsx: "code",
  rs: "code", py: "code", go: "code", java: "code", kt: "code", swift: "code", c: "code", h: "code", cpp: "code", hpp: "code", cs: "code",
  rb: "code", php: "code", sh: "code", zsh: "code", sql: "code", lua: "code", vue: "code", svelte: "code", dart: "code", scala: "code",
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

export function iconFor(name: string): ChipIcon {
  return ICONS_BY_EXTENSION[extensionOf(name)] ?? "file";
}

function kindFromName(name: string): AttachmentKind {
  const icon = iconFor(name);
  if (icon === "image") return "image";
  if (icon === "pdf") return "pdf";
  return "other";
}

const KIND_WORDS: Record<AttachmentKind, string> = { image: "image", pdf: "PDF", text: "text", other: "file" };

/** "Attachment, notes.md, text" — what a screen reader announces for a chip. */
export function chipLabel(name: string, kind: AttachmentKind): string {
  return `Attachment, ${name}, ${KIND_WORDS[kind]}`;
}

/** Shortens a long name in the middle, keeping the extension (and the end of the stem) visible. */
export function shortenName(name: string, max = 28): string {
  if (name.length <= max) return name;
  const ext = extensionOf(name);
  const suffix = ext && ext.length <= 8 ? `.${ext}` : "";
  const stem = name.slice(0, name.length - suffix.length);
  const tail = Math.min(4, Math.max(0, stem.length - 1));
  const head = Math.max(1, max - suffix.length - tail - 1);
  return `${stem.slice(0, head)}…${tail ? stem.slice(-tail) : ""}${suffix}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
