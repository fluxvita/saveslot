// TenantPool on either backend (02-architecture §5, §7, §8): a tenant lent to uses at the same time
// through one opening, never closed while used, closed when idle after its reads are written and its
// high water moved up; `exclusive` waiting for uses and holding new ones back, the next use opening
// what the directory names then; only an active tenant opened. Fictional IDs.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendImportEvent,
  createOpsContext,
  createTenant,
  importIntoStaging,
  type ReadEntry,
  readBufferOf,
  readTail,
  runImport,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
  writeExport,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import type { TenantEntry, TenantId } from "./control-plane.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";
import { createServerTenant, databaseOf } from "./server-tenant.ts";
import { TenantPool, type TenantPoolOptions } from "./tenant-pool.ts";

const T = 120_000;
const NOW = "2026-11-20T10:00:00.000Z";
const CELL = "cell_a";
const root = mkdtempSync(join(tmpdir(), "saveslot-tenant-pool-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

/** A database of a cell is a directory of the test backend; how often each was opened is counted. */
const opened = new Map<string, number>();
const backend: StorageBackend = {
  open: (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    opened.set(ref.database, (opened.get(ref.database) ?? 0) + 1);
    return testBackend().open({ kind: "pglite", dir: join(root, ref.cell, ref.database) }, opts);
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
const tenantOf = (u: `u_${string}`) =>
  createServerTenant({
    control: cp,
    backend,
    owner: u,
    cell: CELL,
    cells: new Set([CELL]),
    now: NOW,
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A backend whose stores' close can be held back (`hold`) or made to fail (`fails` times, without
 * closing the storage: it stays open, as a close that failed may leave it), for the pool's close
 * paths. Counts the closes asked for and the ones done.
 */
function controlled() {
  const c = { hold: undefined as Promise<void> | undefined, fails: 0, asked: 0, closed: 0 };
  const b: StorageBackend = {
    open: async (ref, opts) => {
      const s = await backend.open(ref, opts);
      return new Proxy(s, {
        get(target, k) {
          if (k === "close") {
            return async () => {
              c.asked++;
              if (c.hold !== undefined) await c.hold;
              if (c.fails > 0) {
                c.fails--;
                throw new Error("PROBE close failed");
              }
              await target.close();
              c.closed++;
            };
          }
          const v = Reflect.get(target, k);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
  let release = () => {};
  const hold = () => {
    c.hold = new Promise<void>((r) => {
      release = () => {
        c.hold = undefined;
        r();
      };
    });
  };
  return { backend: b, c, hold, release: () => release() };
}

/** Waits until `ok` holds, polling; fails after 30 s. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !ok(); i++) await sleep(50);
  expect(ok()).toBe(true);
}

/** A pool that closes a tenant `idleMs` after its last use. */
function pool(idleMs = 60_000, more: Partial<TenantPoolOptions> = {}): TenantPool {
  return new TenantPool({
    control: cp,
    backend,
    idleMs,
    now: () => NOW,
    discardStaging: async (tenant, staging) => {
      discarded.push(`${tenant} ${staging}`);
    },
    discardScratch: async () => {},
    ...more,
  });
}

/** The staging databases the pools discarded, as `tenant staging`. */
const discarded: string[] = [];

describe("TenantPool", () => {
  it(
    "lends one opening to uses at the same time",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      const before = opened.get(databaseOf(e.id)) ?? 0;
      const tails = await Promise.all(
        [1, 2, 3].map(() => p.use(e.id, (t) => t.store.read((tx) => readTail(tx)))),
      );
      expect(tails.every((x) => x?.seq === tails[0]?.seq)).toBe(true);
      expect((opened.get(databaseOf(e.id)) ?? 0) - before).toBe(1);
      await p.closeAll();
    },
    T,
  );

  it(
    "does not close a tenant while a use runs, though its idle time passes",
    async () => {
      const e = await tenantOf(owner());
      const p = pool(20);
      const r = await p.use(e.id, async (t) => {
        await sleep(200);
        return t.store.read((tx) => tx.query<{ one: number }>("SELECT 1 AS one"));
      });
      expect(Number(r.rows[0]?.one)).toBe(1);
      await p.closeAll();
    },
    T,
  );

  it(
    "closes an idle tenant after writing its reads and moving its high water to the log's end",
    async () => {
      const e = await tenantOf(owner());
      const p = pool(20);
      const read = {
        read: `rd_${"5".repeat(16)}`,
        actor: e.owner,
        task: null,
        at: NOW,
        pos: 1,
        operation: "query",
        rows: [],
        coarse: [],
        lastRead: [],
      } as unknown as ReadEntry;
      const end = await p.use(e.id, async (t) => {
        readBufferOf(t.store).record(read);
        return (await t.store.read((tx) => readTail(tx)))?.seq;
      });
      expect((await cp.anchors.read(e.id)).highWater).toBe(0);
      const before = opened.get(databaseOf(e.id)) ?? 0;
      // Closing takes its time: waited for until the high water moves, not slept on.
      for (let i = 0; i < 600 && (await cp.anchors.read(e.id)).highWater !== end; i++) {
        await sleep(50);
      }
      expect((await cp.anchors.read(e.id)).highWater).toBe(end);
      const reads = await p.use(e.id, (t) =>
        t.store.read((tx) => tx.query<{ n: number }>("SELECT count(*)::int AS n FROM read_log")),
      );
      expect(Number(reads.rows[0]?.n)).toBe(1);
      // Closed: the use after it opened the tenant again.
      expect((opened.get(databaseOf(e.id)) ?? 0) - before).toBe(1);
      await p.closeAll();
    },
    T,
  );

  it(
    "refuses a tenant still being created, and does not keep the refusal",
    async () => {
      const u = owner();
      const id = `tn_${String(users).padStart(26, "0")}` as TenantId;
      await cp.registerTenant({
        id,
        owner: u,
        ref: { kind: "postgres", cell: CELL, database: databaseOf(id) },
      });
      const p = pool();
      await expect(p.use(id, async () => "lent")).rejects.toMatchObject({
        name: "TenantPoolError",
        code: "tenant_creating",
      });
      await tenantOf(u);
      expect(await p.use(id, async () => "lent")).toBe("lent");
      await p.closeAll();
    },
    T,
  );

  it(
    "exclusive waits for the uses in progress and holds new ones back until it ends",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      const order: string[] = [];
      let finishUse = () => {};
      let started = () => {};
      const isStarted = new Promise<void>((r) => {
        started = r;
      });
      const first = p.use(e.id, async () => {
        order.push("use 1 starts");
        started();
        await new Promise<void>((r) => {
          finishUse = r;
        });
        order.push("use 1 ends");
      });
      // Opening the tenant takes its time: waited for, not slept on.
      await isStarted;
      const excl = p.exclusive(e.id, async () => {
        order.push("exclusive runs");
        await sleep(50);
        order.push("exclusive ends");
      });
      await sleep(20);
      const second = p.use(e.id, async () => {
        order.push("use 2 runs");
      });
      await sleep(20);
      expect(order).toEqual(["use 1 starts"]);
      finishUse();
      await Promise.all([first, excl, second]);
      expect(order).toEqual([
        "use 1 starts",
        "use 1 ends",
        "exclusive runs",
        "exclusive ends",
        "use 2 runs",
      ]);
      await p.closeAll();
    },
    T,
  );

  it(
    "after an exclusive that swapped the staging database in, the next use opens that database",
    async () => {
      const e: TenantEntry = await tenantOf(owner());
      const p = pool();
      const at = await p.use(e.id, async (t) => (await t.store.read((tx) => readTail(tx)))?.at);
      // The staging database: the same tenant, its genesis written at another time.
      const staging = `${databaseOf(e.id)}_staging`;
      const s = await backend.open(
        { kind: "postgres", cell: CELL, database: staging },
        { create: true },
      );
      const later = "2026-11-20T11:00:00.000Z";
      try {
        await createTenant(
          s,
          createOpsContext({
            tenant: e.id,
            actor: e.owner,
            trigger: null,
            task: null,
            visibility: { kind: "all" },
            idempotency_key_window: 0,
            idempotency_window: 0,
            now: later,
            confirmation: null,
          }),
        );
      } finally {
        await s.close();
      }
      await cp.setStaging(e.id, staging);
      await p.exclusive(e.id, () => cp.swapInStaging(e.id));
      const after = await p.use(e.id, async (t) => (await t.store.read((tx) => readTail(tx)))?.at);
      expect(after).not.toBe(at);
      expect(after).toBe(later);
      await p.closeAll();
    },
    T,
  );

  it(
    "keeps a tenant open through a use longer than the idle time, though the use before set its timer",
    async () => {
      const e = await tenantOf(owner());
      const { backend: b, c } = controlled();
      const p = pool(30, { backend: b });
      await p.use(e.id, async () => {});
      const r = await p.use(e.id, async (t) => {
        await sleep(200);
        return t.store.read((tx) => tx.query<{ one: number }>("SELECT 1 AS one"));
      });
      expect(Number(r.rows[0]?.one)).toBe(1);
      expect(c.asked).toBe(0);
      await p.closeAll();
    },
    T,
  );

  it(
    "runs two exclusives of one tenant one after the other",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      const order: string[] = [];
      await Promise.all([
        p.exclusive(e.id, async () => {
          order.push("first starts");
          await sleep(50);
          order.push("first ends");
        }),
        p.exclusive(e.id, async () => {
          order.push("second starts");
          order.push("second ends");
        }),
      ]);
      expect(order).toEqual(["first starts", "first ends", "second starts", "second ends"]);
      await p.closeAll();
    },
    T,
  );

  it(
    "an exclusive arriving during an idle close waits for it, and a use after it for the exclusive",
    async () => {
      const e = await tenantOf(owner());
      const { backend: b, c, hold, release } = controlled();
      const p = pool(10, { backend: b });
      hold();
      await p.use(e.id, async () => {});
      await until(() => c.asked === 1);
      const order: string[] = [];
      const excl = p.exclusive(e.id, async () => {
        order.push(`exclusive starts, closed: ${c.closed}`);
        await sleep(30);
        order.push("exclusive ends");
      });
      const use = p.use(e.id, async () => {
        order.push("use runs");
      });
      await sleep(50);
      expect(order).toEqual([]);
      release();
      await Promise.all([excl, use]);
      expect(order).toEqual(["exclusive starts, closed: 1", "exclusive ends", "use runs"]);
      await p.closeAll();
    },
    T,
  );

  it(
    "a close that fails is reported, not thrown at a use; the storage is closed again before the tenant opens anew",
    async () => {
      const e = await tenantOf(owner());
      const { backend: b, c, hold, release } = controlled();
      const failures: string[] = [];
      const unhandled: string[] = [];
      const onUnhandled = (r: unknown) => unhandled.push(String(r));
      process.on("unhandledRejection", onUnhandled);
      try {
        const p = pool(10, {
          backend: b,
          onCloseFailure: (tenant, what, error) =>
            failures.push(`${tenant} ${what} ${String(error)}`),
        });
        hold();
        c.fails = 2;
        await p.use(e.id, async () => {});
        await until(() => c.asked === 1);
        // Waits for the idle close, which fails; closing the kept storage again fails too: this use
        // is refused for the tenant, not given the idle close's error.
        const waiting = p.use(e.id, async () => "lent");
        release();
        await expect(waiting).rejects.toMatchObject({
          name: "TenantPoolError",
          code: "close_failed",
        });
        // The third close of the kept storage succeeds: the tenant opens anew.
        expect(await p.use(e.id, (t) => t.store.read((tx) => readTail(tx)))).toBeDefined();
        expect(c.closed).toBe(1);
        expect(failures).toEqual([
          `${e.id} close_failed Error: PROBE close failed`,
          `${e.id} close_failed Error: PROBE close failed`,
        ]);
        await sleep(20);
        expect(unhandled).toEqual([]);
        await p.closeAll();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    },
    T,
  );

  it(
    "closeAll waits for the uses in progress and for a close under way, and refuses uses after it",
    async () => {
      const e = await tenantOf(owner());
      const { backend: b, c, hold, release } = controlled();
      const p = pool(60_000, { backend: b });
      const order: string[] = [];
      let finish = () => {};
      const finished = new Promise<void>((r) => {
        finish = r;
      });
      let started = () => {};
      const isStarted = new Promise<void>((r) => {
        started = r;
      });
      const inUse = p.use(e.id, async (t) => {
        order.push("use starts");
        started();
        await finished;
        await t.store.read((tx) => readTail(tx));
        order.push("use ends");
      });
      await isStarted;
      const all = p.closeAll().then(() => order.push("closeAll returns"));
      await sleep(30);
      expect(order).toEqual(["use starts"]);
      await expect(p.use(e.id, async () => "lent")).rejects.toMatchObject({ code: "pool_closed" });
      finish();
      await Promise.all([inUse, all]);
      expect(order).toEqual(["use starts", "use ends", "closeAll returns"]);
      expect(c.closed).toBe(1);

      // A close under way: closeAll returns once it is done.
      const q = pool(10, { backend: b });
      hold();
      await q.use(e.id, async () => {});
      await until(() => c.asked === 2);
      let returned = false;
      const all2 = q.closeAll().then(() => {
        returned = true;
      });
      await sleep(30);
      expect(returned).toBe(false);
      release();
      await all2;
      expect(c.closed).toBe(2);
    },
    T,
  );

  it(
    "an exclusive that refuses refuses uses at once and other exclusives as busy, from taking the gate to its end",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      const order: string[] = [];
      let finishUse = () => {};
      let started = () => {};
      const isStarted = new Promise<void>((r) => {
        started = r;
      });
      // A use in progress: the import waits for it, already refusing what comes meanwhile.
      const first = p.use(e.id, async () => {
        started();
        await new Promise<void>((r) => {
          finishUse = r;
        });
        order.push("use in progress ends");
      });
      await isStarted;
      let finishImport = () => {};
      let importStarted = () => {};
      const importRuns = new Promise<void>((r) => {
        importStarted = r;
      });
      const imp = p.exclusive(
        e.id,
        async () => {
          order.push("import runs");
          importStarted();
          await new Promise<void>((r) => {
            finishImport = r;
          });
          order.push("import ends");
        },
        { refuse: "importing" },
      );
      await sleep(20);
      await expect(p.use(e.id, async () => "lent")).rejects.toMatchObject({
        name: "TenantPoolError",
        code: "importing",
      });
      await expect(p.exclusive(e.id, async () => "ran")).rejects.toMatchObject({
        code: "busy",
        holder: "importing",
      });
      await expect(
        p.exclusive(e.id, async () => "ran", { refuse: "restoring" }),
      ).rejects.toMatchObject({ code: "busy", holder: "importing" });
      finishUse();
      await first;
      // Closing the tenant takes its time: the import's start is waited for, not slept on.
      await importRuns;
      await expect(p.use(e.id, async () => "lent")).rejects.toMatchObject({ code: "importing" });
      finishImport();
      await imp;
      expect(await p.use(e.id, async () => "lent")).toBe("lent");
      expect(order).toEqual(["use in progress ends", "import runs", "import ends"]);
      await p.closeAll();
    },
    T,
  );

  it(
    "an exclusive refused while a restore holds the tenant is busy with the restore as its holder",
    async () => {
      const e = await tenantOf(owner());
      const p = pool();
      let finishRestore = () => {};
      let restoreStarted = () => {};
      const restoreRuns = new Promise<void>((r) => {
        restoreStarted = r;
      });
      const restore = p.exclusive(
        e.id,
        async () => {
          restoreStarted();
          await new Promise<void>((r) => {
            finishRestore = r;
          });
        },
        { refuse: "restoring" },
      );
      await restoreRuns;
      await expect(
        p.exclusive(e.id, async () => "ran", { refuse: "importing" }),
      ).rejects.toMatchObject({ code: "busy", holder: "restoring" });
      finishRestore();
      await restore;
      await p.closeAll();
    },
    T,
  );

  it(
    "drops the tenant's log.reconcile scratch storage when it opens; a failed drop is reported, it serves, and the next opening tries again",
    async () => {
      const e = await tenantOf(owner());
      const dropped: TenantId[] = [];
      const openedAtDrop: number[] = [];
      const reported: string[] = [];
      let fails = 1;
      const more: Partial<TenantPoolOptions> = {
        discardScratch: async (t) => {
          dropped.push(t);
          openedAtDrop.push(opened.get(databaseOf(e.id)) ?? 0);
          if (fails-- > 0) throw Object.assign(new Error("PROBE"), { code: "probe_failed" });
        },
        onScratchDiscardFailure: (tenant, error) => {
          reported.push(`${tenant} ${(error as { code?: string }).code}`);
        },
      };
      const before = opened.get(databaseOf(e.id)) ?? 0;
      const failing = pool(60_000, more);
      expect(await failing.use(e.id, async () => "lent")).toBe("lent");
      expect(reported).toEqual([`${e.id} probe_failed`]);
      // Once per opening: not on a use of the tenant already open.
      expect(await failing.use(e.id, async () => "lent")).toBe("lent");
      expect(dropped).toEqual([e.id]);
      await failing.closeAll();
      const p = pool(60_000, more);
      expect(await p.use(e.id, async () => "lent")).toBe("lent");
      expect(dropped).toEqual([e.id, e.id]);
      expect(reported).toEqual([`${e.id} probe_failed`]);
      // Each drop comes before that opening opens the tenant's storage.
      expect(openedAtDrop).toEqual([before, before + 1]);
      await p.closeAll();
    },
    T,
  );

  // 02-architecture §8 «重入», one case for each place an import can stop, each state made by the
  // kernel's own steps on real storages and the anchor read back after.
  describe("opening a tenant an import left", () => {
    const stagingOf = (e: TenantEntry) => `${databaseOf(e.id)}_staging`;
    const dirOf = (database: string) => join(root, CELL, database);
    /** The host's discard: the staging database dropped, then cleared from the directory. */
    const discard = async (tenant: TenantId, staging: string) => {
      rmSync(dirOf(staging), { recursive: true, force: true });
      await cp.setStaging(tenant, null);
    };

    /** The file's last event for each staged tenant, as step ③ returned it. */
    const importedUpto = new Map<TenantId, number>();

    /**
     * Steps ①–③ into `e`'s staging database, registered first: another tenant's log exported and
     * replayed there, then the import's event. Returns the staging log's end, the import event's
     * `seq`.
     */
    const stage = async (e: TenantEntry): Promise<number> => {
      const source = await tenantOf(owner());
      const from = await backend.open(source.ref, {});
      const lines: string[] = [];
      try {
        await from.read((tx) =>
          writeExport(tx, { exportedAt: NOW as never }, async (l) => {
            lines.push(l);
          }),
        );
      } finally {
        await from.close();
      }
      const staging = stagingOf(e);
      await cp.setStaging(e.id, staging);
      const store = await backend.open(
        { kind: "postgres", cell: CELL, database: staging },
        { create: true },
      );
      try {
        const body = (async function* () {
          yield new TextEncoder().encode(lines.join(""));
        })();
        const s = await importIntoStaging({ staging: store, body });
        const ev = await appendImportEvent(store, {
          user: e.owner,
          tenant: e.id,
          manifest: s.manifest,
          now: NOW as never,
        });
        importedUpto.set(e.id, s.importedUpto);
        return ev.seq;
      } finally {
        await store.close();
      }
    };

    /**
     * Steps ④–⑥ by the kernel's `runImport`, killed in the swap: before it took effect (the marker
     * set, ⑤ not done) or after (⑤ done, ⑥ not).
     */
    const killed = async (e: TenantEntry, end: number, at: "before ⑤" | "after ⑤") => {
      const target = await backend.open(e.ref, {});
      const staging = await backend.open(
        { kind: "postgres", cell: CELL, database: stagingOf(e) },
        {},
      );
      try {
        await expect(
          runImport({
            target,
            anchor: cp.anchors,
            tenant: e.id,
            importId: "im_killed",
            staging,
            importSeq: end as never,
            importedUpto: importedUpto.get(e.id) as never,
            swap: async () => {
              if (at === "after ⑤") await cp.swapInStaging(e.id);
              throw new Error("PROBE killed in the swap");
            },
          }),
        ).rejects.toThrow("PROBE killed in the swap");
      } finally {
        await staging.close();
        await target.close();
      }
      expect((await cp.anchors.read(e.id)).importInProgress).toBe("im_killed");
    };

    const tailOf = (p: TenantPool, e: TenantEntry) =>
      p.use(e.id, async (t) => (await t.store.read((tx) => readTail(tx)))?.seq);

    it(
      "stopped before ④: the staging database is discarded, the anchor left as it was, and it serves",
      async () => {
        const e = await tenantOf(owner());
        await stage(e);
        const before = await cp.anchors.read(e.id);
        const p = pool(60_000, { discardStaging: discard });
        expect(await tailOf(p, e)).toBe(1);
        expect((await cp.tenant(e.id))?.staging).toBeUndefined();
        expect(existsSync(dirOf(stagingOf(e)))).toBe(false);
        expect(await cp.anchors.read(e.id)).toEqual(before);
        await p.closeAll();
      },
      T,
    );

    it(
      "stopped between ④ and ⑤: rolled back, the staging database discarded and the marker cleared; it serves empty",
      async () => {
        const e = await tenantOf(owner());
        const end = await stage(e);
        await killed(e, end, "before ⑤");
        const p = pool(60_000, { discardStaging: discard });
        expect(await tailOf(p, e)).toBe(1);
        expect((await cp.tenant(e.id))?.staging).toBeUndefined();
        expect(existsSync(dirOf(stagingOf(e)))).toBe(false);
        const a = await cp.anchors.read(e.id);
        expect(a.importInProgress).toBeUndefined();
        expect(a.restoreCount).toBe(0);
        await p.closeAll();
      },
      T,
    );

    it(
      "stopped between ⑤ and ⑥: finished, the high water at the log's end and the import's restore count; it serves the import",
      async () => {
        const e = await tenantOf(owner());
        const end = await stage(e);
        await killed(e, end, "after ⑤");
        expect((await cp.tenant(e.id))?.ref).toMatchObject({ database: stagingOf(e) });
        const p = pool(60_000, { discardStaging: discard });
        expect(await tailOf(p, e)).toBe(end);
        const a = await cp.anchors.read(e.id);
        expect(a.importInProgress).toBeUndefined();
        expect(a.highWater).toBe(end);
        expect(a.restoreCount).toBe(1);
        await p.closeAll();
      },
      T,
    );

    it(
      "the marker there and the staging database already gone: the marker cleared, and it serves empty",
      async () => {
        const e = await tenantOf(owner());
        const end = await stage(e);
        await killed(e, end, "before ⑤");
        // An earlier rollback discarded the staging database and stopped before clearing the marker.
        await discard(e.id, stagingOf(e));
        const tried: string[] = [];
        const p = pool(60_000, {
          discardStaging: async (tenant, staging) => {
            tried.push(staging);
            await discard(tenant, staging);
          },
        });
        expect(await tailOf(p, e)).toBe(1);
        expect(tried).toEqual([]);
        expect((await cp.anchors.read(e.id)).importInProgress).toBeUndefined();
        await p.closeAll();
      },
      T,
    );

    it(
      "the marker there and the discard failing: this opening is refused and the marker kept; the next one rolls back",
      async () => {
        const e = await tenantOf(owner());
        const end = await stage(e);
        await killed(e, end, "before ⑤");
        const failing = pool(60_000, {
          discardStaging: async () => {
            throw new Error("PROBE discard failed");
          },
        });
        await expect(failing.use(e.id, async () => "lent")).rejects.toMatchObject({
          name: "TenantPoolError",
          code: "staging_not_discarded",
        });
        expect((await cp.anchors.read(e.id)).importInProgress).toBe("im_killed");
        expect((await cp.tenant(e.id))?.staging).toBe(stagingOf(e));
        await failing.closeAll();
        const p = pool(60_000, { discardStaging: discard });
        expect(await tailOf(p, e)).toBe(1);
        expect((await cp.anchors.read(e.id)).importInProgress).toBeUndefined();
        await p.closeAll();
      },
      T,
    );

    it(
      "the marker there and the log empty: the marker is taken up first, then the opening refused as tenant_empty (§4's order)",
      async () => {
        const e = await tenantOf(owner());
        // A new, empty database put in the directory's place: on either backend, a storage with no log.
        const empty = `${databaseOf(e.id)}_empty`;
        await (
          await backend.open({ kind: "postgres", cell: CELL, database: empty }, { create: true })
        ).close();
        await cp.setStaging(e.id, empty);
        await cp.swapInStaging(e.id);
        await cp.anchors.beginImport(e.id, "im_empty");
        const p = pool(60_000, { discardStaging: discard });
        await expect(p.use(e.id, async () => "lent")).rejects.toMatchObject({
          code: "tenant_empty",
        });
        expect((await cp.anchors.read(e.id)).importInProgress).toBeUndefined();
        await p.closeAll();
      },
      T,
    );

    it(
      "no marker and the discard failing: reported in one line, it serves, and the next opening tries again",
      async () => {
        const e = await tenantOf(owner());
        await stage(e);
        const reported: string[] = [];
        const failing = pool(60_000, {
          discardStaging: async () => {
            throw Object.assign(new Error("PROBE discard failed"), { code: "PROBE_DROP" });
          },
          onDiscardFailure: (tenant, error) => {
            reported.push(`${tenant} ${(error as { code?: string }).code}`);
          },
        });
        expect(await tailOf(failing, e)).toBe(1);
        expect(reported).toEqual([`${e.id} PROBE_DROP`]);
        expect((await cp.tenant(e.id))?.staging).toBe(stagingOf(e));
        await failing.closeAll();
        const p = pool(60_000, { discardStaging: discard });
        expect(await tailOf(p, e)).toBe(1);
        expect((await cp.tenant(e.id))?.staging).toBeUndefined();
        await p.closeAll();

        // A tenant with neither: nothing discarded.
        const plain = await tenantOf(owner());
        discarded.length = 0;
        const q = pool();
        expect(await tailOf(q, plain)).toBe(1);
        expect(discarded).toEqual([]);
        await q.closeAll();
      },
      T,
    );
  });
});
