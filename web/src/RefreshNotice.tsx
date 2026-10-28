import type { QueryState } from "./queryCache";

/** A small inline note under stale data whose background refresh failed; nothing otherwise. */
export function RefreshNotice({ query }: { query: QueryState<unknown> }) {
  if (query.state !== "ready" || query.refreshError === undefined) return null;
  return (
    <p role="status" className="pr-notice">
      Couldn't refresh: {query.refreshError}
    </p>
  );
}
