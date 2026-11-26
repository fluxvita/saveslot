// The tenant pool's places (02-architecture §7 «连接»), each case built step by step on fake timers
// with a backend whose opens and closes the case settles (tenant-pool-schedule.fixture.ts). After
// each case the pool's invariants hold. The seeded schedules over the same world are in
// tenant-pool.prop.test.ts.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantId } from "./control-plane.ts";
import {
  flush,
  held,
  invariants,
  poolIn,
  stateOf,
  type World,
  world,
} from "./tenant-pool-schedule.fixture.ts";

// The kernel's lazy loads (the opening's parsers) on the real clock, before any case fakes it.
beforeAll(async () => {
  const w = world();
  w.opts.autoOpen = true;
  w.opts.autoClose = true;
  const p = poolIn(w, { maxOpen: 1 });
  await p.use("tn_warm" as TenantId, async () => {});
  await p.closeAll();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** The invariants, with the state in the message when they do not hold. */
function holds(w: World, p: ReturnType<typeof poolIn>, max: number) {
  expect(invariants(w, p, max, "end"), stateOf(w, p)).toEqual([]);
}

describe("the places of open tenants", () => {
  it("an opening that fails wakes the line: the one waiting gets the place at once, not at its time", async () => {
    const w = world();
    const p = poolIn(w, { maxOpen: 1, openWaitMs: 10_000 });
    const a = held(p, "tn_a");
    await flush();
    const b = held(p, "tn_b");
    await flush();
    expect(p.stateForTests().line).toBe(1);
    w.settleOpen(0, "fail");
    await flush();
    // No time has passed: b is opening on the place a's failed opening gave back.
    expect(p.stateForTests().line).toBe(0);
    expect(w.pendingOpens.map((x) => x.conn.tenant)).toEqual(["tn_b"]);
    w.settleOpen(0, "ok");
    await flush();
    expect([a.s.result, b.s.started]).toEqual(["connection_failed", true]);
    b.release();
    await flush();
    holds(w, p, 1);
  });

  it("one waiting past its time leaves the line: a place that comes free later goes to the next one", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 1, openWaitMs: 1000 });
    const a = held(p, "tn_a");
    await flush();
    const b = held(p, "tn_b");
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(b.s.result).toBe("pool_full");
    expect(p.stateForTests().line).toBe(0);
    a.release();
    await flush();
    const c = held(p, "tn_c");
    await flush();
    expect(c.s.started).toBe(true);
    c.release();
    await flush();
    holds(w, p, 1);
  });

  it("the idle tenant closed is the one whose last use ended first, not the one opened or used first", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 2 });
    // a opened first and used longest; b opened after it and done first.
    const a = held(p, "tn_a");
    await vi.advanceTimersByTimeAsync(10);
    const b = held(p, "tn_b");
    await vi.advanceTimersByTimeAsync(10);
    b.release();
    await vi.advanceTimersByTimeAsync(10);
    a.release();
    await vi.advanceTimersByTimeAsync(10);
    await p.use("tn_c" as TenantId, async () => {});
    const open = () =>
      w
        .live()
        .map((c) => c.tenant)
        .sort();
    expect(open()).toEqual(["tn_a", "tn_c"]);
    // Used again: d, opened after a and last used before it, is the one closed for e.
    await vi.advanceTimersByTimeAsync(10);
    await p.use("tn_d" as TenantId, async () => {});
    await vi.advanceTimersByTimeAsync(10);
    await p.use("tn_a" as TenantId, async () => {});
    await vi.advanceTimersByTimeAsync(10);
    await p.use("tn_e" as TenantId, async () => {});
    expect(open()).toEqual(["tn_a", "tn_e"]);
    holds(w, p, 2);
  });

  it("a tenant whose close failed is closed again when a place is needed, and the place goes on", async () => {
    const w = world();
    w.opts.autoOpen = true;
    const failures: string[] = [];
    const p = poolIn(w, { maxOpen: 1, openWaitMs: 5000, closeFailures: failures });
    await p.use("tn_a" as TenantId, async () => {});
    const c = held(p, "tn_c");
    await flush();
    // a is closed for c, and its close fails: a still holds its connection, and its place.
    w.settleClose(0, false);
    await flush();
    expect(failures).toEqual(["tn_a close_failed"]);
    // Its close is tried once more for c, at once.
    expect(w.pendingCloses.map((x) => x.conn.tenant)).toEqual(["tn_a"]);
    w.settleClose(0, true);
    await flush();
    expect(c.s.started).toBe(true);
    c.release();
    await flush();
    holds(w, p, 1);
  });

  it("a close that fails again is not tried again and again: the one waiting is refused at its time", async () => {
    const w = world();
    w.opts.autoOpen = true;
    const p = poolIn(w, { maxOpen: 1, openWaitMs: 1000, closeFailures: [] });
    await p.use("tn_a" as TenantId, async () => {});
    const c = held(p, "tn_c");
    await flush();
    w.settleClose(0, false);
    await flush();
    w.settleClose(0, false);
    await flush();
    // Tried twice in all: the eviction and the one retry for this line.
    expect([w.conns[0]?.closes, w.pendingCloses.length]).toEqual([2, 0]);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(c.s.result).toBe("pool_full");
    holds(w, p, 1);
  });
});

// A request's tenant held from its authentication to the end of its operation (02-architecture §7
// «连接»): two uses, never one nested use, and the tenant not idle between them.
describe("a request's hold on its tenant", () => {
  /** A request's first use (its authentication) that takes the hold inside it. */
  async function authenticated(p: ReturnType<typeof poolIn>, tenant: string) {
    let release!: () => void;
    await p.use(tenant as TenantId, async () => {
      release = p.hold(tenant as TenantId);
    });
    return release;
  }

  it("held between authentication and operation: not closed for one in line; the operation needs no place", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 1, openWaitMs: 1000 });
    const release = await authenticated(p, "tn_x");
    const y = held(p, "tn_y");
    await flush();
    // x is not idle: y waits, x stays open.
    expect([y.s.started, w.live().map((c) => c.tenant)]).toEqual([false, ["tn_x"]]);
    let operated = false;
    await p.use("tn_x" as TenantId, async () => {
      operated = true;
    });
    expect([operated, w.conns.filter((c) => c.tenant === "tn_x").length]).toEqual([true, 1]);
    // The request's response ends: x is idle, and closed for y.
    release();
    await flush();
    expect(y.s.started).toBe(true);
    y.release();
    await flush();
    holds(w, p, 1);
  });

  it("an exclusive still closes a held tenant and runs; the hold takes no place", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 1, openWaitMs: 5000 });
    const release = await authenticated(p, "tn_x");
    let ran = false;
    await p.exclusive("tn_x" as TenantId, async () => {
      ran = true;
      // Closed, and its place given back, though the hold is still taken.
      const st = p.stateForTests();
      expect([w.live().length, st.held, st.slots.find((x) => x.tenant === "tn_x")?.holds]).toEqual([
        0, 0, 1,
      ]);
      await p.use("tn_y" as TenantId, async () => {});
    });
    expect(ran).toBe(true);
    release();
    await flush();
    holds(w, p, 1);
  });

  it("closeAll does not wait for a hold; released afterwards it does nothing and leaves no timer", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 1 });
    const release = await authenticated(p, "tn_x");
    await p.closeAll();
    expect(w.live().length).toBe(0);
    release();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("released twice, a hold is given back once", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 1 });
    let first!: () => void;
    let second!: () => void;
    await p.use("tn_x" as TenantId, async () => {
      first = p.hold("tn_x" as TenantId);
      second = p.hold("tn_x" as TenantId);
    });
    first();
    first();
    const x = () => p.stateForTests().slots.find((s) => s.tenant === "tn_x");
    expect([x()?.holds, x()?.idleTimer]).toEqual([1, false]);
    second();
    expect([x()?.holds, x()?.idleTimer]).toEqual([0, true]);
    holds(w, p, 1);
  });

  it("a hold only inside a use of the tenant", () => {
    const p = poolIn(world(), { maxOpen: 1 });
    expect(() => p.hold("tn_x" as TenantId)).toThrow();
  });
});
