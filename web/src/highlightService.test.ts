import { describe, expect, it } from "vitest";
import { createHighlightService } from "./highlightService";

describe("highlight service", () => {
  const service = createHighlightService(["typescript"]);

  it("highlights a warmed grammar into themed HTML", async () => {
    const html = await service.highlight("const answer = 42;", "ts");
    expect(html).toMatch(/^<pre class="shiki/);
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("answer");
  });

  it("loads a grammar that was not warmed on first use", async () => {
    const html = await service.highlight("main = putStrLn \"hi\"", "haskell");
    expect(html).toMatch(/<span style="[^"]*color/);
  });

  it("renders unknown languages as plain, escaped text", async () => {
    const html = await service.highlight("<b>not html</b>", "no-such-lang");
    expect(html).toMatch(/^<pre class="shiki/);
    expect(html).toContain("&#x3C;b>not html&#x3C;/b>");
  });
});
