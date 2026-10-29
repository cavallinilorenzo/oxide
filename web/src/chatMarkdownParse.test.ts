import { describe, expect, it } from "vitest";
import { parseChatMarkdown, parseInline } from "./chatMarkdownParse";

const t = (text: string) => ({ kind: "text", text });

describe("parseInline", () => {
  it("reads code, strong, emphasis and links", () => {
    expect(parseInline("a `b` **c** *d* [e](http://x)")).toEqual([
      t("a "),
      { kind: "code", text: "b" },
      t(" "),
      { kind: "strong", children: [t("c")] },
      t(" "),
      { kind: "em", children: [t("d")] },
      t(" "),
      { kind: "link", href: "http://x", children: [t("e")] },
    ]);
  });

  it("leaves unfinished markup as text while streaming", () => {
    expect(parseInline("a **bo")).toEqual([t("a **bo")]);
  });

  it("does not treat snake_case or a lone star as emphasis", () => {
    expect(parseInline("my_var_name and 2 * 3 * 4")).toEqual([t("my_var_name and 2 * 3 * 4")]);
  });
});

describe("parseChatMarkdown", () => {
  it("reads headings and paragraphs", () => {
    expect(parseChatMarkdown("## Title\n\nBody")).toEqual([
      { kind: "heading", level: 2, inline: [t("Title")] },
      { kind: "paragraph", inline: [t("Body")] },
    ]);
  });

  it("nests lists and keeps ordered numbering", () => {
    const [list] = parseChatMarkdown("3. one\n   - sub\n4. two");
    expect(list).toMatchObject({ kind: "list", ordered: true, start: 3 });
    if (list.kind !== "list") throw new Error();
    expect(list.items).toHaveLength(2);
    expect(list.items[0].children[0]).toMatchObject({ kind: "list", ordered: false });
  });

  it("keeps a list together across a blank line", () => {
    const blocks = parseChatMarkdown("- a\n\n- b");
    expect(blocks).toHaveLength(1);
  });

  it("starts a new list when numbered turns into bulleted", () => {
    expect(parseChatMarkdown("1. a\n2. b\n\n- c").map((b) => b.kind)).toEqual(["list", "list"]);
    expect(parseChatMarkdown("1. a\n- c").map((b) => b.kind)).toEqual(["list", "list"]);
  });

  it("reads task items", () => {
    const [list] = parseChatMarkdown("- [x] done\n- [ ] todo");
    if (list.kind !== "list") throw new Error();
    expect(list.items.map((i) => i.checked)).toEqual([true, false]);
  });

  it("reads quotes and rules", () => {
    expect(parseChatMarkdown("> hi\n\n---")).toEqual([
      { kind: "quote", blocks: [{ kind: "paragraph", inline: [t("hi")] }] },
      { kind: "rule" },
    ]);
  });

  it("reads tables and pads short rows", () => {
    const [table] = parseChatMarkdown("| A | B |\n|---|:-:|\n| 1 |\n| 2 | 3 |");
    if (table.kind !== "table") throw new Error();
    expect(table.header).toHaveLength(2);
    expect(table.rows[0]).toEqual([[t("1")], []]);
    expect(table.rows).toHaveLength(2);
  });

  it("shows a half-streamed table as text", () => {
    expect(parseChatMarkdown("| A | B |")[0].kind).toBe("paragraph");
  });
});
