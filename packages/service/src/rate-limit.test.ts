// The per-tenant request limit (02-architecture §5 «限流与配额»): a bucket of `burst` requests,
// refilled at `limit` a minute; each tenant its own; refused as `rate_limited` (`quota`) with the whole
// seconds to wait; buckets that filled up again dropped.

import { describe, expect, it } from "vitest";
import { ContractError } from "./contract-error.ts";
import { TenantRateLimiter } from "./rate-limit.ts";

/** The refusal `take` throws, or undefined when the request may go on. */
const refusal = (l: TenantRateLimiter, tenant: string) => {
  try {
    l.take(tenant);
    return undefined;
  } catch (e) {
    if (!(e instanceof ContractError)) throw e;
    return { code: e.code, ...e.detail };
  }
};

describe("the per-tenant limit", () => {
  it("lets a burst through, then refuses with the seconds until one more may come", () => {
    let now = 0;
    const l = new TenantRateLimiter(6, 3, () => now);
    for (let i = 0; i < 3; i++) expect(refusal(l, "tn_a")).toBeUndefined();
    // One request every 10 s: the next one in 10 s.
    expect(refusal(l, "tn_a")).toEqual({ code: "rate_limited", reason: "quota", retry_after: 10 });
    now = 9_999;
    expect(refusal(l, "tn_a")).toEqual({ code: "rate_limited", reason: "quota", retry_after: 1 });
    now = 10_000;
    expect(refusal(l, "tn_a")).toBeUndefined();
    expect(refusal(l, "tn_a")).toMatchObject({ retry_after: 10 });
  });

  it("a refused request takes nothing: the wait does not grow by asking", () => {
    let now = 0;
    const l = new TenantRateLimiter(60, 1, () => now);
    expect(refusal(l, "tn_a")).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(refusal(l, "tn_a")).toMatchObject({ retry_after: 1 });
    now = 1_000;
    expect(refusal(l, "tn_a")).toBeUndefined();
  });

  it("each tenant has its own bucket", () => {
    const l = new TenantRateLimiter(1, 1, () => 0);
    expect(refusal(l, "tn_a")).toBeUndefined();
    expect(refusal(l, "tn_a")).toMatchObject({ code: "rate_limited" });
    expect(refusal(l, "tn_b")).toBeUndefined();
  });

  it("a bucket that filled up again is dropped, and one still refilling is kept", () => {
    let now = 0;
    const l = new TenantRateLimiter(60, 1, () => now);
    l.take("tn_idle");
    now = 10_000;
    // Requests 2 to 1023: one tenant, its bucket empty all along; no sweep yet.
    for (let i = 0; i < 1022; i++) refusal(l, "tn_busy");
    expect(l.size).toBe(2);
    // The 1024th sweeps first: tn_idle has filled up again (10 s at one a second), tn_busy has not.
    refusal(l, "tn_busy");
    expect(l.size).toBe(1);
  });

  it("a limit or a burst that is not a whole number of at least 1 is refused", () => {
    for (const [limit, burst] of [
      [0, 1],
      [1, 0],
      [1.5, 1],
      [1, Number.NaN],
    ] as const) {
      expect(() => new TenantRateLimiter(limit, burst, () => 0)).toThrow(RangeError);
    }
  });
});
