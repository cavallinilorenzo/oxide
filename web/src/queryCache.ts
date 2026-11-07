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
  /** When the last fetch settled, or when the data was written directly. */
  updatedAt?: number;
  /** Marked by `invalidateQueries` so even an unmounted entry revalidates on its next mount. */
  stale?: boolean;
}

/** How long cached data is trusted before a mount revalidates it in the background. */
export const QUERY_STALE_MS = 30_000;

/** Entries kept per window session, least recently used first out. */
const ENTRY_BUDGET = 200;

let entries = new LruCache<string, Entry>(ENTRY_BUDGET, () => 1);
const inflight = new Map<string, number>();
const listeners = new Map<string, Set<(invalidated: boolean) => void>>();
let sequence = 0;

function notify(key: string, invalidated = false) {
  listeners.get(key)?.forEach((l) => l(invalidated));
}

/** Whether a mount should ask again: nothing cached, invalidated, or older than the threshold. */
function isStale(key: string): boolean {
  const entry = entries.get(key);
  if (entry === undefined || entry.updatedAt === undefined || entry.stale === true) return true;
  return Date.now() - entry.updatedAt >= QUERY_STALE_MS;
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
      result.status === "ok"
        ? { data: result.data, updatedAt: Date.now() }
        : { data: previous?.data, error: result.error.message, updatedAt: Date.now() },
    );
    notify(key);
  };
  fetch().then(settle, (e: unknown) => settle({ status: "error", error: { message: String(e) } }));
}

/** Shows the last known result for `key` at once. A mount only revalidates in the background when
 *  the cached entry is older than `QUERY_STALE_MS` (or was invalidated); a changed `refresh` token
 *  is an explicit ask, so it bypasses the threshold. The caller owns the refresh policy; this owns
 *  what to show meanwhile. */
export function useQuery<T>(key: string, fetch: () => Promise<QueryResult<T>>, refresh: string | number = 0): QueryState<T> {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const fetchRef = useRef(fetch);
  const seen = useRef<{ key: string; refresh: string | number } | null>(null);
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
  useEffect(() => {
    const previous = seen.current;
    seen.current = { key, refresh };
    // A token bump on the same key is a manual refresh, a mutation's invalidation, or the
    // auto-refresh timer: ask again whatever the cache's age. A first mount (or a new key)
    // reuses the cache unless it has gone stale.
    const forced = previous !== null && previous.key === key && previous.refresh !== refresh;
    if (forced || isStale(key)) run(key, () => fetchRef.current(), forced);
  }, [key, refresh]);

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
  for (const key of entries.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (options.drop) entries.delete(key);
    else entries.set(key, { ...entries.get(key), stale: true });
  }
  for (const key of [...listeners.keys()]) if (key.startsWith(prefix)) notify(key, true);
}

/** The last known data for `key`, if any. */
export function getQueryData<T>(key: string): T | undefined {
  return entries.get(key)?.data as T | undefined;
}

/** Replaces a key's data directly, e.g. after a mutation returned the new value or a list seeded a
 *  detail view's preview. Written data counts as fresh. */
export function setQueryData<T>(key: string, data: T): void {
  entries.set(key, { data, updatedAt: Date.now() });
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
