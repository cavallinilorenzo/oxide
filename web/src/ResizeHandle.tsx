import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PanelBounds } from "./panelLayout";

interface ResizeHandleProps extends PanelBounds {
  label: string;
  controls: string;
  axis: "x" | "y";
  edge: "start" | "end";
  direction?: 1 | -1;
  style?: CSSProperties;
  onResize: (value: number) => void;
  onCommit: (value: number) => void;
  onReset: () => void;
  onCancel: () => void;
}

/** An accessible splitter; pointer moves are batched once per animation frame. */
export function ResizeHandle({ label, controls, axis, edge, direction = 1, value, min, max, style,
  onResize, onCommit, onReset, onCancel }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; origin: number; value: number; element: HTMLDivElement } | null>(null);
  const pending = useRef(value);
  const frame = useRef<number | null>(null);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));

  const finish = useCallback((cancel = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const next = pending.current;
    if (cancel || next === current.value) onCancel();
    else { onResize(next); onCommit(next); }
    setDragging(false);
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }, [onResize, onCommit, onCancel]);

  useEffect(() => {
    if (!dragging) return;
    const className = axis === "x" ? "oxide-resizing-columns" : "oxide-resizing-rows";
    document.documentElement.classList.add(className);
    const stop = () => finish();
    window.addEventListener("blur", stop);
    window.addEventListener("resize", stop);
    return () => {
      document.documentElement.classList.remove(className);
      window.removeEventListener("blur", stop);
      window.removeEventListener("resize", stop);
    };
  }, [dragging, axis, finish]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (drag.current) { drag.current = null; onCancel(); }
  }, [onCancel]);

  return <div role="separator" tabIndex={max > min ? 0 : -1}
    className={`resize-handle resize-handle-${axis}`} data-edge={edge} data-dragging={dragging}
    aria-label={label} aria-controls={controls} aria-orientation={axis === "x" ? "vertical" : "horizontal"}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} pixels`}
    title={`${label}. Drag or use arrow keys; Shift for larger steps. Double-click or press Enter to reset.`}
    style={style}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0 || max <= min) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, origin: axis === "x" ? event.clientX : event.clientY, value, element: event.currentTarget };
      pending.current = value;
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      pending.current = clamp(current.value + ((axis === "x" ? event.clientX : event.clientY) - current.origin) * direction);
      if (frame.current === null) frame.current = requestAnimationFrame(() => {
        frame.current = null;
        onResize(pending.current);
      });
    }}
    onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) finish(); }}
    onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) finish(); }}
    onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) finish(); }}
    onDoubleClick={() => onReset()}
    onKeyDown={(event) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault(); event.stopPropagation(); finish(true); return;
      }
      if (drag.current) return;
      if (event.key === "Enter") { event.preventDefault(); onReset(); return; }
      const negative = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const positive = axis === "x" ? "ArrowRight" : "ArrowDown";
      let next: number;
      if (event.key === "Home") next = min;
      else if (event.key === "End") next = max;
      else if (event.key === negative || event.key === positive) next = clamp(value + (event.key === positive ? 1 : -1) * direction * (event.shiftKey ? 32 : 8));
      else return;
      event.preventDefault(); event.stopPropagation();
      onResize(next); onCommit(next);
    }} />;
}
