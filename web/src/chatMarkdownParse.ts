/** Markdown for an agent's messages: headings, emphasis, lists, quotes, tables, inline code.
 *  Fenced code is split off beforehand (see codeSegments). Output is data, never HTML, and
 *  anything unfinished while a message streams in (`**bo`, a half table) simply reads as text. */

export type Inline =
  | { kind: "text" | "code"; text: string }
  | { kind: "strong" | "em" | "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export interface ListItem {
  inline: Inline[];
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]*)\)|\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|~~(?=\S)(.+?)(?<=\S)~~|\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*|(?<![\w])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w])/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "link", href: m[3], children: parseInline(m[2]) });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ kind: "strong", children: parseInline(m[4] ?? m[5]) });
    else if (m[6] !== undefined) out.push({ kind: "del", children: parseInline(m[6]) });
    else out.push({ kind: "em", children: parseInline(m[7] ?? m[8]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

function cells(line: string): string[] {
  const row = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parseList(lines: string[], from: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[from])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line keeps the list going only when another item follows.
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const following = j < lines.length ? ITEM.exec(lines[j]) : null;
      if (!following || following[1].length < base) break;
      i = j;
      continue;
    }
    const item = ITEM.exec(line);
    const depth = indentOf(line);
    if (item && depth === base) {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      items.push({
        inline: parseInline(task ? task[2] : item[3]),
        checked: task ? task[1] !== " " : null,
        children: [],
      });
      i++;
    } else if (item && depth > base && items.length) {
      const nested = parseList(lines, i);
      items[items.length - 1].children.push(nested.block);
      i = nested.next;
    } else if (!item && depth > base && items.length) {
      // A wrapped item: fold it into the entry above.
      items[items.length - 1].inline.push(...parseInline(`\n${line.trim()}`));
      i++;
    } else break;
  }
  const start = ordered ? Number.parseInt(first[2], 10) : 1;
  return { block: { kind: "list", ordered, start, items }, next: i };
}

export function parseChatMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", inline: parseInline(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const heading = HEADING.exec(line);
    if (!line.trim()) {
      flush();
      i++;
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, inline: parseInline(heading[2]) });
      i++;
    } else if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      i++;
    } else if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(QUOTE.exec(lines[i])![1]);
      blocks.push({ kind: "quote", blocks: parseChatMarkdown(inner.join("\n")) });
    } else if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const header = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) {
        const row = cells(lines[i]).map(parseInline);
        while (row.length < header.length) row.push([]);
        rows.push(row.slice(0, header.length));
      }
      blocks.push({ kind: "table", header, rows });
    } else if (ITEM.test(line) && !RULE.test(line)) {
      flush();
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
    } else {
      para.push(line);
      i++;
    }
  }
  flush();
  return blocks;
}
