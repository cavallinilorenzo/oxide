/** The formatting actions of the Markdown toolbar. */
export type Format = "heading" | "bold" | "italic" | "quote" | "code" | "link" | "bullets" | "numbers" | "tasks";

/** The text after an action, and the selection to restore. */
export interface Edit {
  value: string;
  start: number;
  end: number;
}

const WRAP: Partial<Record<Format, string>> = { bold: "**", italic: "_", code: "`" };
const PREFIX: Partial<Record<Format, (index: number) => string>> = {
  heading: () => "### ",
  quote: () => "> ",
  bullets: () => "- ",
  numbers: (i) => `${i + 1}. `,
  tasks: () => "- [ ] ",
};
const ANY_PREFIX: Partial<Record<Format, RegExp>> = {
  heading: /^#{1,6} /,
  quote: /^> ?/,
  bullets: /^[-*] (?!\[[ x]\] )/,
  numbers: /^\d+\. /,
  tasks: /^- \[[ x]\] /,
};

const ANY_LIST = /^(?:- \[[ x]\] |[-*] |\d+\. )/;
const LISTS: Format[] = ["bullets", "numbers", "tasks"];

/** Applies a toolbar action to `value` with the selection `start`..`end`, as GitHub's editor does:
 *  inline marks wrap the selection (or sit around the caret), line marks prefix every selected
 *  line and a second press takes them off again. */
export function applyFormat(value: string, start: number, end: number, format: Format): Edit {
  const selected = value.slice(start, end);

  if (format === "link") {
    const label = selected || "text";
    const inserted = `[${label}](url)`;
    const urlStart = start + label.length + 3;
    return { value: value.slice(0, start) + inserted + value.slice(end), start: urlStart, end: urlStart + 3 };
  }

  if (format === "code" && selected.includes("\n")) {
    const inserted = `\`\`\`\n${selected}\n\`\`\``;
    return { value: value.slice(0, start) + inserted + value.slice(end), start: start + 4, end: start + 4 + selected.length };
  }

  const mark = WRAP[format];
  if (mark !== undefined) {
    const wrapped = value.slice(start - mark.length, start) === mark && value.slice(end, end + mark.length) === mark;
    if (wrapped) {
      return {
        value: value.slice(0, start - mark.length) + selected + value.slice(end + mark.length),
        start: start - mark.length,
        end: end - mark.length,
      };
    }
    return {
      value: value.slice(0, start) + mark + selected + mark + value.slice(end),
      start: start + mark.length,
      end: end + mark.length,
    };
  }

  const prefix = PREFIX[format]!;
  const strip = ANY_PREFIX[format]!;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const newline = value.indexOf("\n", end);
  const lineEnd = newline === -1 ? value.length : newline;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const allMarked = lines.every((line) => strip.test(line));
  // Moving a line from one kind of list to another replaces its mark rather than stacking two.
  const clear = LISTS.includes(format) ? ANY_LIST : strip;
  const next = lines.map((line, i) => (allMarked ? line.replace(strip, "") : prefix(i) + line.replace(clear, "")));
  const block = next.join("\n");
  return {
    value: value.slice(0, lineStart) + block + value.slice(lineEnd),
    start: lineStart,
    end: lineStart + block.length,
  };
}
