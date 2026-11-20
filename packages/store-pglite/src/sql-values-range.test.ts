// The values `sql` gives (04-contract §1, 11-restricted-sql.md «类型», «确定性»): integers and decimals
// are always text; an integer sum is a 64-bit integer, so that a sum past 64 bits is a runtime
// failure of the query and not a number the contract has no type for; a date outside 0001-01-01 to
// 9999-12-31, which PostgreSQL computes (`0044-03-15 BC`, year 10000), is a runtime failure too.

import { loadRsql } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, refusal, runSql } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlrange-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const run = (sql: string) => runSql(s, { sql });
const rows = async (sql: string) => (await run(sql)).result.rows;
const runtime = { code: "sql_rejected", reason: "runtime" };

describe("integers and decimals", () => {
  it("are text, small or large, in every column that has them", async () => {
    const r = await run(
      "SELECT 2 AS two, count(*) AS n, -3 AS neg, 9007199254740993 AS big, 0.5 AS half, sum(pieces) AS total FROM spend",
    );
    expect(r.result.columns.map((c) => c.type)).toEqual([
      "integer",
      "integer",
      "integer",
      "integer",
      "decimal",
      "integer",
    ]);
    expect(r.result.rows).toEqual([["2", "4", "-3", "9007199254740993", "0.5", "3"]]);
    for (const cell of r.result.rows[0] as unknown[]) expect(typeof cell).toBe("string");
  });
});

describe("an integer sum", () => {
  it("is a 64-bit integer, as far as 64 bits go", async () => {
    // 4 rows of 2^61: 2^63 - 1 would be the limit; 2 rows of it fit.
    expect(await rows("SELECT sum(2305843009213693951) AS x FROM spend WHERE pieces = 2")).toEqual([
      ["2305843009213693951"],
    ]);
    expect(await rows("SELECT sum(-9223372036854775807) AS x FROM spend WHERE pieces = 2")).toEqual(
      [["-9223372036854775807"]],
    );
  });

  it.each([
    "SELECT sum(9223372036854775807) AS x FROM spend",
    "SELECT sum(-9223372036854775807) AS x FROM spend",
    "SELECT category, sum(9223372036854775807) AS x FROM spend GROUP BY category HAVING count(*) > 1",
    "SELECT 1 AS y FROM spend GROUP BY category HAVING sum(9223372036854775807) > 0",
    "SELECT q.x FROM (SELECT sum(9223372036854775807) AS x FROM spend) AS q",
  ])("past 64 bits is a runtime failure of the query: %s", async (text) => {
    expect(await refusal(run(text))).toMatchObject(runtime);
  });
});

describe("an integer sum as a window", () => {
  it("is a 64-bit integer too, as far as 64 bits go", async () => {
    expect(
      await rows("SELECT sum(2305843009213693951) OVER () AS x FROM spend WHERE pieces = 2"),
    ).toEqual([["2305843009213693951"]]);
    const r = await run(
      "SELECT sum(pieces) OVER (PARTITION BY category) AS x FROM spend WHERE pieces = 2",
    );
    expect(r.result.columns).toEqual([{ name: "x", type: "integer" }]);
    expect(r.result.rows).toEqual([["2"]]);
  });

  it.each([
    "SELECT sum(9223372036854775807) OVER () AS x FROM spend",
    "SELECT sum(9223372036854775807) OVER (PARTITION BY category) AS x FROM spend",
    "SELECT q.x * 1 AS y FROM (SELECT sum(9223372036854775807) OVER () AS x FROM spend) AS q",
    "SELECT q.x + 1 AS y FROM (SELECT sum(9223372036854775807) OVER (ORDER BY note) AS x FROM spend) AS q",
    "SELECT sum(9223372036854775807) OVER w AS x FROM spend WINDOW w AS (PARTITION BY category)",
  ])("past 64 bits is a runtime failure of the query: %s", async (text) => {
    expect(await refusal(run(text))).toMatchObject(runtime);
  });
});

describe("a date out of range", () => {
  it.each([
    ["before year 1", "SELECT make_date(-44, 3, 15) AS d"],
    ["one day before 0001-01-01", "SELECT DATE '0001-01-01' - 1 AS d"],
    ["after year 9999", "SELECT DATE '9999-12-31' + 1 AS d"],
    ["a date column carried out of range", "SELECT date - 800000 AS d FROM spend"],
  ])("%s is a runtime failure", async (_n, text) => {
    expect(await refusal(run(text))).toMatchObject({
      ...runtime,
      message: "a date is out of range (0001-01-01 to 9999-12-31)",
    });
  });

  it("the ends of the range are values", async () => {
    expect(await rows("SELECT DATE '0001-01-01' AS a, DATE '9999-12-31' AS b")).toEqual([
      ["0001-01-01", "9999-12-31"],
    ]);
  });
});
