// Import into an empty tenant, server mode, on either backend (02-architecture §8 «格式版本、导出、导入与恢复»
// steps ①–⑥ and «重入», §5 «租户目录», §11 «导入在每一步之后强杀再打开»; 04-contract §17 `import`).
// The control plane is the real one on a test storage; a database of a cell is a storage of the
// test backend (on PostgreSQL, a database of its own), and dropping one drops that storage (on
// PostgreSQL, `DROP DATABASE`) and gives the next opening of that name a new, empty storage.
//
// A crash is a control plane that, from a chosen call on, fails every call (the process is gone):
// nothing the import would do afterwards is done. A new pool on the real control plane is the
// process started again; its first use opens the tenant and takes the import up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  appendOperation,
  ImportRejected,
  importEventInLog,
  OpsError,
  readTail,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
  writeExport,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkDiscard,
  dropTestStorage,
  testBackend,
  testStorageExists,
} from "../../test-backend/src/index.fixture.ts";
import type { ServerControl, TenantId, UserId } from "./control-plane.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";
import {
  type DiscardDatabase,
  importServerTenant,
  stagingDatabaseOf,
  stagingDiscarder,
} from "./server-import.ts";
import { createServerTenant, databaseOf } from "./server-tenant.ts";
import { TenantPool, TenantPoolError } from "./tenant-pool.ts";

const T = 120_000;
/**
 * For the cases whose subject is the drop itself: on PostgreSQL each `DROP DATABASE` requests a
 * checkpoint and waits for it, behind every other database's writes on a busy server (seconds
 * alone, minutes in a full run). Those cases get the time a group of drops is given at the run's
 * end (vitest.config `teardownTimeout`), as store-postgres's discard.test does.
 */
const DROP_T = 300_000;
const NOW = "2026-11-21T10:00:00.000Z";
const CELL = "cell_a";
const root = mkdtempSync(join(tmpdir(), "saveslot-server-import-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

/**
 * A database of a cell is a directory of the test backend. Dropping a database drops its storage
 * and gives the name a new generation: the next opening, with `create`, gets a new empty storage;
 * without, there is none.
 */
const generation = new Map<string, number>();
const dropped = new Set<string>();
const key = (cell: string, database: string) => `${cell}/${database}`;
const dirOf = (cell: string, database: string) =>
  join(root, cell, `${database}.${generation.get(key(cell, database)) ?? 0}`);
const backend: StorageBackend = {
  open: (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    const k = key(ref.cell, ref.database);
    if (dropped.has(k)) {
      if (opts.create !== true) throw new Error(`no database ${ref.database}`);
      dropped.delete(k);
    }
    return testBackend().open({ kind: "pglite", dir: dirOf(ref.cell, ref.database) }, opts);
  },
};

/**
 * What was dropped, in order. The guard is the daemon's own (store-postgres's `checkDiscard`), on
 * the names the import gives it. The drop is the test backend's for that name (on PostgreSQL a
 * real `DROP DATABASE`) only for the tenants in `realDrops`, the cases whose subject is the drop;
 * elsewhere the name only gets a new generation, its storage left for the run's end to drop.
 */
const discards: string[] = [];
const realDrops = new Set<TenantId>();
const discardDatabase: DiscardDatabase = async (o) => {
  checkDiscard(o);
  const tenant = [...realDrops].find((t) => o.tenantDatabase === databaseOf(t));
  if (tenant !== undefined) await dropTestStorage(dirOf(o.cell, o.database));
  const k = key(o.cell, o.database);
  generation.set(k, (generation.get(k) ?? 0) + 1);
  dropped.add(k);
  discards.push(o.database);
};

let controlStore: TenantStore;
let cp: ServerControlPlane;
beforeAll(async () => {
  controlStore = await testBackend().open(
    { kind: "pglite", dir: join(root, "control") },
    { create: true },
  );
  cp = await initControlPlane(controlStore);
}, T);

const pools: TenantPool[] = [];
afterAll(async () => {
  for (const p of pools) await p.closeAll().catch(() => {});
  await controlStore?.close();
}, T);

const poolOf = (control: ServerControl, discard: DiscardDatabase = discardDatabase) => {
  const p = new TenantPool({
    control,
    backend,
    idleMs: 60_000,
    now: () => NOW,
    discardStaging: stagingDiscarder({ control, discardDatabase: discard }),
  });
  pools.push(p);
  return p;
};

let users = 0;
const newOwner = () => `u_${String(++users).padStart(26, "0")}` as UserId;
async function newTenant(): Promise<{ tenant: TenantId; owner: UserId }> {
  const owner = newOwner();
  const e = await createServerTenant({
    control: cp,
    backend,
    owner,
    cell: CELL,
    cells: new Set([CELL]),
    now: NOW,
  });
  return { tenant: e.id, owner };
}

/** An export file: a source tenant's log (genesis, a connection's registration), as NDJSON. */
let file: string[];
let sourceEnd: number;
beforeAll(async () => {
  const { tenant } = await newTenant();
  const pool = poolOf(cp);
  file = await pool.use(tenant, async (t) => {
    await t.store.write((tx) =>
      appendOperation(tx, {
        actor: t.owner,
        now: "2026-11-21T09:00:00.000Z" as never,
        events: [
          {
            type: "principal.registered",
            blocks: {
              ctx: { now: "2026-11-21T09:00:00.000Z", ruleset_version: 1 },
              principal: {
                principal: `ci_${"2".repeat(26)}`,
                kind: "connection",
                scopes: ["saveslot.read"],
                via: "token",
              },
              name: { name: "desk" },
            },
          } as never,
        ],
      }),
    );
    // The kernel's own export: each line JCS, the manifest naming its last header (09 §8).
    return t.store.read(async (tx) => {
      const lines: string[] = [];
      const s = await writeExport(
        tx,
        { exportedAt: "2026-11-21T09:30:00.000Z" as never },
        async (l) => {
          lines.push(l.slice(0, -1));
        },
      );
      sourceEnd = s.upto;
      return lines;
    });
  });
  await pool.closeAll();
}, T);

/** The file as a request body gives it: bytes, a line a chunk; `hold` stops it after the first. */
async function* bodyOf(lines: readonly string[], hold?: Promise<void>): AsyncGenerator<Uint8Array> {
  for (const [i, l] of lines.entries()) {
    yield new TextEncoder().encode(`${l}\n`);
    if (i === 0 && hold !== undefined) await hold;
  }
}

const imported = (
  control: ServerControl,
  pool: TenantPool,
  tenant: TenantId,
  user: UserId,
  body = bodyOf(file),
) =>
  importServerTenant({
    control,
    backend,
    pool,
    discardDatabase,
    tenant,
    user,
    body,
    now: "2026-11-21T10:30:00.000Z" as never,
  });

/** The tenant as a new process sees it: empty, or the import complete with the anchor agreeing. */
async function outcome(tenant: TenantId): Promise<"empty" | "complete"> {
  const pool = poolOf(cp);
  try {
    return await pool.use(tenant, async (t) => {
      const tail = await t.store.read(readTail);
      const a = await t.anchor.read(tenant);
      const entry = await cp.tenant(tenant);
      expect(entry?.staging).toBeUndefined();
      expect(a.importInProgress).toBeUndefined();
      if (tail?.seq === 1) {
        expect(a.restoreCount).toBe(0);
        return "empty";
      }
      expect(await t.store.read(importEventInLog)).toBe(true);
      expect({ end: tail?.seq, highWater: a.highWater, restoreCount: a.restoreCount }).toEqual({
        end: sourceEnd + 1,
        highWater: sourceEnd + 1,
        restoreCount: 1,
      });
      return "complete";
    });
  } finally {
    await pool.closeAll();
  }
}

/**
 * The control plane as a process that dies at `at` (the anchor store's or the control plane's
 * method of that name): that call and every later one fail.
 */
function dying(at: string): {
  control: ServerControl;
  discard: DiscardDatabase;
  dead: () => boolean;
} {
  let dead = false;
  const die = () => {
    dead = true;
    throw new Error(`PROBE killed at ${at}`);
  };
  const wrap = <O extends object>(target: O): O =>
    new Proxy(target, {
      get(t, k) {
        const v = Reflect.get(t, k);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (dead || k === at) die();
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  const anchors = wrap(cp.anchors as AnchorStore);
  const control = new Proxy(cp, {
    get(t, k) {
      if (k === "anchors") return anchors;
      const v = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (dead || k === at) die();
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  }) as unknown as ServerControl;
  const discard: DiscardDatabase = async (o) => {
    if (dead) die();
    return discardDatabase(o);
  };
  return { control, discard, dead: () => dead };
}

/** An import killed at `at`; the error it gave. */
async function killedAt(at: string, tenant: TenantId, user: UserId) {
  const d = dying(at);
  const pool = poolOf(d.control, d.discard);
  const e = await importServerTenant({
    control: d.control,
    backend,
    pool,
    discardDatabase: d.discard,
    tenant,
    user,
    body: bodyOf(file),
    now: "2026-11-21T10:30:00.000Z" as never,
  }).then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(d.dead()).toBe(true);
  expect(String(e)).toContain("PROBE killed");
  await pool.closeAll().catch(() => {});
}

describe("an import", () => {
  it(
    "into an empty tenant: the directory names the staging database, the replaced one is dropped",
    async () => {
      const { tenant, owner } = await newTenant();
      realDrops.add(tenant);
      const pool = poolOf(cp);
      const r = await imported(cp, pool, tenant, owner);
      expect(r).toMatchObject({
        importedUpto: sourceEnd,
        events: sourceEnd,
        highWater: sourceEnd + 1,
      });
      const entry = await cp.tenant(tenant);
      // The staging database's name as 02 §5 gives it, spelled out rather than taken from the code.
      expect(entry?.ref).toMatchObject({
        database: `${databaseOf(tenant)}_${r.importId.toLowerCase()}`,
      });
      expect(entry?.ref).toMatchObject({
        database: expect.stringMatching(
          new RegExp(`^${databaseOf(tenant)}_im_[0-9a-hjkmnp-tv-z]{16}$`),
        ),
      });
      expect(entry?.staging).toBeUndefined();
      expect(discards).toContain(databaseOf(tenant));
      // Dropped for real: on PostgreSQL the server no longer has the database.
      expect(await testStorageExists(join(root, CELL, `${databaseOf(tenant)}.0`))).toBe(false);
      expect(await testStorageExists(dirOf(CELL, stagingDatabaseOf(tenant, r.importId)))).toBe(
        true,
      );
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    DROP_T,
  );

  it(
    "holds the tenant from its first step: a use meanwhile is refused (importing), another import too (busy)",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      let release = () => {};
      const hold = new Promise<void>((r) => {
        release = r;
      });
      const running = imported(cp, pool, tenant, owner, bodyOf(file, hold));
      try {
        // Wait until the replay has started: the staging database is recorded (step ①).
        for (let i = 0; i < 200 && (await cp.tenant(tenant))?.staging === undefined; i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect((await cp.tenant(tenant))?.staging).toBeDefined();
        const code = (e: unknown) => (e instanceof TenantPoolError ? e.code : e);
        // Refused at once, not queued behind the import: a queued use would still be waiting.
        const waited = new Promise((r) => setTimeout(() => r("queued"), 2_000));
        expect(await Promise.race([pool.use(tenant, async () => "used").catch(code), waited])).toBe(
          "importing",
        );
        expect(await imported(cp, pool, tenant, owner).catch(code)).toBe("busy");
      } finally {
        // A failed check above must not leave the import held for the hooks after.
        release();
        await running;
      }
      expect(await pool.use(tenant, async () => "used")).toBe("used");
      await pool.closeAll();
    },
    T,
  );

  it(
    "holds the tenant through ⑥: a use between ③ and ④ is refused (importing), the staging database kept",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      // The import stopped as it takes the marker (④), ①–③ done.
      let atFour = () => {};
      const reached = new Promise<void>((r) => {
        atFour = r;
      });
      let release = () => {};
      const held = new Promise<void>((r) => {
        release = r;
      });
      const anchors = new Proxy(cp.anchors as AnchorStore, {
        get(t, k) {
          const v = Reflect.get(t, k);
          if (typeof v !== "function") return v;
          if (k !== "beginImport") return v.bind(t);
          return async (...args: unknown[]) => {
            atFour();
            await held;
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
      const control = new Proxy(cp, {
        get(t, k) {
          if (k === "anchors") return anchors;
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as unknown as ServerControl;
      const running = importServerTenant({
        control,
        backend,
        pool,
        discardDatabase,
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      });
      try {
        await reached;
        const staging = (await cp.tenant(tenant))?.staging;
        expect(staging).toBeDefined();
        const code = (e: unknown) => (e instanceof TenantPoolError ? e.code : e);
        expect(await pool.use(tenant, async () => "used").catch(code)).toBe("importing");
        expect((await cp.tenant(tenant))?.staging).toBe(staging);
        expect(discards).not.toContain(staging);
      } finally {
        release();
      }
      expect((await running).highWater).toBe(sourceEnd + 1);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "while a restore holds the tenant: busy, with the restore as its holder; the tenant still empty",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      let finish = () => {};
      let started = () => {};
      const isStarted = new Promise<void>((r) => {
        started = r;
      });
      const restore = pool.exclusive(
        tenant,
        async () => {
          started();
          await new Promise<void>((r) => {
            finish = r;
          });
        },
        { refuse: "restoring" },
      );
      await isStarted;
      const e = await imported(cp, pool, tenant, owner).catch((x: unknown) => x);
      expect(e).toMatchObject({ name: "TenantPoolError", code: "busy", holder: "restoring" });
      finish();
      await restore;
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("empty");
    },
    T,
  );

  it(
    "of a file refused, the staging database's drop failing: still import_rejected, the drop told",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const broken = [...file];
      broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
      const failures: string[] = [];
      const e = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: async (o) => {
          if (o.database !== o.tenantDatabase) throw new Error("PROBE drop failed");
          return discardDatabase(o);
        },
        onDiscardFailure: (_, database) => failures.push(database),
        tenant,
        user: owner,
        body: bodyOf(broken),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(e instanceof ImportRejected ? e.reason : e).toBe("checksum_mismatch");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.startsWith(`${databaseOf(tenant)}_im_`)).toBe(true);
      await pool.closeAll();
      // Still recorded, so the next opening drops it.
      expect(await outcome(tenant)).toBe("empty");
      expect(discards).toContain(failures[0]);
    },
    T,
  );

  it(
    "endImport committed but its answer lost: the staging database, the tenant's now, is not dropped",
    async () => {
      const { tenant, owner } = await newTenant();
      const anchors = new Proxy(cp.anchors as AnchorStore, {
        get(t, k) {
          const v = Reflect.get(t, k);
          if (typeof v !== "function") return v;
          if (k !== "endImport") return v.bind(t);
          return async (...args: unknown[]) => {
            await (v as (...a: unknown[]) => Promise<unknown>).apply(t, args);
            throw new Error("PROBE the answer was lost");
          };
        },
      });
      const control = new Proxy(cp, {
        get(t, k) {
          if (k === "anchors") return anchors;
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as unknown as ServerControl;
      const pool = poolOf(control);
      const failures: string[] = [];
      const e = await importServerTenant({
        control,
        backend,
        pool,
        discardDatabase,
        onDiscardFailure: (_, database) => failures.push(database),
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE the answer was lost");
      const current = (await cp.tenant(tenant))?.ref;
      expect(current).not.toMatchObject({ database: databaseOf(tenant) });
      // No drop of it was even asked: the guard would have refused it and the refusal been told.
      expect(failures).toEqual([]);
      expect(discards).not.toContain((current as { database: string }).database);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "a reporter that throws does not replace the import's outcome: after ⑥ it stands, a refused file stays import_rejected",
    async () => {
      const throwing = () => {
        throw new Error("PROBE reporter threw");
      };
      const failingDrop: DiscardDatabase = async () => {
        throw new Error("PROBE drop failed");
      };
      // After ⑥: the replaced database's drop fails, its report throws; the import stands.
      const a = await newTenant();
      const pool = poolOf(cp);
      const r = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: failingDrop,
        onDiscardFailure: throwing,
        tenant: a.tenant,
        user: a.owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(r).toMatchObject({ highWater: sourceEnd + 1, restoreCount: 1 });
      // A refused file: the staging database's drop fails, its report throws; still import_rejected.
      const b = await newTenant();
      const broken = [...file];
      broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
      const e = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: failingDrop,
        onDiscardFailure: throwing,
        tenant: b.tenant,
        user: b.owner,
        body: bodyOf(broken),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(e instanceof ImportRejected ? e.reason : e).toBe("checksum_mismatch");
      await pool.closeAll();
      expect(await outcome(a.tenant)).toBe("complete");
      expect(await outcome(b.tenant)).toBe("empty");
    },
    T,
  );

  it(
    "into a tenant not empty with a staging database still recorded: tenant_not_empty, the recorded one dropped and forgotten",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      await imported(cp, pool, tenant, owner);
      // A staging database left recorded (as a failed drop leaves the one a swap replaced).
      const left = `${databaseOf(tenant)}_im_0123456789abcdef`;
      await (
        await backend.open({ kind: "postgres", cell: CELL, database: left }, { create: true })
      ).close();
      await cp.setStaging(tenant, left);
      const e = await imported(cp, pool, tenant, owner).catch((x: unknown) => x);
      expect(e instanceof OpsError ? e.detail.reason : e).toBe("tenant_not_empty");
      expect(discards).toContain(left);
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "into a tenant not empty: tenant_not_empty, no staging database made",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      await imported(cp, pool, tenant, owner);
      const before = await cp.tenant(tenant);
      const dropped = discards.length;
      const e = await imported(cp, pool, tenant, owner).catch((x: unknown) => x);
      expect(e instanceof OpsError ? e.detail.reason : e).toBe("tenant_not_empty");
      expect(await cp.tenant(tenant)).toEqual(before);
      // Refused before any staging database: none was made, so none was dropped.
      expect(discards.length).toBe(dropped);
      await pool.closeAll();
    },
    T,
  );

  it(
    "of a file refused: the staging database dropped and forgotten, the tenant still empty",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const broken = [...file];
      broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
      const e = await imported(cp, pool, tenant, owner, bodyOf(broken)).catch((x: unknown) => x);
      expect(e instanceof ImportRejected ? e.reason : e).toBe("checksum_mismatch");
      expect(discards.filter((d) => d.startsWith(`${databaseOf(tenant)}_im_`))).toHaveLength(1);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("empty");
    },
    T,
  );
});

describe("killed after each step, the tenant opened again (§11)", () => {
  const again = async (tenant: TenantId, owner: UserId) => {
    const pool = poolOf(cp);
    await imported(cp, pool, tenant, owner);
    await pool.closeAll();
    expect(await outcome(tenant)).toBe("complete");
  };

  it(
    "after ③ (killed taking the marker): the staging database is dropped on opening; empty; imports again",
    async () => {
      const { tenant, owner } = await newTenant();
      await killedAt("beginImport", tenant, owner);
      expect((await cp.tenant(tenant))?.staging).toBeDefined();
      expect((await cp.anchors.read(tenant)).importInProgress).toBeUndefined();
      expect(await outcome(tenant)).toBe("empty");
      await again(tenant, owner);
    },
    T,
  );

  it(
    "after ③, imported again without opening first: the next import drops the staging database left",
    async () => {
      const { tenant, owner } = await newTenant();
      realDrops.add(tenant);
      await killedAt("beginImport", tenant, owner);
      const left = (await cp.tenant(tenant))?.staging;
      expect(left).toBeDefined();
      // An exclusive does not open the tenant: only the import itself sees what was left.
      const pool = poolOf(cp);
      await imported(cp, pool, tenant, owner);
      await pool.closeAll();
      expect(discards).toContain(left);
      // Dropped for real: on PostgreSQL the server no longer has the database.
      expect(await testStorageExists(join(root, CELL, `${left}.0`))).toBe(false);
      expect(await outcome(tenant)).toBe("complete");
    },
    DROP_T,
  );

  it(
    "a failure after ④ with the control plane up (the swap refused): the staging database kept for the re-entry",
    async () => {
      const { tenant, owner } = await newTenant();
      // Only the swap fails, once; the directory and the anchors still answer.
      const control = new Proxy(cp, {
        get(t, k) {
          const v = Reflect.get(t, k);
          if (typeof v !== "function") return v;
          if (k !== "swapInStaging") return v.bind(t);
          return async () => {
            throw new Error("PROBE swap refused");
          };
        },
      }) as unknown as ServerControl;
      const pool = poolOf(control);
      const e = await importServerTenant({
        control,
        backend,
        pool,
        discardDatabase,
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE swap refused");
      await pool.closeAll();
      expect((await cp.anchors.read(tenant)).importInProgress).toBeDefined();
      const staging = (await cp.tenant(tenant))?.staging;
      expect(staging).toBeDefined();
      expect(discards).not.toContain(staging);
      // Opening rolls it back: the staging database dropped then, the tenant empty.
      expect(await outcome(tenant)).toBe("empty");
      expect(discards).toContain(staging);
    },
    T,
  );

  it(
    "after ④ (killed swapping): rolled back on opening; empty; imports again",
    async () => {
      const { tenant, owner } = await newTenant();
      await killedAt("swapInStaging", tenant, owner);
      expect((await cp.anchors.read(tenant)).importInProgress).toBeDefined();
      // From ④ on the staging database is the re-entry's: kept until the tenant opens again.
      const staging = (await cp.tenant(tenant))?.staging;
      expect(staging).toBeDefined();
      expect(discards).not.toContain(staging);
      expect(await outcome(tenant)).toBe("empty");
      await again(tenant, owner);
    },
    T,
  );

  it(
    "after ⑤ (killed rebuilding the anchor): finished on opening; complete",
    async () => {
      const { tenant, owner } = await newTenant();
      await killedAt("endImport", tenant, owner);
      const a = await cp.anchors.read(tenant);
      expect(a.importInProgress).toBeDefined();
      expect((await cp.tenant(tenant))?.ref).not.toMatchObject({ database: databaseOf(tenant) });
      // The swap recorded the database it replaced; the opening that finishes the import drops it.
      expect((await cp.tenant(tenant))?.staging).toBe(databaseOf(tenant));
      expect(discards).not.toContain(databaseOf(tenant));
      expect(await outcome(tenant)).toBe("complete");
      expect(discards).toContain(databaseOf(tenant));
    },
    T,
  );

  it(
    "after ⑥, the replaced database not dropped: reported; the import stands",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const failures: string[] = [];
      await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: async (o) => {
          if (o.database === databaseOf(tenant)) throw new Error("PROBE drop failed");
          return discardDatabase(o);
        },
        onDiscardFailure: (_, database) => failures.push(database),
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      });
      expect(failures).toEqual([databaseOf(tenant)]);
      await pool.closeAll();
      // Still recorded, so not lost: the next opening drops it (no marker) and forgets it.
      expect((await cp.tenant(tenant))?.staging).toBe(databaseOf(tenant));
      expect(discards).not.toContain(databaseOf(tenant));
      expect(await outcome(tenant)).toBe("complete");
      expect(discards).toContain(databaseOf(tenant));
    },
    T,
  );

  it(
    "a failure after ④ (the swap refused), retried with no opening between: rolled back, then imported",
    async () => {
      const { tenant, owner } = await newTenant();
      const control = new Proxy(cp, {
        get(t, k) {
          const v = Reflect.get(t, k);
          if (typeof v !== "function") return v;
          if (k !== "swapInStaging") return v.bind(t);
          return async () => {
            throw new Error("PROBE swap refused");
          };
        },
      }) as unknown as ServerControl;
      const first = poolOf(control);
      const e = await importServerTenant({
        control,
        backend,
        pool: first,
        discardDatabase,
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(String(e)).toContain("PROBE swap refused");
      await first.closeAll();
      const staging = (await cp.tenant(tenant))?.staging;
      expect((await cp.anchors.read(tenant)).importInProgress).toBeDefined();
      // The client retries: nothing opened the tenant meanwhile.
      const pool = poolOf(cp);
      const r = await imported(cp, pool, tenant, owner);
      expect(r.highWater).toBe(sourceEnd + 1);
      expect(discards).toContain(staging);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "killed after ⑤, retried with no opening between: the import finished by the retry, which is tenant_not_empty",
    async () => {
      const { tenant, owner } = await newTenant();
      await killedAt("endImport", tenant, owner);
      expect((await cp.anchors.read(tenant)).importInProgress).toBeDefined();
      const pool = poolOf(cp);
      const e = await imported(cp, pool, tenant, owner).catch((x: unknown) => x);
      expect(e instanceof OpsError ? e.detail.reason : e).toBe("tenant_not_empty");
      // Finished, not merely refused: the marker cleared and the anchor rebuilt from the log.
      const a = await cp.anchors.read(tenant);
      expect({
        marker: a.importInProgress,
        highWater: a.highWater,
        restoreCount: a.restoreCount,
      }).toEqual({ marker: undefined, highWater: sourceEnd + 1, restoreCount: 1 });
      expect(discards).toContain(databaseOf(tenant));
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "a roll back killed after dropping the staging database, before clearing the marker: it runs again",
    async () => {
      const { tenant, owner } = await newTenant();
      await killedAt("swapInStaging", tenant, owner);
      // The first opening dies after dropping the staging database (taking the marker off fails).
      const d = dying("abortImport");
      const pool = poolOf(d.control, discardDatabase);
      await pool.use(tenant, async () => "used").catch(() => {});
      await pool.closeAll().catch(() => {});
      expect((await cp.anchors.read(tenant)).importInProgress).toBeDefined();
      expect(await outcome(tenant)).toBe("empty");
      await again(tenant, owner);
    },
    T,
  );
});
