// `saveslot server restore` (06-cli §4.1 «服务器自部署的运维命令», §6.2; 02-architecture §8) on a real
// control database and tenants, on either backend (`pnpm test:postgres` runs this file on
// PostgreSQL): the tenant named by its ID, the flow run on it, and each refusal
// with its exit code and nothing changed. A put-back database is a log that ends before the control
// plane's high water mark, as in the service's tests. Fictional IDs.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServerTenant,
  initControlPlane,
  type ServerControlPlane,
  type TenantId,
} from "@fluxvita/saveslot-service";
import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import { serverCommand } from "./server-commands.ts";
import { SERVER_LOCK } from "./server-lock.ts";
import type { ServerRestoreIO } from "./server-restore-command.ts";

/** A store the test backend opens. */
type Store = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;
type Backend = NonNullable<ServerRestoreIO["backend"]>;

const T = 120_000;
const NOW = "2026-11-21T10:00:00.000Z";
const CELL = "main";
const root = mkdtempSync(join(tmpdir(), "saveslot-server-restore-cmd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

/** A password no output may hold. */
const SECRET = "pw-4e7a-must-not-show";

const stores: Store[] = [];
afterAll(async () => {
  for (const s of stores) await s.close().catch(() => {});
}, T);

/** A server tenant's database is a directory of the test backend. */
const backend: Backend = {
  open: (ref, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    return testBackend().open({ kind: "pglite", dir: join(root, ref.cell, ref.database) }, opts);
  },
};

let n = 0;
/** A control database of its own, its tables made unless `bare`; `close` leaves it open. */
async function controlDb(o: { bare?: boolean } = {}) {
  const dir = join(root, `control${n++}`);
  const store = await testBackend().open({ kind: "pglite", dir }, { create: true });
  stores.push(store);
  const cp = o.bare ? undefined : await initControlPlane(store);
  const db: ControlDatabase = {
    read: store.read.bind(store),
    write: store.write.bind(store),
    close: async () => {},
  };
  return { store, cp, db, dir };
}

const env = {
  SAVESLOT_CONTROL_DATABASE_URL: `postgres://saveslot:${SECRET}@db.internal/saveslot_control`,
  SAVESLOT_CELL_DATABASE_URL: `postgres://saveslot:${SECRET}@db.internal/postgres`,
  SAVESLOT_PUBLIC_URL: "https://saveslot.example.com",
  SAVESLOT_HANDLE_KEY_FILE: join(root, "unused.key"),
};

async function restore(
  argv: string[],
  o: { db?: ControlDatabase; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string; err: string; opened: number }> {
  let out = "";
  let err = "";
  let opened = 0;
  const code = await serverCommand(["restore", ...argv], {
    out: (l) => {
      out += `${l}\n`;
    },
    err: (l) => {
      err += `${l}\n`;
    },
    env: o.env ?? env,
    openControl: async () => {
      opened++;
      if (o.db === undefined) throw new Error("unreachable in this test");
      return o.db;
    },
    backend,
    now: () => NOW,
  });
  expect(out + err).not.toContain(SECRET);
  return { code, out, err, opened };
}

/** The tenant's log's end. */
async function logEnd(cp: ServerControlPlane, id: TenantId): Promise<number> {
  const e = await cp.tenant(id);
  const s = await backend.open((e as NonNullable<typeof e>).ref, { create: false });
  try {
    return await s.read(
      async (tx) =>
        Number((await tx.query<{ m: unknown }>("SELECT max(seq) AS m FROM events")).rows[0]?.m) ||
        0,
    );
  } finally {
    await s.close();
  }
}

let owners = 0;
/** A tenant, its database put back: the live log had gone 5 further than the database's. */
async function putBack(c: Awaited<ReturnType<typeof controlDb>>) {
  const cp = c.cp as ServerControlPlane;
  const { id: tenant } = await createServerTenant({
    control: cp,
    backend,
    owner: `u_${String(++owners).padStart(26, "0")}`,
    cell: CELL,
    cells: new Set([CELL]),
    now: NOW,
  });
  const high = (await logEnd(cp, tenant)) + 5;
  await cp.anchors.advanceHighWater(tenant, high);
  return { tenant, high };
}

describe("saveslot server restore", () => {
  let c: Awaited<ReturnType<typeof controlDb>>;
  beforeAll(async () => {
    c = await controlDb();
  }, T);

  it(
    "--tenant: the flow runs on that tenant; its restore count and log end are told",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const { tenant, high } = await putBack(c);
      const r = await restore(["--tenant", tenant], { db: c.db });
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const a = await cp.anchors.read(tenant);
      expect(a).toMatchObject({ restoreCount: 1, highWater: high + 1 });
      expect(await logEnd(cp, tenant)).toBe(high + 1);
      expect(r.out).toContain(`Restored tenant ${tenant}`);
      expect(r.out).toContain(`restore count is 1; its log ends at seq ${high + 1}`);
    },
    T,
  );

  it(
    "only the tenant named: another put back is not touched",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const one = await putBack(c);
      const other = await putBack(c);
      const r = await restore(["--tenant", one.tenant], { db: c.db });
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Restored tenant ${one.tenant}`);
      expect(await cp.anchors.read(one.tenant)).toMatchObject({ restoreCount: 1 });
      expect(await cp.anchors.read(other.tenant)).toMatchObject({ restoreCount: 0 });
    },
    T,
  );

  it(
    "a restore an earlier run began is finished, and said so",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const { tenant } = await putBack(c);
      await cp.anchors.beginRestore(tenant, "rs_0000000000000007");
      const r = await restore(["--tenant", tenant], { db: c.db });
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Finished the restore of tenant ${tenant} that an earlier run began`);
      expect((await cp.anchors.read(tenant)).restoreInProgress).toBeUndefined();
    },
    T,
  );

  it.each([
    [[]],
    // Given twice: refused, not the last one taken (06 §6.2).
    [["--tenant", "tn_00000000000000000000000001", "--tenant", "tn_00000000000000000000000002"]],
    [["--tenant", ""]],
    [["--user", "ann"]],
    [["tn_00000000000000000000000001"]],
    [["--tenant"]],
    [["--name", "ann"]],
  ])("%j: usage error 2, the control database not opened", async (argv) => {
    const r = await restore(argv);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^error: /);
    expect(r.opened).toBe(0);
  });

  it("an argument that is not an option is named in the usage error", async () => {
    const r = await restore(["--tenant", "tn_00000000000000000000000001", "extra"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("'extra'");
  });

  it("a configuration refused: 5, the control database not opened", async () => {
    const { SAVESLOT_PUBLIC_URL: _, ...partial } = env;
    const r = await restore(["--tenant", "tn_00000000000000000000000001"], { env: partial });
    expect(r.code).toBe(5);
    expect(r.err).toContain("SAVESLOT_PUBLIC_URL is not set");
    expect(r.opened).toBe(0);
  });

  it("the control database not reached: 7", async () => {
    const r = await restore(["--tenant", "tn_00000000000000000000000001"]);
    expect(r.code).toBe(7);
    expect(r.err).toContain("SAVESLOT_CONTROL_DATABASE_URL");
    expect(r.opened).toBe(1);
  });

  it(
    "a control database without tables: 5, none made",
    async () => {
      const bare = await controlDb({ bare: true });
      const tables = () =>
        bare.store.read(async (tx) =>
          (
            await tx.query(
              "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
            )
          ).rows.map((x) => x["table_name"]),
        );
      const before = await tables();
      expect(before).not.toContain("control_meta");
      const r = await restore(["--tenant", "tn_00000000000000000000000001"], { db: bare.db });
      expect(r.code).toBe(5);
      expect(r.err).toContain("nothing was done");
      expect(await tables()).toEqual(before);
    },
    T,
  );

  it(
    "a tenant the directory does not have: 4",
    async () => {
      const t = await restore(["--tenant", "tn_99999999999999999999999999"], { db: c.db });
      expect(t.code).toBe(4);
      expect(t.err).toContain("no such tenant");
    },
    T,
  );

  it(
    "a tenant whose creation has not finished: 5, nothing opened",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const id = `tn_${"8".repeat(26)}` as TenantId;
      await cp.registerTenant({
        id,
        owner: `u_${"8".repeat(26)}`,
        ref: { kind: "postgres", cell: CELL, database: id },
      });
      const r = await restore(["--tenant", id], { db: c.db });
      expect(r.code).toBe(5);
      expect(r.err).toContain("creation has not finished");
    },
    T,
  );

  it(
    "a tenant whose database has no log (the backup not put back): 5, the flow's refusal told",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const id = `tn_${"7".repeat(26)}` as TenantId;
      const ref = { kind: "postgres", cell: CELL, database: id } as const;
      await cp.registerTenant({ id, owner: `u_${"7".repeat(26)}`, ref });
      await cp.activateTenant(id);
      mkdirSync(join(root, CELL), { recursive: true });
      await (await backend.open(ref, { create: true })).close();
      const r = await restore(["--tenant", id], { db: c.db });
      expect(r.code).toBe(5);
      expect(r.err).toContain("has no log");
      expect(await cp.anchors.read(id)).toMatchObject({ restoreCount: 0 });
    },
    T,
  );
});

// PGlite has one connection to a database: another holder of the lock exists on PostgreSQL only.
describe.skipIf(TEST_BACKEND !== "postgres")("saveslot server restore: a server running", () => {
  it(
    "while a server holds the lock: 7, nothing done; the command's own lock released after it",
    async () => {
      const c = await controlDb();
      const cp = c.cp as ServerControlPlane;
      const { tenant } = await putBack(c);
      const other = await secondConnection(c.dir);
      const tryLock = () =>
        other.write(async (tx) => {
          const r = await tx.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1) AS got", [
            SERVER_LOCK.toString(),
          ]);
          return r.rows[0]?.got === true;
        });
      const unlock = () =>
        other.write((tx) => tx.query("SELECT pg_advisory_unlock($1)", [SERVER_LOCK.toString()]));
      try {
        expect(await tryLock()).toBe(true);
        const held = await restore(["--tenant", tenant], { db: c.db });
        expect(held.code).toBe(7);
        expect(held.err).toContain("stop it first");
        expect(await cp.anchors.read(tenant)).toMatchObject({ restoreCount: 0 });
        await unlock();
        const r = await restore(["--tenant", tenant], { db: c.db });
        expect(r.code).toBe(0);
        // Released when it ended: a server could start now.
        expect(await tryLock()).toBe(true);
        await unlock();
      } finally {
        await other.close();
      }
    },
    T,
  );
});
