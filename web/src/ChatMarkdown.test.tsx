import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

const SAMPLE = [
  "## Riepilogo",
  "",
  "Ho modificato **due file** e aggiunto `parseChatMarkdown`.",
  "",
  "1. Primo passo",
  "   - dettaglio annidato",
  "   - altro dettaglio",
  "2. Secondo passo",
  "",
  "- [x] test",
  "- [ ] PR",
  "",
  "> nota importante",
  "",
  "| File | Stato |",
  "|---|---|",
  "| a.ts | ok |",
].join("\n");

describe("ChatMarkdown", () => {
  it("renders a message as structured HTML with no raw markers", () => {
    const html = renderToStaticMarkup(<ChatMarkdown text={SAMPLE} />);
    expect(html).not.toMatch(/##|\*\*|`/);
    expect(html).toContain('<strong>due file</strong>');
    expect(html).toContain("<code>parseChatMarkdown</code>");
    expect(html).toMatch(/<ol[^>]*><li><div>Primo passo<ul><li><div>dettaglio annidato/);
    expect(html).toContain("<th>File</th>");
    // The checklist is its own list, not more steps of the numbered one.
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<ul/g)).toHaveLength(2);
  });
});
