// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueryCache, invalidateQueries, QUERY_STALE_MS, setQueryData, useQuery, type QueryResult, type QueryState } from "./queryCache";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ok = <T,>(data: T): QueryResult<T> => ({ status: "ok", data });
const fail = (message: string): QueryResult<never> => ({ status: "error", error: { message } });
const never = <T,>() => new Promise<QueryResult<T>>(() => {});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;
let seen: QueryState<unknown>;

function Probe({ k, fetch, refresh = 0 }: { k: string; fetch: () => Promise<QueryResult<unknown>>; refresh?: number }) {
  const state = useQuery(k, fetch, refresh);
  useEffect(() => {
    seen = state;
  });
  return null;
}
const mount = (k: string, fetch: () => Promise<QueryResult<unknown>>, refresh = 0) =>
  act(async () => root.render(<Probe k={k} fetch={fetch} refresh={refresh} />));

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
});

describe("query cache", () => {
  it("shows loading once, then renders the cached data on remount without asking again while fresh", async () => {
    let resolveFirst!: () => void;
    await mount("k", () => new Promise((r) => (resolveFirst = () => r(ok("one")))));
    expect(seen.state).toBe("loading");
    await act(async () => resolveFirst());
    expect(seen).toMatchObject({ state: "ready", data: "one" });
    await act(() => root.unmount());

    root = createRoot(host);
    const fetcher = vi.fn(() => never<string>());
    await mount("k", fetcher);
    expect(seen).toMatchObject({ state: "ready", data: "one", refreshing: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revalidates silently in the background once the cached entry is older than the threshold", async () => {
    vi.useFakeTimers();
    try {
      await mount("k", async () => ok("one"));
      await act(() => root.unmount());
      await act(async () => void vi.advanceTimersByTime(QUERY_STALE_MS + 1));

      root = createRoot(host);
      const next = deferred<QueryResult<string>>();
      const fetcher = vi.fn(() => next.promise);
      await mount("k", fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      // The old data stays on screen while the refresh runs.
      expect(seen).toMatchObject({ state: "ready", data: "one", refreshing: true });
      await act(async () => next.resolve(ok("two")));
      expect(seen).toMatchObject({ state: "ready", data: "two", refreshing: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revalidate on mount while the entry is younger than the threshold", async () => {
    vi.useFakeTimers();
    try {
      await mount("k", async () => ok("one"));
      await act(() => root.unmount());
      await act(async () => void vi.advanceTimersByTime(QUERY_STALE_MS - 1));

      root = createRoot(host);
      const fetcher = vi.fn(() => never<string>());
      await mount("k", fetcher);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches when the caller bumps its refresh token, even while the entry is fresh", async () => {
    await mount("k", async () => ok("one"));
    const fetcher = vi.fn(async () => ok("two"));
    await mount("k", fetcher, 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "two" });
  });

  it("joins an identical fetch already in flight", async () => {
    const fetcher = vi.fn(() => never<string>());
    await act(async () =>
      root.render(
        <>
          <Probe k="k" fetch={fetcher} />
          <Probe k="k" fetch={fetcher} />
        </>,
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps data and reports the failure when a refresh fails; errors only without data", async () => {
    await mount("a", async () => fail("boom"));
    expect(seen).toEqual({ state: "error", message: "boom" });

    setQueryData("b", "kept");
    const fetcher = async () => fail("later");
    await mount("b", fetcher);
    // A manual refresh asks again even though the freshly written data is not stale.
    await mount("b", fetcher, 1);
    expect(seen).toMatchObject({ state: "ready", data: "kept", refreshError: "later" });
  });

  it("never applies a result to another key", async () => {
    const slow = deferred<QueryResult<string>>();
    await mount("x", () => slow.promise);
    await mount("y", async () => ok("y"));
    expect(seen).toMatchObject({ data: "y" });
    await act(async () => slow.resolve(ok("x")));
    expect(seen).toMatchObject({ data: "y" });
  });

  it("refetches mounted queries on invalidation by prefix, and can drop data", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ok(`v${++n}`));
    await mount("p:1:list", fetcher);
    expect(seen).toMatchObject({ data: "v1" });
    await act(async () => invalidateQueries("p:1:"));
    expect(seen).toMatchObject({ data: "v2" });
    await act(async () => invalidateQueries("p:2:"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(() => root.unmount());

    invalidateQueries("p:1:", { drop: true });
    root = createRoot(host);
    await mount("p:1:list", () => never<string>());
    expect(seen.state).toBe("loading");
  });

  it("refetches an unmounted entry on its next mount after invalidation, even while fresh", async () => {
    await mount("p:1:list", async () => ok("one"));
    await act(() => root.unmount());
    invalidateQueries("p:1:");

    root = createRoot(host);
    const fetcher = vi.fn(async () => ok("two"));
    await mount("p:1:list", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({ state: "ready", data: "two" });
  });

  it("stays bounded", async () => {
    for (let i = 0; i < 1000; i++) setQueryData(`k${i}`, i);
    await mount("k0", () => never<number>());
    expect(seen.state).toBe("loading");
  });
});
