// The read record must not make a query cost more than the query the caller wrote. A statement of
// the record runs a level's full FROM and WHERE, with a subquery in it and without the caller's
// LIMIT; so a level is recorded by row only when it has exactly one table reference and no subquery
// in its WHERE, and a table that will be recorded whole anyway (it is referenced somewhere else
// that cannot be read by row) gets no statement for any of its references. The inputs are the
// review's: a table of 48 rows, a LIMIT of 1 on the query, and a product of the same table in a
// subquery of its WHERE. On PostgreSQL the call has a deadline of 50 ms, which the statement of
// the caller (about a millisecond) keeps and the statement of the record would not.

import { loadRsql } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, runSql } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlcost-");
  await buildTenant(s);
  // 44 more live rows: `spend` has 48.
  await s.store.write((tx) =>
    tx.exec(
      `INSERT INTO "t_t1_v1" (row_id, revoked, "f_f4") SELECT 'r_bulk' || g, false, 'n' || g FROM generate_series(1, 44) g`,
    ),
  );
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const records = (statements: readonly { text: string }[]) =>
  statements.filter((x) => /^SELECT DISTINCT/.test(x.text));

describe("a level whose WHERE has a subquery", () => {
  it.each([
    [
      "a correlated scalar subquery over a product",
      "SELECT 1 FROM spend s WHERE (SELECT count(*) FROM spend a, spend b, spend c WHERE a.note <> s.note) >= 0 LIMIT 1",
    ],
    [
      "an IN subquery over a product",
      "SELECT 1 FROM spend s WHERE s.note IN (SELECT a.note FROM spend a, spend b, spend c) LIMIT 1",
    ],
  ])(
    "%s: no statement for the record, the table recorded whole, no timeout at 50 ms",
    async (_n, sql) => {
      const r = await runSql(s, { sql }, { timeoutMs: 50 });
      expect(records(r.statements)).toEqual([]);
      expect(r.entry.coarse).toEqual(["t1"]);
      expect(r.entry.rows).toEqual([]);
      expect(r.result.rows).toHaveLength(1);
    },
  );

  it("is whole also when its table is referenced once only: the subquery is the cost", async () => {
    const r = await runSql(
      s,
      {
        sql: "SELECT 1 FROM spend s WHERE (SELECT count(*) FROM budgets a, budgets b, budgets c WHERE a.category <> s.note) >= 0 LIMIT 1",
      },
      { timeoutMs: 50 },
    );
    expect(records(r.statements)).toEqual([]);
    expect([...r.entry.coarse].sort()).toEqual(["t1", "t3"]);
    expect(r.entry.rows).toEqual([]);
  });

  it("is recorded by row again when the subquery is in the output instead", async () => {
    const r = await runSql(
      s,
      { sql: "SELECT (SELECT count(*) FROM budgets) AS n FROM spend WHERE note = 'lunch'" },
      { timeoutMs: 50 },
    );
    expect(records(r.statements)).toHaveLength(2);
    expect(r.entry.coarse).toEqual([]);
    expect(r.entry.rows.map((x) => x.table).sort()).toEqual(["t1", "t3"]);
  });
});

describe("a table that is recorded whole anyway", () => {
  it("gets no statement for its references that could have been read by row", async () => {
    const r = await runSql(s, {
      sql: "SELECT (SELECT count(*) FROM spend a, spend b) AS n, (SELECT max(pieces) FROM spend WHERE note = 'lunch') AS m FROM spend",
    });
    expect(records(r.statements)).toEqual([]);
    expect(r.entry.coarse).toEqual(["t1"]);
    expect(r.entry.rows).toEqual([]);
  });
});
