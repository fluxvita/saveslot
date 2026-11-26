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
    expect([a.s.result, b.s.started]).toEqual(["open_failed", true]);
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

// An open tenant lent only while it is good (02-architecture §7 «连接»): its connection not gone, and
// its database the one the directory names; else closed and opened again by the use.
describe("an open tenant opened again", () => {
  /** The connection a use was lent. */
  async function lent(w: World, p: ReturnType<typeof poolIn>, tenant: string, entry?: object) {
    let conn: number | undefined;
    await p.use(
      tenant as TenantId,
      async (t) => {
        conn = w.connOf(t.store as object)?.id;
      },
      entry === undefined ? {} : { entry: entry as never },
    );
    return conn;
  }

  it("its connection gone: the next use closes it and opens it again, told as connection", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const reopened: string[] = [];
    const p = poolIn(w, { maxOpen: 2, reopened });
    const first = await lent(w, p, "tn_a");
    w.kill("tn_a");
    const second = await lent(w, p, "tn_a");
    expect(second).not.toBe(first);
    expect(w.conns.find((c) => c.id === first)?.closes).toBe(1);
    expect(reopened).toEqual(["tn_a connection"]);
    holds(w, p, 2);
  });

  it("another database named for it: opened again on that one, whether the use read the directory or was given its row", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const reopened: string[] = [];
    const p = poolIn(w, { maxOpen: 2, reopened });
    await lent(w, p, "tn_a");
    // The pool reads the directory itself.
    w.databases.set("tn_a", "tn_a_swapped");
    const read = await lent(w, p, "tn_a");
    expect(w.conns.find((c) => c.id === read)?.tenant).toBe("tn_a_swapped");
    // Given the row (a request's authentication read it): compared with what is open.
    w.databases.set("tn_a", "tn_a_again");
    const given = await lent(w, p, "tn_a", {
      id: "tn_a",
      owner: "u_00000000000000000000000001",
      ref: { kind: "postgres", cell: "c", database: "tn_a_again" },
      state: "active",
    });
    expect(w.conns.find((c) => c.id === given)?.tenant).toBe("tn_a_again");
    expect(reopened).toEqual(["tn_a database", "tn_a database"]);
    expect(w.live().map((c) => c.tenant)).toEqual(["tn_a_again"]);
    holds(w, p, 2);
  });

  it("a use given the directory's row of an open tenant reads no other: one read for a request", async () => {
    const w = world();
    w.opts.autoOpen = true;
    const p = poolIn(w, { maxOpen: 2 });
    const row = {
      id: "tn_a",
      owner: "u_00000000000000000000000001",
      ref: { kind: "postgres", cell: "c", database: "tn_a" },
      state: "active",
    };
    // Opening reads it (what it opens is the directory's at that moment).
    const first = await lent(w, p, "tn_a", row);
    const before = w.reads.directory;
    expect(await lent(w, p, "tn_a", row)).toBe(first);
    expect(await lent(w, p, "tn_a", row)).toBe(first);
    expect(w.reads.directory).toBe(before);
    // Not given: the pool reads it once for the use.
    await lent(w, p, "tn_a");
    expect(w.reads.directory).toBe(before + 1);
  });

  it("a use still on the old connection is done first; the new use gets the new connection after it", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 2 });
    const old = held(p, "tn_a");
    await flush();
    const oldConn = w.conns[0]?.id;
    w.databases.set("tn_a", "tn_a_swapped");
    let newConn: number | undefined;
    const next = p.use("tn_a" as TenantId, async (t) => {
      newConn = w.connOf(t.store as object)?.id;
    });
    await flush();
    // Not closed under the use running on it; the new use waits.
    expect([w.conns[0]?.state, newConn]).toEqual(["open", undefined]);
    old.release();
    await next;
    expect(newConn).not.toBe(oldConn);
    expect(w.conns.find((c) => c.id === oldConn)?.state).toBe("closed");
    holds(w, p, 2);
  });

  it("a gone connection whose close fails is let go: no place kept, the tenant opens again", async () => {
    const w = world();
    w.opts.autoOpen = true;
    const failures: string[] = [];
    const p = poolIn(w, { maxOpen: 1, closeFailures: failures });
    await lent(w, p, "tn_a");
    w.kill("tn_a");
    const next = lent(w, p, "tn_a");
    await flush();
    w.settleClose(0, false);
    expect(await next).toBe(2);
    expect(failures).toEqual(["tn_a close_failed"]);
    expect(p.stateForTests().held).toBe(1);
  });

  it("a hold taken before the tenant is opened again still holds it after", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 1 });
    let release!: () => void;
    await p.use("tn_a" as TenantId, async () => {
      release = p.hold("tn_a" as TenantId);
    });
    w.kill("tn_a");
    await lent(w, p, "tn_a");
    const a = () => p.stateForTests().slots.find((x) => x.tenant === "tn_a");
    // The same record, still held: not idle, no idle timer.
    expect([a()?.holds, a()?.idleTimer, a()?.open]).toEqual([1, false, true]);
    release();
    expect([a()?.holds, a()?.idleTimer]).toEqual([0, true]);
    holds(w, p, 1);
  });

  it("opened again and the database not reached: open_failed, a retry later; one try a use, not a storm", async () => {
    const w = world();
    w.opts.autoOpen = true;
    w.opts.autoClose = true;
    const p = poolIn(w, { maxOpen: 1 });
    await lent(w, p, "tn_a");
    w.kill("tn_a");
    w.opts.autoOpen = false;
    const failing = p.use("tn_a" as TenantId, async () => {});
    await flush();
    w.settleOpen(0, "fail");
    await expect(failing).rejects.toMatchObject({ code: "open_failed" });
    // Nothing tries again on its own: one open asked for, the failed one; none waiting.
    await vi.advanceTimersByTimeAsync(60_000);
    expect([w.conns.length, w.pendingOpens.length]).toEqual([2, 0]);
    // The next use tries once more, and is lent.
    w.opts.autoOpen = true;
    expect(await lent(w, p, "tn_a")).toBe(3);
    holds(w, p, 1);
  });
});
