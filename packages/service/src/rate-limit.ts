// The per-tenant request limit (docs/zh-CN/spec/02-architecture.md §5 «限流与配额», §9): a token
// bucket for each tenant, refilled at a number of requests a minute up to a burst. The values are
// the server's configuration (06-cli §4.1), read where the rest of it is; with none, there is no
// limiter. One process serves a deployment (v1), so the buckets are this process's memory; a
// bucket that has filled up again is the same as none, and is dropped.

import { ContractError } from "./contract-error.ts";

/** How often (in requests taken) buckets that have filled up again are dropped. */
const SWEEP_EVERY = 1024;

interface Bucket {
  tokens: number;
  /** When `tokens` was last brought up to date, in milliseconds. */
  at: number;
}

export class TenantRateLimiter {
  readonly #burst: number;
  readonly #now: () => number;
  /** Tokens a millisecond. */
  readonly #rate: number;
  readonly #buckets = new Map<string, Bucket>();
  #taken = 0;

  /**
   * `limit`: requests a minute for each tenant; `burst`: at most that many at once (both whole,
   * at least 1). `now`: milliseconds, never going back (a monotonic clock).
   */
  constructor(limit: number, burst: number, now: () => number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(burst) || burst < 1) {
      throw new RangeError("a rate limit and its burst are whole numbers, at least 1");
    }
    this.#burst = burst;
    this.#now = now;
    this.#rate = limit / 60_000;
  }

  /**
   * Takes one request of `tenant`'s: refused with `rate_limited` (`quota`), and the whole seconds
   * until one more may come in `retry_after` (at least 1), when its bucket is empty.
   */
  take(tenant: string): void {
    const now = this.#now();
    if (++this.#taken % SWEEP_EVERY === 0) this.#sweep(now);
    const b = this.#buckets.get(tenant) ?? { tokens: this.#burst, at: now };
    b.tokens = this.#filled(b, now);
    b.at = now;
    this.#buckets.set(tenant, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    throw new ContractError("rate_limited", "too many requests for this tenant", {
      reason: "quota",
      retry_after: Math.max(1, Math.ceil((1 - b.tokens) / this.#rate / 1000)),
    });
  }

  /** How many tenants have a bucket (tests). */
  get size(): number {
    return this.#buckets.size;
  }

  #filled(b: Bucket, now: number): number {
    return Math.min(this.#burst, b.tokens + (now - b.at) * this.#rate);
  }

  #sweep(now: number): void {
    for (const [tenant, b] of this.#buckets) {
      if (this.#filled(b, now) >= this.#burst) this.#buckets.delete(tenant);
    }
  }
}
