// The structural fingerprint of a `sql` query (./sql-fingerprint.ts; 04-write-and-read «读取记录里记什么形状»),
// offline: names are IDs, constants and parameters are placeholders, an IN list is one, and nothing of
// the caller's spelling is in it; what the reading depends on is.

import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql } from "./load.ts";
import { check, health, ledger } from "./sql.fixture.ts";
import type { SqlSlot } from "./sql.ts";
import { fingerprintOf } from "./sql-fingerprint.ts";

beforeAll(async () => {
  await loadRsql();
});

function fp(
  sql: string,
  params: readonly unknown[] = [],
  slots: readonly SqlSlot[] = [health()],
): string {
  const r = check(sql, params, slots);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return fingerprintOf(r.analysis);
}

describe("what the fingerprint is", () => {
  it("has IDs for names and placeholders for values", () => {
    expect(fp("SELECT r.laps FROM runs r WHERE r.feeling = 'tired' AND r.laps > 5")).toBe(
      `SELECT "t1"."f6" FROM "sl_health"."t1" AS "t1" WHERE (("t1"."f4" = $1) AND ("t1"."f6" > $2))`,
    );
  });

  it("numbers the placeholders in the order printed, a parameter as one", () => {
    expect(fp("SELECT laps FROM runs WHERE laps > $1 AND pace < 4.5 LIMIT $2", [3, 10])).toBe(
      `SELECT "t1"."f6" FROM "sl_health"."t1" AS "t1" WHERE (("t1"."f6" > $1) AND ("t1"."f7" < $2)) LIMIT $3`,
    );
  });

  it("folds an IN list into one placeholder, however long", () => {
    const two = fp("SELECT laps FROM runs WHERE laps IN (1, 2)");
    const many = fp("SELECT laps FROM runs WHERE laps IN (1, 2, 3, 4, 5, 6, 7)");
    expect(two).toBe(many);
    expect(two).toContain("IN ($1)");
  });

  it("is a position where the SQL is one: ORDER BY, GROUP BY and DISTINCT ON", () => {
    expect(fp("SELECT route, count(*) FROM runs GROUP BY 1 ORDER BY 2 DESC")).toBe(
      `SELECT "t1"."f5", count(*) FROM "sl_health"."t1" AS "t1" GROUP BY 1 ORDER BY 2 DESC`,
    );
  });

  it("keeps the kind of a time clause, and puts the times in placeholders", () => {
    expect(fp("SELECT category FROM budgets FOR VALID_TIME AS OF '2026-11-03'")).toContain(
      `FROM "sl_health"."t3" FOR VALID_TIME AS OF $1 AS "t1"`,
    );
    expect(
      fp("SELECT category FROM budgets FOR VALID_TIME FROM $1 TO saveslot_today() - 3", [
        "2026-11-01",
      ]),
    ).toContain(`FOR VALID_TIME FROM $1 TO $2 AS "t1"`);
  });

  it("names a table by its slot's ID and its own, so a table of the same name in another slot is another", () => {
    const slots = [health(), ledger()];
    const a = fp("SELECT date FROM health.expenses", [], slots);
    const b = fp("SELECT date FROM ledger.expenses", [], slots);
    expect(a).toContain(`"sl_health"."t2"`);
    expect(b).toContain(`"sl_ledger"."t1"`);
    expect(a).not.toBe(b);
  });
});

describe("what it does not have", () => {
  it("is the same for the same query written with other names, aliases, spellings and values", () => {
    const base = fp("SELECT r.laps AS n FROM runs r WHERE r.feeling = 'a' AND r.laps > 1");
    expect(
      fp(
        `SELECT RR.LAPS AS "Other" FROM health.RUNS AS rr WHERE rr.Feeling = 'zzz' AND rr.laps > 99`,
        [],
        [health()],
      ),
    ).toBe(base);
    expect(fp("SELECT x.laps FROM runs x WHERE x.feeling = 'q' AND x.laps > $1", [7])).toBe(base);
  });

  it("has no alias, CTE name, output name or window name of the caller's", () => {
    const text = fp(
      `WITH Secret_Cte AS (SELECT laps AS Secret_Col FROM runs Secret_Alias)
       SELECT Secret_Col AS Secret_Out, sum(Secret_Col) OVER Secret_Win FROM Secret_Cte AS Secret_Sub
       WINDOW Secret_Win AS (ORDER BY Secret_Col)`,
    );
    expect(text).not.toMatch(/secret/i);
    expect(text).toMatch(/OVER "w1"/);
    expect(text).not.toContain(' AS "Secret');
  });

  it("does not put a caller's string in, whatever is in it", () => {
    const text = fp(`SELECT laps FROM runs WHERE feeling = 'x'' OR ''1''=''1 -- secret_text' `);
    expect(text).not.toMatch(/secret_text|OR '|--/);
  });

  it("has no output column names: a different AS gives the same text", () => {
    expect(fp("SELECT laps AS a, pace AS b FROM runs")).toBe(
      fp("SELECT laps AS x, pace AS y FROM runs"),
    );
    expect(fp("SELECT laps AS a FROM runs")).toBe(fp("SELECT laps FROM runs"));
  });
});

describe("what it keeps", () => {
  it("tells apart queries that read differently", () => {
    const seen = new Set([
      fp("SELECT laps FROM runs"),
      fp("SELECT laps FROM runs WHERE laps > 1"),
      fp("SELECT laps FROM runs WHERE laps >= 1"),
      fp("SELECT pace FROM runs"),
      fp("SELECT laps FROM runs ORDER BY 1"),
      fp("SELECT DISTINCT laps FROM runs"),
      fp("SELECT laps FROM runs r JOIN shoes s ON s.row_id = r.shoe"),
      fp("SELECT laps FROM runs LIMIT 1"),
    ]);
    expect(seen.size).toBe(8);
  });

  it("puts a subquery's output column by position, and a system column by its name", () => {
    expect(fp("SELECT s.row_id, q.k FROM shoes s, (SELECT laps AS k FROM runs) q")).toBe(
      `SELECT "t1"."row_id", "t3"."o1" FROM "sl_health"."t5" AS "t1", (SELECT "t2"."f6" FROM "sl_health"."t1" AS "t2") AS "t3"`,
    );
  });

  it("writes a CTE and a reference to it by their ordinals", () => {
    expect(fp("WITH x AS (SELECT laps FROM runs) SELECT laps FROM x")).toBe(
      `WITH "c2" AS (SELECT "t1"."f6" FROM "sl_health"."t1" AS "t1") SELECT "t3"."o1" FROM "c2" AS "t3"`,
    );
  });
});
