export type Segment =
  | { kind: "text"; text: string }
  /** `closed` is false while the fence is still streaming in. */
  | { kind: "code"; lang: string; code: string; closed: boolean };

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;

/** Splits message content into plain text and fenced code blocks. */
export function parseSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  const lines = content.split("\n");
  let text: string[] = [];
  let i = 0;

  const flushText = () => {
    if (text.length > 0) segments.push({ kind: "text", text: text.join("\n") });
    text = [];
  };

  while (i < lines.length) {
    const open = OPEN_FENCE.exec(lines[i]);
    if (!open) {
      text.push(lines[i++]);
      continue;
    }
    // The newline before the fence stays with the preceding text.
    if (text.length > 0) text.push("");
    flushText();
    const fence = open[1];
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    const code: string[] = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      if (close.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      code.push(lines[i++]);
    }
    segments.push({ kind: "code", lang: open[2] || "text", code: code.join("\n"), closed });
  }
  flushText();
  return segments;
}
