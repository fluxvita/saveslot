// The bounds on fetching client documents (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»): a client
// ID is an address the server fetches, and a request does not need a sign-in to make it fetch one.
// So the fetches a cache miss makes are bounded, in this process: per source address within a
// window, and in how many run at once. The cache's own row count is bounded by the store
// (`OAuthStore.cacheClient`). The numbers are initial values; the deployment's are set later.
//
// A try takes its place before anything is awaited, so requests sent at once cannot pass a
// bound; and no live count is ever dropped to make room for a new source.

/** The bounds. */
export interface ClientFetchBounds {
  /** Cache misses one source may cause within `windowMs`. */
  readonly perSource: number;
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
  windowMs: 15 * 60_000,
  concurrent: 8,
  sources: 10_000,
  cachedRows: 10_000,
};

/** The fetches of one process: per source, and under way. */
export class ClientFetchLimits {
  readonly bounds: ClientFetchBounds;
  readonly #counts = new Map<string, { n: number; until: number }>();
  #running = 0;

  constructor(bounds: ClientFetchBounds = CLIENT_FETCH_BOUNDS) {
    this.bounds = bounds;
  }

  /**
   * Takes a place for one fetch from `source` at `now`, at once (nothing awaited): "busy" when
   * as many fetches as allowed are under way (nothing counted), "limited" when the source is at its
   * bound — or is new and the count is full of live sources. Otherwise "ok", and `done` must be
   * called when the fetch ends.
   */
  take(source: string, now: number): "ok" | "busy" | "limited" {
    if (this.#running >= this.bounds.concurrent) return "busy";
    let e = this.#counts.get(source);
    if (e !== undefined && e.until <= now) {
      this.#counts.delete(source);
      e = undefined;
    }
    if ((e?.n ?? 0) >= this.bounds.perSource) return "limited";
    if (e !== undefined) e.n++;
    else {
      if (this.#counts.size >= this.bounds.sources) {
        for (const [k, v] of this.#counts) if (v.until <= now) this.#counts.delete(k);
      }
      if (this.#counts.size >= this.bounds.sources) return "limited";
      this.#counts.set(source, { n: 1, until: now + this.bounds.windowMs });
    }
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
