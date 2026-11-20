// A derived table read by `sql` (11-restricted-sql.md «处理步骤», 04-write-and-read «记多少条»): the
// stored one is read from its table `d_<id>_v<n>`, its rows are recorded by the partition each
// came from (a derived row has no version of its own), and what the statement could not reach of
// the base tables it was computed from stays out of the result.

import { loadRsql } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildHealth, HEALTH, MARK } from "./testing/sql-health.fixture.ts";
import { refusal, runSql } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlderived-");
  await buildHealth(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const HEALTH_ONLY = { kind: "scoped", slots: [{ slot: HEALTH }] } as const;
const call = (sql: string) => runSql(s, { sql }, { visibility: HEALTH_ONLY as never });

describe("the stored derived table `weekly`", () => {
  it("is read: its rows, in the columns its rule gives", async () => {
    const r = await call("SELECT week, km FROM weekly ORDER BY week");
    expect(r.result.columns.map((c) => c.name)).toEqual(["week", "km"]);
    expect(r.result.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.result)).not.toContain(MARK);
    // The physical table of the derived table, as the compiled schema names it.
    const main = r.statements.find((x) => x.text.includes('"d_t9_v1"'));
    expect(main).toBeDefined();
  });

  it("is recorded by the partitions its rows come from, without a version", async () => {
    const r = await call("SELECT week, km FROM weekly");
    const rows = r.entry.rows.filter((x) => x.table === "t9");
    expect(rows.length).toBe(r.result.rows.length);
    expect(rows.every((x) => x.ver === undefined)).toBe(true);
    expect(r.entry.coarse).toEqual([]);
  });

  it("reads the same as the query it is the result of, over the visible rows only", async () => {
    const weekly = await call("SELECT week, km FROM weekly ORDER BY week");
    const direct = await call(
      "SELECT date_trunc('week', date::timestamp)::date AS week, sum(distance) AS km FROM runs GROUP BY 1 ORDER BY 1",
    );
    // `km` is a quantity (a revoked run is not in it, nor the corrected value's old one).
    expect(weekly.result.rows).toEqual(direct.result.rows);
  });

  it("can be joined with a base table, and both are recorded, whole (a join runs at the cost of its product)", async () => {
    const r = await call("SELECT w.km, r.laps FROM weekly w CROSS JOIN runs r");
    expect(new Set(r.entry.coarse)).toEqual(new Set(["t9", "t1"]));
    expect(r.entry.rows).toEqual([]);
  });
});

describe("the visibility of a derived table", () => {
  type V = Parameters<typeof runSql>[2] extends infer O
    ? O extends { visibility?: infer X }
      ? X
      : never
    : never;
  const only = (...tables: string[]): V =>
    ({
      kind: "scoped",
      slots: [{ slot: HEALTH, tables: tables.map((table) => ({ table })) }],
    }) as V;
  const read = (sql: string, visibility: V) => runSql(s, { sql }, { visibility });

  it("is visible when everything it depends on is: `weekly` is computed from `runs`", async () => {
    const r = await read("SELECT week, km FROM weekly ORDER BY week", only("t9", "t1"));
    expect(r.result.rows.length).toBeGreaterThan(0);
  });

  it("is not visible when a table it depends on is out of range: `unknown_name`, as a name that is not there", async () => {
    for (const visible of [only("t9"), only("t9", "t5"), only("t5")]) {
      const out = await refusal(read("SELECT week FROM weekly", visible));
      const absent = await refusal(read("SELECT week FROM nosuch_zz", visible));
      expect(out).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
      expect(JSON.stringify(out).replaceAll("weekly", "X")).toBe(
        JSON.stringify(absent).replaceAll("nosuch_zz", "X"),
      );
    }
  });

  it("does not make the tables it depends on visible", async () => {
    const e = await refusal(read("SELECT 1 FROM runs", only("t9")));
    expect(e).toMatchObject({ code: "sql_rejected", reason: "unknown_name" });
  });
});
