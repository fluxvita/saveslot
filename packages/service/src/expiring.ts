// Entries that expire, in this process, at most a fixed number of them: the counts a server keeps
// in memory (failed logins, tenants made per source). An expired entry reads as absent. A table
// full of live entries takes no new key, rather than dropping one that is still counting: whoever
// fills it cannot wipe out another's count by doing so; the caller treats "not taken" as the limit
// reached. Internal to the package.

/** How many entries a table keeps at most, unless it says otherwise. */
export const EXPIRING_CAP = 10_000;

export class Expiring<V> {
  readonly #m = new Map<string, { value: V; until: number }>();
  readonly #cap: number;

  constructor(cap = EXPIRING_CAP) {
    this.#cap = cap;
  }

  /** The live entry of `key`, its value and when it expires. */
  entry(key: string, now: number): { readonly value: V; readonly until: number } | undefined {
    const e = this.#m.get(key);
    if (e === undefined) return undefined;
    if (e.until <= now) {
      this.#m.delete(key);
      return undefined;
    }
    return e;
  }

  get(key: string, now: number): V | undefined {
    return this.entry(key, now)?.value;
  }

  /**
   * Sets `key` until `until`, and says whether it did: a new key is not taken while the table holds
   * `cap` live entries (expired ones are dropped first to make room).
   */
  set(key: string, value: V, until: number, now: number): boolean {
    if (!this.#m.has(key) && this.#m.size >= this.#cap) {
      for (const [k, e] of this.#m) if (e.until <= now) this.#m.delete(k);
      if (this.#m.size >= this.#cap) return false;
    }
    this.#m.set(key, { value, until });
    return true;
  }

  delete(key: string): boolean {
    return this.#m.delete(key);
  }

  get size(): number {
    return this.#m.size;
  }
}

/** Counts that expire `windowMs` after their last addition. */
export class Counts {
  readonly #t: Expiring<number>;
  readonly #windowMs: number;

  constructor(windowMs: number, cap = EXPIRING_CAP) {
    this.#t = new Expiring<number>(cap);
    this.#windowMs = windowMs;
  }

  get(key: string, now: number): number {
    return this.#t.get(key, now) ?? 0;
  }

  /** Adds one to `key`'s count; false, adding nothing, when the table is full of live counts. */
  add(key: string, now: number): boolean {
    return this.#t.set(key, this.get(key, now) + 1, now + this.#windowMs, now);
  }

  /** Takes one back from `key`'s count, never under 0, leaving its expiry as it is. */
  takeBack(key: string, now: number): void {
    const e = this.#t.entry(key, now);
    if (e === undefined) return;
    if (e.value <= 1) this.#t.delete(key);
    else this.#t.set(key, e.value - 1, e.until, now);
  }
}
