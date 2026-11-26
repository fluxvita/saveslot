// `saveslot server restore` (06-cli §4.1 «服务器自部署的运维命令», §6.2; 02-architecture §8) on a real
// control database and tenants, on either backend (`pnpm test:postgres` runs this file on
// PostgreSQL): the tenant named by its ID or by its local account's name, the flow run on it, and
// each refusal with its exit code and nothing changed. A put-back database is a log that ends before the control
// plane's high water mark, as in the service's tests. Fictional IDs.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addLocalUser,
  createServerTenant,
  disableLocalUser,
  initControlPlane,
  initLocalAccounts,
  type LocalAccounts,
  type ServerControlPlane,
  type TenantId,
} from "@fluxvita/saveslot-service";
import { type ControlDatabase, PostgresStoreError } from "@fluxvita/saveslot-store-postgres";
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
    onLost: () => {},
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
    // Exactly one of --tenant and --user.
    [["--tenant", "tn_00000000000000000000000001", "--user", "ann"]],
    [["--user", "ann", "--user", "bo"]],
    [["--user", ""]],
    [["--user"]],
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

const PASSWORD = "correct horse battery";

describe("saveslot server restore: a tenant's storage format upgrade that fails", () => {
  it(
    "5: the step and the SQLSTATE, and what to do; never the database's message",
    async () => {
      const c = await controlDb();
      const { tenant } = await putBack(c);
      let err = "";
      const code = await serverCommand(["restore", "--tenant", tenant], {
        out: () => {},
        err: (l) => {
          err += `${l}\n`;
        },
        env,
        openControl: async () => c.db,
        // As the PostgreSQL backend fails a step: the database's message, which may quote a stored
        // value, in its own message.
        backend: {
          open: async () => {
            throw new PostgresStoreError(
              "upgrade_failed",
              'upgrading storage format 5 to 6: invalid input syntax for type integer: "MARK-51d0-stored"',
              { sqlState: "22P02", step: "5->6" },
            );
          },
        },
        now: () => NOW,
      });
      expect(code).toBe(5);
      expect(err).toContain("failed at step 5->6 (SQLSTATE 22P02)");
      expect(err).toContain("run the command again");
      expect(err).not.toContain("MARK-51d0");
      expect(err).not.toContain("invalid input syntax");
    },
    T,
  );
});

describe("saveslot server restore --user", () => {
  let c: Awaited<ReturnType<typeof controlDb>>;
  let accounts: LocalAccounts;
  beforeAll(async () => {
    c = await controlDb();
    accounts = await initLocalAccounts(c.store);
  }, T);

  /** `name`'s account and tenant, its database put back as `putBack` does. */
  async function putBackAccount(name: string) {
    const cp = c.cp as ServerControlPlane;
    const { tenant } = await addLocalUser(accounts, {
      control: cp,
      backend,
      name,
      password: PASSWORD,
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    });
    const high = (await logEnd(cp, tenant)) + 5;
    await cp.anchors.advanceHighWater(tenant, high);
    return { tenant, high };
  }

  it(
    "the account's tenant is restored, and named; another account's is not touched",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const alex = await putBackAccount("alex");
      const bo = await putBackAccount("bo");
      const r = await restore(["--user", "alex"], { db: c.db });
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain(`The account "alex"'s tenant is ${alex.tenant}`);
      expect(r.out).toContain(`Restored tenant ${alex.tenant}`);
      expect(await cp.anchors.read(alex.tenant)).toMatchObject({
        restoreCount: 1,
        highWater: alex.high + 1,
      });
      expect(await logEnd(cp, alex.tenant)).toBe(alex.high + 1);
      expect(await cp.anchors.read(bo.tenant)).toMatchObject({ restoreCount: 0 });
    },
    T,
  );

  it(
    "the same as --tenant: two accounts' tenants, one named each way, end alike",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const byName = await putBackAccount("cass");
      const byId = await putBackAccount("dana");
      const a = await restore(["--user", "cass"], { db: c.db });
      const b = await restore(["--tenant", byId.tenant], { db: c.db });
      expect([a.code, b.code]).toEqual([0, 0]);
      for (const t of [byName, byId]) {
        expect(await cp.anchors.read(t.tenant)).toMatchObject({
          restoreCount: 1,
          highWater: t.high + 1,
        });
        expect(await logEnd(cp, t.tenant)).toBe(t.high + 1);
      }
      // The lines after the account's are those --tenant gives, the tenant aside.
      const rest = (out: string, tenant: string) =>
        out
          .split("\n")
          .filter((l) => !l.startsWith("The account "))
          .join("\n")
          .replaceAll(tenant, "<tenant>");
      expect(rest(a.out, byName.tenant)).toBe(rest(b.out, byId.tenant));
    },
    T,
  );

  it(
    "a disabled account's tenant is restored all the same",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const t = await putBackAccount("eli");
      await disableLocalUser(accounts, { name: "eli" });
      const r = await restore(["--user", "eli"], { db: c.db });
      expect(r.code).toBe(0);
      expect(await cp.anchors.read(t.tenant)).toMatchObject({ restoreCount: 1 });
    },
    T,
  );

  let bystanders = 0;
  it.each([
    ["nobody"],
    // Names no account can have: no account, as server user disable finds none.
    ["Alex"],
    ["a".repeat(65)],
    [".dot"],
  ])(
    "no account named %j: 4, nothing done",
    async (name) => {
      const cp = c.cp as ServerControlPlane;
      const t = await putBackAccount(`bystander${++bystanders}`);
      const r = await restore(["--user", name], { db: c.db });
      expect(r.code).toBe(4);
      expect(r.err).toContain("there is no account named");
      expect(await cp.anchors.read(t.tenant)).toMatchObject({ restoreCount: 0 });
    },
    T,
  );

  it(
    "an account whose tenant is registered and not made (an add that stopped): 5, the add to finish it told",
    async () => {
      const cp = c.cp as ServerControlPlane;
      const failing: Backend = {
        open: () => Promise.reject(new Error("the cell is down")),
      };
      await expect(
        addLocalUser(accounts, {
          control: cp,
          backend: failing,
          name: "gus",
          password: PASSWORD,
          cell: CELL,
          cells: new Set([CELL]),
          now: NOW,
        }),
      ).rejects.toThrow();
      const r = await restore(["--user", "gus"], { db: c.db });
      expect(r.code).toBe(5);
      expect(r.err).toContain("is not made yet");
      expect(r.err).toContain("saveslot server user add gus");
    },
    T,
  );

  it(
    "an account with no tenant registered at all: 5, the same",
    async () => {
      await c.store.write((tx) =>
        tx.query(
          "INSERT INTO accounts (id, name, password_hash, state) VALUES ($1, 'hal', 'x', 'active')",
          [`u_${"9".repeat(26)}`],
        ),
      );
      const r = await restore(["--user", "hal"], { db: c.db });
      expect(r.code).toBe(5);
      expect(r.err).toContain("is not made yet");
    },
    T,
  );

  it("the external login configured: 5, the control database not opened", async () => {
    const r = await restore(["--user", "alex"], {
      env: {
        ...env,
        SAVESLOT_IDENTITY_ISSUER: "https://platform.example",
        SAVESLOT_IDENTITY_LOGIN_URL: "https://platform.example/login",
        SAVESLOT_IDENTITY_KEYS_FILE: join(root, "platform-keys.json"),
      },
    });
    expect(r.code).toBe(5);
    expect(r.err).toContain("--tenant <tenant>");
    expect(r.opened).toBe(0);
  });

  it(
    "a control database without the local accounts' tables: 5, none made",
    async () => {
      const bare = await controlDb();
      const r = await restore(["--user", "alex"], { db: bare.db });
      expect(r.code).toBe(5);
      const made = await bare.store.read(
        async (tx) =>
          (await tx.query<{ a: string | null }>("SELECT to_regclass('accounts')::text AS a"))
            .rows[0]?.a ?? null,
      );
      expect(made).toBeNull();
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
        // By an account's name the same: nothing looked up, nothing done.
        const byName = await restore(["--user", "alex"], { db: c.db });
        expect(byName.code).toBe(7);
        expect(byName.err).toContain("stop it first");
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
