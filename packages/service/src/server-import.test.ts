// Import into an empty tenant, server mode, on either backend (02-architecture §8 «格式版本、导出、导入与恢复»
// steps ①–⑥ and «重入», §5 «租户目录», §11 "an import killed by force after each step and then opened
// again"; 04-contract §17 `import`).
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
  newImportId,
  OpsError,
  readTail,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
  writeExport,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  checkDiscard,
  dropTestStorage,
  TEST_BACKEND,
  testBackend,
  testStorageExists,
} from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import type { ServerControl, TenantId, UserId } from "./control-plane.ts";
import { controlImportHolders } from "./import-holders.ts";
import type { OAuthClient } from "./oauth-client.ts";
import { ClientFetchLimits } from "./oauth-client-limits.ts";
import { connectionNameTaken, issueCode, type OAuthDeps, redeemCode } from "./oauth-server.ts";
import { initOAuthTables, openOAuthStore } from "./oauth-store.ts";
import {
  initControlPlane,
  openControlPlane,
  type ServerControlPlane,
} from "./server-control-plane.ts";
import {
  type DiscardDatabase,
  importServerTenant,
  stagingDatabaseOf,
  stagingDiscarder,
} from "./server-import.ts";
import { createServerTenant, databaseOf } from "./server-tenant.ts";
import { TenantPool, TenantPoolError, type TenantPoolOptions } from "./tenant-pool.ts";

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
    // As the server's pool: an opening leaves a staging database to a drop of it under way.
    discardStaging: stagingDiscarder({ control, discardDatabase: discard, inFlight: "leave" }),
    discardScratch: async () => {},
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
let sourceTenant: TenantId;
beforeAll(async () => {
  const { tenant } = await newTenant();
  sourceTenant = tenant;
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

/** An import and the drops it runs after its answer, both done, whether it stands or fails. */
const imported = async (
  control: ServerControl,
  pool: TenantPool,
  tenant: TenantId,
  user: UserId,
  body = bodyOf(file),
) => {
  let afterFailure: Promise<void> | undefined;
  try {
    const r = await importServerTenant({
      control,
      backend,
      pool,
      discardDatabase,
      tenant,
      user,
      body,
      now: "2026-11-21T10:30:00.000Z" as never,
      onFailureDrops: (p) => {
        afterFailure = p;
      },
    });
    await r.dropped;
    return r;
  } catch (e) {
    await afterFailure;
    throw e;
  }
};

/**
 * The tenant as a new process sees it: empty, or the import complete with the anchor agreeing. A
 * control plane of its own, as a new process has: it knows of no drop under way in this one.
 */
async function outcome(tenant: TenantId): Promise<"empty" | "complete"> {
  const fresh = new Proxy(cp, {
    get(t, k) {
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as ServerControl;
  const pool = poolOf(fresh);
  try {
    return await pool.use(tenant, async (t) => {
      const tail = await t.store.read(readTail);
      const a = await t.anchor.read(tenant);
      const entry = await cp.tenant(tenant);
      expect(entry?.staging).toBeUndefined();
      // No seal left (the server mode's ④): the tenant takes a write.
      await t.store.write(async () => {});
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

describe("a clean-up drop's record and report", () => {
  it(
    "a staging record written while a drop runs is kept: the drop forgets only the database it dropped",
    async () => {
      const { tenant } = await newTenant();
      const left = stagingDatabaseOf(tenant, "im_0123456789abcdef");
      const meanwhile = stagingDatabaseOf(tenant, "im_fedcba9876543210");
      await cp.setStaging(tenant, left);
      const discard = stagingDiscarder({
        control: cp,
        inFlight: "wait",
        discardDatabase: async (o) => {
          await discardDatabase(o);
          // Between the drop's reading the entry and its forgetting the record: another recorded.
          await cp.setStaging(tenant, meanwhile);
        },
      });
      await discard(tenant, left);
      expect((await cp.tenant(tenant))?.staging).toBe(meanwhile);
      await cp.setStaging(tenant, null);
    },
    T,
  );

  it(
    "with no reporter given, a failed drop after the answer is one line on standard error",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const lines: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
      try {
        const r = await importServerTenant({
          control: cp,
          backend,
          pool,
          discardDatabase: async (o) => {
            if (o.database === databaseOf(tenant)) {
              throw Object.assign(new Error("PROBE drop failed"), { code: "discard_refused" });
            }
            return discardDatabase(o);
          },
          tenant,
          user: owner,
          body: bodyOf(file),
          now: "2026-11-21T10:30:00.000Z" as never,
        });
        await r.dropped;
      } finally {
        spy.mockRestore();
      }
      expect(lines).toEqual([
        `saveslot server import: ${databaseOf(tenant)} of ${tenant} not dropped: discard_refused`,
      ]);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );
});

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
      // The contract's result, as the local mode gives it: the same keys in the same order.
      expect(r.contract).toEqual({
        tenant_id: tenant,
        previous_tenant_id: sourceTenant,
        events: sourceEnd,
        seq: sourceEnd + 1,
        restore_count: 1,
        // The source's user and its connection: active before the import, disabled by it.
        principals_disabled: 2,
        slots: 0,
        removed: 0,
        pending_deletions: { executed: 0, carried: 0 },
        exported_at: "2026-11-21T09:30:00.000Z",
        not_imported: ["read_log", "credentials", "external_files"],
      });
      expect(Object.keys(r.contract)).toEqual([
        "tenant_id",
        "previous_tenant_id",
        "events",
        "seq",
        "principals_disabled",
        "slots",
        "removed",
        "pending_deletions",
        "exported_at",
        "not_imported",
        "restore_count",
      ]);
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
      let after: Promise<void> | undefined;
      const e = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: async (o) => {
          if (o.database !== o.tenantDatabase) throw new Error("PROBE drop failed");
          return discardDatabase(o);
        },
        onDiscardFailure: (_, database) => failures.push(database),
        onFailureDrops: (p) => {
          after = p;
        },
        tenant,
        user: owner,
        body: bodyOf(broken),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(e instanceof ImportRejected ? e.reason : e).toBe("checksum_mismatch");
      // The drop runs after the answer: it failed, that was told, and its promise resolved.
      await expect(after).resolves.toBeUndefined();
      expect(failures).toHaveLength(1);
      // Still recorded until a drop finishes.
      expect((await cp.tenant(tenant))?.staging).toBe(failures[0]);
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
      await (r as { dropped: Promise<void> }).dropped;
      // A refused file: the staging database's drop fails, its report throws; still import_rejected.
      const b = await newTenant();
      const broken = [...file];
      broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
      let after: Promise<void> | undefined;
      const e = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: failingDrop,
        onDiscardFailure: throwing,
        onFailureDrops: (p) => {
          after = p;
        },
        tenant: b.tenant,
        user: b.owner,
        body: bodyOf(broken),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(e instanceof ImportRejected ? e.reason : e).toBe("checksum_mismatch");
      await expect(after).resolves.toBeUndefined();
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

describe("the replaced database dropped after the answer, outside the exclusive", () => {
  /**
   * A drop of the database `tenant`'s import replaced held until `release` (the first one only),
   * then done as `then` says; other drops as usual.
   */
  function heldDrop(tenant: TenantId, then: "drop" | "fail" = "drop") {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reached = () => {};
    const atDrop = new Promise<void>((r) => {
      reached = r;
    });
    let first = true;
    const drop: DiscardDatabase = async (o) => {
      if (o.database === databaseOf(tenant) && first) {
        first = false;
        reached();
        await held;
        if (then === "fail") throw new Error("PROBE the server went away mid-drop");
      }
      return discardDatabase(o);
    };
    return { drop, release, atDrop };
  }
  /** What `p` gives, or "still waiting" after 30 s. */
  const within = <V>(p: Promise<V>) =>
    Promise.race([p, new Promise<string>((r) => setTimeout(() => r("still waiting"), 30_000))]);

  it(
    "the import answers while the drop is still running, and the tenant serves meanwhile",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const h = heldDrop(tenant);
      const r = await within(
        importServerTenant({
          control: cp,
          backend,
          pool,
          discardDatabase: h.drop,
          tenant,
          user: owner,
          body: bodyOf(file),
          now: "2026-11-21T10:30:00.000Z" as never,
        }),
      );
      // Answered with the drop held: the answer did not wait for it.
      expect(r).toMatchObject({ highWater: sourceEnd + 1, restoreCount: 1 });
      await h.atDrop;
      expect((await cp.tenant(tenant))?.staging).toBe(databaseOf(tenant));
      // The exclusive is released: a use is lent while the drop runs.
      expect(await pool.use(tenant, async () => "used")).toBe("used");
      h.release();
      await (r as { dropped: Promise<void> }).dropped;
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      expect(discards).toContain(databaseOf(tenant));
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "an opening dropping the same record meanwhile: both end, nothing told, the record forgotten",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const h = heldDrop(tenant);
      const failures: string[] = [];
      const r = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: h.drop,
        onDiscardFailure: (_, database) => failures.push(database),
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      });
      await h.atDrop;
      await pool.closeAll();
      // A new process's opening: no marker, the record there, dropped by the opening itself.
      expect(await outcome(tenant)).toBe("complete");
      h.release();
      await r.dropped;
      expect(failures).toEqual([]);
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
    },
    T,
  );

  it(
    "the service stopping while the drop runs: not waited for; the drop failing is told, the record kept, the next opening drops it",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const h = heldDrop(tenant, "fail");
      const failures: string[] = [];
      const r = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: h.drop,
        onDiscardFailure: (_, database) => failures.push(database),
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      });
      await h.atDrop;
      // The pool closes (the server stopping) with the drop in flight: it does not wait for it.
      expect(await within(pool.closeAll().then(() => "closed"))).toBe("closed");
      h.release();
      // The drop fails; that is told, and its promise still resolves (no unhandled rejection).
      await expect(r.dropped).resolves.toBeUndefined();
      expect(failures).toEqual([databaseOf(tenant)]);
      expect((await cp.tenant(tenant))?.staging).toBe(databaseOf(tenant));
      expect(await outcome(tenant)).toBe("complete");
      expect(discards).toContain(databaseOf(tenant));
    },
    T,
  );
});

describe("a failed import's staging database dropped after the answer, outside the exclusive", () => {
  /**
   * Drops as usual, except the first drop `which` matches: held until its `release`, then done.
   * `reached` resolves when that drop has been asked for.
   */
  function holding(...which: ((database: string, tenantDatabase: string) => boolean)[]) {
    const held = which.map((match) => {
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let reach = () => {};
      const reached = new Promise<void>((r) => {
        reach = r;
      });
      return { match, gate, release, reach, reached, used: false };
    });
    /** Every drop asked, in order. */
    const asked: string[] = [];
    const drop: DiscardDatabase = async (o) => {
      asked.push(o.database);
      const h = held.find((x) => !x.used && x.match(o.database, o.tenantDatabase));
      if (h !== undefined) {
        h.used = true;
        h.reach();
        await h.gate;
      }
      return discardDatabase(o);
    };
    return { drop, held, asked };
  }
  const isStaging = (database: string, tenantDatabase: string) =>
    database.startsWith(`${tenantDatabase}_im_`);
  /** What `p` gives, or "still waiting" after 30 s. */
  const within = <V>(p: Promise<V>) =>
    Promise.race([p, new Promise<string>((r) => setTimeout(() => r("still waiting"), 30_000))]);
  /**
   * Resolves once the import reads the tenant's entry a second time with `left` recorded: the read
   * right before it drops a recorded left-over (`importHeld`), which it then asks for at once. A spy
   * on the control plane itself, so the drops under way it keeps are the same ones.
   */
  const readsLeft = (tenant: TenantId, left: string) => {
    let seen = () => {};
    const reached = new Promise<void>((r) => {
      seen = r;
    });
    const read = cp.tenant.bind(cp);
    let reads = 0;
    const spy = vi.spyOn(cp, "tenant").mockImplementation(async (id) => {
      const entry = await read(id);
      if (id === tenant && entry?.staging === left && ++reads === 2) seen();
      return entry;
    });
    return { reached, restore: () => spy.mockRestore() };
  };
  const reasonOf = (e: unknown) =>
    e instanceof ImportRejected ? e.reason : e instanceof OpsError ? e.detail.reason : e;
  const brokenFile = () => {
    const broken = [...file];
    broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
    return broken;
  };
  /** An import with `drop`; its error (or result), and the promise of the drops after a failure. */
  const tried = (
    control: ServerControl,
    pool: TenantPool,
    tenant: TenantId,
    user: UserId,
    drop: DiscardDatabase,
    body: AsyncIterable<Uint8Array>,
  ) => {
    let after: Promise<void> = Promise.resolve();
    const outcome = importServerTenant({
      control,
      backend,
      pool,
      discardDatabase: drop,
      onFailureDrops: (p) => {
        after = p;
      },
      tenant,
      user,
      body,
      now: "2026-11-21T10:30:00.000Z" as never,
    }).catch((x: unknown) => x);
    return { outcome, after: () => after };
  };

  it(
    "a file refused: refused while its staging database's drop is held, the record kept until the drop has finished",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const h = holding(isStaging);
      const t = tried(cp, pool, tenant, owner, h.drop, bodyOf(brokenFile()));
      // Answered with the drop held: the refusal did not wait for it.
      expect(reasonOf(await within(t.outcome))).toBe("checksum_mismatch");
      await h.held[0]?.reached;
      const staging = (await cp.tenant(tenant))?.staging;
      expect(staging?.startsWith(`${databaseOf(tenant)}_im_`)).toBe(true);
      expect(discards).not.toContain(staging);
      h.held[0]?.release();
      await t.after();
      expect(discards).toContain(staging);
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("empty");
    },
    T,
  );

  it(
    "a new import right after a refusal, its drop still held: the new one waits for that drop, then stands",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      // Held: the refused import's staging drop, and the new import's drop of the database it replaced.
      const h = holding(isStaging, (database, tenantDatabase) => database === tenantDatabase);
      const refused = tried(cp, pool, tenant, owner, h.drop, bodyOf(brokenFile()));
      expect(reasonOf(await within(refused.outcome))).toBe("checksum_mismatch");
      await h.held[0]?.reached;
      const old = (await cp.tenant(tenant))?.staging as string;
      // The new import meets the old record with its drop under way: it waits for that drop.
      const reading = readsLeft(tenant, old);
      const r = importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: h.drop,
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      });
      let settled = false;
      void r.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await reading.reached;
      reading.restore();
      await new Promise((go) => setImmediate(go));
      // The held drop asked once (the refused import's), and the new import not answered.
      expect(h.asked.filter((d) => d === old)).toHaveLength(1);
      expect(settled).toBe(false);
      expect((await cp.tenant(tenant))?.staging).toBe(old);
      h.held[0]?.release();
      await refused.after();
      const done = await within(r);
      // The new import asked it again once that drop had ended: it waited for it, and did not leave it.
      expect(h.asked.filter((d) => d === old)).toHaveLength(2);
      expect(done).toMatchObject({ highWater: sourceEnd + 1, restoreCount: 1 });
      await h.held[1]?.reached;
      // The record names the database the swap replaced, its drop held.
      expect((await cp.tenant(tenant))?.staging).toBe(databaseOf(tenant));
      h.held[1]?.release();
      await (done as { dropped: Promise<void> }).dropped;
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      expect(discards).toContain(old);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "a new import right after a refusal whose drop then fails: the new one drops that database itself; none is left unrecorded",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let reach = () => {};
      const reached = new Promise<void>((r) => {
        reach = r;
      });
      let first = true;
      const asked: string[] = [];
      // The refused import's staging drop: held, then failing, as a server going away mid-drop.
      const drop: DiscardDatabase = async (o) => {
        if (first && isStaging(o.database, o.tenantDatabase)) {
          first = false;
          reach();
          await gate;
          throw new Error("PROBE the drop failed");
        }
        asked.push(o.database);
        return discardDatabase(o);
      };
      const failures: string[] = [];
      let after: Promise<void> = Promise.resolve();
      const e = await within(
        importServerTenant({
          control: cp,
          backend,
          pool,
          discardDatabase: drop,
          onDiscardFailure: (_, database) => failures.push(database),
          onFailureDrops: (p) => {
            after = p;
          },
          tenant,
          user: owner,
          body: bodyOf(brokenFile()),
          now: "2026-11-21T10:30:00.000Z" as never,
        }).catch((x: unknown) => x),
      );
      expect(reasonOf(e)).toBe("checksum_mismatch");
      await reached;
      const old = (await cp.tenant(tenant))?.staging as string;
      const reading = readsLeft(tenant, old);
      const r = importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase: drop,
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
      });
      // It waits for the drop under way before its own: not answered, and no drop of it asked.
      let settled = false;
      void r.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await reading.reached;
      reading.restore();
      await new Promise((go) => setImmediate(go));
      expect(settled).toBe(false);
      expect(asked).not.toContain(old);
      release();
      await after;
      expect(failures).toEqual([old]);
      const done = await within(r);
      expect(done).toMatchObject({ highWater: sourceEnd + 1, restoreCount: 1 });
      await (done as { dropped: Promise<void> }).dropped;
      // The old staging database was dropped by the new import, not recorded over and lost.
      expect(asked).toContain(old);
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "a tenant not empty, a staging database still recorded: refused while that database's drop is held",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      await imported(cp, pool, tenant, owner);
      const left = `${databaseOf(tenant)}_im_0123456789abcdef`;
      await (
        await backend.open({ kind: "postgres", cell: CELL, database: left }, { create: true })
      ).close();
      await cp.setStaging(tenant, left);
      const h = holding((database) => database === left);
      const t = tried(cp, pool, tenant, owner, h.drop, bodyOf(file));
      expect(reasonOf(await within(t.outcome))).toBe("tenant_not_empty");
      await h.held[0]?.reached;
      expect((await cp.tenant(tenant))?.staging).toBe(left);
      h.held[0]?.release();
      await t.after();
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      expect(discards).toContain(left);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("complete");
    },
    T,
  );

  it(
    "④ refusing the marker: refused while the staging database's drop is held, the tenant still empty",
    async () => {
      const { tenant, owner } = await newTenant();
      // ④ refuses as it does when the tenant is no longer empty: no marker set.
      const anchors = new Proxy(cp.anchors as AnchorStore, {
        get(t, k) {
          const v = Reflect.get(t, k);
          if (typeof v !== "function") return v;
          if (k !== "beginImport") return v.bind(t);
          return async () => {
            throw new OpsError("invalid_argument", "the tenant is not empty", {
              reason: "tenant_not_empty",
            });
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
      const h = holding(isStaging);
      const t = tried(control, pool, tenant, owner, h.drop, bodyOf(file));
      expect(reasonOf(await within(t.outcome))).toBe("tenant_not_empty");
      await h.held[0]?.reached;
      const staging = (await cp.tenant(tenant))?.staging;
      expect(staging?.startsWith(`${databaseOf(tenant)}_im_`)).toBe(true);
      h.held[0]?.release();
      await t.after();
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      expect(discards).toContain(staging);
      await pool.closeAll();
      expect(await outcome(tenant)).toBe("empty");
    },
    T,
  );
});

describe("a drop of a staging database already under way", () => {
  /** A drop of `database` held until `release`, then done or failed; others as usual. */
  function heldOnce(database: () => string, then: "drop" | "fail" = "drop") {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reach = () => {};
    const reached = new Promise<void>((r) => {
      reach = r;
    });
    let first = true;
    const calls: string[] = [];
    const drop: DiscardDatabase = async (o) => {
      calls.push(o.database);
      if (first && o.database === database()) {
        first = false;
        reach();
        await gate;
        if (then === "fail") throw new Error("PROBE the drop failed");
      }
      return discardDatabase(o);
    };
    return { drop, release, reached, calls };
  }
  /** What `p` gives, or "still waiting" after 10 s. */
  const within = <V>(p: Promise<V>) =>
    Promise.race([p, new Promise<string>((r) => setTimeout(() => r("still waiting"), 10_000))]);
  /** A tenant with a staging database recorded, as an import's failure leaves it. */
  async function recorded() {
    const { tenant } = await newTenant();
    const staging = `${databaseOf(tenant)}_im_0123456789abcdef`;
    await (
      await backend.open({ kind: "postgres", cell: CELL, database: staging }, { create: true })
    ).close();
    await cp.setStaging(tenant, staging);
    return { tenant, staging };
  }

  it(
    "an opening's discard with inFlight leave: returns at once, asks no drop; the drop under way forgets the record",
    async () => {
      const { tenant, staging } = await recorded();
      const h = heldOnce(() => staging);
      const running = stagingDiscarder({ control: cp, discardDatabase: h.drop, inFlight: "wait" })(
        tenant,
        staging,
      );
      await h.reached;
      const leave = stagingDiscarder({ control: cp, discardDatabase: h.drop, inFlight: "leave" });
      expect(await within(leave(tenant, staging).then(() => "returned"))).toBe("returned");
      expect(h.calls).toEqual([staging]);
      expect((await cp.tenant(tenant))?.staging).toBe(staging);
      h.release();
      await running;
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
    },
    T,
  );

  it(
    "with inFlight wait, it waits for the drop under way, then drops again: that drop failing still leaves the database dropped and forgotten",
    async () => {
      const { tenant, staging } = await recorded();
      const h = heldOnce(() => staging, "fail");
      const running = stagingDiscarder({ control: cp, discardDatabase: h.drop, inFlight: "wait" })(
        tenant,
        staging,
      );
      await h.reached;
      let done = false;
      const waiting = stagingDiscarder({ control: cp, discardDatabase: h.drop, inFlight: "wait" })(
        tenant,
        staging,
      ).then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 200));
      // Not before the drop under way has ended.
      expect(done).toBe(false);
      expect(h.calls).toEqual([staging]);
      h.release();
      await expect(running).rejects.toThrow("PROBE the drop failed");
      await waiting;
      expect(h.calls).toEqual([staging, staging]);
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
    },
    T,
  );

  it(
    "an after-answer drop meeting a drop of the same database under way: settles only once that drop has ended, and a failure is told to this import",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      await imported(cp, pool, tenant, owner);
      // A left-over recorded, its drop under way (an opening's, held) when the import is refused.
      const left = `${databaseOf(tenant)}_im_0123456789abcdef`;
      await (
        await backend.open({ kind: "postgres", cell: CELL, database: left }, { create: true })
      ).close();
      await cp.setStaging(tenant, left);
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let reach = () => {};
      const reached = new Promise<void>((r) => {
        reach = r;
      });
      const asked: string[] = [];
      // Every drop of it fails (the server went away); the first is held.
      const drop: DiscardDatabase = async (o) => {
        asked.push(o.database);
        if (o.database !== left) return discardDatabase(o);
        if (asked.filter((d) => d === left).length === 1) {
          reach();
          await gate;
        }
        throw new Error("PROBE the drop failed");
      };
      const under = stagingDiscarder({ control: cp, discardDatabase: drop, inFlight: "leave" })(
        tenant,
        left,
      ).catch(() => {});
      await reached;
      const failures: string[] = [];
      let after: Promise<void> = Promise.resolve();
      const e = await within(
        importServerTenant({
          control: cp,
          backend,
          pool,
          discardDatabase: drop,
          onDiscardFailure: (_, database) => failures.push(database),
          onFailureDrops: (p) => {
            after = p;
          },
          tenant,
          user: owner,
          body: bodyOf(file),
          now: "2026-11-21T10:30:00.000Z" as never,
        }).catch((x: unknown) => x),
      );
      expect(e instanceof OpsError ? e.detail.reason : e).toBe("tenant_not_empty");
      let settled = false;
      void after.then(() => {
        settled = true;
      });
      await new Promise((go) => setImmediate(go));
      // The drop under way is held: the import's own is not done yet.
      expect(settled).toBe(false);
      expect(asked.filter((d) => d === left)).toHaveLength(1);
      release();
      await under;
      await after;
      // It dropped once more itself, failed, and this import was told; the record stays.
      expect(asked.filter((d) => d === left)).toHaveLength(2);
      expect(failures).toEqual([left]);
      expect((await cp.tenant(tenant))?.staging).toBe(left);
      await pool.closeAll();
    },
    T,
  );

  it(
    "a host's onFailureDrops that throws: the import's own refusal is what is thrown",
    async () => {
      const { tenant, owner } = await newTenant();
      const pool = poolOf(cp);
      const broken = [...file];
      broken[2] = (broken[2] as string).replace('"desk"', '"DESK"');
      let after: Promise<void> | undefined;
      const e = await importServerTenant({
        control: cp,
        backend,
        pool,
        discardDatabase,
        onFailureDrops: (p) => {
          after = p;
          throw new Error("PROBE the host's callback threw");
        },
        tenant,
        user: owner,
        body: bodyOf(broken),
        now: "2026-11-21T10:30:00.000Z" as never,
      }).catch((x: unknown) => x);
      expect(e instanceof ImportRejected ? e.reason : e).toBe("checksum_mismatch");
      await after;
      expect((await cp.tenant(tenant))?.staging).toBeUndefined();
      await pool.closeAll();
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
      const r = await importServerTenant({
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
      await r.dropped;
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

/** The OAuth client and PKCE pair of the cross-process redemption (RFC 7636's example pair). */
const EXT = "https://saveslot.example";
const OAUTH_CLIENT: OAuthClient = {
  id: "https://client.example/oauth/client.json",
  name: "Example Agent",
  host: "client.example",
  redirectUris: ["https://client.example/callback"],
  builtIn: false,
};
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

// Across processes (02-architecture §8 «格式版本、导出、导入与恢复», the import's hold): each process
// a pool of its own over a connection of its own to the control database, with its import holders
// (./import-holders.ts). On PostgreSQL only: PGlite has one connection to a database, one session.
describe.runIf(TEST_BACKEND === "postgres")("an import across processes", () => {
  const controlDir = join(root, "control");
  const open: { close(): Promise<void> }[] = [];
  const mine: TenantPool[] = [];
  // The pools first, while their control connections are there to take their high water.
  afterAll(async () => {
    for (const p of mine.splice(0)) await p.closeAll().catch(() => {});
    for (const c of open.splice(0)) await c.close().catch(() => {});
  }, T);

  /** A process: its control connection, control plane, holders and pool. */
  async function processOf(onCloseFailure: TenantPoolOptions["onCloseFailure"] = () => {}) {
    const conn = await secondConnection(controlDir);
    open.push(conn);
    const control = await openControlPlane(conn);
    const holders = controlImportHolders({
      db: conn,
      open: async () => {
        const c = await secondConnection(controlDir);
        open.push(c);
        return c;
      },
    });
    const pool = new TenantPool({
      control,
      backend,
      idleMs: 60_000,
      now: () => NOW,
      discardStaging: stagingDiscarder({ control, discardDatabase, inFlight: "leave" }),
      discardScratch: async () => {},
      holders,
      onCloseFailure,
    });
    mine.push(pool);
    return { control, holders, pool };
  }

  const importing = { name: "TenantPoolError", code: "importing" };
  const entryOf = (tenant: TenantId) => cp.tenant(tenant);
  const tailOf = (pool: TenantPool, tenant: TenantId) =>
    pool.use(tenant, (t) => t.store.read((tx) => readTail(tx)));
  /** A write of the tenant through a pool: a connection's registration, as any write. */
  const writeThrough = (pool: TenantPool, tenant: TenantId, n: number) =>
    pool.use(tenant, (t) =>
      t.store.write((tx) =>
        appendOperation(tx, {
          actor: t.owner,
          now: NOW as never,
          events: [
            {
              type: "principal.registered",
              blocks: {
                ctx: { now: NOW, ruleset_version: 1 },
                principal: {
                  principal: `ci_${String(n).padStart(26, "7")}`,
                  kind: "connection",
                  scopes: ["saveslot.read"],
                  via: "token",
                },
                name: { name: `w${n}` },
              },
            } as never,
          ],
        }),
      ),
    );

  it(
    "while one process imports, another's use is refused (importing) and its import is busy; then it reads what was imported",
    async () => {
      const a = await processOf();
      const b = await processOf();
      const { tenant, owner } = await newTenant();
      let go!: () => void;
      const hold = new Promise<void>((r) => {
        go = r;
      });
      const running = importServerTenant({
        control: a.control,
        backend,
        pool: a.pool,
        discardDatabase,
        tenant,
        user: owner,
        body: bodyOf(file, hold),
        now: "2026-11-21T10:30:00.000Z" as never,
        holders: a.holders,
      });
      try {
        for (let i = 0; (await entryOf(tenant))?.importHolder === undefined; i++) {
          if (i > 500) throw new Error("the import never wrote its mark");
          await new Promise((r) => setTimeout(r, 10));
        }
        await expect(tailOf(b.pool, tenant)).rejects.toMatchObject(importing);
        await expect(
          importServerTenant({
            control: b.control,
            backend,
            pool: b.pool,
            discardDatabase,
            tenant,
            user: owner,
            body: bodyOf(file),
            now: "2026-11-21T10:31:00.000Z" as never,
            holders: b.holders,
          }),
        ).rejects.toMatchObject({ code: "busy", holder: "importing" });
      } finally {
        go();
      }
      await (await running).dropped;
      expect((await entryOf(tenant))?.importHolder).toBeUndefined();
      expect((await tailOf(b.pool, tenant))?.seq).toBe(sourceEnd + 1);
    },
    T,
  );

  it(
    "OAuth's code redemption in another process while one imports: refused (importing), nothing written to the old database or the staging one; after it, a redemption issues",
    async () => {
      await initOAuthTables(controlStore);
      const a = await processOf();
      const b = await processOf();
      const { tenant, owner } = await newTenant();
      const conn = await secondConnection(controlDir);
      open.push(conn);
      const deps: OAuthDeps = {
        store: await openOAuthStore(conn),
        control: b.control,
        identity: {
          issueUserSession: async () => {
            throw new Error("no user session here");
          },
        },
        pool: { use: (t, fn) => b.pool.use(t, fn) },
        fetchClient: async () => {
          throw new Error("no client document fetched here");
        },
        external: EXT,
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        clientFetches: new ClientFetchLimits(),
      };
      const NAME = "Laptop · Example Agent";
      const code = () =>
        issueCode(deps, {
          client: OAUTH_CLIENT,
          redirectUri: OAUTH_CLIENT.redirectUris[0] as string,
          codeChallenge: CHALLENGE,
          resource: EXT,
          user: owner,
          login: "login-1",
          tenant,
          scopes: ["saveslot.read"],
          name: NAME,
          now: NOW,
        });
      const redeem = async (c: string) =>
        redeemCode(
          deps,
          new URLSearchParams({
            grant_type: "authorization_code",
            code: c,
            code_verifier: VERIFIER,
            client_id: OAUTH_CLIENT.id,
            redirect_uri: OAUTH_CLIENT.redirectUris[0] as string,
          }),
          NOW,
        );
      const old = await entryOf(tenant);
      let go!: () => void;
      const hold = new Promise<void>((r) => {
        go = r;
      });
      const running = importServerTenant({
        control: a.control,
        backend,
        pool: a.pool,
        discardDatabase,
        tenant,
        user: owner,
        body: bodyOf(file, hold),
        now: "2026-11-21T10:30:00.000Z" as never,
        holders: a.holders,
      });
      let staging: string | undefined;
      try {
        for (let i = 0; (await entryOf(tenant))?.staging === undefined; i++) {
          if (i > 500) throw new Error("the import never made its staging database");
          await new Promise((r) => setTimeout(r, 10));
        }
        staging = (await entryOf(tenant))?.staging;
        await expect(redeem(await code())).rejects.toMatchObject(importing);
        // Nothing of it in either database: the old one holds its genesis only, the staging one
        // no connection of that name.
        const oldStore = await backend.open((old as NonNullable<typeof old>).ref, {});
        // Named in the directory before it is made: opened once it is there.
        let stagingStore: TenantStore | undefined;
        for (let i = 0; stagingStore === undefined; i++) {
          stagingStore = await backend
            .open({ kind: "postgres", cell: CELL, database: staging as string }, {})
            .catch((e: unknown) => {
              if (i > 500) throw e;
              return new Promise<undefined>((r) => setTimeout(() => r(undefined), 10));
            });
        }
        try {
          expect((await oldStore.read((tx) => readTail(tx)))?.seq).toBe(1);
          expect(await connectionNameTaken(oldStore, NAME)).toBe(false);
          expect(await connectionNameTaken(stagingStore, NAME)).toBe(false);
        } finally {
          await oldStore.close();
          await stagingStore.close();
        }
      } finally {
        go();
      }
      await (await running).dropped;
      const issued = await redeem(await code());
      expect(issued.access_token).toMatch(/^slt_/);
      expect(await b.pool.use(tenant, (t) => connectionNameTaken(t.store, NAME))).toBe(true);
    },
    T,
  );

  it(
    "an import whose process ended before ④: the next use in another process drops its staging database, clears the mark, and serves",
    async () => {
      const a = await processOf();
      const b = await processOf();
      const { tenant } = await newTenant();
      const hold = await a.holders.take(tenant);
      if (hold === undefined) throw new Error("no hold");
      const ended = newImportId();
      await hold.mark(ended);
      const staging = stagingDatabaseOf(tenant, ended);
      await a.control.setStaging(tenant, staging);
      await (
        await backend.open({ kind: "postgres", cell: CELL, database: staging }, { create: true })
      ).close();
      // The process ends: its connection, and the lock with it, gone; the mark stays.
      await hold.release();
      expect((await entryOf(tenant))?.importHolder).toBe(ended);
      await writeThrough(b.pool, tenant, 1);
      const after = await entryOf(tenant);
      expect(after?.importHolder).toBeUndefined();
      expect(after?.staging).toBeUndefined();
      expect(discards).toContain(staging);
    },
    T,
  );

  it(
    "one that ended after ④, sealed and marked, before ⑤: the finder lifts the seal, clears the anchor's marker and then the mark; writes go on",
    async () => {
      const a = await processOf();
      const b = await processOf();
      const { tenant } = await newTenant();
      const importId = newImportId();
      const hold = await a.holders.take(tenant);
      if (hold === undefined) throw new Error("no hold");
      await hold.mark(importId);
      const entry = await entryOf(tenant);
      const staging = stagingDatabaseOf(tenant, importId);
      await a.control.setStaging(tenant, staging);
      await (
        await backend.open({ kind: "postgres", cell: CELL, database: staging }, { create: true })
      ).close();
      await a.control.anchors.beginImport(tenant, importId);
      const target = await backend.open((entry as NonNullable<typeof entry>).ref, {});
      try {
        expect(await target.seal?.(importId)).toBe("sealed");
        // Sealed: a write of any process is refused.
        await expect(writeThrough(b.pool, tenant, 2)).rejects.toBeDefined();
      } finally {
        await target.close();
      }
      await hold.release();
      await writeThrough(b.pool, tenant, 3);
      const after = await entryOf(tenant);
      expect(after?.importHolder).toBeUndefined();
      expect(after?.staging).toBeUndefined();
      expect((await cp.anchors.read(tenant)).importInProgress).toBeUndefined();
    },
    T,
  );

  it(
    "a process that had the tenant open before another's import closes the replaced database without pushing the high water from it",
    async () => {
      const a = await processOf();
      const failures: string[] = [];
      const b = await processOf((_t, what) => failures.push(what));
      const { tenant, owner } = await newTenant();
      expect((await tailOf(b.pool, tenant))?.seq).toBe(1);
      const r = await importServerTenant({
        control: a.control,
        backend,
        pool: a.pool,
        discardDatabase,
        tenant,
        user: owner,
        body: bodyOf(file),
        now: "2026-11-21T10:30:00.000Z" as never,
        holders: a.holders,
      });
      await r.dropped;
      const before = await cp.anchors.read(tenant);
      // B's storage is the replaced database's: closed, and told nothing went wrong.
      await b.pool.closeAll();
      expect(failures).toEqual([]);
      expect(await cp.anchors.read(tenant)).toEqual(before);
    },
    T,
  );

  it(
    "two processes finding it at once: one finishes it; the other is refused (importing) or served after",
    async () => {
      const a = await processOf();
      const b = await processOf();
      const c = await processOf();
      const { tenant } = await newTenant();
      const hold = await a.holders.take(tenant);
      if (hold === undefined) throw new Error("no hold");
      await hold.mark(newImportId());
      await hold.release();
      const results = await Promise.allSettled([tailOf(b.pool, tenant), tailOf(c.pool, tenant)]);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toMatchObject(importing);
      }
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
      expect((await entryOf(tenant))?.importHolder).toBeUndefined();
    },
    T,
  );

  it(
    "a write already waiting for the tenant's lock when ④ seals it is refused once it gets the lock (tenant_sealed), nothing written",
    async () => {
      const { tenant } = await newTenant();
      const entry = await entryOf(tenant);
      const ref = (entry as NonNullable<typeof entry>).ref;
      const holder = await backend.open(ref, {});
      const sealer = await backend.open(ref, {});
      const writer = await backend.open(ref, {});
      const watcher = await backend.open(ref, {});
      const waiting = async (n: number) => {
        for (let i = 0; i < 500; i++) {
          const r = await watcher.read((tx) =>
            tx.query<{ n: number }>(
              `SELECT count(*)::int4 AS n FROM pg_locks
               WHERE locktype = 'advisory' AND NOT granted
                 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
            ),
          );
          if (r.rows[0]?.n === n) return;
          await new Promise((res) => setTimeout(res, 10));
        }
        throw new Error(`never ${n} waiting for the lock`);
      };
      try {
        let release!: () => void;
        let holding!: () => void;
        const inside = new Promise<void>((r) => {
          holding = r;
        });
        // Inside its transaction, the lock taken: only then are the others queued behind it.
        const held = holder.write(
          () =>
            new Promise<void>((r) => {
              release = r;
              holding();
            }),
        );
        await inside;
        // ④ first in the lock's queue, then the write: it passed its checks before the seal.
        const sealed = sealer.seal?.(newImportId());
        await waiting(1);
        const wrote = writer.write((tx) => tx.query("SELECT 1"));
        await waiting(2);
        release();
        await held;
        expect(await sealed).toBe("sealed");
        await expect(wrote).rejects.toMatchObject({ code: "tenant_sealed" });
      } finally {
        for (const s of [holder, sealer, writer, watcher]) await s.close().catch(() => {});
      }
    },
    T,
  );

  it(
    "④ refuses a log that holds more than the genesis event: nothing sealed",
    async () => {
      const entry = await entryOf(sourceTenant);
      const target = await backend.open((entry as NonNullable<typeof entry>).ref, {});
      try {
        expect(await target.seal?.(newImportId())).toBe("not_empty");
        await target.write(async () => {});
      } finally {
        await target.close();
      }
    },
    T,
  );
});
