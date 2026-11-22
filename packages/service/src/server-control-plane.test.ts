// The server mode's control plane on a real database, on either backend (02-architecture §11
// «测试矩阵»; `pnpm test:postgres` runs this file on PostgreSQL): its tables made once, the tenant
// directory and the credentials, and the anchor store — the kernel's conformance cases, and that
// each of its writes commits on its own, whatever a tenant's transaction does. Fictional IDs.

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantStore } from "@fluxvita/saveslot-kernel";
import { anchorStoreConformance, deletionEntry } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  POSTGRES_DATABASE_NAME,
  TEST_BACKEND,
  testBackend,
} from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import {
  CONTROL_FORMAT,
  ControlPlaneError,
  DATABASE_NAME,
  initControlPlane,
  openControlPlane,
  type ServerControlPlane,
} from "./server-control-plane.ts";

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-server-control-"));
// Removing a directory holding a PGlite data directory can pass the default 10 s hook time under load.
afterAll(() => rm(root, { recursive: true, force: true }), T);

const TENANT = `tn_${"8".repeat(26)}` as const;
const USER = `u_${"1".repeat(26)}` as const;
const CI = `ci_${"5".repeat(26)}` as const;
const HASH = "a".repeat(64);

let n = 0;
const open: TenantStore[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {});
}, T);

/** A database of its own, closed after the test: the test backend's storage for a directory. */
async function database(dir = join(root, String(n++))): Promise<{ db: TenantStore; dir: string }> {
  const db = await testBackend().open({ kind: "pglite", dir }, { create: true });
  open.push(db);
  return { db, dir };
}

// One control database for the file, its tables made once and emptied before each use: opening a
// PGlite database takes about a second, emptying four tables milliseconds.
const sharedDir = join(root, "control");
let shared: TenantStore;
let sharedCp: ServerControlPlane;
beforeAll(async () => {
  shared = await testBackend().open({ kind: "pglite", dir: sharedDir }, { create: true });
  sharedCp = await initControlPlane(shared);
}, T);
afterAll(async () => {
  await shared?.close();
}, T);

/** The file's control plane, with nothing in it. */
async function controlPlane(): Promise<{ cp: ServerControlPlane; db: TenantStore }> {
  await shared.write((tx) =>
    tx.exec(
      "DELETE FROM credentials; DELETE FROM tenants; DELETE FROM anchor_deletions; DELETE FROM anchors",
    ),
  );
  return { cp: sharedCp, db: shared };
}

describe("initControlPlane", () => {
  it(
    "makes the tables once; run again, it checks the format and changes nothing",
    async () => {
      const { db } = await database();
      await initControlPlane(db);
      await db.write((tx) =>
        tx.query(
          "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'a', 'db1', 'active')",
          [TENANT, USER],
        ),
      );
      await initControlPlane(db);
      const r = await db.read((tx) =>
        tx.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants"),
      );
      expect(Number(r.rows[0]?.n)).toBe(1);
      const f = await db.read((tx) =>
        tx.query<{ value: string }>("SELECT value FROM control_meta WHERE key = 'format'"),
      );
      expect(f.rows[0]?.value).toBe(String(CONTROL_FORMAT));
    },
    T,
  );

  it(
    "refuses a control database of another format, and so does opening one",
    async () => {
      const { db } = await database();
      await initControlPlane(db);
      await db.write((tx) => tx.query("UPDATE control_meta SET value = '2' WHERE key = 'format'"));
      await expect(initControlPlane(db)).rejects.toMatchObject({
        name: ControlPlaneError.name,
        code: "control_format_mismatch",
      });
      await expect(openControlPlane(db)).rejects.toMatchObject({
        code: "control_format_mismatch",
      });
    },
    T,
  );

  it(
    "opens a control plane only over a control database made, and makes nothing itself",
    async () => {
      const { db } = await database();
      await expect(openControlPlane(db)).rejects.toMatchObject({
        code: "control_not_initialized",
      });
      await initControlPlane(db);
      const cp = await openControlPlane(db);
      expect(await cp.tenant(TENANT)).toBeUndefined();
    },
    T,
  );
});

describe("the tenant directory", () => {
  it(
    "gives a tenant by its ID and by its owner, its storage a database of a cell",
    async () => {
      const { cp, db } = await controlPlane();
      await db.write((tx) =>
        tx.query(
          "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'cell_a', 'tdb_1', 'creating')",
          [TENANT, USER],
        ),
      );
      const entry = {
        id: TENANT,
        owner: USER,
        ref: { kind: "postgres", cell: "cell_a", database: "tdb_1" },
        state: "creating",
      };
      expect(await cp.tenant(TENANT)).toEqual(entry);
      expect(await cp.tenantOf(USER)).toEqual(entry);
      expect(await cp.tenant(`tn_${"9".repeat(26)}` as const)).toBeUndefined();
      expect(await cp.tenantOf(`u_${"2".repeat(26)}` as const)).toBeUndefined();
    },
    T,
  );
});

describe("credentials", () => {
  it(
    "are recorded and found by hash, with an expiry and a grant when they have them, and removed by principal",
    async () => {
      const { cp, db } = await controlPlane();
      await db.write((tx) =>
        tx.query(
          "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'a', 'db1', 'active')",
          [TENANT, USER],
        ),
      );
      const session = {
        hash: HASH,
        kind: "session",
        principal: USER,
        tenant: TENANT,
        expiresAt: "2026-12-01T00:00:00.000Z",
      } as const;
      const connection = {
        hash: "b".repeat(64),
        kind: "connection",
        principal: CI,
        tenant: TENANT,
        expiresAt: "2026-11-21T00:00:00.000Z",
        grant: "g_1",
      } as const;
      await cp.putCredential(session);
      await cp.putCredential(connection);
      expect(await cp.credential(HASH)).toEqual(session);
      expect(await cp.credential("b".repeat(64))).toEqual(connection);
      expect(await cp.credential("c".repeat(64))).toBeUndefined();
      expect(await cp.removeCredentials(TENANT, new Set([CI]))).toBe(1);
      expect(await cp.removeCredentials(TENANT, new Set())).toBe(0);
      expect(await cp.credential("b".repeat(64))).toBeUndefined();
      expect(await cp.credential(HASH)).toEqual(session);
    },
    T,
  );

  it(
    "are refused for a tenant the directory does not have",
    async () => {
      const { cp } = await controlPlane();
      await expect(
        cp.putCredential({ hash: HASH, kind: "connection", principal: CI, tenant: TENANT }),
      ).rejects.toMatchObject({ name: ControlPlaneError.name, code: "unknown_tenant" });
      expect(await cp.credential(HASH)).toBeUndefined();
    },
    T,
  );

  it(
    "are refused not of their form, or with a hash already there, and nothing is stored",
    async () => {
      const { cp, db } = await controlPlane();
      await db.write((tx) =>
        tx.query(
          "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'a', 'db1', 'active')",
          [TENANT, USER],
        ),
      );
      const c = { hash: HASH, kind: "connection", principal: CI, tenant: TENANT } as const;
      for (const bad of [
        { ...c, hash: HASH.toUpperCase() },
        { ...c, hash: `${HASH}0` },
        { ...c, expiresAt: "never" },
        { ...c, expiresAt: "2026-12-01T00:00:00Z" },
        { ...c, expiresAt: "2026-02-30T00:00:00.000Z" },
      ]) {
        await expect(cp.putCredential(bad)).rejects.toMatchObject({ code: "invalid_credential" });
      }
      expect(await cp.credential(HASH)).toBeUndefined();
      await cp.putCredential(c);
      await expect(
        cp.putCredential({ ...c, principal: `ci_${"6".repeat(26)}` }),
      ).rejects.toMatchObject({ code: "already_exists" });
      expect(await cp.credential(HASH)).toEqual(c);
    },
    T,
  );

  it(
    "are removed in their tenant only, a principal's ID being in two tenants' logs",
    async () => {
      const { cp, db } = await controlPlane();
      const OTHER_TENANT = `tn_${"9".repeat(26)}` as const;
      await db.write((tx) =>
        tx.exec(`INSERT INTO tenants (id, owner, cell, database, state) VALUES
          ('${TENANT}', '${USER}', 'a', 'db1', 'active'),
          ('${OTHER_TENANT}', 'u_${"2".repeat(26)}', 'a', 'db2', 'active')`),
      );
      await cp.putCredential({
        hash: "a".repeat(64),
        kind: "connection",
        principal: CI,
        tenant: TENANT,
      });
      await cp.putCredential({
        hash: "b".repeat(64),
        kind: "connection",
        principal: CI,
        tenant: OTHER_TENANT,
      });
      expect(await cp.removeCredentials(OTHER_TENANT, new Set([CI]))).toBe(1);
      expect(await cp.credential("a".repeat(64))).toBeDefined();
      expect(await cp.credential("b".repeat(64))).toBeUndefined();
    },
    T,
  );

  it(
    "are removed by kind when asked: a user's sessions, not the connections recorded for it",
    async () => {
      const { cp, db } = await controlPlane();
      await db.write((tx) =>
        tx.query(
          "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'a', 'db1', 'active')",
          [TENANT, USER],
        ),
      );
      await cp.putCredential({
        hash: "a".repeat(64),
        kind: "session",
        principal: USER,
        tenant: TENANT,
      });
      await cp.putCredential({
        hash: "b".repeat(64),
        kind: "connection",
        principal: USER,
        tenant: TENANT,
      });
      expect(await cp.removeCredentials(TENANT, new Set([USER]), { kind: "session" })).toBe(1);
      expect(await cp.credential("a".repeat(64))).toBeUndefined();
      expect(await cp.credential("b".repeat(64))).toBeDefined();
    },
    T,
  );
});

describe("the tenant directory's databases", () => {
  it(
    "are one tenant's in a cell; the same name in another cell is another database",
    async () => {
      const { db } = await controlPlane();
      await db.write((tx) =>
        tx.exec(`INSERT INTO tenants (id, owner, cell, database, state) VALUES
          ('tn_${"1".repeat(26)}', 'u_${"1".repeat(26)}', 'cell_a', 'tdb', 'active'),
          ('tn_${"2".repeat(26)}', 'u_${"2".repeat(26)}', 'cell_b', 'tdb', 'active')`),
      );
      await expect(
        db.write((tx) =>
          tx.exec(`INSERT INTO tenants (id, owner, cell, database, state) VALUES
            ('tn_${"3".repeat(26)}', 'u_${"3".repeat(26)}', 'cell_a', 'tdb', 'active')`),
        ),
      ).rejects.toBeDefined();
    },
    T,
  );
});

describe("the tenant directory's states", () => {
  const ref = (database: string) => ({ kind: "postgres", cell: "cell_a", database }) as const;
  const OTHER = `u_${"2".repeat(26)}` as const;
  const ID2 = `tn_${"9".repeat(26)}` as const;

  it(
    "registers a tenant as creating, and gives an owner's tenant as it is when it has one",
    async () => {
      const { cp } = await controlPlane();
      const e = await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_1") });
      expect(e).toEqual({ id: TENANT, owner: USER, ref: ref("tdb_1"), state: "creating" });
      expect(await cp.registerTenant({ id: ID2, owner: USER, ref: ref("tdb_2") })).toEqual(e);
      expect(await cp.tenant(ID2)).toBeUndefined();
    },
    T,
  );

  it(
    "refuses another owner's tenant ID, or a database of the same cell; takes the name in another cell",
    async () => {
      const { cp } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_1") });
      await expect(
        cp.registerTenant({ id: TENANT, owner: OTHER, ref: ref("tdb_2") }),
      ).rejects.toMatchObject({ name: ControlPlaneError.name, code: "tenant_taken" });
      await expect(
        cp.registerTenant({ id: ID2, owner: OTHER, ref: ref("tdb_1") }),
      ).rejects.toMatchObject({ code: "tenant_taken" });
      expect(await cp.tenantOf(OTHER)).toBeUndefined();
      const elsewhere = { kind: "postgres", cell: "cell_b", database: "tdb_1" } as const;
      expect(await cp.registerTenant({ id: ID2, owner: OTHER, ref: elsewhere })).toMatchObject({
        id: ID2,
        ref: elsewhere,
      });
    },
    T,
  );

  it(
    "activates a tenant, again without error; refuses a tenant not there",
    async () => {
      const { cp } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_1") });
      await cp.activateTenant(TENANT);
      await cp.activateTenant(TENANT);
      expect((await cp.tenant(TENANT))?.state).toBe("active");
      await expect(cp.activateTenant(ID2)).rejects.toMatchObject({ code: "unknown_tenant" });
    },
    T,
  );

  it(
    "swaps the staging database in, in one step, and forgets it",
    async () => {
      const { cp, db } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_1") });
      await cp.setStaging(TENANT, "tdb_staging");
      await cp.swapInStaging(TENANT);
      expect((await cp.tenant(TENANT))?.ref).toEqual(ref("tdb_staging"));
      const r = await db.read((tx) =>
        tx.query<{ s: string | null }>("SELECT staging_database AS s FROM tenants WHERE id = $1", [
          TENANT,
        ]),
      );
      expect(r.rows[0]?.s).toBeNull();
    },
    T,
  );

  it(
    "refuses a swap with no staging database, and leaves the tenant as it was",
    async () => {
      const { cp } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_1") });
      await expect(cp.swapInStaging(TENANT)).rejects.toMatchObject({ code: "no_staging" });
      await cp.setStaging(TENANT, "tdb_staging");
      await cp.setStaging(TENANT, null);
      await expect(cp.swapInStaging(TENANT)).rejects.toMatchObject({ code: "no_staging" });
      expect((await cp.tenant(TENANT))?.ref).toEqual(ref("tdb_1"));
      await expect(cp.swapInStaging(ID2)).rejects.toMatchObject({ code: "unknown_tenant" });
      await expect(cp.setStaging(ID2, "x")).rejects.toMatchObject({ code: "unknown_tenant" });
    },
    T,
  );
});

describe("the tenant directory's database names", () => {
  it("are checked by the same shape as the PostgreSQL backend's", () => {
    expect(DATABASE_NAME.source).toBe(POSTGRES_DATABASE_NAME.source);
    expect(DATABASE_NAME.flags).toBe(POSTGRES_DATABASE_NAME.flags);
  });

  const ref = (database: string, cell = "cell_a") =>
    ({ kind: "postgres", cell, database }) as const;
  const OTHER = `u_${"2".repeat(26)}` as const;
  const THIRD = `u_${"3".repeat(26)}` as const;
  const ID2 = `tn_${"9".repeat(26)}` as const;
  const ID3 = `tn_${"7".repeat(26)}` as const;
  const staging = async (db: TenantStore, id: string) =>
    (
      await db.read((tx) =>
        tx.query<{ s: string | null }>("SELECT staging_database AS s FROM tenants WHERE id = $1", [
          id,
        ]),
      )
    ).rows[0]?.s;

  it(
    "refuses one not of a database's shape, or the server's own, registered or as staging",
    async () => {
      const { cp, db } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_1") });
      for (const bad of [
        "postgres",
        "template0",
        "template1",
        'a"; DROP DATABASE x; --',
        "",
        "Tdb",
        "1db",
        "a".repeat(64),
      ]) {
        await expect(
          cp.registerTenant({ id: ID2, owner: OTHER, ref: ref(bad) }),
          bad,
        ).rejects.toMatchObject({ name: ControlPlaneError.name, code: "invalid_database" });
        await expect(cp.setStaging(TENANT, bad), bad).rejects.toMatchObject({
          code: "invalid_database",
        });
      }
      expect(await cp.tenantOf(OTHER)).toBeUndefined();
      expect(await staging(db, TENANT)).toBeNull();
    },
    T,
  );

  it(
    "refuses as staging a database a tenant of the cell has, or another's staging; takes it in another cell",
    async () => {
      const { cp, db } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_a") });
      await cp.registerTenant({ id: ID2, owner: OTHER, ref: ref("tdb_b") });
      await cp.registerTenant({ id: ID3, owner: THIRD, ref: ref("tdb_c", "cell_b") });
      await expect(cp.setStaging(TENANT, "tdb_b")).rejects.toMatchObject({ code: "tenant_taken" });
      await expect(cp.setStaging(TENANT, "tdb_a")).rejects.toMatchObject({ code: "tenant_taken" });
      await cp.setStaging(ID2, "tdb_s");
      await expect(cp.setStaging(TENANT, "tdb_s")).rejects.toMatchObject({ code: "tenant_taken" });
      expect(await staging(db, TENANT)).toBeNull();
      await cp.setStaging(ID3, "tdb_b");
      await cp.setStaging(ID3, "tdb_s");
      expect(await staging(db, ID3)).toBe("tdb_s");
    },
    T,
  );

  it(
    "refuses to register a database another tenant of the cell has as staging",
    async () => {
      const { cp } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_a") });
      await cp.setStaging(TENANT, "tdb_s");
      await expect(
        cp.registerTenant({ id: ID2, owner: OTHER, ref: ref("tdb_s") }),
      ).rejects.toMatchObject({ code: "tenant_taken" });
      expect(await cp.tenantOf(OTHER)).toBeUndefined();
      expect(
        await cp.registerTenant({ id: ID2, owner: OTHER, ref: ref("tdb_s", "cell_b") }),
      ).toMatchObject({ id: ID2 });
    },
    T,
  );

  it(
    "a swap that would take another tenant's database is refused as taken, and changes neither",
    async () => {
      const { cp, db } = await controlPlane();
      await cp.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_a") });
      await cp.registerTenant({ id: ID2, owner: OTHER, ref: ref("tdb_b") });
      // Only by hand now that setStaging refuses it: the directory as a bug could leave it.
      await db.write((tx) =>
        tx.query("UPDATE tenants SET staging_database = 'tdb_b' WHERE id = $1", [TENANT]),
      );
      await expect(cp.swapInStaging(TENANT)).rejects.toMatchObject({
        name: ControlPlaneError.name,
        code: "tenant_taken",
      });
      expect((await cp.tenant(TENANT))?.ref).toEqual(ref("tdb_a"));
      expect((await cp.tenant(ID2))?.ref).toEqual(ref("tdb_b"));
    },
    T,
  );
});

anchorStoreConformance("server control plane", async () => {
  const { cp } = await controlPlane();
  return {
    store: cp.anchors,
    // The database closed and opened again: what was written is on disk, not in a connection. The
    // file goes on with the new one.
    reopen: async () => {
      await shared.close();
      shared = await testBackend().open({ kind: "pglite", dir: sharedDir }, {});
      sharedCp = await openControlPlane(shared);
      return sharedCp.anchors;
    },
  };
});

describe("the anchor store's writes are the control database's own", () => {
  it(
    "a deletion entry written inside a tenant transaction is there before that commits, and stays when it rolls back",
    async () => {
      const { cp } = await controlPlane();
      const tenant = (await database()).db;
      await tenant.write((tx) => tx.exec("CREATE TABLE confirmed (n integer)"));
      const entry = deletionEntry(1, { state: "intent" });
      await expect(
        tenant.write(async (tx) => {
          await tx.query("INSERT INTO confirmed (n) VALUES (1)");
          await cp.anchors.putDeletion(TENANT, entry);
          // Seen through the control database while the tenant transaction is still open.
          expect((await cp.anchors.read(TENANT)).deletions).toEqual([entry]);
          throw new Error("the tenant transaction rolls back");
        }),
      ).rejects.toThrow("the tenant transaction rolls back");
      expect((await cp.anchors.read(TENANT)).deletions).toEqual([entry]);
      const rows = await tenant.read((tx) => tx.query("SELECT n FROM confirmed"));
      expect(rows.rows).toEqual([]);
    },
    T,
  );

  it(
    "a write that fails leaves the anchor as it was",
    async () => {
      const { cp } = await controlPlane();
      await cp.anchors.putDeletion(TENANT, deletionEntry(1));
      await cp.anchors.advanceHighWater(TENANT, 5);
      await expect(cp.anchors.endRestore(TENANT, "rs_1", 9)).rejects.toMatchObject({
        code: "not_in_progress",
      });
      expect(await cp.anchors.read(TENANT)).toEqual({
        deletions: [deletionEntry(1)],
        highWater: 5,
        restoreCount: 0,
      });
    },
    T,
  );
});

// Two connections to one control database (two processes, or two cells sharing it): the row lock
// is what keeps their writes of one tenant apart. One connection runs one transaction at a time,
// so this needs two; PGlite has one connection to a database, so the case runs on PostgreSQL only.
describe.runIf(TEST_BACKEND === "postgres")("two connections to one control database", () => {
  it(
    "initializing an empty one at the same time take turns, and both succeed",
    async () => {
      for (let round = 0; round < 5; round++) {
        const { dir } = await database();
        const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
        try {
          const results = await Promise.allSettled([initControlPlane(a), initControlPlane(b)]);
          expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
        } finally {
          await a.close();
          await b.close();
        }
      }
    },
    T,
  );

  it(
    "writing a tenant's first entries at the same time keep every entry",
    async () => {
      const { db, dir } = await database();
      await initControlPlane(db);
      const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
      try {
        const one = await openControlPlane(a);
        const two = await openControlPlane(b);
        const N = 20;
        await Promise.all(
          Array.from({ length: N }, (_, i) => [
            one.anchors.putDeletion(TENANT, deletionEntry(i + 1)),
            two.anchors.putDeletion(TENANT, deletionEntry(N + i + 1)),
          ]).flat(),
        );
        const ids = (await one.anchors.read(TENANT)).deletions.map((e) => e.deletion).sort();
        expect(ids).toEqual(
          Array.from({ length: 2 * N }, (_, i) => deletionEntry(i + 1).deletion).sort(),
        );
      } finally {
        await a.close();
        await b.close();
      }
    },
    T,
  );

  it(
    "each of 20 tenants never written gets both of two first writes made at the same time",
    async () => {
      const { db, dir } = await database();
      await initControlPlane(db);
      const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
      try {
        const one = await openControlPlane(a);
        const two = await openControlPlane(b);
        const tenants = Array.from({ length: 20 }, (_, i) => `tn_${String(i).padStart(26, "0")}`);
        await Promise.all(
          tenants.flatMap((t) => [
            one.anchors.putDeletion(t, deletionEntry(1)),
            two.anchors.putDeletion(t, deletionEntry(2)),
          ]),
        );
        for (const t of tenants) {
          const ids = (await one.anchors.read(t)).deletions.map((e) => e.deletion).sort();
          expect({ t, ids }).toEqual({
            t,
            ids: [deletionEntry(1).deletion, deletionEntry(2).deletion],
          });
        }
      } finally {
        await a.close();
        await b.close();
      }
    },
    T,
  );

  it(
    "a database name registered by one and set as staging by the other at the same time is given to one",
    async () => {
      const ref = (database: string) => ({ kind: "postgres", cell: "cell_a", database }) as const;
      for (let round = 0; round < 10; round++) {
        const { dir } = await database();
        const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
        try {
          const cpa = await initControlPlane(a);
          const cpb = await openControlPlane(b);
          await cpa.registerTenant({ id: TENANT, owner: USER, ref: ref("tdb_a") });
          const results = await Promise.allSettled([
            cpa.registerTenant({
              id: `tn_${"9".repeat(26)}`,
              owner: `u_${"2".repeat(26)}`,
              ref: ref("tdb_x"),
            }),
            cpb.setStaging(TENANT, "tdb_x"),
          ]);
          expect(
            results.filter((r) => r.status === "fulfilled"),
            `round ${round}`,
          ).toHaveLength(1);
          const refused = results.find((r) => r.status === "rejected");
          expect(refused?.reason).toMatchObject({ code: "tenant_taken" });
        } finally {
          await a.close();
          await b.close();
        }
      }
    },
    T,
  );
});
