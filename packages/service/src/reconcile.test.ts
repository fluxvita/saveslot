// log.reconcile in the service, on either backend (04-contract, the operation table; 02-architecture
// §3, §7 "对拍"): the run borrows the live storage from the pool and compares it with a scratch
// storage made for it; one run per tenant, a second refused with `rate_limited` (`busy`); the scratch
// storage dropped after a run that succeeded or failed, and one left over dropped before; an
// exclusive started during a run waits for it; the local opening drops a scratch storage a crash
// left. The kernel's comparison itself is tested in store-pglite. Fictional IDs.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpsContext,
  createTenant,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeStorage, TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import type { TenantId, UserId } from "./control-plane.ts";
import { createLocalHome, TEST_TENANT } from "./local-home.fixture.ts";
import { openLocalTenant } from "./local-tenant.ts";
import {
  localReconcileScratch,
  type ReconcileScratch,
  scratchDatabaseOf,
  scratchDirOf,
  serverReconcileScratch,
  TenantReconciler,
} from "./reconcile.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";
import { createServerTenant } from "./server-tenant.ts";
import { TenantPool } from "./tenant-pool.ts";

const T = 120_000;
/** A case that drops a database: each DROP DATABASE waits for a checkpoint (see `removeStorage`). */
const DROP_T = 300_000;
const NOW = "2026-11-21T10:00:00.000Z";
const CELL = "cell_a";
const root = mkdtempSync(join(tmpdir(), "saveslot-reconcile-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

/** A database of a cell is a directory of the test backend. */
const dirOf = (cell: string, database: string) => join(root, cell, database);
const backend: StorageBackend = {
  open: (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    return testBackend().open({ kind: "pglite", dir: dirOf(ref.cell, ref.database) }, opts);
  },
};

let control: TenantStore;
let cp: ServerControlPlane;
beforeAll(async () => {
  control = await testBackend().open(
    { kind: "pglite", dir: join(root, "control") },
    { create: true },
  );
  cp = await initControlPlane(control);
}, T);
afterAll(async () => {
  await control?.close();
}, T);

let users = 0;
const owner = () => `u_${String(++users).padStart(26, "0")}` as const;
const tenantOf = (u: UserId) =>
  createServerTenant({
    control: cp,
    backend,
    owner: u,
    cell: CELL,
    cells: new Set([CELL]),
    now: NOW,
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scratchDir = (tenant: TenantId) => dirOf(CELL, scratchDatabaseOf(tenant));
/**
 * Removes a tenant's scratch storage. On PostgreSQL the database is emptied, not dropped (see
 * `removeStorage`); `drop` drops it, as a host's `discardScratch` does: one case keeps that.
 */
const dropScratch = (tenant: TenantId, o: { readonly drop?: boolean } = {}) =>
  removeStorage(scratchDir(tenant), o);

/** Writes a genesis into a store, as a scratch storage left with events would have. */
const genesis = (store: TenantStore, tenant: TenantId, u: UserId) =>
  createTenant(
    store,
    createOpsContext({
      tenant,
      actor: u,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 86_400_000,
      now: NOW,
      confirmation: null,
    }),
  );

/**
 * The server mode's scratch storage, counting its drops; `hold()` keeps the next opening of a
 * scratch storage waiting until released, so a run can be caught in progress.
 */
function scratch(more: { readonly open?: ReconcileScratch["open"]; readonly drop?: boolean } = {}) {
  const c = { discarded: [] as TenantId[], opened: 0 };
  let gate: Promise<void> | undefined;
  let release = () => {};
  let entered = () => {};
  let isEntered = Promise.resolve();
  const base = serverReconcileScratch({
    control: cp,
    backend,
    discard: async (t) => {
      c.discarded.push(t);
      await dropScratch(t, { drop: more.drop === true });
    },
  });
  const s: ReconcileScratch = {
    open: async (t) => {
      c.opened++;
      if (gate !== undefined) {
        entered();
        await gate;
      }
      return (more.open ?? base.open)(t);
    },
    discard: base.discard,
  };
  const hold = () => {
    isEntered = new Promise<void>((r) => {
      entered = r;
    });
    gate = new Promise<void>((r) => {
      release = () => {
        gate = undefined;
        r();
      };
    });
    return { entered: isEntered, release: () => release() };
  };
  return { scratch: s, base, c, hold };
}

const pool = () =>
  new TenantPool({
    control: cp,
    backend,
    idleMs: 60_000,
    now: () => NOW,
    discardStaging: async () => {},
    discardScratch: dropScratch,
  });

describe("TenantReconciler, server mode", () => {
  it(
    "compares the live storage the pool lends with a scratch storage, dropped after",
    async () => {
      const u = owner();
      const e = await tenantOf(u);
      const p = pool();
      const s = scratch();
      const r = new TenantReconciler({ scratch: s.scratch });
      const run = () => r.reconcile(e.id, (fn) => p.use(e.id, (t) => fn(t.store)));
      expect((await run()).mismatches_total).toBe(0);
      await p.use(e.id, (t) =>
        t.store.write((tx) =>
          tx.query("UPDATE principals SET name = 'TAMPERED' WHERE id = $1", [u]),
        ),
      );
      const found = await run();
      expect(found.mismatches).toEqual([
        { table: "principals", row: u, field: "name", kind: "different" },
      ]);
      // Dropped before each run and after it.
      expect(s.c.discarded).toEqual([e.id, e.id, e.id, e.id]);
      expect(existsSync(scratchDir(e.id))).toBe(false);
      await p.closeAll();
    },
    T,
  );

  it(
    "refuses a second run of a tenant with rate_limited (busy) while one runs; another tenant runs",
    async () => {
      const [a, b] = [await tenantOf(owner()), await tenantOf(owner())];
      const p = pool();
      const s = scratch();
      const r = new TenantReconciler({ scratch: s.scratch });
      const run = (id: TenantId) => r.reconcile(id, (fn) => p.use(id, (t) => fn(t.store)));
      const held = s.hold();
      const first = run(a.id);
      await held.entered;
      await expect(run(a.id)).rejects.toMatchObject({
        name: "ContractError",
        code: "rate_limited",
        detail: { reason: "busy", retry_after: 60 },
      });
      held.release();
      expect((await run(b.id)).mismatches_total).toBe(0);
      expect((await first).mismatches_total).toBe(0);
      // Not kept: the tenant runs again once the first run ended.
      expect((await run(a.id)).mismatches_total).toBe(0);
      await p.closeAll();
    },
    T,
  );

  it(
    "drops a scratch storage left over before the run, and its own after a run that failed",
    async () => {
      const u = owner();
      const e = await tenantOf(u);
      const p = pool();
      // Left over with events: a run that used it would be refused by the kernel.
      const left = await backend.open(
        { kind: "postgres", cell: CELL, database: scratchDatabaseOf(e.id) },
        { create: true },
      );
      await genesis(left, e.id, u);
      await left.close();
      const ok = scratch();
      const run = (r: TenantReconciler) =>
        r.reconcile(e.id, (fn) => p.use(e.id, (t) => fn(t.store)));
      expect((await run(new TenantReconciler({ scratch: ok.scratch }))).mismatches_total).toBe(0);

      // A scratch storage that is not empty fails the kernel's run.
      const failing = scratch({
        open: async (t) => {
          const store = await ok.base.open(t);
          await genesis(store, t, u);
          return store;
        },
      });
      const r = new TenantReconciler({ scratch: failing.scratch });
      await expect(run(r)).rejects.toMatchObject({ code: "internal" });
      expect(failing.c.discarded).toEqual([e.id, e.id]);
      expect(existsSync(scratchDir(e.id))).toBe(false);
      await p.closeAll();
    },
    T,
  );

  it(
    "reports a scratch storage not dropped after the run, and keeps the run's result",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      const s = scratch();
      let drops = 0;
      const reported: string[] = [];
      const r = new TenantReconciler({
        scratch: {
          open: s.scratch.open,
          discard: async (t) => {
            if (++drops === 2) throw Object.assign(new Error("PROBE"), { code: "probe_failed" });
            await s.scratch.discard(t);
          },
        },
        onDiscardFailure: (t, err) => reported.push(`${t} ${(err as { code: string }).code}`),
      });
      const result = await r.reconcile(e.id, (fn) => p.use(e.id, (t) => fn(t.store)));
      expect(result.mismatches_total).toBe(0);
      expect(reported).toEqual([`${e.id} probe_failed`]);
      // The next opening of the tenant drops it.
      expect(existsSync(scratchDir(e.id))).toBe(true);
      await p.closeAll();
      await pool().use(e.id, async () => {});
      expect(existsSync(scratchDir(e.id))).toBe(false);
    },
    T,
  );

  it(
    "a scratch database dropped, as the host drops it, not emptied: the run ends with it gone",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      // The one case whose scratch database is dropped. On PostgreSQL a DROP DATABASE waits for a
      // checkpoint, behind every other file's under load: a case of its own, with time for that.
      const s = scratch({ drop: true });
      const r = new TenantReconciler({ scratch: s.scratch });
      const result = await r.reconcile(e.id, (fn) => p.use(e.id, (t) => fn(t.store)));
      expect(result.mismatches_total).toBe(0);
      expect(s.c.discarded).toEqual([e.id, e.id]);
      expect(existsSync(scratchDir(e.id))).toBe(false);
      await p.closeAll();
    },
    DROP_T,
  );

  it(
    "an exclusive started during a run waits for the run",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      const s = scratch();
      const r = new TenantReconciler({ scratch: s.scratch });
      const order: string[] = [];
      const held = s.hold();
      const run = r
        .reconcile(e.id, (fn) => p.use(e.id, (t) => fn(t.store)))
        .then(() => order.push("run ends"));
      await held.entered;
      const excl = p.exclusive(e.id, async () => {
        order.push("exclusive runs");
      });
      await sleep(50);
      expect(order).toEqual([]);
      held.release();
      await Promise.all([run, excl]);
      expect(order).toEqual(["run ends", "exclusive runs"]);
      await p.closeAll();
    },
    T,
  );
});

describe("TenantReconciler, local mode", () => {
  // The home's single-writer lock is PGlite's own: the PostgreSQL test backend has none to hold.
  it.skipIf(TEST_BACKEND === "postgres")(
    "a second opening while the home's writer is held: refused at the lock, the scratch directory left as it is",
    async () => {
      const home = join(root, "home-held");
      await createLocalHome(home, testBackend());
      const opened = await openLocalTenant({ home, backend: testBackend() });
      if (!opened.ok) throw new Error(opened.failure);
      try {
        // A run of the process holding the home, its scratch storage in place.
        const dir = scratchDirOf(home, TEST_TENANT);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "run"), "x");
        const second = await openLocalTenant({ home, backend: testBackend() }).catch(
          (e: unknown) => e,
        );
        expect(second).toMatchObject({ code: "store_locked" });
        expect(existsSync(join(dir, "run"))).toBe(true);
      } finally {
        await opened.tenant.store.close();
      }
    },
    T,
  );

  it(
    "runs with a scratch directory under the home; the opening drops one a crash left",
    async () => {
      const home = join(root, "home");
      await createLocalHome(home, testBackend());
      const dir = scratchDirOf(home, TEST_TENANT);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "left"), "x");
      const opened = await openLocalTenant({ home, backend: testBackend() });
      if (!opened.ok) throw new Error(opened.failure);
      expect(existsSync(dir)).toBe(false);
      const t = opened.tenant;
      try {
        const r = new TenantReconciler({
          scratch: localReconcileScratch({ home, backend: testBackend() }),
        });
        expect((await r.reconcile(t.tenant, (fn) => fn(t.store))).mismatches_total).toBe(0);
        expect(existsSync(dir)).toBe(false);
      } finally {
        await t.store.close();
      }
    },
    T,
  );
});
