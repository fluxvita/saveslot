// The segments of a state table as `sql` shows them, set against `query`, which is the reference for
// what the table holds (11-restricted-sql.md «时间» «SQL 看到的段»): an interval with no value is never a
// row, and segments that were cut physically but hold the same values are one segment, with the
// same endpoints, in both. The cases are built by hand: a revoke over an interval, and the physical
// table cut by raw statements (a write makes cuts of its own, not ones a case can pick).

import { createOpsContext, loadRsql, query, write } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, runSql, TENANT, USER } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
let split: string;
let gapped: string;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlsegments-");
  await buildTenant(s);
  let minute = 10;
  const ctx = () =>
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_window: 600_000,
      idempotency_key_window: 86_400_000,
      now: `2026-11-05T05:${String(++minute).padStart(2, "0")}:00.000Z` as never,
      confirmation: null,
    });
  const insert = async (category: string) => {
    const r = await write(s.store, ctx(), {
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "budgets",
          set: { category, amount: 10 },
          valid_from: "2026-12-01",
          valid_to: "2026-12-31",
        },
      ],
    });
    return (r.ops[0] as { target: { entity: string } }).target.entity;
  };
  split = await insert("split");
  gapped = await insert("gapped");
  // The table is cut at 12-10 and 12-20 with the same values on both sides.
  await s.store.write(async (tx) => {
    await tx.exec(`UPDATE "t_t3_v1" SET valid_to = '2026-12-10T00:00:00Z' WHERE entity_id = '${split}';
      INSERT INTO "t_t3_v1" (entity_id, valid_from, valid_to, f_f1, f_f2) VALUES
        ('${split}', '2026-12-10T00:00:00Z', '2026-12-20T00:00:00Z', 'split', 10),
        ('${split}', '2026-12-20T00:00:00Z', '2026-12-31T00:00:00Z', 'split', 10)`);
  });
  // A revoke over [12-10, 12-20): a stretch in which the entity has no value.
  await write(s.store, ctx(), {
    sv: 1,
    ops: [
      {
        intent: "revoke",
        table: "budgets",
        entity: gapped,
        valid_from: "2026-12-10",
        valid_to: "2026-12-20",
      },
    ],
  });
  const ctxNow = ctx();
  ref = (during: [string, string]) =>
    query(s.store, ctxNow, { table: "budgets", valid_during: during, limit: 200 }).then((r) =>
      r.rows.map((x) => ({
        entity: x.entity as string,
        amount: (x.values as Record<string, unknown>)["amount"],
        from: x["valid_from"] as string,
        to: x["valid_to"] as string,
      })),
    );
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

let ref: (
  during: [string, string],
) => Promise<{ entity: string; amount: unknown; from: string; to: string }[]>;

const sqlRows = async (category: string, clause: string) => {
  return (
    await runSql(s, {
      sql: `SELECT amount, valid_from, valid_to FROM budgets ${clause} WHERE category = '${category}' ORDER BY valid_from`,
    })
  ).result.rows;
};
const WHOLE = "FOR VALID_TIME FROM '2026-11-30' TO '2027-01-01'";

describe("segments cut physically that hold the same values", () => {
  it("are one segment in `sql`, with the endpoints `query` gives", async () => {
    const q = (await ref(["2026-11-30", "2027-01-01"])).filter((x) => x.entity === split);
    expect(q).toEqual([{ entity: split, amount: "10", from: "2026-12-01", to: "2026-12-31" }]);
    expect(await sqlRows("split", WHOLE)).toEqual([["10", "2026-12-01", "2026-12-31"]]);
  });

  it("are one segment as of a day inside the cut, and over an interval that holds the cut", async () => {
    expect(await sqlRows("split", "FOR VALID_TIME AS OF '2026-12-15'")).toEqual([
      ["10", "2026-12-01", "2026-12-31"],
    ]);
    expect(await sqlRows("split", "FOR VALID_TIME FROM '2026-12-05' TO '2026-12-25'")).toEqual([
      ["10", "2026-12-01", "2026-12-31"],
    ]);
  });
});

describe("an interval with no value", () => {
  it("is never a row of `sql`: two segments around it, none for it, no row of empty values", async () => {
    const q = (await ref(["2026-11-30", "2027-01-01"])).filter((x) => x.entity === gapped);
    expect(q.map((x) => [x.from, x.to])).toEqual([
      ["2026-12-01", "2026-12-10"],
      ["2026-12-20", "2026-12-31"],
    ]);
    const rows = await sqlRows("gapped", WHOLE);
    expect(rows).toEqual([
      ["10", "2026-12-01", "2026-12-10"],
      ["10", "2026-12-20", "2026-12-31"],
    ]);
    for (const row of rows) expect(row.every((c) => c !== null)).toBe(true);
  });

  it("gives no row as of a day inside it, and no row of the entity at all for an interval that is only it", async () => {
    expect(await sqlRows("gapped", "FOR VALID_TIME AS OF '2026-12-15'")).toEqual([]);
    expect(await sqlRows("gapped", "FOR VALID_TIME FROM '2026-12-11' TO '2026-12-19'")).toEqual([]);
  });
});
