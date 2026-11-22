// `saveslot server init` (06-cli §4.1 «服务器自部署的运维命令», «服务器模式的配置», §6.2) on a real
// control database, on either backend (`pnpm test:postgres` runs this file on PostgreSQL): the key
// file and the tables made once, nothing changed the second time, and each refusal with its exit
// code and without the configuration's values.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import { type ServerCommandIO, serverCommand } from "./server-commands.ts";

/** A store the test backend opens: the control database of these tests. */
type TenantStore = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-server-cmd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

/** A password no output may hold. */
const SECRET = "pw-9c1e-must-not-show";

let n = 0;
const stores: TenantStore[] = [];
afterAll(async () => {
  for (const s of stores) await s.close().catch(() => {});
}, T);

/** A control database of its own; `close` from the command leaves it open for the test. */
async function controlDb(): Promise<{ store: TenantStore; open: () => Promise<ControlDatabase> }> {
  const store = await testBackend().open(
    { kind: "pglite", dir: join(root, `db${n++}`) },
    { create: true },
  );
  stores.push(store);
  return {
    store,
    open: async () => ({
      read: store.read.bind(store),
      write: store.write.bind(store),
      close: async () => {},
    }),
  };
}

function env(keyFile: string): Record<string, string> {
  return {
    SAVESLOT_CONTROL_DATABASE_URL: `postgres://saveslot:${SECRET}@db.internal/saveslot_control`,
    SAVESLOT_CELL_DATABASE_URL: `postgres://saveslot:${SECRET}@db.internal/postgres`,
    SAVESLOT_PUBLIC_URL: "https://saveslot.example.com",
    SAVESLOT_HANDLE_KEY_FILE: keyFile,
  };
}

async function server(
  argv: string[],
  o: Partial<ServerCommandIO> & { env: Record<string, string> },
): Promise<{ code: number; out: string; err: string; opened: number }> {
  let out = "";
  let err = "";
  let opened = 0;
  const code = await serverCommand(argv, {
    out: (l) => {
      out += `${l}\n`;
    },
    err: (l) => {
      err += `${l}\n`;
    },
    ...o,
    ...(o.openControl !== undefined
      ? {
          openControl: (at) => {
            opened++;
            return (o.openControl as NonNullable<ServerCommandIO["openControl"]>)(at);
          },
        }
      : {}),
  });
  return { code, out, err, opened };
}

const keyDir = () => {
  const d = join(root, `keys${n++}`);
  mkdirSync(d, { mode: 0o700 });
  return d;
};

const tables = (store: TenantStore) =>
  store.read(async (tx) =>
    (
      await tx.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      )
    ).rows.map((r) => r["table_name"]),
  );

describe("saveslot server init", () => {
  let db: Awaited<ReturnType<typeof controlDb>>;
  beforeAll(async () => {
    db = await controlDb();
  }, T);

  it(
    "makes the key file (0600) and the control database's tables; run again, changes nothing",
    async () => {
      const keyFile = join(keyDir(), "handle-key");
      const first = await server(["init"], { env: env(keyFile), openControl: db.open });
      expect(first).toMatchObject({ code: 0, err: "" });
      expect(first.out).toContain("Made the handle key file");
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      const key = readFileSync(keyFile, "utf8");
      const made = await tables(db.store);
      expect(made).toEqual(
        expect.arrayContaining([
          "anchor_deletions",
          "anchors",
          "control_meta",
          "credentials",
          "tenants",
        ]),
      );
      const again = await server(["init"], { env: env(keyFile), openControl: db.open });
      expect(again).toMatchObject({ code: 0, err: "" });
      expect(again.out).toContain("left as it is");
      expect(readFileSync(keyFile, "utf8")).toBe(key);
      expect(await tables(db.store)).toEqual(made);
    },
    T,
  );

  it(
    "a control database of another format: refused with 5, nothing changed",
    async () => {
      const other = await controlDb();
      const keyFile = join(keyDir(), "handle-key");
      expect((await server(["init"], { env: env(keyFile), openControl: other.open })).code).toBe(0);
      await other.store.write((tx) =>
        tx.query("UPDATE control_meta SET value = '99' WHERE key = 'format'"),
      );
      const r = await server(["init"], { env: env(keyFile), openControl: other.open });
      expect(r.code).toBe(5);
      expect(r.err).toContain("a format this saveslot does not know");
      const format = await other.store.read(
        async (tx) =>
          (await tx.query("SELECT value FROM control_meta WHERE key = 'format'")).rows[0]?.[
            "value"
          ],
      );
      expect(format).toBe("99");
    },
    T,
  );
});

describe("saveslot server init: what it refuses before the database", () => {
  const never = async (): Promise<ControlDatabase> => {
    throw new Error("the control database was opened");
  };

  it("no configuration: 5, every required variable named, nothing opened", async () => {
    const r = await server(["init"], { env: {}, openControl: never });
    expect(r.code).toBe(5);
    for (const v of [
      "SAVESLOT_CONTROL_DATABASE_URL",
      "SAVESLOT_CELL_DATABASE_URL",
      "SAVESLOT_PUBLIC_URL",
      "SAVESLOT_HANDLE_KEY_FILE",
    ]) {
      expect(r.err).toContain(`${v} is not set`);
    }
    expect(r.opened).toBe(0);
  });

  it("a URL refused: its password does not show", async () => {
    const e = { ...env("/k"), SAVESLOT_CONTROL_DATABASE_URL: `mysql://saveslot:${SECRET}@db/x` };
    const r = await server(["init"], { env: e, openControl: never });
    expect(r.code).toBe(5);
    expect(r.err).toContain("SAVESLOT_CONTROL_DATABASE_URL is not valid");
    expect(r.err + r.out).not.toContain(SECRET);
  });

  it("the key file's directory missing: 5, nothing opened", async () => {
    const r = await server(["init"], {
      env: env(join(root, "nowhere", "handle-key")),
      openControl: never,
    });
    expect([r.code, r.opened]).toEqual([5, 0]);
    expect(r.err).toContain("directory of SAVESLOT_HANDLE_KEY_FILE is not there");
  });

  it(
    "a key file open to others: 5, nothing opened, the file left as it is",
    async () => {
      const keyFile = join(keyDir(), "handle-key");
      const db = await controlDb();
      expect((await server(["init"], { env: env(keyFile), openControl: db.open })).code).toBe(0);
      chmodSync(keyFile, 0o644);
      const before = readFileSync(keyFile, "utf8");
      const r = await server(["init"], { env: env(keyFile), openControl: never });
      expect([r.code, r.opened]).toEqual([5, 0]);
      expect(r.err).toContain("is open to others");
      expect(readFileSync(keyFile, "utf8")).toBe(before);
    },
    T,
  );

  it("the control database cannot be reached: 7, the driver's message not shown", async () => {
    const r = await server(["init"], {
      env: env(join(keyDir(), "handle-key")),
      openControl: async () => {
        throw new Error(`connect failed for saveslot:${SECRET}@db.internal`);
      },
    });
    expect(r.code).toBe(7);
    expect(r.err).toContain("SAVESLOT_CONTROL_DATABASE_URL) could not be reached");
    expect(r.err).not.toContain(SECRET);
  });

  it.each([[[]], [["user"]], [["restore"]], [["init", "--force"]], [["init", "extra"]]])(
    "usage error %j: 2",
    async (argv) => {
      expect((await server(argv, { env: {}, openControl: never })).code).toBe(2);
    },
  );
});
