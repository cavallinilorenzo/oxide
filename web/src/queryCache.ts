import { useEffect, useReducer, useRef } from "react";
import { LruCache } from "./lru";

/** The shape every `commands.*` read returns. */
export type QueryResult<T> = { status: "ok"; data: T } | { status: "error"; error: { message: string } };

export type QueryState<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  /** `refreshing` while a background fetch runs; `refreshError` when the last refresh failed. */
  | { state: "ready"; data: T; refreshing: boolean; refreshError?: string };

interface Entry {
  data?: unknown;
  error?: string;
}

/** Entries kept per window session, least recently used first out. */
const ENTRY_BUDGET = 200;

let entries = new LruCache<string, Entry>(ENTRY_BUDGET, () => 1);
const inflight = new Map<string, number>();
const listeners = new Map<string, Set<(invalidated: boolean) => void>>();
let sequence = 0;

function notify(key: string, invalidated = false) {
  listeners.get(key)?.forEach((l) => l(invalidated));
}

function subscribe(key: string, listener: (invalidated: boolean) => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Fetches `key`, joining a fetch already in flight unless `force`. A result is only applied if no
 *  newer fetch for the same key started meanwhile. */
function run<T>(key: string, fetch: () => Promise<QueryResult<T>>, force: boolean): void {
  if (!force && inflight.has(key)) return;
  const id = ++sequence;
  inflight.set(key, id);
  notify(key);
  const settle = (result: QueryResult<T>) => {
    if (inflight.get(key) !== id) return;
    inflight.delete(key);
    const previous = entries.get(key);
    entries.set(
      key,
      result.status === "ok" ? { data: result.data } : { data: previous?.data, error: result.error.message },
    );
    notify(key);
  };
  fetch().then(settle, (e: unknown) => settle({ status: "error", error: { message: String(e) } }));
}

/** Shows the last known result for `key` at once and refetches in the background whenever `key` or
 *  `refresh` changes, and once on mount. The caller owns the refresh policy; this owns what to show
 *  meanwhile. */
export function useQuery<T>(key: string, fetch: () => Promise<QueryResult<T>>, refresh: string | number = 0): QueryState<T> {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const fetchRef = useRef(fetch);
  useEffect(() => {
    fetchRef.current = fetch;
  });

  useEffect(
    () =>
      subscribe(key, (invalidated) => {
        if (invalidated) run(key, () => fetchRef.current(), true);
        rerender();
      }),
    [key],
  );
  useEffect(() => run(key, () => fetchRef.current(), false), [key, refresh]);

  const entry = entries.get(key);
  if (entry?.data !== undefined) {
    return { state: "ready", data: entry.data as T, refreshing: inflight.has(key), refreshError: entry.error };
  }
  if (entry?.error !== undefined) return { state: "error", message: entry.error };
  return { state: "loading" };
}

/** Marks every entry under `prefix` stale: mounted queries refetch now, unmounted ones on their next
 *  mount. With `drop`, the old data is discarded instead of shown meanwhile. */
export function invalidateQueries(prefix: string, options: { drop?: boolean } = {}): void {
  if (options.drop) {
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
  }
  for (const key of [...listeners.keys()]) if (key.startsWith(prefix)) notify(key, true);
}

/** The last known data for `key`, if any. */
export function getQueryData<T>(key: string): T | undefined {
  return entries.get(key)?.data as T | undefined;
}

/** Replaces a key's data directly, e.g. after a mutation returned the new value. */
export function setQueryData<T>(key: string, data: T): void {
  entries.set(key, { data });
  notify(key);
}

/** Rewrites the data of every entry under `prefix`, e.g. to take a merged pull request off cached lists. */
export function updateQueries<T>(prefix: string, update: (data: T) => T): void {
  for (const key of entries.keys()) {
    if (!key.startsWith(prefix)) continue;
    const entry = entries.get(key);
    if (entry?.data === undefined) continue;
    entries.set(key, { ...entry, data: update(entry.data as T) });
    notify(key);
  }
}

/** Forgets everything (tests). */
export function clearQueryCache(): void {
  entries = new LruCache<string, Entry>(ENTRY_BUDGET, () => 1);
  inflight.clear();
}
