import { describe, expect, it } from "vitest";
import { languageForPath, MAX_HIGHLIGHT_CHARS, shouldHighlight } from "./fileLang";

describe("languageForPath", () => {
  it("maps extensions, case-insensitively, using only the file name", () => {
    expect(languageForPath("src/main.rs")).toBe("rust");
    expect(languageForPath("web/App.TSX")).toBe("tsx");
    expect(languageForPath("a.b/readme.md")).toBe("markdown");
  });
  it("maps well-known file names", () => {
    expect(languageForPath("ci/Dockerfile")).toBe("docker");
  });
  it("falls back to text", () => {
    expect(languageForPath("LICENSE")).toBe("text");
    expect(languageForPath(".gitignore")).toBe("text");
    expect(languageForPath("data.unknownext")).toBe("text");
  });
});

describe("shouldHighlight", () => {
  it("skips highlighting for very large files", () => {
    expect(shouldHighlight("x".repeat(MAX_HIGHLIGHT_CHARS))).toBe(true);
    expect(shouldHighlight("x".repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(false);
  });
});
