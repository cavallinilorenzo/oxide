import { useEffect, useState } from "react";

/** How often an open GitHub panel reloads while the window is visible. */
export const REFRESH_INTERVAL_MS = 30_000;

/** A counter that changes whenever GitHub should be asked again: on window focus and on a timer
 *  that only runs while the window is visible. */
export function useAutoRefresh(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", bump);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", bump);
    };
  }, []);
  return tick;
}
