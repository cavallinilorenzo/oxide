import { useEffect, useRef, type CSSProperties } from "react";
import "./skeleton.css";

type SkeletonKind = "list" | "detail" | "form" | "tree" | "code" | "diff" | "board" | "conversation" | "picker";

/** Content-shaped placeholders. Mount only while the corresponding content is unavailable. */
export function Skeleton({ kind = "list", label = "Loading…", rows = 4, style }: {
  kind?: SkeletonKind;
  label?: string;
  rows?: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current!;
    let visible = true;
    const update = () => { element.dataset.paused = String(document.hidden || !visible); };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer?.observe(element);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const line = (width: string, className = "") => <span className={`skeleton-block ${className}`} style={{ width }} />;
  const lines = (count: number) => Array.from({ length: count }, (_, i) => (
    <div className="skeleton-line" key={i}>{line(`${[82, 61, 92, 48, 73][i % 5]}%`)}</div>
  ));
  const list = (compact = false) => Array.from({ length: rows }, (_, i) => (
    <div className={`skeleton-row${compact ? " skeleton-row-compact" : ""}`} key={i}>
      {line("14px", "skeleton-icon")}
      <div className="skeleton-row-body">
        {line(`${[78, 58, 87, 66][i % 4]}%`)}
        {!compact && <>{line("46%", "skeleton-meta")}{line("58%", "skeleton-meta")}</>}
      </div>
    </div>
  ));
  const code = <div className="skeleton-code-body">{line("52%", "skeleton-heading")}{lines(12)}</div>;
  const conversation = <div className="skeleton-conversation-body">
    <div className="skeleton-prompt">{lines(2)}</div>
    <div className="skeleton-answer">{line("22%", "skeleton-meta")}{lines(5)}</div>
  </div>;
  return (
    <div ref={ref} className={`skeleton skeleton-${kind}`} role="status" aria-busy="true" style={style}>
      <span className="sr-only">{label}</span>
      <div className="skeleton-shapes" aria-hidden="true">
        {kind === "list" && list()}
        {(kind === "tree" || kind === "picker") && list(true)}
        {kind === "code" && code}
        {kind === "diff" && <div className="diff-split"><div className="diff-files">{list(true)}</div>{code}</div>}
        {kind === "detail" && <div className="skeleton-detail-body">
          {line("80%", "skeleton-heading")}{line("58%", "skeleton-heading")}
          {line("38%", "skeleton-meta")}
          <div className="skeleton-description">{lines(6)}</div>
          {line("28%", "skeleton-heading")}{list(true)}
        </div>}
        {kind === "form" && <div className="skeleton-form-body">
          {line("24%", "skeleton-meta")}{line("100%", "skeleton-field")}
          {line("18%", "skeleton-meta")}{line("100%", "skeleton-textarea")}
          {line("32%", "skeleton-field")}
        </div>}
        {kind === "board" && <div className="board-columns">
          {["Needs input", "Working", "Completed"].map((title) => <section className="board-column" key={title}>
            <h3 className="board-column-title">{title}</h3>
            <div className="board-cards">{[0, 1].map((i) => <div className="board-card" key={i}>
              {line(i ? "62%" : "82%")}{line("46%", "skeleton-meta")}
              {line("30%", "skeleton-field")}
            </div>)}</div>
          </section>)}
        </div>}
        {kind === "conversation" && conversation}
      </div>
    </div>
  );
}
