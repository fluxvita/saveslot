// A world for the tenant pool's places (02-architecture §7 «连接»), wholly under a test's hand: a
// fake backend whose opens and closes wait until the test settles them (or settle at once when
// told to), a fake control plane, and the invariants that must hold whenever the pool has nothing
// left to do. Used by the fixed constructions (tenant-pool-places.test.ts) and the seeded schedules
// (tenant-pool.prop.test.ts), on fake timers.

import type { StorageBackend } from "@fluxvita/saveslot-kernel";
import type { ControlPlane, TenantId } from "./control-plane.ts";
import { TenantPool, type TenantPoolOptions } from "./tenant-pool.ts";

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

type ConnState = "opening" | "open" | "closing" | "closed" | "refused";
export interface Conn {
  readonly id: number;
  readonly tenant: string;
  state: ConnState;
  closes: number;
}

/** The fake backend's connections and the pool's uses on them, and what went wrong under them. */
export function world() {
  const conns: Conn[] = [];
  const pendingOpens: { conn: Conn; d: ReturnType<typeof deferred<unknown>> }[] = [];
  const pendingCloses: { conn: Conn; d: ReturnType<typeof deferred<void>> }[] = [];
  /** The uses running now, by an ID of the test's, with the connection each was lent. */
  const running = new Map<number, { tenant: string; conn: Conn }>();
  const violations: string[] = [];
  const opts = {
    /** Opens settle at once, as `ok`. */
    autoOpen: false,
    /** Closes settle at once, as done. */
    autoClose: false,
    /** The next open throws before it returns a promise: as a full database, or another error. */
    syncThrow: false as false | "53300" | "plain",
  };
  let ids = 0;
  const storeOf = new WeakMap<object, Conn>();
  // What the pool's opening reads: a log of one event.
  const tx = {
    query: async () => ({ rows: [{ seq: 1, header_hash: "h", at: "2026-11-20T10:00:00.000Z" }] }),
  };
  const store = (conn: Conn) => {
    const s = {
      read: async (fn: (t: unknown) => unknown) => {
        if (conn.state !== "open" && conn.state !== "closing") {
          violations.push(`read on ${conn.state} connection ${conn.id}`);
        }
        return fn(tx);
      },
      write: async (fn: (t: unknown) => unknown) => fn(tx),
      close: () => {
        conn.closes++;
        for (const [u, r] of running) {
          if (r.conn === conn) violations.push(`close of ${conn.id} while use ${u} runs on it`);
        }
        if (conn.state !== "open") violations.push(`close of ${conn.id} in state ${conn.state}`);
        conn.state = "closing";
        if (opts.autoClose) {
          conn.state = "closed";
          return Promise.resolve();
        }
        const d = deferred<void>();
        pendingCloses.push({ conn, d });
        return d.promise;
      },
    };
    storeOf.set(s, conn);
    return s;
  };
  const tooMany = () =>
    Object.assign(new Error("too many clients"), { code: "connection_failed", sqlState: "53300" });
  const backend = {
    open: (ref: { kind: string; database: string }) => {
      if (opts.syncThrow !== false) {
        const what = opts.syncThrow;
        opts.syncThrow = false;
        if (what === "53300") throw tooMany();
        throw new Error("an open that throws");
      }
      const conn: Conn = { id: ++ids, tenant: ref.database, state: "opening", closes: 0 };
      conns.push(conn);
      if (opts.autoOpen) {
        conn.state = "open";
        return Promise.resolve(store(conn));
      }
      const d = deferred<unknown>();
      pendingOpens.push({ conn, d });
      return d.promise;
    },
  };
  /** Settles the `i`th open waiting: opened, failed, or refused as a full database. */
  const settleOpen = (i: number, how: "ok" | "fail" | "53300") => {
    const [x] = pendingOpens.splice(i, 1);
    if (x === undefined) return;
    if (how === "ok") {
      x.conn.state = "open";
      x.d.resolve(store(x.conn));
    } else {
      x.conn.state = "refused";
      x.d.reject(
        how === "53300"
          ? tooMany()
          : Object.assign(new Error("an open that fails"), {
              code: "connection_failed",
              sqlState: "08006",
            }),
      );
    }
  };
  /** Settles the `i`th close waiting: done, or failed with the storage still open. */
  const settleClose = (i: number, ok: boolean) => {
    const [x] = pendingCloses.splice(i, 1);
    if (x === undefined) return;
    if (ok) {
      x.conn.state = "closed";
      x.d.resolve();
    } else {
      x.conn.state = "open";
      x.d.reject(new Error("a close that fails"));
    }
  };
  const live = () =>
    conns.filter((c) => c.state === "opening" || c.state === "open" || c.state === "closing");
  const control = {
    anchors: {
      read: async () => ({ deletions: [], highWater: 0, restoreCount: 0 }),
      advanceHighWater: async () => {},
    },
    tenant: async (id: string) => ({
      id,
      owner: "u_00000000000000000000000001",
      ref: { kind: "postgres", cell: "c", database: id },
      state: "active",
    }),
    tenantOf: async () => undefined,
  };
  return {
    conns,
    pendingOpens,
    pendingCloses,
    running,
    violations,
    opts,
    backend: backend as unknown as StorageBackend,
    control: control as unknown as ControlPlane,
    settleOpen,
    settleClose,
    live,
    connOf: (s: object) => storeOf.get(s),
  };
}

export type World = ReturnType<typeof world>;

/** A pool on the world's backend; the place's waits on fake timers. */
export function poolIn(
  w: World,
  o: {
    maxOpen?: number;
    idleMs?: number;
    openWaitMs?: number;
    full?: string[];
    closeFailures?: string[];
  } = {},
): TenantPool {
  const options: TenantPoolOptions = {
    control: w.control,
    backend: w.backend,
    idleMs: o.idleMs ?? 60_000,
    ...(o.maxOpen !== undefined ? { maxOpen: o.maxOpen } : {}),
    openWaitMs: o.openWaitMs ?? 1000,
    onFull: (t, why) => o.full?.push(`${t} ${why}`),
    onCloseFailure: (t, what) => o.closeFailures?.push(`${t} ${what}`),
    now: () => "2026-11-20T10:00:00.000Z",
    discardStaging: async () => {},
    discardScratch: async () => {},
  };
  return new TenantPool(options);
}

/** Lets every promise the pool chained run: a few turns of the event loop on the real clock. */
const realSetImmediate = setImmediate;
export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => realSetImmediate(r));
}

/** A use of `tenant` held open by the test: started once its function runs; its outcome. */
export function held(p: TenantPool, tenant: string) {
  const g = deferred<void>();
  const s = { started: false, result: "pending" };
  const done = p
    .use(tenant as TenantId, async () => {
      s.started = true;
      await g.promise;
    })
    .then(
      () => {
        s.result = "ok";
      },
      (e: unknown) => {
        s.result = String((e as { code?: unknown }).code ?? (e as Error).message);
      },
    );
  return { s, release: () => g.resolve(), done };
}

/** The pool and the world, in one line, for a failure's message. */
export function stateOf(w: World, p: TenantPool): string {
  const st = p.stateForTests();
  const slots = st.slots.map(
    (s) =>
      `${s.tenant}{place=${s.place} open=${s.open} opening=${s.opening} closing=${s.closing} unclosed=${s.unclosed} uses=${s.uses} holds=${s.holds} gate=${s.gate} idle=${s.idleTimer} placing=${s.placing}}`,
  );
  return `held=${st.held} line=${st.line} evicting=${st.evicting} live=${w
    .live()
    .map((c) => `${c.tenant}#${c.id}:${c.state}`)
    .join(",")} slots=${slots.join(" ")}`;
}

/** The invariants once the pool has nothing left to do at a point of a schedule. */
export function invariants(w: World, p: TenantPool, max: number, where: string): string[] {
  const out: string[] = [];
  const st = p.stateForTests();
  const live = w.live();
  const withPlace = st.slots.filter((s) => s.place).length;
  if (live.length > max) out.push(`${where}: ${live.length} connections, more than ${max}`);
  if (st.held > max) out.push(`${where}: ${st.held} places held, more than ${max}`);
  if (st.held < 0) out.push(`${where}: ${st.held} places held`);
  if (st.held !== withPlace)
    out.push(`${where}: ${st.held} places held, ${withPlace} slots hold one`);
  if (live.length > st.held) out.push(`${where}: ${live.length} connections on ${st.held} places`);
  const byTenant = new Map<string, number>();
  for (const c of live) byTenant.set(c.tenant, (byTenant.get(c.tenant) ?? 0) + 1);
  for (const [t, n] of byTenant) {
    if (n > 1) out.push(`${where}: tenant ${t} has ${n} connections`);
    if (st.slots.find((s) => s.tenant === t)?.place !== true) {
      out.push(`${where}: tenant ${t} has a connection without a place`);
    }
  }
  if (st.line > 0) {
    if (st.held < max) out.push(`${where}: ${st.line} in line while a place is free`);
    if (st.idlest !== undefined && st.evicting < st.line) {
      out.push(
        `${where}: ${st.line} in line, ${st.evicting} evicting, ${st.idlest} idle and not closed`,
      );
    }
  }
  for (const s of st.slots) {
    if (
      s.open &&
      s.uses === 0 &&
      s.holds === 0 &&
      !s.gate &&
      !s.closing &&
      !s.idleTimer &&
      !st.closed
    ) {
      out.push(`${where}: tenant ${s.tenant} idle with no idle timer`);
    }
    if (s.place && !s.opening && !s.closing && !s.unclosed && !s.placing && s.uses === 0) {
      out.push(`${where}: tenant ${s.tenant} holds a place with no connection`);
    }
  }
  for (const v of w.violations.splice(0)) out.push(`${where}: ${v}`);
  return out;
}

/** A small seeded generator (mulberry32): the same seed, the same schedule. */
export function seeded(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
