import { useEffect, useRef, useState } from "react";

/** Steady typing speed, in characters per second. */
const BASE_CPS = 110;
/** A backlog is worked off within about this long, so the text never lags far behind the stream. */
const CATCH_UP_MS = 350;
/** Longest frame gap honoured; a backgrounded tab resumes smoothly instead of jumping. */
const MAX_FRAME_MS = 64;

/**
 * Next revealed length after `dtMs`: fast typing speed, speeding up in
 * proportion to the backlog so a burst of tokens drains quickly. Fractional,
 * so the pace is independent of the frame rate.
 */
export function advanceReveal(revealed: number, target: number, dtMs: number): number {
  const backlog = target - revealed;
  if (backlog <= 0) return target;
  const cps = Math.max(BASE_CPS, (backlog * 1000) / CATCH_UP_MS);
  return Math.min(target, revealed + (cps * Math.min(dtMs, MAX_FRAME_MS)) / 1000);
}

/** Cuts at `count` characters without splitting a surrogate pair. */
export function revealPrefix(text: string, count: number): string {
  let end = Math.min(text.length, Math.floor(count));
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * `text` typed out one character at a time. What is already there when the
 * component mounts shows at once; only text that arrives afterwards is typed.
 */
export function useTypewriter(text: string): string {
  const [revealed, setRevealed] = useState(text.length);
  // Fractional position, so the pace does not depend on the frame rate.
  const position = useRef(text.length);

  useEffect(() => {
    if (prefersReducedMotion() || text.length < position.current) {
      position.current = text.length;
      setRevealed(text.length);
      return;
    }
    if (position.current >= text.length) return;
    let last = performance.now();
    let frame = 0;
    const step = (now: number) => {
      position.current = advanceReveal(position.current, text.length, now - last);
      last = now;
      setRevealed(Math.floor(position.current));
      if (position.current < text.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);

  return revealPrefix(text, revealed);
}
