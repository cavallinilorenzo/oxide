import { createHighlightClient, type HighlightClient } from "./highlightClient";

let client: HighlightClient | null = null;

/** The app's one highlight worker, started (and its grammars warmed) on first call. */
export function highlighter(): HighlightClient {
  client ??= createHighlightClient(
    new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" })
  );
  return client;
}
