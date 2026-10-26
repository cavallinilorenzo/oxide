import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./prMarkdown";

describe("parseMarkdown", () => {
  it("drops HTML comments and bot metadata", () => {
    const blocks = parseMarkdown(
      "<!-- What changes and why. -->\nBumps `a` from 1 to 2.\n\n---\nupdated-dependencies:\n- dependency-name: a\n...\n",
    );
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        inline: [
          { kind: "text", text: "Bumps " },
          { kind: "code", text: "a" },
          { kind: "text", text: " from 1 to 2." },
        ],
      },
    ]);
  });

  it("reads checklists with their state", () => {
    const [list] = parseMarkdown("- [ ] Tests added\n- [x] Docs");
    expect(list).toMatchObject({ kind: "list", items: [{ checked: false }, { checked: true }] });
  });

  it("keeps only link text and strips raw tags", () => {
    const [p] = parseMarkdown("<details><summary>Notes</summary>See [the docs](https://x.y/z)</details>");
    expect(p).toEqual({
      kind: "paragraph",
      inline: [
        { kind: "text", text: "NotesSee " },
        { kind: "link", text: "the docs" },
      ],
    });
  });

  it("keeps fenced code verbatim", () => {
    expect(parseMarkdown("```\n- not a list\n```")).toEqual([{ kind: "code", text: "- not a list" }]);
  });
});
