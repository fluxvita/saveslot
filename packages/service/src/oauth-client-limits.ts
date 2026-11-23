// The bounds on fetching client documents (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»): a client
// ID is an address the server fetches, and a request does not need a sign-in to make it fetch one.
// So the fetches a cache miss makes are bounded, in this process: per source within a window,
// and in how many run at once. A source is counted as login failures are (identity.ts
// `sourceKey`): an IPv4 address as it is, an IPv6 address by its /64, and an IPv6 address's /48
// once more under a bound of its own, so that many /64s of one site still meet a limit. The
// cache's own row count is bounded by the store (`OAuthStore.cacheClient`). The numbers are
// initial values; the deployment's are set later.
//
// A try takes its place before anything is awaited, so requests sent at once cannot pass a
// bound; and no live count is ever dropped to make room for a new source.

import { sourceKey, wideSourceKey } from "./identity.ts";

/** The bounds. */
export interface ClientFetchBounds {
  /** Cache misses one source (an IPv4 address, an IPv6 /64) may cause within `windowMs`. */
  readonly perSource: number;
  /** Cache misses one IPv6 /48 may cause within `windowMs`, all its /64s together. */
  readonly perWideSource: number;
  readonly windowMs: number;
  /** Fetches under way at once. */
  readonly concurrent: number;
  /** Sources the per-source count keeps at most. */
  readonly sources: number;
  /** Rows the client document cache keeps at most. */
  readonly cachedRows: number;
}

export const CLIENT_FETCH_BOUNDS: ClientFetchBounds = {
  perSource: 30,
  perWideSource: 150,
  windowMs: 15 * 60_000,
  concurrent: 8,
  sources: 10_000,
  cachedRows: 10_000,
};

/** One count by key, each counted until its window ends; at most `cap` keys. */
class FetchCount {
  readonly #m = new Map<string, { n: number; until: number }>();
  readonly #limit: number;
  readonly #cap: number;

  constructor(limit: number, cap: number) {
    this.#limit = limit;
    this.#cap = cap;
  }

  /**
   * Whether `key` may cause one more fetch at `now`. A new key when the count is full, after the
   * expired entries went, may not: no live count is dropped to make room.
   */
  allows(key: string, now: number): boolean {
    const e = this.#m.get(key);
    if (e !== undefined && e.until > now) return e.n < this.#limit;
    if (e !== undefined) this.#m.delete(key);
    if (this.#limit <= 0) return false;
    if (this.#m.size < this.#cap) return true;
    for (const [k, v] of this.#m) if (v.until <= now) this.#m.delete(k);
    return this.#m.size < this.#cap;
  }

  /** Counts one fetch of `key` (which `allows`); the window starts with its first. */
  add(key: string, now: number, windowMs: number): void {
    const e = this.#m.get(key);
    if (e !== undefined && e.until > now) e.n++;
    else this.#m.set(key, { n: 1, until: now + windowMs });
  }
}

/** The fetches of one process: per source, and under way. */
export class ClientFetchLimits {
  readonly bounds: ClientFetchBounds;
  readonly #sources: FetchCount;
  readonly #wide: FetchCount;
  #running = 0;

  constructor(bounds: ClientFetchBounds = CLIENT_FETCH_BOUNDS) {
    this.bounds = bounds;
    this.#sources = new FetchCount(bounds.perSource, bounds.sources);
    this.#wide = new FetchCount(bounds.perWideSource, bounds.sources);
  }

  /**
   * Takes a place for one fetch from `remote` (the request's source address) at `now`, at once
   * (nothing awaited): "busy" when as many fetches as allowed are under way (nothing counted),
   * "limited" when its source or, for IPv6, its /48 is at its bound — or is new and that count is
   * full of live sources (nothing counted). Otherwise "ok", and `done` must be called when the
   * fetch ends.
   */
  take(remote: string, now: number): "ok" | "busy" | "limited" {
    if (this.#running >= this.bounds.concurrent) return "busy";
    const source = sourceKey(remote);
    const wide = wideSourceKey(remote);
    // The /48 first, as login checks it: both are checked before either is counted.
    if (wide !== undefined && !this.#wide.allows(wide, now)) return "limited";
    if (!this.#sources.allows(source, now)) return "limited";
    if (wide !== undefined) this.#wide.add(wide, now, this.bounds.windowMs);
    this.#sources.add(source, now, this.bounds.windowMs);
    this.#running++;
    return "ok";
  }

  /** A fetch that took its place has ended. */
  done(): void {
    this.#running--;
  }
}

/** The process's own, when the host gives none. */
export const PROCESS_CLIENT_FETCHES = new ClientFetchLimits();
