import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Attachment } from "./bindings";

/** Literal paths, never executable shell fragments. PowerShell and POSIX differ on apostrophes. */
export function terminalPaths(paths: string[], windows = /Windows/i.test(navigator.userAgent)): string {
  return paths.map((path) => `'${path.replaceAll("'", windows ? "''" : "'\\''")}'`).join(" ") + " ";
}

async function bytesOf(file: File): Promise<Uint8Array> {
  if (file.arrayBuffer) return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** Native Windows file drops bypass DOM drop events in Tauri. Paste images become local files. */
export function useTerminalTransfer(host: RefObject<HTMLElement | null>, visible: boolean, insert: (text: string) => void) {
  const latest = useRef(insert);
  useLayoutEffect(() => { latest.current = insert; });
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!visible || !host.current) return;
    const element = host.current;
    let active = true;
    void Promise.resolve().then(() => { if (active) { setDragging(false); setBusy(false); } });
    let unlisten: (() => void) | undefined;
    let queue = Promise.resolve();
    const files = (files: File[]) => {
      // Queue separate pastes so a slower image cannot reorder the user's input.
      queue = queue.then(async () => {
        if (!active) return;
        setBusy(true);
        setError(null);
        try {
          const paths: string[] = [];
          for (const file of files) {
            if (file.size > 25 * 1024 * 1024) throw new Error("Files can be up to 25 MB.");
            const attachment = await invoke<Attachment>("attach_bytes", await bytesOf(file), {
              headers: { "x-oxide-name": encodeURIComponent(file.name) },
            });
            paths.push(attachment.path);
          }
          if (active) latest.current(terminalPaths(paths));
        } catch (cause) {
          if (active) setError(typeof cause === "object" && cause && "message" in cause ? String(cause.message) : String(cause));
        } finally { if (active) setBusy(false); }
      });
    };
    const paste = (event: ClipboardEvent) => {
      const pasted = Array.from(event.clipboardData?.files ?? []);
      if (!pasted.length) return; // Ordinary text stays with xterm/the shell's bracketed paste.
      event.preventDefault();
      event.stopPropagation();
      files(pasted);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDragging(false);
      files(Array.from(event.dataTransfer.files));
    };
    const dragover = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    };
    const dragleave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) setDragging(false);
    };
    element.addEventListener("paste", paste, true);
    element.addEventListener("drop", drop);
    element.addEventListener("dragover", dragover);
    element.addEventListener("dragleave", dragleave);
    const over = (position: { x: number; y: number }) => {
      const rect = element.getBoundingClientRect();
      const x = position.x / window.devicePixelRatio, y = position.y / window.devicePixelRatio;
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    try {
      void getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (!active) return;
        if (payload.type === "leave") setDragging(false);
        else if (payload.type === "drop") {
          setDragging(false);
          if (over(payload.position) && payload.paths.length) latest.current(terminalPaths(payload.paths));
        } else setDragging(over(payload.position));
      }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => {});
    } catch { /* Browser previews use DOM drops. */ }
    return () => {
      active = false;
      unlisten?.();
      element.removeEventListener("paste", paste, true);
      element.removeEventListener("drop", drop);
      element.removeEventListener("dragover", dragover);
      element.removeEventListener("dragleave", dragleave);
    };
  }, [host, visible]);
  return { dragging: visible && dragging, busy, error };
}
