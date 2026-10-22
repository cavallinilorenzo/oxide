import { describe, expect, it } from "vitest";
import { LruCache } from "./lru";

describe("LRU cache", () => {
  it("evicts the least recently used entries once over its size budget", () => {
    const cache = new LruCache<string, string>(10, (v) => v.length);
    cache.set("a", "aaaa");
    cache.set("b", "bbbb");
    cache.get("a"); // a is now more recent than b
    cache.set("c", "cccc");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("aaaa");
    expect(cache.get("c")).toBe("cccc");
    expect(cache.size).toBe(8);
  });

  it("stays within budget however much is put in", () => {
    const cache = new LruCache<number, string>(1000, (v) => v.length);
    for (let i = 0; i < 10_000; i++) cache.set(i, "x".repeat(37));
    expect(cache.size).toBeLessThanOrEqual(1000);
    expect(cache.get(9999)).toBe("x".repeat(37));
  });

  it("does not keep a single value larger than the whole budget", () => {
    const cache = new LruCache<string, string>(4, (v) => v.length);
    cache.set("small", "ab");
    cache.set("huge", "abcdefgh");
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.get("small")).toBe("ab");
  });

  it("replacing a key accounts for the new size only", () => {
    const cache = new LruCache<string, string>(10, (v) => v.length);
    cache.set("a", "aaaaaaaa");
    cache.set("a", "aa");
    expect(cache.size).toBe(2);
  });
});
