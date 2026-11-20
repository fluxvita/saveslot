// The read a `sql` call leaves (02-integrity-and-records «读取记录»; 04-write-and-read «读取记录里记什么形状»,
// «记多少条»): one record per call, its shape the fingerprint, and for each base table a superset of
// the rows the query read of it, up to 1,000 one by one and beyond that, or where its level cannot
// run alone, one record of the table. The rows come from statements of the same read transaction.

import { createOpsContext, loadRsql, query, readBufferOf } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import {
  buildTenant,
  LEDGER,
  lastStatements,
  NOW,
  runSql,
  TENANT,
  type Tenant,
  USER,
  VAULT,
} from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
let tenant: Tenant;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlreadlog-");
  tenant = await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const entry = async (sql: string, params?: unknown[], o: Parameters<typeof runSql>[2] = {}) =>
  (await runSql(s, { sql, ...(params !== undefined ? { params } : {}) }, o)).entry;
const targets = (e: Awaited<ReturnType<typeof entry>>, table: string) =>
  e.rows
    .filter((r) => r.table === table)
    .map((r) => r.target)
    .sort();

/** The operations the `query` operation gives as the versions of a table's rows. */
async function versionsOf(table: string, more: object = {}): Promise<Map<string, number>> {
  const r = await query(
    s.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_window: 600_000,
      idempotency_key_window: 86_400_000,
      now: NOW,
      confirmation: null,
    }),
    { table, limit: 200, ...more },
  );
  readBufferOf(s.store).take();
  return new Map(
    r.rows.map((x) => [(x.row ?? x.entity) as string, Number(/^v(\d+)\./.exec(x.ver)?.[1])]),
  );
}

describe("one record for the call", () => {
  it("is a read of operation `sql`, with the slot and table when it reads one, and the position of the state it read", async () => {
    const e = await entry("SELECT note FROM spend WHERE pieces = $1", [2]);
    expect(e).toMatchObject({
      operation: "sql",
      slot: LEDGER,
      sv: 1,
      table: "t1",
      at: NOW,
      coarse: [],
      lastRead: [{ kind: "sv", target: LEDGER, op: 1, restoreCount: 0 }],
    });
    expect(typeof e.pos).toBe("number");
    expect(e.shape).toBe(`SELECT "t1"."f4" FROM "${LEDGER}"."t1" AS "t1" WHERE ("t1"."f5" = $1)`);
  });

  it("gives no slot or table of its own when it reads several, and a read of each slot", async () => {
    const e = await entry("SELECT 1 FROM spend, budgets, vault.secrets", undefined, {
      visibility: { kind: "all" },
    });
    expect(e.slot).toBeUndefined();
    expect(e.table).toBeUndefined();
    expect(e.lastRead.map((x) => x.target).sort()).toEqual([LEDGER, VAULT].sort());
    const two = await entry("SELECT 1 FROM spend, budgets");
    expect(two.slot).toBe(LEDGER);
    expect(two.table).toBeUndefined();
  });

  it("is a read of no table and no slot when it reads none", async () => {
    const e = await entry("SELECT 1 + 1");
    expect(e).toMatchObject({ rows: [], coarse: [], lastRead: [] });
    expect(e.slot).toBeUndefined();
  });

  it("has a shape that holds no value and no spelling of the caller's", async () => {
    const e = await entry(
      `SELECT secret_alias.note AS "Secret_Out" FROM spend AS secret_alias WHERE secret_alias.note = 'secret value' AND secret_alias.pieces IN (1, 2, 3)`,
    );
    expect(e.shape).not.toMatch(/secret|Secret/i);
    expect(e.shape).toContain("IN ($");
  });
});

describe("the rows read", () => {
  it("are every row the query's own level lets through, with the version each was read at", async () => {
    const e = await entry("SELECT note FROM spend WHERE pieces IS NOT NULL");
    expect(e.rows).toHaveLength(2);
    const versions = await versionsOf("spend");
    for (const r of e.rows) {
      expect(r.ver).toEqual({ op: versions.get(r.target), restoreCount: 0 });
    }
  });

  it("are not fewer for a grouping, HAVING, DISTINCT, LIMIT or ORDER BY: those are not looked at", async () => {
    const all = await entry("SELECT note FROM spend");
    expect(all.rows).toHaveLength(4);
    for (const sql of [
      "SELECT count(*) FROM spend",
      "SELECT category FROM spend GROUP BY category HAVING count(*) > 100",
      "SELECT DISTINCT category FROM spend",
      "SELECT note FROM spend ORDER BY note LIMIT 1",
      "SELECT note FROM spend LIMIT 0",
      "SELECT max(pieces) FROM spend",
      "SELECT row_number() OVER (ORDER BY note) FROM spend OFFSET 99",
    ]) {
      expect(targets(await entry(sql), "t1"), sql).toEqual(targets(all, "t1"));
    }
  });

  it("are only the rows that pass the WHERE of the query's level", async () => {
    const e = await entry("SELECT note FROM spend WHERE category = 'rent'");
    expect(e.rows).toHaveLength(1);
    const none = await entry("SELECT note FROM spend WHERE category = 'nothing'");
    expect(none.rows).toEqual([]);
    expect(none.coarse).toEqual([]);
  });

  it("do not include a revoked row, nor a row of a table the statement did not name", async () => {
    const e = await entry("SELECT note FROM spend");
    expect(e.rows.every((r) => r.table === "t1")).toBe(true);
    expect(e.rows).toHaveLength(4);
  });

  it("are a state table's entities, once each however many segments it has, at the time read", async () => {
    const now = await entry("SELECT category FROM budgets");
    expect(targets(now, "t3")).toEqual([tenant.rows.entityA]);
    const during = await entry(
      "SELECT category FROM budgets FOR VALID_TIME FROM '2026-10-01' TO '2026-12-01'",
    );
    expect(targets(during, "t3")).toEqual([tenant.rows.entityA, tenant.rows.entityB].sort());
    // Entity A has three segments in it: one record.
    expect(during.rows.filter((r) => r.target === tenant.rows.entityA)).toHaveLength(1);
    const versions = await versionsOf("budgets", { valid_during: ["2026-10-01", "2026-12-01"] });
    expect(during.rows.find((r) => r.target === tenant.rows.entityB)?.ver?.op).toBe(
      versions.get(tenant.rows.entityB),
    );
  });

  it("are no row for the side of an outer join that has none: a join is recorded whole (the fuzz found a target `null`)", async () => {
    const e = await entry(
      "SELECT s.note FROM spend s LEFT JOIN budgets b ON b.category = s.category AND b.category = 'no such category'",
    );
    expect(e.rows).toEqual([]);
    expect([...e.coarse].sort()).toEqual(["t1", "t3"]);
  });

  it("are the union of the references to a table", async () => {
    const e = await entry(
      "SELECT (SELECT count(*) FROM spend WHERE pieces = 2) AS a, (SELECT count(*) FROM spend WHERE category = 'rent') AS b",
    );
    const rent = (await entry("SELECT 1 FROM spend WHERE category = 'rent'")).rows;
    const two = (await entry("SELECT 1 FROM spend WHERE pieces = 2")).rows;
    expect(e.rows.map((r) => r.target).sort()).toEqual(
      [...new Set([...rent, ...two].map((r) => r.target))].sort(),
    );
    expect(e.rows.length).toBeGreaterThan(Math.max(rent.length, two.length));
  });

  it("are read in the same read transaction as the query, and only to the cap", async () => {
    const r = await runSql(s, { sql: "SELECT note FROM spend" });
    const texts = r.statements.map((x) => x.text);
    expect(texts.filter((t) => /^SELECT DISTINCT .* LIMIT 1001$/.test(t))).toHaveLength(1);
    // One transaction: the statements were all made through the one handle runSql wraps.
    expect(texts.findIndex((t) => t.includes("OFFSET 0 LIMIT"))).toBeLessThan(
      texts.findIndex((t) => /^SELECT DISTINCT/.test(t)),
    );
  });
});

describe("a table recorded whole", () => {
  it("is a level with a subquery in its WHERE, and the table of a subquery that reads the outer query's columns", async () => {
    const e = await entry(
      "SELECT note FROM spend s WHERE EXISTS (SELECT 1 FROM budgets b WHERE b.category = s.category)",
    );
    expect([...e.coarse].sort()).toEqual(["t1", "t3"]);
    expect(e.rows).toEqual([]);
  });

  it("is a table in a subquery of the output that reads the outer query's columns; the outer table's rows are recorded", async () => {
    const e = await entry(
      "SELECT (SELECT max(b.amount) FROM budgets b WHERE b.category = s.category) FROM spend s",
    );
    expect(e.coarse).toEqual(["t3"]);
    expect(e.rows.filter((r) => r.table === "t1").length).toBeGreaterThan(0);
    expect(
      (
        await entry(
          "SELECT 1 FROM spend s WHERE s.category IN (SELECT b.category FROM budgets b WHERE b.amount > s.pieces)",
        )
      ).coarse
        .slice()
        .sort(),
    ).toEqual(["t1", "t3"]);
  });

  it("is not so for a subquery of the output that stands alone: its rows are recorded one by one", async () => {
    const e = await entry(
      "SELECT (SELECT max(amount) FROM budgets WHERE category = 'food') AS m FROM spend",
    );
    expect(e.coarse).toEqual([]);
    expect(targets(e, "t3")).toEqual([tenant.rows.entityA]);
    expect(e.rows.filter((r) => r.table === "t1").length).toBeGreaterThan(0);
  });

  it("is a level with a subquery in its WHERE even when the subquery stands alone", async () => {
    const e = await entry(
      "SELECT note FROM spend WHERE category IN (SELECT category FROM budgets)",
    );
    expect(e.coarse).toEqual(["t1"]);
    expect(targets(e, "t3")).toEqual([tenant.rows.entityA]);
    expect(e.rows.filter((r) => r.table === "t1")).toEqual([]);
  });

  it("is a level of a join, also beside common table expressions", async () => {
    const joined = await entry(
      "WITH x AS (SELECT category FROM budgets) SELECT 1 FROM spend s JOIN x ON x.category = s.category",
    );
    // The join's level has two references: spend is recorded whole, the CTE's own level by row.
    expect(joined.coarse).toEqual(["t1"]);
    expect(targets(joined, "t3")).toEqual([tenant.rows.entityA]);
  });
});

describe("the threshold", () => {
  const settings = (n: number) =>
    s.store.write(async (tx) => {
      await tx.exec(
        `INSERT INTO "t_t5_v1" (row_id, revoked, "f_f1") SELECT 'r_bulk' || g, false, 'k' || g FROM generate_series(1, ${n}) g`,
      );
    });

  it("is 1,000 rows of a table one by one, and a record of the table above it", async () => {
    // `settings` has 2 rows: 997 more make 999, then 1,000, then 1,001.
    await settings(997);
    expect((await entry("SELECT key FROM settings")).rows).toHaveLength(999);
    await settings(0);
    await s.store.write((tx) =>
      tx.exec(`INSERT INTO "t_t5_v1" (row_id, revoked, "f_f1") VALUES ('r_bulk_a', false, 'x')`),
    );
    const at = await entry("SELECT key FROM settings");
    expect(at.rows).toHaveLength(1000);
    expect(at.coarse).toEqual([]);
    await s.store.write((tx) =>
      tx.exec(`INSERT INTO "t_t5_v1" (row_id, revoked, "f_f1") VALUES ('r_bulk_b', false, 'y')`),
    );
    const over = await entry("SELECT key FROM settings");
    expect(over.rows).toEqual([]);
    expect(over.coarse).toEqual(["t5"]);
  });

  it("is judged by the rows read, not the rows there are: a WHERE that lets few through stays by rows", async () => {
    const e = await entry("SELECT key FROM settings WHERE key = 'a'");
    expect(e.rows).toHaveLength(1);
    expect(e.coarse).toEqual([]);
  });

  it("is judged for each table, and a table of rows read is not made whole by another's", async () => {
    const e = await entry(
      "SELECT (SELECT count(*) FROM settings) AS n FROM spend WHERE note = 'lunch' LIMIT 1",
    );
    expect(e.coarse).toEqual(["t5"]);
    expect(e.rows.map((r) => r.table)).toEqual(["t1"]);
  });

  it("makes a statement of a level that reads 1,001 rows read only 1,001", async () => {
    await runSql(s, { sql: "SELECT key FROM settings" });
    const ids = lastStatements.filter((x) => /^SELECT DISTINCT/.test(x.text));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.text).toMatch(/LIMIT 1001$/);
  });
});

describe("the business time read", () => {
  it("is the instant, or the day in the zone, of a state table read without a clause", async () => {
    expect((await entry("SELECT category FROM budgets")).valid).toEqual({ at: "2026-11-05" });
    expect((await entry("SELECT guest FROM rooms")).valid).toEqual({ at: NOW });
    expect(
      (await entry("SELECT category FROM budgets", undefined, { now: "2026-11-05T20:00:00.000Z" }))
        .valid,
    ).toEqual({ at: "2026-11-06" });
  });

  it("is what the clause says, as the call resolved it", async () => {
    expect(
      (await entry("SELECT category FROM budgets FOR VALID_TIME AS OF '2026-11-12'")).valid,
    ).toEqual({ at: "2026-11-12" });
    expect(
      (
        await entry("SELECT category FROM budgets FOR VALID_TIME FROM $1 TO '2026-12-01'", [
          "2026-10-01",
        ])
      ).valid,
    ).toEqual({
      during: ["2026-10-01", "2026-12-01"],
    });
  });

  it("is none for event and timeless tables, whose reads are matched by their versions", async () => {
    expect((await entry("SELECT note FROM spend")).valid).toBeUndefined();
  });

  it("is none where the state tables of the query are read at different times: the whole time", async () => {
    expect(
      (
        await entry(
          "SELECT 1 FROM budgets FOR VALID_TIME AS OF '2026-11-12' a, budgets FOR VALID_TIME AS OF '2026-11-13' b",
        )
      ).valid,
    ).toBeUndefined();
    expect((await entry("SELECT 1 FROM budgets, rooms")).valid).toBeUndefined();
    expect(
      (
        await entry(
          "SELECT 1 FROM budgets FOR VALID_TIME AS OF '2026-11-12' a, budgets FOR VALID_TIME AS OF '2026-11-12' b",
        )
      ).valid,
    ).toEqual({ at: "2026-11-12" });
  });
});

describe("marks", () => {
  it("are counted over the rows read, once for a row and kind, and over the whole table of a record of the table", async () => {
    const r1 = tenant.rows.r1;
    const r2 = tenant.rows.r2;
    await s.store.write((tx) =>
      tx.exec(
        `INSERT INTO flags (table_id, row_id, flag, item_id, fields, spans) VALUES
           ('t1', '${r1}', 'disputed', 'pi_B', NULL, NULL),
           ('t1', '${r1}', 'disputed', 'pi_A', NULL, NULL),
           ('t1', '${r1}', 'awaiting', 'pi_A', NULL, NULL),
           ('t1', '${r2}', 'flagged', 'pi_C', NULL, NULL)`,
      ),
    );
    const one = (await runSql(s, { sql: "SELECT note FROM spend WHERE note = 'lunch'" })).result;
    expect(one.marks_summary).toEqual({
      disputed: 1,
      awaiting: 1,
      flagged: 0,
      premise_changed: 0,
      items: ["pi_A", "pi_B"],
    });
    const all = (await runSql(s, { sql: "SELECT note FROM spend" })).result;
    expect(all.marks_summary).toMatchObject({
      disputed: 1,
      awaiting: 1,
      flagged: 1,
      items: ["pi_A", "pi_B", "pi_C"],
    });
    const none = (await runSql(s, { sql: "SELECT 1 + 1" })).result;
    expect(none.marks_summary).toEqual({
      disputed: 0,
      awaiting: 0,
      flagged: 0,
      premise_changed: 0,
      items: [],
    });
    // A table whose rows are recorded whole: its flags are all counted, more rather than fewer.
    const whole = (
      await runSql(s, {
        sql: "SELECT 1 FROM budgets b WHERE EXISTS (SELECT 1 FROM spend x WHERE x.category = b.category)",
      })
    ).result;
    expect(whole.marks_summary).toMatchObject({ disputed: 1, awaiting: 1, flagged: 1 });
  });
});
