import { useMemo, type ReactNode } from "react";
import { limitBlocks, parseMarkdown, type Inline } from "./prMarkdown";

function inline(parts: Inline[]): ReactNode[] {
  return parts.map((p, i) => {
    if (p.kind === "code") return <code key={i}>{p.text}</code>;
    if (p.kind === "strong") return <strong key={i}>{p.text}</strong>;
    if (p.kind === "link") return <span key={i} className="md-link">{p.text}</span>;
    return p.text;
  });
}

/** A pull request description or comment, read for the narrow panel. */
export function Markdown({ source, maxLines }: { source: string; maxLines?: number }) {
  const blocks = useMemo(() => {
    const all = parseMarkdown(source);
    return maxLines === undefined ? all : limitBlocks(all, maxLines).blocks;
  }, [source, maxLines]);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return <p key={i} className={`md-h md-h${Math.min(b.level, 3)}`}>{inline(b.inline)}</p>;
          case "paragraph":
            return <p key={i}>{inline(b.inline)}</p>;
          case "code":
            return <pre key={i}>{b.text}</pre>;
          case "rule":
            return <hr key={i} />;
          case "list":
            return (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j} className={item.checked === null ? undefined : "md-task"}>
                    {item.checked !== null && (
                      <span className={`md-box${item.checked ? " done" : ""}`} role="img" aria-label={item.checked ? "Done" : "Not done"} />
                    )}
                    <span>{inline(item.inline)}</span>
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}
