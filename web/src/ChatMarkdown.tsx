import { memo, useMemo, type ReactNode } from "react";
import { parseChatMarkdown, type Block, type Inline } from "./chatMarkdownParse";

function inline(parts: Inline[]): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.kind) {
      case "code":
        return <code key={i}>{p.text}</code>;
      case "strong":
        return <strong key={i}>{inline(p.children)}</strong>;
      case "em":
        return <em key={i}>{inline(p.children)}</em>;
      case "del":
        return <del key={i}>{inline(p.children)}</del>;
      case "link":
        // Never a real anchor: a click would navigate the app's own webview.
        return (
          <span key={i} className="md-link" title={p.href}>
            {inline(p.children)}
          </span>
        );
      case "text":
        return p.text;
    }
  });
}

function blockView(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case "heading":
      return (
        <p key={key} className={`md-h md-h${Math.min(b.level, 4)}`} role="heading" aria-level={b.level}>
          {inline(b.inline)}
        </p>
      );
    case "paragraph":
      return <p key={key}>{inline(b.inline)}</p>;
    case "rule":
      return <hr key={key} />;
    case "quote":
      return <blockquote key={key}>{b.blocks.map(blockView)}</blockquote>;
    case "list": {
      const items = b.items.map((item, j) => (
        <li key={j} className={item.checked === null ? undefined : "md-task"}>
          {item.checked !== null && (
            <span className={`md-box${item.checked ? " done" : ""}`} role="img" aria-label={item.checked ? "Done" : "Not done"} />
          )}
          <div>
            {inline(item.inline)}
            {item.children.map(blockView)}
          </div>
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start} style={{ counterReset: `md-item ${b.start - 1}` }}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table":
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {b.header.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((c, k) => (
                    <td key={k}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** The prose between an agent message's code blocks. Memoized, so only the text still streaming re-parses. */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseChatMarkdown(text), [text]);
  return <div className="chat-md">{blocks.map(blockView)}</div>;
});
