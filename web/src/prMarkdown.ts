/** A deliberately small Markdown reader for pull request descriptions and comments.
 *  It shows what matters (headings, lists, checkboxes, code, link text) and drops what is
 *  noise in a narrow panel: HTML comments, bot metadata, raw tags. Output is data, never HTML. */

export interface Inline {
  kind: "text" | "code" | "link" | "strong";
  text: string;
}

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; items: { checked: boolean | null; inline: Inline[] }[] }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const TAGS =
  "details|summary|p|blockquote|ul|ol|li|code|em|strong|b|i|a|img|div|span|h[1-6]|hr|table|tr|td|th|thead|tbody|sup|sub";

function clean(src: string): string {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Dependabot's machine-readable trailer.
    .replace(/\n?---\nupdated-dependencies:[\s\S]*?(\n\.\.\.\n?|$)/, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`</?(${TAGS})(\\s[^>]*)?/?>`, "gi"), "");
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "strong", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "link", text: m[3].replace(/`/g, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const COLUMNS = 36;

function textLines(parts: Inline[]): number {
  return Math.max(1, Math.ceil(parts.reduce((n, p) => n + p.text.length, 0) / COLUMNS));
}

function cost(block: Block): number {
  switch (block.kind) {
    case "heading":
      return 1;
    case "paragraph":
      return textLines(block.inline);
    case "list":
      return block.items.reduce((n, item) => n + textLines(item.inline), 0);
    case "code":
      return block.text.split("\n").length;
    case "rule":
      return 0;
  }
}

/** The first `budget` visual lines of a document, cut between lines, never through one.
 *  A code block is the only thing cut inside, and keeps whole lines. */
export function limitBlocks(blocks: Block[], budget: number): { blocks: Block[]; truncated: boolean } {
  const out: Block[] = [];
  let left = budget;
  for (const block of blocks) {
    const c = cost(block);
    if (c <= left) {
      out.push(block);
      left -= c;
      continue;
    }
    if (block.kind === "code" && left >= 2) {
      out.push({ kind: "code", text: block.text.split("\n").slice(0, left).join("\n") });
    } else if (out.length === 0) out.push(block);
    // A heading with nothing under it reads as a mistake.
    while (out[out.length - 1]?.kind === "heading" || out[out.length - 1]?.kind === "rule") out.pop();
    return { blocks: out, truncated: true };
  }
  return { blocks, truncated: false };
}

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = clean(src).split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];
    if (!line.trim()) flush();
    else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
    } else if (item) {
      flush();
      const entry = { checked: item[1] === undefined ? null : item[1] !== " ", inline: parseInline(item[2]) };
      if (last?.kind === "list") last.items.push(entry);
      else blocks.push({ kind: "list", items: [entry] });
    } else if (/^\s+\S/.test(line) && last?.kind === "list" && !para.length) {
      // A wrapped list item: fold it into the previous entry.
      last.items[last.items.length - 1].inline.push(...parseInline(` ${line.trim()}`));
    } else para.push(line.replace(/^>\s?/, ""));
  }
  flush();
  return blocks;
}
