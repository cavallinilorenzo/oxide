/** A map that evicts its least recently used entries to stay within `budget`. */
export class LruCache<K, V> {
  private entries = new Map<K, V>();
  private used = 0;

  constructor(
    private readonly budget: number,
    private readonly sizeOf: (value: V) => number
  ) {}

  /** Total size of the cached values. */
  get size(): number {
    return this.used;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert to mark as most recently used (Map keeps insertion order).
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const size = this.sizeOf(value);
    if (size > this.budget) return;
    this.entries.set(key, value);
    this.used += size;
    for (const [oldest, old] of this.entries) {
      if (this.used <= this.budget) break;
      this.entries.delete(oldest);
      this.used -= this.sizeOf(old);
    }
  }

  private delete(key: K): void {
    const old = this.entries.get(key);
    if (old === undefined) return;
    this.entries.delete(key);
    this.used -= this.sizeOf(old);
  }
}
