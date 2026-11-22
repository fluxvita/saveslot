// openControlDatabase: a plain database for the server mode's control plane (02-architecture §5):
// made when asked, none of a tenant's storage in it, a tenant's storage refused as one, transactions
// that commit or roll back whole.

import { describe, expect, it } from "vitest";
import { PostgresBackend } from "./backend.ts";
import { openControlDatabase } from "./control-database.ts";
import { PostgresStoreError } from "./errors.ts";
import { testCell, testPostgres } from "./testing/test-postgres.fixture.ts";

const T = 60_000;
const cell = testCell();

describe.skipIf(cell === undefined)("against a server", () => {
  const pg = testPostgres(cell);

  it(
    "makes the database when asked, and has nothing of a tenant's storage in it",
    async () => {
      const name = pg.name();
      const db = await openControlDatabase(pg.cell, name, { create: true });
      try {
        const tables = await db.read((tx) =>
          tx.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
          ),
        );
        expect(Number(tables.rows[0]?.n)).toBe(0);
      } finally {
        await db.close();
      }
    },
    T,
  );

  it(
    "writes at READ COMMITTED and reads one snapshot at REPEATABLE READ, whatever the default",
    async () => {
      const name = pg.name();
      const db = await openControlDatabase(pg.cell, name, { create: true });
      try {
        await pg.admin(
          `ALTER DATABASE "${name}" SET default_transaction_isolation = 'serializable'`,
        );
        await db.close();
        const again = await openControlDatabase(pg.cell, name);
        try {
          const iso =
            "SELECT current_setting('transaction_isolation') AS i, current_setting('transaction_read_only') AS ro";
          const w = await again.write((tx) => tx.query<{ i: string; ro: string }>(iso));
          const r = await again.read((tx) => tx.query<{ i: string; ro: string }>(iso));
          expect(w.rows[0]).toEqual({ i: "read committed", ro: "off" });
          expect(r.rows[0]).toEqual({ i: "repeatable read", ro: "on" });
        } finally {
          await again.close();
        }
      } finally {
        await db.close();
      }
    },
    T,
  );

  it(
    "refuses a database that is not there when not asked to make it",
    async () => {
      await expect(openControlDatabase(pg.cell, pg.name())).rejects.toBeDefined();
    },
    T,
  );

  it(
    "refuses a name it does not take, before connecting",
    async () => {
      await expect(openControlDatabase(pg.cell, "Not-A-Name")).rejects.toMatchObject({
        name: PostgresStoreError.name,
        code: "bad_database_name",
      });
    },
    T,
  );

  it(
    "refuses a tenant's storage: a control plane pointed at one by mistake sees it at once",
    async () => {
      const name = pg.name();
      const backend = new PostgresBackend({ cells: { here: pg.cell } });
      await (
        await backend.open({ kind: "postgres", cell: "here", database: name }, { create: true })
      ).close();
      await expect(openControlDatabase(pg.cell, name)).rejects.toMatchObject({
        name: PostgresStoreError.name,
        code: "tenant_storage",
      });
      await expect(openControlDatabase(pg.cell, name, { create: true })).rejects.toMatchObject({
        code: "tenant_storage",
      });
    },
    T,
  );

  it(
    "commits a write whole, rolls one back whole, and reads what was committed",
    async () => {
      const name = pg.name();
      const db = await openControlDatabase(pg.cell, name, { create: true });
      try {
        await db.write((tx) => tx.exec("CREATE TABLE t (n integer)"));
        await db.write((tx) => tx.query("INSERT INTO t (n) VALUES ($1)", [1]));
        await expect(
          db.write(async (tx) => {
            await tx.query("INSERT INTO t (n) VALUES ($1)", [2]);
            throw new Error("rolled back");
          }),
        ).rejects.toThrow("rolled back");
        const r = await db.read((tx) => tx.query<{ n: number }>("SELECT n FROM t ORDER BY n"));
        expect(r.rows.map((x) => Number(x.n))).toEqual([1]);
        // Opened again: what was committed is on the server, not in the connection.
        await db.close();
        const again = await openControlDatabase(pg.cell, name);
        try {
          const r2 = await again.read((tx) => tx.query<{ n: number }>("SELECT n FROM t"));
          expect(r2.rows.map((x) => Number(x.n))).toEqual([1]);
        } finally {
          await again.close();
        }
      } finally {
        await db.close();
      }
    },
    T,
  );
});
