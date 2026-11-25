// Experiment 9 (capacity, local PGlite side): a home's store opened in this process, written and
// read through the kernel's contract operations (the same calls the service makes), with the
// store's real durability (host fsync). Helpers shared by the shapes and the measurements.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  applyEvents,
  catalog,
  createOpsContext,
  createTenant,
  history,
  type OpsContext,
  query,
  randomCrockford,
  readEvents,
  readTail,
  schemaDraft,
  type TenantStore,
  write,
} from "@fluxvita/saveslot-kernel";
import { PgliteBackend } from "@fluxvita/saveslot-store-pglite";

export const backend = new PgliteBackend({ durability: "host-fsync" });

/** A synthetic clock: each call is a millisecond after the last, from a fixed start. */
export class Clock {
  #t: number;
  constructor(start = Date.parse("2026-11-01T00:00:00Z")) {
    this.#t = start;
  }
  next(stepMs = 1): string {
    this.#t += stepMs;
    return new Date(this.#t).toISOString();
  }
}

export interface Home {
  readonly dir: string;
  readonly tenant: string;
  readonly user: string;
  store: TenantStore;
}

const ctxOf = (h: Home, now: string): OpsContext =>
  createOpsContext({
    tenant: h.tenant,
    actor: h.user,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 0,
    idempotency_window: 0,
    now,
    confirmation: null,
  });

export async function createHome(dir: string, clock: Clock): Promise<Home> {
  const tenant = `tn_${randomCrockford(26)}`;
  const user = `u_${randomCrockford(26)}`;
  const store = await backend.open({ kind: "pglite", dir }, { create: true });
  await createTenant(
    store,
    createOpsContext({
      tenant,
      actor: user,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 0,
      idempotency_window: 0,
      now: clock.next(),
      confirmation: null,
    }),
  );
  return { dir, tenant, user, store };
}

export async function reopen(h: Home): Promise<number> {
  await h.store.close();
  const t0 = performance.now();
  h.store = await backend.open({ kind: "pglite", dir: h.dir }, {});
  return performance.now() - t0;
}

export const op = {
  draft: (h: Home, clock: Clock, document: unknown) =>
    schemaDraft(h.store, ctxOf(h, clock.next()), { document }),
  write: (h: Home, clock: Clock, params: unknown) => write(h.store, ctxOf(h, clock.next()), params),
  query: (h: Home, clock: Clock, params: unknown) => query(h.store, ctxOf(h, clock.next()), params),
  catalog: (h: Home, clock: Clock, params: unknown) =>
    catalog(h.store, ctxOf(h, clock.next()), params),
  history: (h: Home, clock: Clock, params: unknown) =>
    history(h.store, ctxOf(h, clock.next()), params),
};

export const evidence = (text: string) => [{ kind: "tool_result", text }];

/** Bytes under a directory, recursively. */
export function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

/** Bytes per relation group (table + its indexes + TOAST), from the store itself. */
export async function relationSizes(h: Home): Promise<Record<string, number>> {
  return h.store.read(async (tx) => {
    const r = await tx.query<{ name: string; bytes: string }>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY 2 DESC`,
    );
    return Object.fromEntries(r.rows.map((x) => [x.name, Number(x.bytes)]));
  });
}

export async function eventCount(h: Home): Promise<number> {
  return h.store.read(async (tx) => Number((await readTail(tx))?.seq ?? 0));
}

/**
 * The whole store replayed from empty into a new directory: the log tables copied as they are,
 * then every event applied in `seq` order, `batch` events to a transaction. Returns milliseconds.
 */
export async function replayFromEmpty(h: Home, to: string, batch = 2000): Promise<number> {
  const t0 = performance.now();
  const dst = await backend.open({ kind: "pglite", dir: to }, { create: true });
  try {
    const end = await eventCount(h);
    for (let from = 1; from <= end; from += batch) {
      const upto = Math.min(end, from + batch - 1);
      const rows = await h.store.read(async (tx) => ({
        events: (await tx.query("SELECT * FROM events WHERE seq BETWEEN $1 AND $2", [from, upto]))
          .rows,
        content: (await tx.query("SELECT * FROM content WHERE seq BETWEEN $1 AND $2", [from, upto]))
          .rows,
      }));
      await dst.write(async (tx) => {
        for (const [table, list] of [
          ["events", rows.events],
          ["content", rows.content],
        ] as const) {
          for (const r of list as Record<string, unknown>[]) {
            const cols = Object.keys(r);
            await tx.query(
              `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
              cols.map((c) => r[c]) as never,
            );
          }
        }
        await applyEvents(tx, await readEvents(tx, from as never, upto as never));
      });
    }
  } finally {
    await dst.close();
  }
  return performance.now() - t0;
}

export function percentiles(ms: readonly number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
  return { n: s.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s[s.length - 1] };
}
