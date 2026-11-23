// The in-memory tables of entries that expire: an expired entry reads as absent; a table full of
// live entries takes no new key and drops none of them; counts added, taken back and expiring.

import { describe, expect, it } from "vitest";
import { Counts, Expiring } from "./expiring.ts";

describe("entries that expire", () => {
  it("read as absent from their expiry on", () => {
    const t = new Expiring<number>();
    expect(t.set("a", 1, 100, 0)).toBe(true);
    expect(t.get("a", 99)).toBe(1);
    expect(t.get("a", 100)).toBeUndefined();
    expect(t.size).toBe(0);
  });

  it("full of live entries, take no new key and keep every one they hold", () => {
    const t = new Expiring<number>(2);
    expect(t.set("a", 1, 1000, 0)).toBe(true);
    expect(t.set("b", 1, 1000, 0)).toBe(true);
    expect(t.set("c", 1, 1000, 0)).toBe(false);
    expect([t.get("a", 0), t.get("b", 0), t.get("c", 0)]).toEqual([1, 1, undefined]);
    // A key already there is still set.
    expect(t.set("a", 2, 1000, 0)).toBe(true);
    expect(t.get("a", 0)).toBe(2);
  });

  it("full, make room by dropping expired entries only", () => {
    const t = new Expiring<number>(2);
    t.set("a", 1, 50, 0);
    t.set("b", 1, 1000, 0);
    expect(t.set("c", 1, 1000, 60)).toBe(true);
    expect([t.get("a", 60), t.get("b", 60), t.get("c", 60)]).toEqual([undefined, 1, 1]);
  });
});

describe("counts", () => {
  it("add up within their window, expire after the last addition, never go under 0", () => {
    const c = new Counts(100);
    expect(c.add("k", 0)).toBe(true);
    expect(c.add("k", 50)).toBe(true);
    expect(c.get("k", 149)).toBe(2);
    expect(c.get("k", 150)).toBe(0);
    c.add("k", 200);
    c.takeBack("k", 210);
    c.takeBack("k", 210);
    expect(c.get("k", 210)).toBe(0);
  });

  it("taken back, keep their expiry", () => {
    const c = new Counts(100);
    c.add("k", 0);
    c.add("k", 0);
    c.takeBack("k", 90);
    expect(c.get("k", 99)).toBe(1);
    expect(c.get("k", 100)).toBe(0);
  });

  it("full of live counts, add none to a new key", () => {
    const c = new Counts(100, 1);
    expect(c.add("a", 0)).toBe(true);
    expect(c.add("b", 0)).toBe(false);
    expect(c.get("b", 0)).toBe(0);
    expect(c.add("a", 0)).toBe(true);
    expect(c.get("a", 0)).toBe(2);
  });
});
