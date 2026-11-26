// `saveslot server init` and `start` (06-cli §4.1 «服务器自部署的运维命令», «服务器模式的配置», §6.2) on
// a real control database, on either backend (`pnpm test:postgres` runs this file on PostgreSQL):
// the key file and the tables made once (the identity provider's chosen by the settings), nothing
// changed the second time, `start` running until it is stopped, and each refusal with its exit code
// and without the configuration's values.

import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { type ControlDatabase, openControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_KEY } from "../../service/src/external-assertion.fixture.ts";
import { cellFromEnv } from "../../store-postgres/src/testing/server.fixture.ts";
import { testPostgres } from "../../store-postgres/src/testing/test-postgres.fixture.ts";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import type { ServerCommandIO } from "./server-command-io.ts";
import { serverCommand } from "./server-commands.ts";
import { SERVER_LOCK } from "./server-lock.ts";
import type { ServerRestoreIO } from "./server-restore-command.ts";
import { testRoot } from "./test-root.fixture.ts";

/** A store the test backend opens: the control database of these tests. */
type TenantStore = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;

const T = 120_000;
// First: its removal runs after every other hook of the file.
const tmp = testRoot("saveslot-server-cmd-", T);
const root = tmp.root;

/** A password no output may hold. */
const SECRET = "pw-9c1e-must-not-show";

let n = 0;
const stores: TenantStore[] = [];
afterAll(async () => {
  for (const s of stores) await tmp.closeWarned("a control database", s);
}, T);

/** A control database of its own; `close` from the command leaves it open for the test. */
async function controlDb(): Promise<{ store: TenantStore; open: () => Promise<ControlDatabase> }> {
  const dir = join(root, `db${n++}`);
  const store = tmp.track(
    `the control database ${dir}`,
    await testBackend().open({ kind: "pglite", dir }, { create: true }),
  );
  stores.push(store);
  return {
    store,
    open: async () => ({
      read: store.read.bind(store),
      write: store.write.bind(store),
      close: async () => {},
      onLost: () => {},
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
  o: Partial<ServerRestoreIO> & { env: Record<string, string> },
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
          // The authorization server's.
          "oauth_clients",
          "oauth_codes",
          "oauth_device_codes",
          "oauth_grants",
          "oauth_refresh_tokens",
          "web_forms",
          // The local accounts': no external login settings are given.
          "accounts",
          "web_logins",
        ]),
      );
      expect(made).not.toContain("external_users");
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

/** A port nothing listens on now: the system's pick for a listener closed again. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const l = createServer();
    l.once("error", reject);
    l.listen(0, "127.0.0.1", () => {
      const { port } = l.address() as AddressInfo;
      l.close(() => resolve(port));
    });
  });

/** The external login's three settings, its key file holding `keys`. */
function externalEnv(keys: unknown[]): Record<string, string> {
  const keysFile = join(keyDir(), "platform-keys.json");
  writeFileSync(keysFile, JSON.stringify({ keys }), { mode: 0o600 });
  return {
    SAVESLOT_IDENTITY_ISSUER: "https://platform.example",
    SAVESLOT_IDENTITY_LOGIN_URL: "https://platform.example/login",
    SAVESLOT_IDENTITY_KEYS_FILE: keysFile,
  };
}

describe("saveslot server init: the identity provider's tables", () => {
  it(
    "the external login's settings given: its tables, not the local accounts'",
    async () => {
      const db = await controlDb();
      const keyFile = join(keyDir(), "handle-key");
      const r = await server(["init"], {
        env: { ...env(keyFile), ...externalEnv([TEST_KEY.public]) },
        openControl: db.open,
      });
      expect(r).toMatchObject({ code: 0, err: "" });
      const made = await tables(db.store);
      expect(made).toEqual(
        expect.arrayContaining([
          "external_jti",
          "external_logins",
          "external_states",
          "external_users",
        ]),
      );
      expect(made).not.toContain("accounts");
      expect(made).not.toContain("web_logins");
    },
    T,
  );

  it("a key file it cannot use: 5, the reason named, nothing made", async () => {
    const keyFile = join(keyDir(), "handle-key");
    let opened = 0;
    const r = await server(["init"], {
      env: { ...env(keyFile), ...externalEnv([{ ...TEST_KEY.public, d: TEST_KEY.d }]) },
      openControl: async () => {
        opened++;
        throw new Error("the control database was opened");
      },
    });
    expect(r.code).toBe(5);
    expect(r.err).toContain("private key");
    expect(r.err).not.toContain(TEST_KEY.d);
    expect(opened).toBe(0);
    expect(() => statSync(keyFile)).toThrow();
  });

  it("some of the external login's settings: 5, the missing ones named", async () => {
    const keyFile = join(keyDir(), "handle-key");
    const r = await server(["init"], {
      env: { ...env(keyFile), SAVESLOT_IDENTITY_ISSUER: "https://platform.example" },
    });
    expect(r.code).toBe(5);
    expect(r.err).toContain("SAVESLOT_IDENTITY_LOGIN_URL is not set");
    expect(r.err).toContain("SAVESLOT_IDENTITY_KEYS_FILE is not set");
  });
});

describe("saveslot server start", () => {
  it(
    "after init: listens, and on the stop signal closes and exits 0; a second signal cuts the drain short",
    async () => {
      const db = await controlDb();
      const keyFile = join(keyDir(), "handle-key");
      const e = {
        ...env(keyFile),
        SAVESLOT_LISTEN: `127.0.0.1:${await freePort()}`,
        // Long enough that the test would time out had the second signal not cut it short.
        SAVESLOT_SHUTDOWN_DRAIN: "3600",
      };
      expect((await server(["init"], { env: e, openControl: db.open })).code).toBe(0);
      let stop!: () => void;
      const stopped = new Promise<void>((r) => {
        stop = r;
      });
      const run = server(["start"], {
        env: e,
        openControl: db.open,
        backend: { open: () => Promise.reject(new Error("no tenant is opened")) },
        stopped: () => {
          stop();
          return Promise.resolve();
        },
        stoppedAgain: () => Promise.resolve(),
      });
      await stopped;
      const r = await run;
      expect(r).toMatchObject({ code: 0, err: "" });
      expect(r.out).toMatch(/listens on 127\.0\.0\.1:\d+/);
      expect(r.out).toContain("has stopped");
    },
    T,
  );

  it(
    "before init: 5, telling to run server init; nothing made",
    async () => {
      const db = await controlDb();
      const keyFile = join(keyDir(), "handle-key");
      const before = await tables(db.store);
      const r = await server(["start"], { env: env(keyFile), openControl: db.open });
      expect(r.code).toBe(5);
      expect(r.err).toContain("run saveslot server init first");
      expect(await tables(db.store)).toEqual(before);
    },
    T,
  );

  it(
    "init for the local accounts, start with the external login's settings: 5, nothing made",
    async () => {
      const db = await controlDb();
      const keyFile = join(keyDir(), "handle-key");
      expect((await server(["init"], { env: env(keyFile), openControl: db.open })).code).toBe(0);
      const before = await tables(db.store);
      const r = await server(["start"], {
        env: { ...env(keyFile), ...externalEnv([TEST_KEY.public]) },
        openControl: db.open,
      });
      expect(r.code).toBe(5);
      expect(r.err).toContain(
        "external login tables are not there; run saveslot server init first",
      );
      expect(await tables(db.store)).toEqual(before);
    },
    T,
  );

  it("an argument: a usage error, 2", async () => {
    const keyFile = join(keyDir(), "handle-key");
    expect((await server(["start", "--now"], { env: env(keyFile) })).code).toBe(2);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a key file this process may not read: 5, the reason said, no stack and no path",
    async () => {
      const db = await controlDb();
      const keyFile = join(keyDir(), "handle-key");
      expect((await server(["init"], { env: env(keyFile), openControl: db.open })).code).toBe(0);
      chmodSync(keyFile, 0o000);
      try {
        for (const sub of ["start", "init"]) {
          const r = await server([sub], { env: env(keyFile), openControl: db.open });
          expect(r.code).toBe(5);
          expect(r.err).toBe(
            "error: the file SAVESLOT_HANDLE_KEY_FILE names cannot be read: give this process's user read permission, and check the path (a loop of links, a name too long, a part that is not a directory)\n",
          );
        }
      } finally {
        chmodSync(keyFile, 0o600);
      }
    },
    T,
  );
});

// The server lock is its control database connection's (06 §4.1): PostgreSQL only, which can end a
// connection from outside.
describe.skipIf(TEST_BACKEND !== "postgres")("saveslot server start: the connection lost", () => {
  const pg = testPostgres(cellFromEnv());

  it(
    "exits 7 saying so, for the process manager to start it again; the lock is free",
    async () => {
      const name = pg.name();
      const open = () => openControlDatabase(pg.cell, name, { create: true });
      const keyFile = join(keyDir(), "handle-key");
      const e = { ...env(keyFile), SAVESLOT_LISTEN: `127.0.0.1:${await freePort()}` };
      expect((await server(["init"], { env: e, openControl: open })).code).toBe(0);
      let listening!: () => void;
      const up = new Promise<void>((r) => {
        listening = r;
      });
      let out = "";
      const run = server(["start"], {
        env: e,
        openControl: open,
        backend: { open: () => Promise.reject(new Error("no tenant is opened")) },
        out: (l) => {
          out += `${l}\n`;
          if (l.includes("listens on")) listening();
        },
        // Not stopped: what ends it is the connection.
        stopped: () => new Promise<void>(() => {}),
      });
      await up;
      await pg.admin(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
      const r = await run;
      expect(r.code).toBe(7);
      expect(r.err).toContain("the connection to the control database");
      expect(r.err).toContain("went away");
      expect(out).not.toContain("has stopped");
      const other = await openControlDatabase(pg.cell, name);
      try {
        const got = await other.write((tx) =>
          tx.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1) AS got", [
            SERVER_LOCK.toString(),
          ]),
        );
        expect(got.rows[0]?.got).toBe(true);
      } finally {
        await other.close();
      }
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

  it("an allowed origin that is not one: start refuses, 5, naming the entry, nothing opened", async () => {
    const e = {
      ...env("/k"),
      SAVESLOT_ALLOWED_ORIGINS: "https://console.example,https://app.example/",
    };
    const r = await server(["start"], { env: e, openControl: never });
    expect([r.code, r.opened]).toEqual([5, 0]);
    expect(r.err).toContain(
      'error: SAVESLOT_ALLOWED_ORIGINS is not valid: the entry "https://app.example/" is not an origin',
    );
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
