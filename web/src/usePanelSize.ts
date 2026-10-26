import { useCallback, useEffect, useState, type RefObject } from "react";

export type PanelName = "sidebar" | "tools" | "terminal" | "files-width" | "files-height";
const storageKey = (name: PanelName) => `oxide.layout.${name}`;

function readSize(name: PanelName): number | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(name)) ?? "null");
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

export function usePanelSize(name: PanelName) {
  const [preferred, setPreferred] = useState<number | null>(() => readSize(name));
  const commit = useCallback((value: number) => {
    setPreferred(value);
    try { localStorage.setItem(storageKey(name), JSON.stringify(value)); } catch { /* Layout still works without storage. */ }
  }, [name]);
  const reset = useCallback(() => {
    setPreferred(null);
    try { localStorage.removeItem(storageKey(name)); } catch { /* Storage may be unavailable. */ }
  }, [name]);
  const cancel = useCallback(() => setPreferred(readSize(name)), [name]);
  return { preferred, resize: setPreferred, commit, reset, cancel };
}

export function useElementSize(ref: RefObject<HTMLElement | null>, initial: { width: number; height: number }) {
  const [size, setSize] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
