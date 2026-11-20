// What a caller is told when the database refuses a statement the checker let through: only `sql_rejected`
// (or `sql_timeout`), in words of the kernel's, never the database's own (they name generated aliases and
// internals). The original goes to the log. Also the statements the analyzer now refuses itself, which
// the database used to refuse in its own words.

import { loadRsql } from "@fluxvita/saveslot-kernel";
import { sqlInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import {
  buildTenant,
  lastDatabaseErrors,
  NOW,
  refusal,
  runSql,
  USER,
} from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqldberr-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const ORIGINAL = 'SECRET internal text: relation "t_t1_v1" column "f_f4" of "sl_4444444444444444"';

/** A call whose statement of the caller's (or of the read record) the database refuses with `state`. */
async function failing(state: string | undefined, where: "main" | "record", code?: string) {
  const logged: unknown[] = [];
  const tell = () => Object.assign(new Error(ORIGINAL), { sqlState: state, code });
  const run = s.store.read((tx) =>
    sqlInTx(
      {
        query: (text, p) => {
          const main = text.includes('AS "c1"') || text.startsWith("SELECT CAST(");
          const record = /^SELECT DISTINCT/.test(text);
          if ((where === "main" && main) || (where === "record" && record)) throw tell();
          return tx.query(text, p);
        },
      },
      {
        actor: USER as never,
        task: null,
        now: NOW as never,
        visibility: { kind: "all" },
        params: { sql: "SELECT note FROM spend" },
        read: `rd_${"2".repeat(16)}` as never,
        onDatabaseError: (e) => logged.push(e),
      },
    ),
  );
  return { run, logged };
}

describe("a statement the database refuses", () => {
  it.each([
    "42P01",
    "42703",
    "42803",
    "XX000",
    "0A000",
    "53200",
    "54001",
    "25006",
    "58030",
    "P0001",
    "40001",
    "08006",
  ])("with SQLSTATE %s is `sql_rejected`, with none of the database's words", async (state) => {
    for (const where of ["main", "record"] as const) {
      const { run, logged } = await failing(state, where);
      const e = await refusal(run);
      expect(e, state).toMatchObject({ code: "sql_rejected", reason: "runtime" });
      expect(JSON.stringify(e), state).not.toMatch(/SECRET|t_t1_v1|f_f4|sl_4444/);
      // The original is in the log, whole.
      expect(logged).toHaveLength(1);
      expect((logged[0] as Error).message).toBe(ORIGINAL);
    }
  });

  it("a query_failed with no SQLSTATE is the caller's refusal too", async () => {
    const { run, logged } = await failing(undefined, "main", "query_failed");
    expect(await refusal(run)).toMatchObject({ code: "sql_rejected", reason: "runtime" });
    expect(logged).toHaveLength(1);
  });

  it("an error that is no refusal of a statement is passed on as it is (a lost connection)", async () => {
    const { run } = await failing(undefined, "main");
    await expect(run).rejects.toThrow(ORIGINAL);
  });

  it("a scalar subquery of several rows (21000) is `runtime`, in the kernel's words", async () => {
    const e = await refusal(runSql(s, { sql: "SELECT (SELECT note FROM spend) AS x" }));
    expect(e).toMatchObject({
      code: "sql_rejected",
      reason: "runtime",
      message: "a subquery used as a value returned more than one row",
    });
    expect(JSON.stringify(e)).not.toMatch(/more than one row returned|expression/);
    expect(lastDatabaseErrors).toHaveLength(1);
  });

  it("a date out of range (22008) is `runtime` in the kernel's words", async () => {
    const e = await refusal(runSql(s, { sql: "SELECT date + 2147483647 AS d FROM spend" }));
    expect(e).toMatchObject({
      code: "sql_rejected",
      reason: "runtime",
      message: "a date or time is out of range",
    });
  });
});

describe("what the analyzer refuses instead of the database", () => {
  it.each([
    [
      "an aggregate containing a window function",
      "SELECT sum(row_number() OVER ()) AS n FROM spend",
    ],
    [
      "a window function in the argument of a window aggregate",
      "SELECT sum(row_number() OVER ()) OVER () AS n FROM spend",
    ],
    [
      "a subquery using a column that is not grouped",
      "SELECT (SELECT s.note) AS x FROM spend s GROUP BY s.category",
    ],
    [
      "the same in HAVING",
      "SELECT s.category FROM spend s GROUP BY s.category HAVING (SELECT s.note) = 'x'",
    ],
  ])("%s: `sql_rejected` (node) before anything is run", async (_n, text) => {
    const e = await refusal(runSql(s, { sql: text }));
    expect(e).toMatchObject({ code: "sql_rejected", reason: "node" });
    // Nothing reached the database: the refusal is the analyzer's.
    expect(lastDatabaseErrors).toEqual([]);
  });

  it("a subquery over a column that is grouped, or a window function in a subquery of an aggregate, is run", async () => {
    const grouped = await runSql(s, {
      sql: "SELECT s.category, (SELECT s.category) AS again FROM spend s GROUP BY s.category ORDER BY 1",
    });
    expect(grouped.result.rows.length).toBeGreaterThan(0);
    const nested = await runSql(s, {
      sql: "SELECT sum((SELECT max(x.rn) FROM (SELECT row_number() OVER () AS rn FROM spend) AS x)) AS n FROM spend",
    });
    expect(nested.result.rows).toHaveLength(1);
  });
});
