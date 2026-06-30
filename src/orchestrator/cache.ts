type Entry<V> = { value: V; expiresAt: number };

export class TtlCache<K, V> {
  private store = new Map<K, Entry<V>>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`ttlMs must be positive, got ${ttlMs}`);
    }
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
