// The tenant pool's places under seeded schedules (02-architecture §7 «连接»): uses and exclusives
// begun and ended, opens and closes settled or failed, opens refused as a full database, time moved
// on, in an order a seed draws; after each step the pool's invariants (tenant-pool-schedule.fixture.ts),
// and at the end every use settled, `closeAll` returning, and no connection, place, line or timer
// left. On fake timers, with a backend whose opens and closes each step settles.
//
// A fixed seed by default, so `pnpm check` runs the same schedules each time; the soak
// (scripts/soak-props.ts, which sets PROP_COVERAGE) and PROP_SEED take others. PROP_RUNS sets how
// many schedules.

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantId } from "./control-plane.ts";
import { TenantPoolError } from "./tenant-pool.ts";
import {
  deferred,
  flush,
  invariants,
  poolIn,
  seeded,
  stateOf,
  type World,
  world,
} from "./tenant-pool-schedule.fixture.ts";

const RUNS =
  Number.isInteger(Number(process.env["PROP_RUNS"])) && Number(process.env["PROP_RUNS"]) > 0
    ? Number(process.env["PROP_RUNS"])
    : 200;
const STEPS = 120;
const SEED =
  process.env["PROP_SEED"] !== undefined
    ? Number(process.env["PROP_SEED"])
    : process.env["PROP_COVERAGE"] !== undefined
      ? undefined
      : 20_261_127;

const unhandled: string[] = [];
const onUnhandled = (e: unknown) => unhandled.push(String((e as Error)?.message ?? e));

beforeAll(async () => {
  process.on("unhandledRejection", onUnhandled);
  // The kernel's lazy loads (the opening's parsers) on the real clock, before the schedules fake it.
  const w = world();
  w.opts.autoOpen = true;
  w.opts.autoClose = true;
  const p = poolIn(w, { maxOpen: 1 });
  await p.use("tn_warm" as TenantId, async () => {});
  await p.closeAll();
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});

interface Op {
  readonly id: number;
  readonly kind: "use" | "exclusive";
  readonly tenant: string;
  readonly fn: ReturnType<typeof deferred<void>>;
  started: boolean;
  settled: boolean;
  result?: string;
}

/** One schedule drawn from `seed`: the failures found, each with the last steps that led to it. */
async function schedule(seed: number): Promise<string[]> {
  const rnd = seeded(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)] as T;
  const w: World = world();
  const max = 1 + Math.floor(rnd() * 3);
  const tenants = Array.from({ length: max + 1 + Math.floor(rnd() * 3) }, (_, i) => `tn_${i}`);
  const p = poolIn(w, { maxOpen: max, idleMs: pick([300, 1500, 60_000]), openWaitMs: 1000 });
  const ops: Op[] = [];
  /** Holds taken inside running uses (as a request's authentication takes one), not yet released. */
  const holds: { tenant: string; release: () => void }[] = [];
  const trace: string[] = [];
  const errors: string[] = [];
  let ids = 0;
  const begin = (kind: Op["kind"], tenant: string) => {
    const op: Op = {
      id: ++ids,
      kind,
      tenant,
      fn: deferred<void>(),
      started: false,
      settled: false,
    };
    ops.push(op);
    const body = async (lent?: { store: object }) => {
      op.started = true;
      if (kind === "use") {
        const conn = w.connOf(lent?.store as object);
        if (conn?.state !== "open")
          w.violations.push(`use ${op.id} lent a ${conn?.state} connection`);
        if (conn !== undefined) w.running.set(op.id, { tenant, conn });
      } else {
        for (const c of w.live()) {
          if (c.tenant === tenant)
            w.violations.push(`exclusive ${op.id} runs with ${tenant} ${c.state}`);
        }
      }
      try {
        await op.fn.promise;
      } finally {
        w.running.delete(op.id);
      }
    };
    const run =
      kind === "use"
        ? p.use(tenant as TenantId, (t) => body(t))
        : p.exclusive(tenant as TenantId, () => body(), rnd() < 0.5 ? { refuse: "importing" } : {});
    run.then(
      () => {
        op.settled = true;
        op.result = "ok";
      },
      (e: unknown) => {
        op.settled = true;
        op.result = e instanceof TenantPoolError ? e.code : (e as Error).message;
      },
    );
  };
  const step = async (i: number) => {
    const r = rnd();
    const running = ops.filter((o) => o.started && !o.settled);
    let what: string;
    if (r < 0.3) {
      const t = pick(tenants);
      what = `use ${t}`;
      begin("use", t);
    } else if (r < 0.36) {
      const t = pick(tenants);
      what = `exclusive ${t}`;
      begin("exclusive", t);
    } else if (r < 0.55 && running.length > 0) {
      const o = pick(running);
      const ok = rnd() < 0.85;
      what = `end ${o.kind} ${o.id} ${ok ? "ok" : "failed"}`;
      if (ok) o.fn.resolve();
      else o.fn.reject(new Error("a use that fails"));
    } else if (r < 0.7 && w.pendingOpens.length > 0) {
      const k = Math.floor(rnd() * w.pendingOpens.length);
      const q = rnd();
      const how = q < 0.8 ? "ok" : q < 0.9 ? "fail" : "53300";
      what = `open ${w.pendingOpens[k]?.conn.id} ${how}`;
      w.settleOpen(k, how);
    } else if (r < 0.82 && w.pendingCloses.length > 0) {
      const k = Math.floor(rnd() * w.pendingCloses.length);
      const ok = rnd() < 0.85;
      what = `close ${w.pendingCloses[k]?.conn.id} ${ok ? "ok" : "failed"}`;
      w.settleClose(k, ok);
    } else if (r < 0.87 && running.some((o) => o.kind === "use")) {
      const o = pick(running.filter((x) => x.kind === "use"));
      what = `hold ${o.tenant} in use ${o.id}`;
      holds.push({ tenant: o.tenant, release: p.hold(o.tenant as TenantId) });
    } else if (r < 0.9 && holds.length > 0) {
      const k = Math.floor(rnd() * holds.length);
      const [h] = holds.splice(k, 1);
      what = `release the hold on ${h?.tenant}`;
      h?.release();
      // Released twice: the second does nothing.
      if (rnd() < 0.3) h?.release();
    } else if (r < 0.92) {
      w.opts.syncThrow = rnd() < 0.5 ? "53300" : "plain";
      what = "the next open throws";
    } else {
      const ms = pick([1, 10, 200, 999, 1000, 1001, 1500]);
      what = `${ms} ms on`;
      await vi.advanceTimersByTimeAsync(ms);
    }
    await flush();
    trace.push(`${i}: ${what}`);
    return invariants(w, p, max, `step ${i} (${what})`);
  };
  for (let i = 0; i < STEPS && errors.length === 0; i++) errors.push(...(await step(i)));
  // Everything settles: opens open, closes close, uses end, time moves on.
  w.opts.syncThrow = false;
  for (let k = 0; k < 200 && errors.length === 0; k++) {
    while (w.pendingOpens.length > 0) w.settleOpen(0, "ok");
    while (w.pendingCloses.length > 0) w.settleClose(0, true);
    for (const o of ops) if (o.started && !o.settled) o.fn.resolve();
    for (const h of holds.splice(0)) h.release();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    errors.push(...invariants(w, p, max, `settling ${k}`));
    if (ops.every((o) => o.settled)) break;
  }
  const stuck = ops.filter((o) => !o.settled);
  if (stuck.length > 0) {
    errors.push(`never settled: ${stuck.map((o) => `${o.kind} ${o.id} (${o.tenant})`).join(", ")}`);
  }
  let closed = false;
  void p.closeAll().then(() => {
    closed = true;
  });
  for (let k = 0; k < 200 && !closed; k++) {
    while (w.pendingOpens.length > 0) w.settleOpen(0, "ok");
    while (w.pendingCloses.length > 0) w.settleClose(0, true);
    await flush();
    await vi.advanceTimersByTimeAsync(100);
  }
  const st = p.stateForTests();
  if (!closed) errors.push("closeAll never returned");
  if (w.live().length !== 0) errors.push(`${w.live().length} connections left after closeAll`);
  if (st.held !== 0) errors.push(`${st.held} places held after closeAll`);
  if (st.line !== 0) errors.push(`${st.line} left in line after closeAll`);
  if (vi.getTimerCount() > 0) errors.push(`${vi.getTimerCount()} timers left after closeAll`);
  vi.clearAllTimers();
  return errors.length === 0
    ? []
    : [
        `seed ${seed}, ${max} places, ${tenants.length} tenants: ${errors.slice(0, 3).join("; ")}`,
        `  the last steps: ${trace.slice(-25).join(" | ")}`,
        `  ${stateOf(w, p)}`,
      ];
}

describe("the places of open tenants, under seeded schedules", () => {
  it("every step keeps the invariants; at the end everything settles and closeAll leaves nothing", {
    timeout: 600_000,
  }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
          const failures = await schedule(seed);
          expect(failures).toEqual([]);
        }),
        { numRuns: RUNS, endOnFailure: true, ...(SEED !== undefined ? { seed: SEED } : {}) },
      );
    } finally {
      vi.useRealTimers();
    }
    expect(unhandled).toEqual([]);
  });
});
