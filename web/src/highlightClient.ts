import { LruCache } from "./lru";

export interface HighlightRequest {
  id: number;
  code: string;
  lang: string;
}

export type HighlightResponse = { id: number; html: string } | { id: number; error: string };

/** The part of `Worker` the client uses, so tests can stand in for it. */
export interface WorkerLike {
  postMessage: (request: HighlightRequest) => void;
  onmessage: ((event: MessageEvent<HighlightResponse>) => void) | null;
}

export interface HighlightClient {
  /** Highlighted HTML for `code`, computed off the main thread. */
  highlight: (code: string, lang: string) => Promise<string>;
  /** Highlighted HTML if already cached, so a remount paints it at once. */
  cached: (code: string, lang: string) => string | undefined;
  /** Characters of highlighted HTML held in the cache. */
  cacheSize: () => number;
}

/** About 8 MB of UTF-16: highlighted HTML is ~10x its source, so keep it bounded. */
const DEFAULT_CACHE_BUDGET = 4_000_000;

export function createHighlightClient(
  worker: WorkerLike,
  { cacheBudget = DEFAULT_CACHE_BUDGET } = {}
): HighlightClient {
  const cache = new LruCache<string, string>(cacheBudget, (html) => html.length);
  const inFlight = new Map<string, Promise<string>>();
  const waiting = new Map<number, { resolve: (html: string) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  worker.onmessage = ({ data }) => {
    const entry = waiting.get(data.id);
    if (!entry) return;
    waiting.delete(data.id);
    if ("html" in data) entry.resolve(data.html);
    else entry.reject(new Error(data.error));
  };

  const keyOf = (code: string, lang: string) => `${lang}\0${code}`;

  return {
    highlight(code, lang) {
      const key = keyOf(code, lang);
      const hit = cache.get(key);
      if (hit !== undefined) return Promise.resolve(hit);
      const pending = inFlight.get(key);
      if (pending) return pending;

      const id = nextId++;
      const promise = new Promise<string>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      })
        .then((html) => {
          cache.set(key, html);
          return html;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      worker.postMessage({ id, code, lang });
      return promise;
    },
    cached: (code, lang) => cache.get(keyOf(code, lang)),
    cacheSize: () => cache.size,
  };
}
