import { describe, expect, it } from "vitest";
import { applyFormat } from "./markdownEdit";

describe("markdown toolbar", () => {
  it("wraps the selection in an inline mark, and takes it off again", () => {
    const bold = applyFormat("a word here", 2, 6, "bold");
    expect(bold).toEqual({ value: "a **word** here", start: 4, end: 8 });
    expect(applyFormat(bold.value, bold.start, bold.end, "bold").value).toBe("a word here");
  });

  it("puts the caret between the marks when nothing is selected", () => {
    expect(applyFormat("", 0, 0, "italic")).toEqual({ value: "__", start: 1, end: 1 });
  });

  it("fences a multi-line selection as code and quotes a single line inline", () => {
    expect(applyFormat("a\nb", 0, 3, "code").value).toBe("```\na\nb\n```");
    expect(applyFormat("run it", 0, 3, "code").value).toBe("`run` it");
  });

  it("links the selection and selects the url to type over", () => {
    const edit = applyFormat("see docs", 4, 8, "link");
    expect(edit.value).toBe("see [docs](url)");
    expect(edit.value.slice(edit.start, edit.end)).toBe("url");
  });

  it("prefixes every selected line, numbering lists, and toggles them off", () => {
    const list = applyFormat("one\ntwo\nthree", 0, 7, "numbers");
    expect(list.value).toBe("1. one\n2. two\nthree");
    expect(applyFormat(list.value, list.start, list.end, "numbers").value).toBe("one\ntwo\nthree");
  });

  it("switches a line from one list kind to another", () => {
    const tasks = applyFormat("- item", 0, 0, "tasks");
    expect(tasks.value).toBe("- [ ] item");
    expect(applyFormat(tasks.value, 0, 0, "bullets").value).toBe("- item");
  });

  it("works on the line the caret is in, not the whole text", () => {
    expect(applyFormat("first\nsecond", 8, 8, "quote").value).toBe("first\n> second");
  });
});
