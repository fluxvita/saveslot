// The names of the printed text against the physical tables (11-restricted-sql.md «执行的文本里没有留给
// 数据库解析的名字»; the rewrite of 07 "改写"). The text `sql` prints uses the logical names of
// tables and fields, `"t<n>"."<field>"`. On a physical table that is not a column: PostgreSQL reads
// `"t1"."to_json"` as the function `to_json("t1")` on the whole row, with the table's internal
// columns in it. So a table reference is rewritten to a subquery that has the logical names as its
// columns, and this file runs that against a physical table that has an internal column the caller
// cannot see, with fields named like functions and like the physical columns.
//
// What tells a rewrite that does this from one that does not is the first test: a rewrite that
// reads the physical table under its own alias gets a row's JSON back here, not the field's value.

import { loadRsql } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, MARK, refusal, runSql } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlnames-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const rows = async (sql: string) => (await runSql(s, { sql })).result.rows;
const refused = (sql: string) => refusal(runSql(s, { sql }));

describe("a field named like a function", () => {
  it("is the field, never the function applied to the row", async () => {
    expect(await rows("SELECT to_json, concat, revoked, f_f1, lag FROM odd")).toEqual([
      ["tj", "cc", "rv", "ff", "7"],
    ]);
  });

  it("is so however it is qualified", async () => {
    expect(await rows("SELECT o.to_json, o.concat, o.revoked FROM odd o")).toEqual([
      ["tj", "cc", "rv"],
    ]);
    expect(await rows("SELECT odd.to_json FROM odd")).toEqual([["tj"]]);
    expect(await rows("SELECT ledger.odd.concat FROM ledger.odd")).toEqual([["cc"]]);
    expect(await rows("SELECT q.to_json FROM (SELECT to_json FROM odd) q")).toEqual([["tj"]]);
    expect(await rows('SELECT "TO_JSON" FROM "Odd"')).toEqual([["tj"]]);
  });

  it("holds where the text is a join, a subquery and a window", async () => {
    expect(await rows("SELECT a.to_json, b.concat FROM odd a JOIN odd b ON b.lag = a.lag")).toEqual(
      [["tj", "cc"]],
    );
    expect(
      await rows(
        "SELECT (SELECT max(o.lag) FROM odd o) AS m, lag(lag) OVER (ORDER BY lag) FROM odd",
      ),
    ).toEqual([["7", null]]);
    expect(await rows("SELECT row_number() OVER (ORDER BY concat) FROM odd")).toEqual([["1"]]);
  });

  it("is what it would not be on the physical table: the hazard is real here", async () => {
    // The printed text against the physical table under the alias: `to_json` is no column of it.
    const naive = await s.store.read((tx) =>
      tx.query<{ to_json: string }>(`SELECT "t1"."to_json" FROM "t_t6_v1" AS "t1"`),
    );
    const leaked = JSON.stringify(naive.rows[0]?.to_json ?? naive.rows[0]);
    expect(leaked).toContain("revoked");
    expect(leaked).toContain("row_id");
    // And the call gives the field's value.
    expect((await rows("SELECT to_json FROM odd"))[0]).toEqual(["tj"]);
  });
});

describe("a column of the physical table the caller cannot see", () => {
  it.each([
    "SELECT revoked FROM spend",
    "SELECT s.revoked FROM spend s",
    "SELECT f_f4 FROM spend",
    "SELECT s.f_f8__zone FROM spend s",
    "SELECT rec_from FROM spend",
    "SELECT src_event FROM spend",
    "SELECT entity_id FROM spend",
    "SELECT valid_from FROM spend",
    "SELECT row_id FROM budgets",
    "SELECT partition_id FROM spend",
    "SELECT ctid FROM spend",
    "SELECT tableoid FROM spend",
    "SELECT xmin FROM spend",
    "SELECT s.to_json FROM spend s",
    "SELECT s.row_to_json FROM spend s",
  ])("is no column: %s", async (sql) => {
    expect(await refused(sql)).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
  });

  it("is not in `*`, which is the fields only", async () => {
    const r = (await runSql(s, { sql: "SELECT * FROM odd" })).result;
    expect(r.columns.map((c) => c.name)).toEqual(["to_json", "concat", "revoked", "f_f1", "lag"]);
    const b = (await runSql(s, { sql: "SELECT * FROM budgets" })).result;
    expect(b.columns.map((c) => c.name)).toEqual(["category", "amount"]);
    const sp = (await runSql(s, { sql: "SELECT t.* FROM spend t" })).result;
    expect(sp.columns.map((c) => c.name)).toEqual([
      "date",
      "category",
      "distance",
      "note",
      "pieces",
      "rate",
      "paid",
      "at",
    ]);
    expect(JSON.stringify(sp.rows)).not.toContain(MARK);
  });

  it("is not in what is executed: a table is the subquery over its columns, and only that", async () => {
    const r = await runSql(s, { sql: "SELECT note FROM spend" });
    const main = r.statements.find((x) => x.text.includes("OFFSET 0 LIMIT"))?.text as string;
    expect(main).toContain(`"public"."t_t1_v1" WHERE NOT "revoked") AS "t1"`);
    // No version table, no kernel table, no other physical table.
    expect(main).not.toMatch(/__ver|events|principals|content|t_t1_v0|ledger\./);
  });
});
