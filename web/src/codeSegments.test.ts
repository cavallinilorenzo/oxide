import { describe, expect, it } from "vitest";
import { parseSegments } from "./codeSegments";

describe("code segments", () => {
  it("splits text around fenced code blocks, keeping the language", () => {
    const content = "Try this:\n```ts\nconst a = 1;\nconst b = 2;\n```\nThen run it.";
    expect(parseSegments(content)).toEqual([
      { kind: "text", text: "Try this:\n" },
      { kind: "code", lang: "ts", code: "const a = 1;\nconst b = 2;", closed: true },
      { kind: "text", text: "Then run it." },
    ]);
  });

  it("marks a fence still streaming as open", () => {
    expect(parseSegments("Here:\n```rust\nfn main() {")).toEqual([
      { kind: "text", text: "Here:\n" },
      { kind: "code", lang: "rust", code: "fn main() {", closed: false },
    ]);
  });

  it("treats a fence without a language as plain text code", () => {
    expect(parseSegments("```\nls -la\n```")).toEqual([
      { kind: "code", lang: "text", code: "ls -la", closed: true },
    ]);
  });

  it("only closes a fence with a matching or longer run of the same marker", () => {
    const content = "````md\n```js\nx\n```\n````";
    expect(parseSegments(content)).toEqual([
      { kind: "code", lang: "md", code: "```js\nx\n```", closed: true },
    ]);
  });

  it("returns plain text untouched", () => {
    expect(parseSegments("no code `inline` here")).toEqual([
      { kind: "text", text: "no code `inline` here" },
    ]);
  });
});
