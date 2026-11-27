// PostgresBackend / PostgresTenantStore: what is checked when a store is opened, transactions,
// the tenant's advisory lock, the ownership epoch, a read's snapshot, and a connection that goes
// away before, during and at the commit (02-architecture §7, §8).

import { META_KEYS, SESSION_SETTINGS, STORAGE_FORMAT_VERSION } from "@fluxvita/saveslot-kernel";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_LOCALE,
  DATABASE_NAME,
  PostgresBackend,
  type PostgresTenantStore,
  SERVER_MAJOR,
  serverMajor,
  WRITE_LOCK,
} from "./backend.ts";
import { Connection } from "./connection.ts";
import { PostgresStoreError } from "./errors.ts";
import { CELL, cellOf, testCell, testPostgres } from "./testing/test-postgres.fixture.ts";

const T = 60_000;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PostgresStoreError) return e.code;
    throw e;
  }
  return "no error";
}

describe("the parts that need no server", () => {
  it("a server's major version, from its version number", () => {
    expect(serverMajor(180007)).toBe(18);
    expect(serverMajor(180000)).toBe(18);
    expect(serverMajor(170012)).toBe(17);
    expect(serverMajor(190001)).toBe(19);
    expect(SERVER_MAJOR).toBe(18);
  });

  it("a database name: lower-case letters, digits and _, a letter first, 63 at most", () => {
    for (const ok of ["t", "tenant_01", `a${"b".repeat(62)}`]) {
      expect(DATABASE_NAME.test(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "1t",
      "_t",
      "T",
      "t-1",
      't"',
      "t t",
      "t;drop",
      `a${"b".repeat(63)}`,
      "té",
    ]) {
      expect(DATABASE_NAME.test(bad), bad).toBe(false);
    }
  });

  it("refuses a reference it cannot open, before any connection", async () => {
    const backend = new PostgresBackend({ cells: { here: { host: "127.0.0.1", user: "u" } } });
    await expect(backend.open({ kind: "pglite", dir: "/x" }, {})).rejects.toThrow(TypeError);
    expect(await codeOf(backend.open({ kind: "postgres", database: "t", cell: "there" }, {}))).toBe(
      "unknown_cell",
    );
    // A name of Object.prototype is no cell.
    expect(
      await codeOf(backend.open({ kind: "postgres", database: "t", cell: "constructor" }, {})),
    ).toBe("unknown_cell");
    expect(
      await codeOf(backend.open({ kind: "postgres", database: 'T"; DROP', cell: "here" }, {})),
    ).toBe("bad_database_name");
  });

  // Not a test of what an authentication failure says: that takes a server that asks for a
  // password, and a connection that is refused carries none.
  it("a server that is not there: connection_failed, with nothing of the cell's password in it", async () => {
    const backend = new PostgresBackend({
      cells: {
        // A port nothing listens on.
        here: {
          host: "127.0.0.1",
          port: 1,
          user: "u",
          password: "s3cret-pw",
          connectTimeoutMs: 2000,
        },
      },
    });
    const e = await backend
      .open({ kind: "postgres", database: "t", cell: "here" }, { create: true })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PostgresStoreError);
    expect((e as PostgresStoreError).code).toBe("connection_failed");
    expect(`${(e as Error).message} ${String((e as Error).cause)}`).not.toContain("s3cret-pw");
  });

  it("a test URL: host or socket directory, port, user, password, maintenance database", () => {
    expect(cellOf("postgres://u:p%40ss@db.example:6543/maint")).toEqual({
      host: "db.example",
      port: 6543,
      user: "u",
      password: "p@ss",
      maintenanceDatabase: "maint",
    });
    expect(cellOf("postgres:///postgres?host=/tmp&user=someone")).toEqual({
      host: "/tmp",
      user: "someone",
      maintenanceDatabase: "postgres",
    });
  });
});

const cell = testCell();

describe.skipIf(cell === undefined)("against a server", () => {
  const pg = testPostgres(cell);
  const { backend } = pg;

  async function withStore<T>(db: string, f: (s: PostgresTenantStore) => Promise<T>): Promise<T> {
    const s = await backend.open(pg.ref(db), { create: true });
    try {
      return await f(s);
    } finally {
      await s.close();
    }
  }

  const count = (s: PostgresTenantStore, table: string) =>
    s.read(async (tx) => {
      const r = await tx.query<{ n: number }>(`SELECT count(*)::int4 AS n FROM ${table}`);
      return r.rows[0]?.n;
    });

  const epochIn = async (db: string) =>
    Number(
      (await pg.sql(db, "SELECT value FROM meta WHERE key = $1", [META_KEYS.ownershipEpoch]))
        .rows[0]?.["value"],
    );

  /** The server process of the store's connection. */
  const backendPid = (s: PostgresTenantStore) =>
    s.read(
      async (tx) => (await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]?.p,
    );

  describe("opening", () => {
    it(
      "creates the database with the fixed encoding and locale, and the storage in it",
      async () => {
        const db = pg.name();
        await withStore(db, async (s) => {
          expect(s.formatVersion).toBe(STORAGE_FORMAT_VERSION);
          expect([s.database, s.cell]).toEqual([db, CELL]);
        });
        const d = (
          await pg.admin(
            `SELECT pg_encoding_to_char(encoding) AS enc, datlocprovider::text AS provider,
                    datlocale AS locale, datcollate AS collate
             FROM pg_database WHERE datname = $1`,
            [db],
          )
        ).rows[0];
        expect(d).toEqual({ enc: "UTF8", provider: "b", locale: BUILTIN_LOCALE, collate: "C" });
        const meta = await pg.sql(db, "SELECT key, value FROM meta ORDER BY key");
        expect(Object.fromEntries(meta.rows.map((r) => [r["key"], r["value"]]))).toEqual({
          [META_KEYS.storageFormat]: String(STORAGE_FORMAT_VERSION),
          // The local mode's epoch row, as made: an opening here neither reads nor raises it.
          [META_KEYS.ownershipEpoch]: "0",
          [META_KEYS.sessionSettings]: JSON.stringify(SESSION_SETTINGS),
        });
        const tables = await pg.sql(
          db,
          "SELECT count(*)::int4 AS n FROM pg_tables WHERE schemaname = 'public'",
        );
        expect(tables.rows[0]?.["n"]).toBeGreaterThan(5);
      },
      T,
    );

    it(
      "the fixed session settings and this backend's own are set on the store's connection",
      async () => {
        await withStore(pg.name(), async (s) => {
          const r = await s.read((tx) =>
            tx.query(`SELECT current_setting('TimeZone') AS tz, current_setting('DateStyle') AS ds,
              current_setting('IntervalStyle') AS iv, current_setting('extra_float_digits') AS fd,
              current_setting('standard_conforming_strings') AS scs,
              current_setting('client_encoding') AS ce, current_setting('lc_numeric') AS n,
              current_setting('lc_monetary') AS m, current_setting('lc_time') AS t,
              current_setting('default_transaction_isolation') AS iso`),
          );
          expect(r.rows[0]).toEqual({
            tz: "UTC",
            ds: "ISO, YMD",
            iv: "iso_8601",
            fd: "3",
            scs: "on",
            ce: "UTF8",
            n: "C",
            m: "C",
            t: "C",
            iso: "read committed",
          });
        });
      },
      T,
    );

    it(
      "opening again keeps the data and leaves the epoch row as made; without create too",
      async () => {
        const db = pg.name();
        await withStore(db, (s) =>
          s.write((tx) => tx.exec("CREATE TABLE t (x INT); INSERT INTO t VALUES (1)")),
        );
        const s = await backend.open(pg.ref(db), {});
        try {
          expect(await epochIn(db)).toBe(0);
          expect(await count(s, "t")).toBe(1);
        } finally {
          await s.close();
        }
        expect(await epochIn(db)).toBe(0);
      },
      T,
    );

    it(
      "no database, or an empty one, and create not asked: store_not_found; nothing is made",
      async () => {
        const missing = pg.name();
        expect(await codeOf(backend.open(pg.ref(missing), {}))).toBe("store_not_found");
        const there = await pg.admin(
          "SELECT count(*)::int4 AS n FROM pg_database WHERE datname = $1",
          [missing],
        );
        expect(there.rows[0]?.["n"]).toBe(0);

        const empty = pg.name();
        await pg.admin(
          `CREATE DATABASE "${empty}" TEMPLATE template0 ENCODING 'UTF8'
             LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'`,
        );
        expect(await codeOf(backend.open(pg.ref(empty), {}))).toBe("store_not_found");
        // With create, an empty database made by someone else (the control plane) is filled.
        await withStore(empty, async (s) => expect(s.formatVersion).toBe(STORAGE_FORMAT_VERSION));
      },
      T,
    );

    it(
      "a database that holds something else: not_a_store, with or without create, and left as it is",
      async () => {
        const db = pg.name();
        await pg.admin(
          `CREATE DATABASE "${db}" TEMPLATE template0 ENCODING 'UTF8'
             LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'`,
        );
        await pg.sql(db, "CREATE TABLE theirs (x INT)");
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("not_a_store");
        expect(await codeOf(backend.open(pg.ref(db), { create: true }))).toBe("not_a_store");
        const t = await pg.sql(db, "SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
        expect(t.rows.map((r) => r["tablename"])).toEqual(["theirs"]);
      },
      T,
    );

    it(
      "another encoding: bad_encoding; another locale: bad_collation",
      async () => {
        const latin = pg.name();
        await pg.admin(
          `CREATE DATABASE "${latin}" TEMPLATE template0 ENCODING 'LATIN1' LOCALE 'C'`,
        );
        expect(await codeOf(backend.open(pg.ref(latin), { create: true }))).toBe("bad_encoding");

        const libc = pg.name();
        await pg.admin(
          `CREATE DATABASE "${libc}" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C'`,
        );
        expect(await codeOf(backend.open(pg.ref(libc), { create: true }))).toBe("bad_collation");

        const builtinC = pg.name();
        await pg.admin(
          `CREATE DATABASE "${builtinC}" TEMPLATE template0 ENCODING 'UTF8'
             LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C' LOCALE 'C'`,
        );
        expect(await codeOf(backend.open(pg.ref(builtinC), { create: true }))).toBe(
          "bad_collation",
        );

        // The builtin locale as asked, but the C library's character type the cluster's own:
        // a database made elsewhere. (Nothing to see where the cluster's is C too.)
        const cluster = (
          await pg.admin("SELECT datctype FROM pg_database WHERE datname = 'template1'")
        ).rows[0]?.["datctype"] as string;
        if (cluster !== "C") {
          const mixed = pg.name();
          await pg.admin(
            `CREATE DATABASE "${mixed}" TEMPLATE template0 ENCODING 'UTF8'
               LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LC_COLLATE 'C' LC_CTYPE '${cluster}'`,
          );
          expect(await codeOf(backend.open(pg.ref(mixed), { create: true }))).toBe("bad_collation");
        }
      },
      T,
    );

    it(
      "a database or a role with a search path and a bytea output of its own: the storage is in public, bytes are read right",
      async () => {
        const db = pg.name();
        await pg.admin(
          `CREATE DATABASE "${db}" TEMPLATE template0 ENCODING 'UTF8'
             LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'`,
        );
        await pg.sql(db, "CREATE SCHEMA elsewhere");
        // For every session on this database, and once more for this role on it.
        await pg.admin(`ALTER DATABASE "${db}" SET search_path = elsewhere`);
        await pg.admin(`ALTER DATABASE "${db}" SET bytea_output = 'escape'`);
        await pg.admin(
          `ALTER ROLE CURRENT_USER IN DATABASE "${db}" SET search_path = elsewhere, public`,
        );
        // What a plain session gets there now.
        const plain = await pg.sql(
          db,
          "SELECT current_setting('search_path') AS p, '\\x00ff41'::bytea::text AS b",
        );
        expect(plain.rows[0]).toEqual({ p: "elsewhere, public", b: "\\000\\377A" });

        await withStore(db, async (s) => {
          await s.write((tx) => tx.exec("CREATE TABLE made_by_a_write (x INT)"));
          const r = await s.read((tx) =>
            tx.query(
              `SELECT current_setting('search_path') AS p, '\\x00ff41'::bytea AS b,
              $1::bytea AS back`,
              [new Uint8Array([0, 255, 65])],
            ),
          );
          expect(r.rows[0]).toEqual({
            p: "public",
            b: new Uint8Array([0, 255, 65]),
            back: new Uint8Array([0, 255, 65]),
          });
        });
        const where = await pg.sql(
          db,
          `SELECT schemaname, count(*)::int4 AS n FROM pg_tables
           WHERE schemaname IN ('public', 'elsewhere') GROUP BY schemaname`,
        );
        expect(where.rows.map((r) => r["schemaname"])).toEqual(["public"]);
        expect(
          (await pg.sql(db, "SELECT to_regclass('public.meta') IS NOT NULL AS ok")).rows[0],
        ).toEqual({ ok: true });
        expect(
          (await pg.sql(db, "SELECT to_regclass('public.made_by_a_write') IS NOT NULL AS ok"))
            .rows[0],
        ).toEqual({ ok: true });
        // Opened again, it is found where it was made.
        await withStore(db, async (s) => expect(s.formatVersion).toBe(STORAGE_FORMAT_VERSION));
      },
      T,
    );

    it(
      "the storage format: older, newer, not a number; the epoch row untouched",
      async () => {
        const db = pg.name();
        await withStore(db, async () => {});
        const set = (v: string) =>
          pg.sql(db, "UPDATE meta SET value = $1 WHERE key = $2", [v, META_KEYS.storageFormat]);
        await set(String(STORAGE_FORMAT_VERSION - 1));
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("format_too_old");
        await set(String(STORAGE_FORMAT_VERSION + 1));
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("format_too_new");
        await set("two");
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("not_a_store");
        await pg.sql(db, "DELETE FROM meta WHERE key = $1", [META_KEYS.storageFormat]);
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("not_a_store");
        expect(await epochIn(db)).toBe(0);
      },
      T,
    );

    it(
      "created with other fixed session settings: session_settings_mismatch; the epoch row untouched",
      async () => {
        const db = pg.name();
        await withStore(db, async () => {});
        await pg.sql(db, "UPDATE meta SET value = $1 WHERE key = $2", [
          JSON.stringify(["SET TIME ZONE 'Asia/Shanghai'"]),
          META_KEYS.sessionSettings,
        ]);
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("session_settings_mismatch");
        await pg.sql(db, "DELETE FROM meta WHERE key = $1", [META_KEYS.sessionSettings]);
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("session_settings_mismatch");
        expect(await epochIn(db)).toBe(0);
      },
      T,
    );

    it(
      "two openers creating the same tenant at once: one storage, both open",
      async () => {
        const db = pg.name();
        const [a, b] = await Promise.all([
          backend.open(pg.ref(db), { create: true }),
          backend.open(pg.ref(db), { create: true }),
        ]);
        // Both open, neither taking the tenant from the other.
        expect([a.formatVersion, b.formatVersion]).toEqual([
          STORAGE_FORMAT_VERSION,
          STORAGE_FORMAT_VERSION,
        ]);
        expect(await epochIn(db)).toBe(0);
        await a.close();
        await b.close();
        expect(await epochIn(db)).toBe(0);
      },
      T,
    );

    /**
     * An empty database, then two openers: one holds the tenant's lock and makes the storage, as
     * `create` does, while this backend's opener, which has seen no storage, waits for the lock.
     * The other makes `meta` and its rows only, all the opener checks for: a commit of the kernel's
     * whole DDL appears to make PostgreSQL reset the waiting connection's catalog caches, which
     * hides a stale answer there. `prepare` changes the database before either connects. Returns
     * the opener's epoch; its store is closed whatever happens.
     */
    async function openedWhileAnotherMadeIt(
      prepare: (db: string) => Promise<unknown> = async () => {},
    ): Promise<{ db: string; opened: number }> {
      const db = pg.name();
      await pg.admin(
        `CREATE DATABASE "${db}" TEMPLATE template0 ENCODING 'UTF8'
           LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C'`,
      );
      await prepare(db);
      const other = await Connection.connect(pg.cell, db);
      let opening: Promise<PostgresTenantStore> | undefined;
      try {
        await other.run("BEGIN ISOLATION LEVEL READ COMMITTED");
        await other.run(`SELECT pg_advisory_xact_lock(${WRITE_LOCK[0]}, ${WRITE_LOCK[1]})`);
        opening = backend.open(pg.ref(db), { create: true });
        const waiting = async () => {
          for (let i = 0; i < 600; i++) {
            const r = await pg.admin(
              `SELECT count(*)::int4 AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
               WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = $1`,
              [db],
            );
            if (r.rows[0]?.["n"] === 1) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error("the opener never waited for the lock");
        };
        // An opener that fails or opens before it waits ends this with what it did.
        await Promise.race([
          waiting(),
          opening.then(() => {
            throw new Error("the opener opened without waiting for the lock");
          }),
        ]);
        await other.run("CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL)");
        for (const [k, v] of [
          [META_KEYS.storageFormat, String(STORAGE_FORMAT_VERSION)],
          [META_KEYS.ownershipEpoch, "0"],
          [META_KEYS.sessionSettings, JSON.stringify(SESSION_SETTINGS)],
        ] as const) {
          await other.run("INSERT INTO meta (key, value) VALUES ($1, $2)", [k, v]);
        }
        await other.run("COMMIT");
        return { db, opened: (await opening).formatVersion };
      } finally {
        await other.end();
        // Ending the other connection lets an opener still waiting go on: its store is closed too.
        await opening?.then(
          (s) => s.close(),
          () => {},
        );
      }
    }

    it(
      "an opener that waited for the lock while another made the storage finds it made, and does not make it again",
      async () => {
        const { db, opened } = await openedWhileAnotherMadeIt();
        expect(opened).toBe(STORAGE_FORMAT_VERSION);
        expect(await epochIn(db)).toBe(0);
      },
      T,
    );

    it(
      "so does one on a database whose default isolation is serializable: the lock's transaction is READ COMMITTED",
      async () => {
        const { db, opened } = await openedWhileAnotherMadeIt((db) =>
          pg.admin(`ALTER DATABASE "${db}" SET default_transaction_isolation = 'serializable'`),
        );
        expect(opened).toBe(STORAGE_FORMAT_VERSION);
        expect(await epochIn(db)).toBe(0);
      },
      T,
    );

    it(
      "a failed open leaves no connection behind",
      async () => {
        const db = pg.name();
        await withStore(db, async () => {});
        await pg.sql(db, "UPDATE meta SET value = '99' WHERE key = $1", [META_KEYS.storageFormat]);
        expect(await codeOf(backend.open(pg.ref(db), {}))).toBe("format_too_new");
        const left = await pg.admin(
          "SELECT count(*)::int4 AS n FROM pg_stat_activity WHERE datname = $1",
          [db],
        );
        expect(left.rows[0]?.["n"]).toBe(0);
      },
      T,
    );
  });

  describe("transactions", () => {
    it(
      "writes, reads back, and keeps the data across close and reopen",
      async () => {
        const db = pg.name();
        await withStore(db, async (s) => {
          const r = await s.write(async (tx) => {
            await tx.exec(
              "CREATE TABLE t (id BIGINT PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')",
            );
            const ins = await tx.query("INSERT INTO t VALUES ($1, $2), ($3, $4)", [2, "b", 3, "c"]);
            return ins.affectedRows;
          });
          expect(r).toBe(2);
          expect(await count(s, "t")).toBe(3);
        });
        await withStore(db, async (s) => expect(await count(s, "t")).toBe(3));
      },
      T,
    );

    it(
      "reads and writes take turns in the order they were asked",
      async () => {
        await withStore(pg.name(), async (s) => {
          await s.write((tx) => tx.exec("CREATE TABLE log (n INT)"));
          const seen: number[] = [];
          const jobs = [0, 1, 2, 3, 4, 5].map((n) =>
            n % 2 === 0
              ? s.write(async (tx) => {
                  await new Promise((r) => setTimeout(r, 30 - n * 5));
                  await tx.query("INSERT INTO log VALUES ($1)", [n]);
                  seen.push(n);
                })
              : s.read(async (tx) => {
                  const r = await tx.query<{ n: number }>("SELECT count(*)::int4 AS n FROM log");
                  seen.push(n);
                  // Each read sees exactly the writes asked before it.
                  expect(r.rows[0]?.n).toBe((n + 1) / 2);
                }),
          );
          await Promise.all(jobs);
          expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
        });
      },
      T,
    );

    it(
      "rolls back when the callback throws, and rejects with the callback's error",
      async () => {
        await withStore(pg.name(), async (s) => {
          await s.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
          const boom = new Error("boom");
          await expect(
            s.write(async (tx) => {
              await tx.query("INSERT INTO t VALUES (1)");
              throw boom;
            }),
          ).rejects.toBe(boom);
          expect(await count(s, "t")).toBe(0);
          // The store goes on.
          await s.write((tx) => tx.query("INSERT INTO t VALUES (2)"));
          expect(await count(s, "t")).toBe(1);
        });
      },
      T,
    );

    it(
      "a refused statement carries its SQLSTATE; the transaction is not committed even if the callback swallowed it",
      async () => {
        await withStore(pg.name(), async (s) => {
          await s.write((tx) => tx.exec("CREATE TABLE t (x INT PRIMARY KEY)"));
          let seen: unknown;
          expect(
            await codeOf(
              s.write(async (tx) => {
                await tx.query("INSERT INTO t VALUES (1)");
                await tx.query("SELECT 1 / 0").catch((e: unknown) => {
                  seen = e;
                });
              }),
            ),
          ).toBe("transaction_failed");
          expect(seen).toBeInstanceOf(PostgresStoreError);
          expect((seen as PostgresStoreError).code).toBe("query_failed");
          expect((seen as PostgresStoreError).sqlState).toBe("22012");
          expect(await count(s, "t")).toBe(0);

          // In a script too, and in a read.
          expect(
            await codeOf(
              s.write((tx) => tx.exec("INSERT INTO t VALUES (1); SELECT 1 / 0").catch(() => {})),
            ),
          ).toBe("transaction_failed");
          expect(await count(s, "t")).toBe(0);
          expect(
            await codeOf(
              s.read((tx) =>
                tx.query("SELECT 1 / 0").then(
                  () => {},
                  () => {},
                ),
              ),
            ),
          ).toBe("transaction_failed");
          const dup = await s
            .write(async (tx) => {
              await tx.query("INSERT INTO t VALUES (1), (1)");
            })
            .catch((e: unknown) => e);
          expect((dup as PostgresStoreError).sqlState).toBe("23505");
        });
      },
      T,
    );

    it(
      "a transaction's handle is of no use once the transaction has finished",
      async () => {
        await withStore(pg.name(), async (s) => {
          let kept: {
            query: (sql: string) => Promise<unknown>;
            exec: (sql: string) => Promise<void>;
          };
          await s.write(async (tx) => {
            kept = tx;
          });
          // biome-ignore lint/style/noNonNullAssertion: assigned in the callback above
          await expect(kept!.query("SELECT 1")).rejects.toThrow("already finished");
          // biome-ignore lint/style/noNonNullAssertion: assigned in the callback above
          await expect(kept!.exec("SELECT 1")).rejects.toThrow("already finished");
        });
      },
      T,
    );

    it(
      "a read is read-only, and what it tried is not there",
      async () => {
        await withStore(pg.name(), async (s) => {
          await s.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
          const e = await s
            .read((tx) =>
              (tx as unknown as { exec: (q: string) => Promise<void> }).exec(
                "INSERT INTO t VALUES (1)",
              ),
            )
            .catch((x: unknown) => x);
          expect((e as PostgresStoreError).sqlState).toBe("25006");
          expect(await count(s, "t")).toBe(0);
        });
      },
      T,
    );

    it(
      "a read sees one state throughout: what another connection commits meanwhile does not show",
      async () => {
        const db = pg.name();
        await withStore(db, async (s) => {
          await s.write((tx) => tx.exec("CREATE TABLE t (x INT); INSERT INTO t VALUES (1)"));
          const n = (tx: {
            query: typeof count extends never
              ? never
              : (sql: string) => Promise<{ rows: readonly unknown[] }>;
          }) => tx.query("SELECT x FROM t ORDER BY x").then((r) => r.rows.length);
          const inRead = await s.read(async (tx) => {
            const before = await n(tx);
            // Another process (a new owner, say) commits while this read is open.
            await pg.sql(db, "INSERT INTO t VALUES (2)");
            const after = await n(tx);
            const again = (await tx.query("SELECT count(*)::int4 AS c FROM t")).rows[0]?.["c"];
            return [before, after, again];
          });
          expect(inRead).toEqual([1, 1, 1]);
          // The next read sees it.
          expect(await count(s, "t")).toBe(2);
        });
      },
      T,
    );

    it(
      "a write holds the tenant's advisory lock until it ends; a read holds none",
      async () => {
        const db = pg.name();
        const tryLock = async () =>
          (
            await pg.sql(
              db,
              `SELECT pg_try_advisory_lock(${WRITE_LOCK[0]}, ${WRITE_LOCK[1]}) AS got`,
            )
          ).rows[0]?.["got"];
        await withStore(db, async (s) => {
          expect(await s.write(() => tryLock())).toBe(false);
          expect(await s.read(() => tryLock())).toBe(true);
          expect(await tryLock()).toBe(true);
        });
      },
      T,
    );

    it(
      "statements a transaction asks for at once run one after another, and answer in order",
      async () => {
        await withStore(pg.name(), async (s) => {
          // The earlier ones take longer: answers out of order would show.
          const got = await s.read((tx) =>
            Promise.all(
              [0, 1, 2, 3, 4].map(
                async (i) =>
                  (
                    await tx.query<{ i: number }>(
                      `SELECT ${i}::int4 AS i FROM pg_sleep(${(4 - i) * 0.02})`,
                    )
                  ).rows[0]?.i,
              ),
            ),
          );
          expect(got).toEqual([0, 1, 2, 3, 4]);
        });
      },
      T,
    );

    it(
      "purgeResidue and snapshot are not in this version, as on PGlite",
      async () => {
        await withStore(pg.name(), async (s) => {
          await expect(s.purgeResidue()).rejects.toThrow("not implemented");
          await expect(s.snapshot()).rejects.toThrow("not implemented");
        });
      },
      T,
    );
  });

  // A write takes the tenant's lock first and reads after it. Its transaction is READ COMMITTED
  // whatever the database's default, so each statement after the wait sees what was committed
  // during it; at REPEATABLE READ the snapshot would be the lock statement's, from before the wait.
  describe("a write that waited for the lock, on a database whose default isolation is repeatable read", () => {
    /**
     * A store over a tenant with a table `t`, opened after the database's default isolation was
     * set to repeatable read. `during` runs on another connection that holds the tenant's lock
     * while the store's write `fn` waits for it, and commits before the write goes on.
     */
    async function waited<T>(
      fn: (tx: {
        query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;
      }) => Promise<T>,
      during: (other: Connection) => Promise<unknown>,
    ): Promise<{ result: Promise<T>; s: PostgresTenantStore; db: string }> {
      const db = pg.name();
      await withStore(db, (s) => s.write((tx) => tx.exec("CREATE TABLE t (x INT)")));
      await pg.admin(
        `ALTER DATABASE "${db}" SET default_transaction_isolation = 'repeatable read'`,
      );
      const s = await backend.open(pg.ref(db), {});
      const other = await Connection.connect(pg.cell, db);
      try {
        await other.run("BEGIN ISOLATION LEVEL READ COMMITTED");
        await other.run(`SELECT pg_advisory_xact_lock(${WRITE_LOCK[0]}, ${WRITE_LOCK[1]})`);
        const result = s.write((tx) => fn(tx as never));
        result.catch(() => {});
        const waiting = async () => {
          for (let i = 0; i < 600; i++) {
            const r = await pg.admin(
              `SELECT count(*)::int4 AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
               WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = $1`,
              [db],
            );
            if (r.rows[0]?.["n"] === 1) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          throw new Error("the write never waited for the lock");
        };
        // A write that fails or ends before it waits ends this with what it did.
        await Promise.race([
          waiting(),
          result.then(() => {
            throw new Error("the write ended without waiting for the lock");
          }),
        ]);
        await during(other);
        await other.run("COMMIT");
        await result.catch(() => {});
        return { result, s, db };
      } catch (e) {
        await s.close().catch(() => {});
        throw e;
      } finally {
        await other.end();
      }
    }

    it(
      "its reads see a row another connection committed while it waited",
      async () => {
        const { result, s } = await waited(
          async (tx) => (await tx.query("SELECT count(*)::int4 AS n FROM t")).rows[0]?.["n"],
          (other) => other.run("INSERT INTO t VALUES (1)"),
        );
        try {
          expect(await result).toBe(1);
        } finally {
          await s.close();
        }
      },
      T,
    );

    it(
      "the epoch row changed while it waited (as the local mode's opening would) changes nothing: it writes",
      async () => {
        const { result, s, db } = await waited(
          async () => "written",
          (other) =>
            other.run("UPDATE meta SET value = (value::bigint + 1)::text WHERE key = $1", [
              META_KEYS.ownershipEpoch,
            ]),
        );
        try {
          expect(await result).toBe("written");
          expect(await epochIn(db)).toBe(1);
        } finally {
          await s.close();
        }
      },
      T,
    );

    it(
      "a newer format written while it waited (another version upgraded it): format_too_new, nothing written",
      async () => {
        const { result, s } = await waited(
          async () => "written",
          (other) =>
            other.run("UPDATE meta SET value = $1 WHERE key = $2", [
              String(STORAGE_FORMAT_VERSION + 1),
              META_KEYS.storageFormat,
            ]),
        );
        try {
          expect(await codeOf(result)).toBe("format_too_new");
        } finally {
          await s.close();
        }
      },
      T,
    );
  });

  // Two openers of one database (02-architecture §7): neither takes the tenant from the other.
  // The writes are serialized by the tenant's lock; each read and write checks the storage format,
  // and each write the seal.
  describe("two openers of one database", () => {
    it(
      "both write, by turns, and each reads the other's; neither is refused, both keep their connection",
      async () => {
        const db = pg.name();
        const first = await backend.open(pg.ref(db), { create: true });
        await first.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
        const second = await backend.open(pg.ref(db), {});
        try {
          await first.write((tx) => tx.query("INSERT INTO t VALUES (1)"));
          await second.write((tx) => tx.query("INSERT INTO t VALUES (2)"));
          await first.write((tx) => tx.query("INSERT INTO t VALUES (3)"));
          expect([await count(first, "t"), await count(second, "t")]).toEqual([3, 3]);
          const conns = await pg.admin(
            "SELECT count(*)::int4 AS n FROM pg_stat_activity WHERE datname = $1",
            [db],
          );
          expect(conns.rows[0]?.["n"]).toBe(2);
          expect(await epochIn(db)).toBe(0);
        } finally {
          await first.close();
          await second.close();
        }
      },
      T,
    );

    it(
      "a second opener waits for the write in progress; then both go on writing",
      async () => {
        const db = pg.name();
        const first = await backend.open(pg.ref(db), { create: true });
        await first.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
        let release: () => void = () => {};
        const held = new Promise<void>((r) => {
          release = r;
        });
        let inside: () => void = () => {};
        const started = new Promise<void>((r) => {
          inside = r;
        });
        const writing = first.write(async (tx) => {
          await tx.query("INSERT INTO t VALUES (1)");
          inside();
          await held;
        });
        await started;
        let opened = false;
        const opening = backend.open(pg.ref(db), {}).then((s) => {
          opened = true;
          return s;
        });
        // The opener is waiting on the lock: seen in the server, not by a pause.
        await expect
          .poll(
            async () =>
              (
                await pg.admin(
                  `SELECT count(*)::int4 AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
                   WHERE d.datname = $1 AND l.locktype = 'advisory' AND NOT l.granted`,
                  [db],
                )
              ).rows[0]?.["n"],
            { timeout: 20_000 },
          )
          .toBe(1);
        expect(opened).toBe(false);
        release();
        await writing;
        const second = await opening;
        try {
          expect(await count(second, "t")).toBe(1);
          await first.write((tx) => tx.query("INSERT INTO t VALUES (2)"));
          await second.write((tx) => tx.query("INSERT INTO t VALUES (3)"));
          expect(await count(first, "t")).toBe(3);
        } finally {
          await first.close();
          await second.close();
        }
      },
      T,
    );

    it(
      "the storage of a newer format: each read and write refused with format_too_new; the store stays to be closed",
      async () => {
        const db = pg.name();
        const s = await backend.open(pg.ref(db), { create: true });
        try {
          await s.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
          // What a newer version's upgrade leaves: the format raised under the lock.
          await pg.sql(db, "UPDATE meta SET value = $1 WHERE key = $2", [
            String(STORAGE_FORMAT_VERSION + 1),
            META_KEYS.storageFormat,
          ]);
          expect(await codeOf(s.write((tx) => tx.query("INSERT INTO t VALUES (1)")))).toBe(
            "format_too_new",
          );
          expect(await codeOf(s.read((tx) => tx.query("SELECT 1")))).toBe("format_too_new");
          // Nothing written.
          await pg.sql(db, "UPDATE meta SET value = $1 WHERE key = $2", [
            String(STORAGE_FORMAT_VERSION),
            META_KEYS.storageFormat,
          ]);
          expect(await count(s, "t")).toBe(0);
        } finally {
          await s.close();
        }
      },
      T,
    );

    it(
      "a sealed tenant: a write refused with tenant_sealed, nothing written; a read as before",
      async () => {
        const db = pg.name();
        await withStore(db, async (s) => {
          await s.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
          await pg.sql(db, "INSERT INTO meta (key, value) VALUES ($1, $2)", [
            META_KEYS.sealed,
            "im_example",
          ]);
          expect(await codeOf(s.write((tx) => tx.query("INSERT INTO t VALUES (1)")))).toBe(
            "tenant_sealed",
          );
          expect(await count(s, "t")).toBe(0);
          await pg.sql(db, "DELETE FROM meta WHERE key = $1", [META_KEYS.sealed]);
          await s.write((tx) => tx.query("INSERT INTO t VALUES (1)"));
          expect(await count(s, "t")).toBe(1);
        });
      },
      T,
    );
  });

  describe("a connection that goes away", () => {
    const kill = (pid: number | undefined) =>
      pg.admin("SELECT pg_terminate_backend($1)", [pid ?? 0]);

    it(
      "between transactions: the next is refused with connection_lost, and so is every one after",
      async () => {
        const db = pg.name();
        const s = await backend.open(pg.ref(db), { create: true });
        try {
          await kill(await backendPid(s));
          expect(await codeOf(s.write(async () => {}))).toBe("connection_lost");
          expect(await codeOf(s.read(async () => {}))).toBe("connection_lost");
        } finally {
          await s.close();
        }
        // Closed and opened again, the tenant is as it was.
        await withStore(db, async (again) =>
          expect(again.formatVersion).toBe(STORAGE_FORMAT_VERSION),
        );
      },
      T,
    );

    it(
      "inside a write, before the commit: connection_lost, and nothing of it is committed",
      async () => {
        const db = pg.name();
        const s = await backend.open(pg.ref(db), { create: true });
        await s.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
        try {
          let inner: unknown;
          const outer = await s
            .write(async (tx) => {
              await tx.query("INSERT INTO t VALUES (1)");
              const pid = (await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]
                ?.p;
              await kill(pid);
              await tx.query("INSERT INTO t VALUES (2)").catch((e: unknown) => {
                inner = e;
                throw e;
              });
            })
            .catch((e: unknown) => e);
          expect((inner as PostgresStoreError).code).toBe("connection_lost");
          expect((outer as PostgresStoreError).code).toBe("connection_lost");
          expect(await codeOf(s.write(async () => {}))).toBe("connection_lost");
        } finally {
          await s.close();
        }
        await withStore(db, async (again) => expect(await count(again, "t")).toBe(0));
      },
      T,
    );

    it(
      "inside a write, with the statement's error swallowed: still connection_lost, not a commit",
      async () => {
        const db = pg.name();
        const s = await backend.open(pg.ref(db), { create: true });
        await s.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
        try {
          expect(
            await codeOf(
              s.write(async (tx) => {
                await tx.query("INSERT INTO t VALUES (1)");
                const pid = (await tx.query<{ p: number }>("SELECT pg_backend_pid() AS p")).rows[0]
                  ?.p;
                await kill(pid);
                await tx.query("INSERT INTO t VALUES (2)").catch(() => {});
              }),
            ),
          ).toBe("connection_lost");
        } finally {
          await s.close();
        }
        await withStore(db, async (again) => expect(await count(again, "t")).toBe(0));
      },
      T,
    );

    it(
      "at the commit: commit_unknown, told apart from connection_lost; the store is failed",
      async () => {
        const db = pg.name();
        const s = await backend.open(pg.ref(db), { create: true });
        // A deferred trigger runs as the transaction commits: it ends the connection from inside
        // the COMMIT, after the store has sent it and before the server has answered.
        await s.write((tx) =>
          tx.exec(`
            CREATE TABLE t (x INT);
            CREATE TABLE fatal (x INT);
            CREATE FUNCTION end_connection() RETURNS trigger LANGUAGE plpgsql AS $f$
              BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NULL; END $f$;
            CREATE CONSTRAINT TRIGGER at_commit AFTER INSERT ON fatal
              DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION end_connection();`),
        );
        try {
          let returned = false;
          const e = await s
            .write(async (tx) => {
              await tx.query("INSERT INTO t VALUES (1)");
              await tx.query("INSERT INTO fatal VALUES (1)");
              returned = true;
            })
            .catch((x: unknown) => x);
          // The callback finished without an error: what failed is the COMMIT.
          expect(returned).toBe(true);
          expect(e).toBeInstanceOf(PostgresStoreError);
          expect((e as PostgresStoreError).code).toBe("commit_unknown");
          expect(await codeOf(s.write(async () => {}))).toBe("connection_lost");
        } finally {
          await s.close();
        }
      },
      T,
    );

    it(
      "a commit the database refuses is not in doubt: query_failed with its SQLSTATE, and the store goes on",
      async () => {
        await withStore(pg.name(), async (s) => {
          await s.write((tx) =>
            tx.exec(`CREATE TABLE p (id INT PRIMARY KEY);
              CREATE TABLE c (p INT REFERENCES p (id) DEFERRABLE INITIALLY DEFERRED)`),
          );
          const e = await s
            .write(async (tx) => {
              await tx.query("INSERT INTO c VALUES (1)");
            })
            .catch((x: unknown) => x);
          expect((e as PostgresStoreError).code).toBe("query_failed");
          expect((e as PostgresStoreError).sqlState).toBe("23503");
          expect(await count(s, "c")).toBe(0);
          await s.write((tx) => tx.query("INSERT INTO p VALUES (1)"));
          expect(await count(s, "p")).toBe(1);
        });
      },
      T,
    );
  });

  describe("closing", () => {
    it(
      "waits for the transaction in progress, refuses what is asked after, and may be asked twice",
      async () => {
        const db = pg.name();
        const s = await backend.open(pg.ref(db), { create: true });
        await s.write((tx) => tx.exec("CREATE TABLE t (x INT)"));
        let inside: () => void = () => {};
        const started = new Promise<void>((r) => {
          inside = r;
        });
        const w = s.write(async (tx) => {
          inside();
          await new Promise((r) => setTimeout(r, 50));
          await tx.query("INSERT INTO t VALUES (1)");
        });
        await started;
        const closing = s.close();
        expect(await codeOf(s.write(async () => {}))).toBe("store_closed");
        await w;
        await closing;
        await s.close();
        expect(await codeOf(s.read(async () => {}))).toBe("store_closed");
        const left = await pg.admin(
          "SELECT count(*)::int4 AS n FROM pg_stat_activity WHERE datname = $1",
          [db],
        );
        expect(left.rows[0]?.["n"]).toBe(0);
        expect((await pg.sql(db, "SELECT count(*)::int4 AS n FROM t")).rows[0]?.["n"]).toBe(1);
      },
      T,
    );
  });
});
