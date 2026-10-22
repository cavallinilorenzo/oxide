import { memo, useEffect, useMemo, useState } from "react";
import { parseSegments } from "./codeSegments";
import { highlighter } from "./highlighter";

/**
 * An Item's text with its code blocks highlighted. Memoized on `content`, so
 * finalized Items never re-render or re-parse; only the streaming one does.
 */
export const ItemContent = memo(function ItemContent({ content }: { content: string }) {
  const segments = useMemo(() => parseSegments(content), [content]);
  return (
    <div className="message-content">
      {segments.map((s, i) =>
        s.kind === "text" ? (
          <span key={i}>{s.text}</span>
        ) : (
          <CodeBlock key={i} code={s.code} lang={s.lang} closed={s.closed} />
        )
      )}
    </div>
  );
});

/** Plain until highlighted; a fence still streaming in stays plain. */
const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  closed,
}: {
  code: string;
  lang: string;
  closed: boolean;
}) {
  const [highlighted, setHighlighted] = useState<{ code: string; lang: string; html: string } | null>(
    null
  );
  const cached = closed ? highlighter().cached(code, lang) : undefined;
  const html =
    cached ?? (highlighted?.code === code && highlighted.lang === lang ? highlighted.html : undefined);

  useEffect(() => {
    if (!closed || html !== undefined) return;
    let active = true;
    highlighter()
      .highlight(code, lang)
      .then((h) => active && setHighlighted({ code, lang, html: h }))
      .catch(() => {
        // Stays plain text.
      });
    return () => {
      active = false;
    };
  }, [code, lang, closed, html]);

  if (html !== undefined) {
    // Shiki's output, generated from escaped source in our own worker.
    return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <div className="code-block">
      <pre className="shiki code-plain">
        <code>{code}</code>
      </pre>
    </div>
  );
});
