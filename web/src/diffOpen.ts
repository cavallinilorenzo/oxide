import { createContext, useContext } from "react";
import type { DiffFile } from "./bindings";

/** Opens the Diff Surface on Uncommitted, optionally focused on a file hint
 *  (a path, or a headline that ends in one). */
export const DiffOpenContext = createContext<(hint?: string) => void>(() => {});

export const useOpenDiff = () => useContext(DiffOpenContext);

/** The file a hint refers to: an exact path, else the longest path the hint ends with. */
export function matchDiffFile(files: DiffFile[], hint: string | null): DiffFile | null {
  if (!hint) return null;
  const text = hint.trim();
  const exact = files.find((f) => f.path === text);
  if (exact) return exact;
  const suffix = files
    .filter((f) => text.endsWith(f.path) && (text.length === f.path.length || /[\s/]/.test(text[text.length - f.path.length - 1])))
    .sort((a, b) => b.path.length - a.path.length);
  return suffix[0] ?? null;
}
