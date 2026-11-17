// `query` of a derived table on PGlite (04-contract.md §10 `query`, §4, §15; 04-contract-types §4.1,
// §4.3): rows by group key with the derived write's `ver`, the parameters that do not apply to a
// derived table, the warning that input marks are not summed, the read record, and later pages
// against derived writes after the first page.
//
// The slot's derived tables are built and written by apply; base rows and flags are changed in their
// tables directly, so that each case sets up exactly what it reads (the write pipeline's refresh is
// covered by write-derived.test.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  continueOperation,
  createOpsContext,
  createTenant,
  derivedWrites,
  eventsOf,
  loadRsql,
  type NewEvent,
  type Query,
  ReadError,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, queryInTx, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NOW = "2026-11-10T08:00:00.000Z";
const T = 120_000;

type Schema = ReturnType<typeof derivedSchema>;
type Derived = Extract<Schema["tables"][number], { kind: "derived" }>;

let schema: Schema;
let store: PgliteTenantStore;
let root: string;
let minute = 0;
const nextNow = () => `2026-11-10T07:${String(minute++ % 60).padStart(2, "0")}:00.000Z` as never;
let partitions = 0;
let rows = 0;

const RULES = [
  [
    "t9",
    "weekly",
    "SELECT date_trunc('week', date::timestamp)::date AS week, sum(distance) AS total, count(*) AS runs FROM runs GROUP BY 1",
    ["week", "total", "runs"],
    "bucketed",
  ],
  [
    "t10",
    "by_route",
    "SELECT route AS route, count(*) AS runs FROM runs GROUP BY 1",
    ["route", "runs"],
    "none",
  ],
  ["t11", "all_runs", "SELECT sum(distance) AS total FROM runs", ["total"], "none"],
  // Members: WHERE drops rows, FILTER does not; HAVING drops groups that still have members.
  [
    "t12",
    "long_december",
    "SELECT route AS route, count(*) FILTER (WHERE distance > 2) AS long FROM runs WHERE date >= DATE '2026-12-01' GROUP BY 1",
    ["route", "long"],
    "none",
  ],
  [
    "t13",
    "busy_routes",
    "SELECT route AS route, count(*) AS runs FROM runs GROUP BY 1 HAVING count(*) > 1",
    ["route", "runs"],
    "none",
  ],
  // A key of two columns.
  [
    "t14",
    "route_weeks",
    "SELECT route AS route, date_trunc('week', date::timestamp)::date AS week, count(*) AS runs FROM runs GROUP BY 1, 2",
    ["route", "week", "runs"],
    "bucketed",
  ],
  // A whole aggregate over the rows of one route only (input marks of its own rows).
  [
    "t15",
    "meadow_total",
    "SELECT sum(distance) AS total FROM runs WHERE route = 'meadow'",
    ["total"],
    "none",
  ],
] as const;

beforeAll(async () => {
  await loadRsql();
  const derived = RULES.map(([id, name, sql, fields, td], i): Derived => {
    const t = derivedSchema(rule(sql, fields, td)).tables.find((x) => x.id === "t9") as Derived;
    return {
      ...t,
      id,
      name,
      physical: { table: `d_${id}_v1` },
      rule: { ...t.rule, id: `r${i + 1}` as Derived["rule"]["id"] },
    } as Derived;
  });
  const base = derivedSchema(rule(RULES[0][2], RULES[0][3], RULES[0][4]));
  schema = {
    ...base,
    slot: SLOT,
    tables: [...base.tables.filter((t) => t.kind === "base"), ...derived],
  } as Schema;
  root = mkdtempSync(join(tmpdir(), "saveslot-read-derived-"));
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  await createTenant(
    store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 86_400_000,
      now: "2026-11-10T04:00:00.000Z",
      confirmation: null,
    }),
  );
  const change = (target: Record<string, unknown>, kind: string) => ({
    target,
    change: kind,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  });
  const events = createSlotEvents({
    compiled: schema as never,
    changes: [
      change({ slot: true }, "create_slot"),
      ...schema.tables.map((t) =>
        change({ table: t.id }, t.kind === "base" ? "add_table" : "add_derived_table"),
      ),
    ] as never,
  });
  await store.write(async (tx) => {
    const op = await appendOperation(tx, { actor: USER as never, now: nextNow(), events });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

afterAll(async () => {
  await store?.close();
  rmSync(root, { recursive: true, force: true });
}, T);

const queryIn =
  (tx: Tx): Query =>
  async (sql, params) =>
    tx.query<Record<string, unknown>>(sql, params as never);

const head = (row: string): NewEvent => ({
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: {
      now: "2026-11-10T06:00:00.000Z",
      today: "2026-11-10",
      ruleset_version: 1,
      policy_version: 1,
      literal_checker: "literal@1",
    },
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t1", row, intent: "insert" },
  },
});

/**
 * One operation: `change` alters the base table; the derived writes it gives are appended and
 * applied (none when `derived` is false: an operation that leaves the derived tables as they are).
 */
async function operation(change: (tx: Tx) => Promise<string>, derived = true): Promise<number> {
  return store.write(async (tx) => {
    const row = await change(tx);
    const opened = await appendOperation(tx, {
      actor: USER as never,
      now: nextNow(),
      events: [head(row)],
    });
    await applyEvents(tx, eventsOf(opened));
    if (!derived) return opened.op;
    const writes = await derivedWrites({
      query: queryIn(tx),
      schema,
      changes: [{ table: "t1", row, fields: [] }],
      newPartitionId: () => `p_${String(++partitions).padStart(16, "0")}` as const,
      readPos: opened.op,
    });
    if (writes.length > 0) {
      const more = await continueOperation(
        tx,
        opened,
        writes.map((w) => ({
          type: "write.derived" as const,
          slot: SLOT,
          blocks: {
            target: w.target as never,
            ...(w.key !== undefined ? { key: w.key as never } : {}),
            ...(w.checksum !== undefined ? { checksum: w.checksum as never } : {}),
          },
        })),
      );
      await applyEvents(tx, eventsOf(more));
    }
    return opened.op;
  });
}

const insert = (date: string, distance: string, route: string | null) =>
  operation(async (tx) => {
    const id = `r_${String(rows++).padStart(26, "0")}`;
    await tx.query(
      `INSERT INTO "t_t1_v1" (row_id, "f_f1", "f_f2", "f_f5") VALUES ($1, $2, $3, $4)`,
      [id, date, distance, route],
    );
    return id;
  });
const revoke = (n: number) =>
  operation(async (tx) => {
    const id = `r_${String(n).padStart(26, "0")}`;
    await tx.query(`UPDATE "t_t1_v1" SET revoked = TRUE WHERE row_id = $1`, [id]);
    return id;
  });

async function query(params: Record<string, unknown>) {
  return store.read((tx) =>
    queryInTx(tx, {
      actor: USER as never,
      task: null,
      now: NOW as never,
      visibility: { kind: "all" },
      params,
      read: "rd_0000000000000000" as never,
    }),
  );
}
async function refused(params: Record<string, unknown>): Promise<unknown> {
  try {
    await query(params);
  } catch (e) {
    if (e instanceof ReadError) return { code: e.code, ...e.detail };
    throw e;
  }
  return "read";
}

const NO_MARKS = { disputed: 0, awaiting: 0, flagged: 0, premise_changed: 0, items: [] };

describe("query of a derived table", () => {
  it(
    "empty before any write: no rows",
    async () => {
      const { result } = await query({ table: "weekly" });
      expect(result).toEqual({
        table: "health.weekly",
        slot: "health",
        sv: 1,
        total: 0,
        rows: [],
      });
    },
    T,
  );

  it(
    "rows by group key, ascending; ver the operation of the last derived write; a whole aggregate's key is {}",
    async () => {
      const a = await insert("2026-11-03", "5", "park");
      await insert("2026-10-27", "2", null);
      const c = await insert("2026-11-04", "1", "park");
      const weekly = (await query({ table: "weekly" })).result;
      expect(weekly.rows).toEqual([
        {
          table: "health.weekly",
          key: { week: "2026-10-26" },
          ver: expect.stringMatching(/^v\d+\.0$/),
          values: { week: "2026-10-26", total: { value: "2", unit: "km" }, runs: "1" },
          input_marks: NO_MARKS,
        },
        {
          table: "health.weekly",
          key: { week: "2026-11-02" },
          ver: `v${c}.0`,
          values: { week: "2026-11-02", total: { value: "6", unit: "km" }, runs: "2" },
          input_marks: NO_MARKS,
        },
      ]);
      expect(a).toBeLessThan(c);
      // NULL keys last, as in any order.
      const routes = (await query({ table: "by_route" })).result.rows;
      expect(routes.map((r) => r.key)).toEqual([{ route: "park" }, { route: null }]);
      const all = (await query({ table: "all_runs" })).result.rows;
      expect(all.map((r) => [r.key, r.values])).toEqual([
        [{}, { total: { value: "8", unit: "km" } }],
      ]);
    },
    T,
  );

  it(
    "fields, where and order as on base tables",
    async () => {
      const r = await query({
        table: "weekly",
        fields: ["total"],
        where: [{ field: "total", op: ">", value: { value: "3000", unit: "m" } }],
        order: [{ field: "runs", dir: "desc" }],
      });
      expect(r.result.rows.map((x) => [x.key, x.values])).toEqual([
        [{ week: "2026-11-02" }, { total: { value: "6", unit: "km" } }],
      ]);
    },
    T,
  );

  it(
    "an emptied partition has no row",
    async () => {
      await revoke(1);
      const r = await query({ table: "weekly" });
      expect(r.result.rows.map((x) => x.key)).toEqual([{ week: "2026-11-02" }]);
      expect((await query({ table: "by_route" })).result.rows.map((x) => x.key)).toEqual([
        { route: "park" },
      ]);
    },
    T,
  );

  it(
    "business time is refused; clip and coalesce are for state tables; at and include_revoked are taken",
    async () => {
      expect(await refused({ table: "weekly", valid_at: "2026-11-03" })).toEqual({
        code: "invalid_argument",
        reason: "derived_table",
        param: "valid_at",
      });
      expect(await refused({ table: "weekly", valid_during: ["2026-11-01", null] })).toEqual({
        code: "invalid_argument",
        reason: "derived_table",
        param: "valid_during",
      });
      expect(await refused({ table: "weekly", clip: true })).toEqual({
        code: "invalid_argument",
        reason: "not_state_table",
        param: "clip",
      });
      const plain = (await query({ table: "weekly" })).result;
      expect(
        (await query({ table: "weekly", at: "2026-12-01T00:00:00Z", include_revoked: true }))
          .result,
      ).toEqual(plain);
    },
    T,
  );

  it(
    "the read: partitions as targets with their ver; only the slot version counts as read",
    async () => {
      const { result, entry } = await query({ table: "weekly" });
      expect(entry.rows).toEqual(
        result.rows.map((r) => ({
          table: "t9",
          target: expect.stringMatching(/^p_/),
          ver: { op: Number(/^v(\d+)\./.exec(r.ver)?.[1]), restoreCount: 0 },
        })),
      );
      expect(entry.lastRead).toEqual([{ kind: "sv", target: SLOT, op: 1, restoreCount: 0 }]);
      expect(JSON.parse(entry.shape as string)).toMatchObject({ table: "t9", time: "none" });
    },
    T,
  );
});

describe("later pages of a derived table", () => {
  /** Two groups at least, read one row a page. */
  async function firstPage() {
    await insert("2026-11-16", "3", "river");
    const first = await query({ table: "weekly", limit: 1 });
    expect(first.result.next_position).toBeDefined();
    return first;
  }
  const next = (first: Awaited<ReturnType<typeof query>>) =>
    query({ table: "weekly", limit: 1, position: first.result.next_position });

  it(
    "a derived write to the table after the first page: handle_expired (derived_changed)",
    async () => {
      const first = await firstPage();
      await insert("2026-11-17", "1", "river");
      expect(
        await refused({ table: "weekly", limit: 1, position: first.result.next_position }),
      ).toEqual({ code: "handle_expired", reason: "derived_changed", param: "position" });
    },
    T,
  );

  it(
    "the first page's own operation wrote the table: the next page as one read of it all",
    async () => {
      // The first page is read right after an operation with derived writes to the table: those
      // have larger seqs than the operation number the position holds, and are no later change.
      const first = await firstPage();
      const second = await next(first);
      const all = (await query({ table: "weekly" })).result.rows;
      expect([...first.result.rows, ...second.result.rows]).toEqual(all.slice(0, 2));
    },
    T,
  );

  it(
    "an operation that leaves the table as it is: the next page as one read of it all",
    async () => {
      const first = await firstPage();
      // Nothing the rule reads changes: no derived write.
      await operation(async () => "r_00000000000000000000000000", false);
      const second = await next(first);
      const all = (await query({ table: "weekly" })).result.rows;
      expect([...first.result.rows, ...second.result.rows]).toEqual(all.slice(0, 2));
    },
    T,
  );

  it(
    "a derived write to another derived table only: the next page as one read of it all",
    async () => {
      const first = await firstPage();
      // Only by_route changes: the route of a run, which weekly does not read.
      await operation(async (tx) => {
        await tx.query(`UPDATE "t_t1_v1" SET "f_f5" = 'river' WHERE row_id = $1`, [
          `r_${String(0).padStart(26, "0")}`,
        ]);
        return `r_${String(0).padStart(26, "0")}`;
      });
      const second = await next(first);
      const all = (await query({ table: "weekly" })).result.rows;
      expect([...first.result.rows, ...second.result.rows]).toEqual(all.slice(0, 2));
    },
    T,
  );
});

describe("input marks of derived rows", () => {
  const item = (c: string) => `pi_${c.repeat(16)}`;
  /** A flag on fields of the row, or (`null`) on the whole row, as flagged items have. */
  const flag = (row: string, kind: string, it: string, fields: string[] | null) =>
    store.write((tx) =>
      tx.query(
        "INSERT INTO flags (table_id, row_id, flag, item_id, fields, spans) VALUES ('t1', $1, $2, $3, $4, NULL)",
        [row, kind, it, fields === null ? null : JSON.stringify(fields)],
      ),
    );
  const id = (n: number) => `r_${String(n).padStart(26, "0")}`;
  async function insertRow(date: string, distance: string, route: string | null) {
    const n = rows;
    await insert(date, distance, route);
    return id(n);
  }
  const marksOf = async (table: string) =>
    (await query({ table })).result.rows.map((r) => [r.key, r.input_marks]);
  const marksByKey = async (table: string) =>
    new Map((await marksOf(table)).map(([k, m]) => [JSON.stringify(k), m] as const));
  const marks = (
    m: Partial<Record<"disputed" | "awaiting" | "flagged", number>>,
    items: string[],
  ) => ({
    ...NO_MARKS,
    ...m,
    items,
  });

  it(
    "flags on the fields the rule depends on, or on the row's existence, of the rows in the partition",
    async () => {
      const a = await insertRow("2026-12-07", "5", "river");
      const b = await insertRow("2026-12-08", "1", "river");
      const c = await insertRow("2026-11-23", "1", "river");
      const d = await insertRow("2026-12-09", "3", "river");
      await revoke(Number(d.slice(2)));
      // a: two disputed items and one awaiting, on distance.
      await flag(a, "disputed", item("A"), ["f2"]);
      await flag(a, "awaiting", item("B"), ["f2"]);
      await flag(a, "disputed", item("C"), ["f2"]);
      // b: on feeling, which no rule here reads; and on the row's existence.
      await flag(b, "disputed", item("D"), ["f4"]);
      await flag(b, "awaiting", item("E"), ["existence"]);
      // c: item A again, in another week; outside long_december's WHERE.
      await flag(c, "disputed", item("A"), ["f1"]);
      // d: revoked, so not read by any rule.
      await flag(d, "disputed", item("F"), ["f2"]);

      const weekly = new Map(
        (await marksOf("weekly")).map(([k, m]) => [JSON.stringify(k), m] as const),
      );
      expect(weekly.get(JSON.stringify({ week: "2026-12-07" }))).toEqual({
        disputed: 1,
        awaiting: 2,
        flagged: 0,
        premise_changed: 0,
        items: [item("A"), item("B"), item("C"), item("E")],
      });
      expect(weekly.get(JSON.stringify({ week: "2026-11-23" }))).toEqual({
        disputed: 1,
        awaiting: 0,
        flagged: 0,
        premise_changed: 0,
        items: [item("A")],
      });
      // long_december reads route, distance and date: b counts though FILTER drops it; c is
      // outside WHERE.
      expect(await marksOf("long_december")).toEqual([
        [
          { route: "river" },
          {
            disputed: 1,
            awaiting: 2,
            flagged: 0,
            premise_changed: 0,
            items: [item("A"), item("B"), item("C"), item("E")],
          },
        ],
      ]);
      // by_route reads route only: the flags on distance and date do not count, existence does.
      const byRoute = new Map(
        (await marksOf("by_route")).map(([k, m]) => [JSON.stringify(k), m] as const),
      );
      expect(byRoute.get(JSON.stringify({ route: "river" }))).toEqual({
        disputed: 0,
        awaiting: 1,
        flagged: 0,
        premise_changed: 0,
        items: [item("E")],
      });
    },
    T,
  );

  it(
    "items in string order, at most 10; a row counted once per kind",
    async () => {
      const r = await insertRow("2026-12-14", "2", "river");
      const ids = "ZYXWVTSRQPNM".split("").map(item);
      for (const it of ids) await flag(r, "disputed", it, ["f2"]);
      const weekly = new Map(
        (await marksOf("weekly")).map(([k, m]) => [JSON.stringify(k), m] as const),
      );
      expect(weekly.get(JSON.stringify({ week: "2026-12-14" }))).toEqual({
        disputed: 1,
        awaiting: 0,
        flagged: 0,
        premise_changed: 0,
        items: [...ids].sort().slice(0, 10),
      });
    },
    T,
  );

  it(
    "items across rows in string order, whatever order the rows come in",
    async () => {
      const first = await insertRow("2026-12-21", "1", "river");
      const second = await insertRow("2026-12-22", "1", "river");
      await flag(first, "disputed", item("Z"), ["f2"]);
      await flag(second, "awaiting", item("A"), ["f2"]);
      const weekly = new Map(
        (await marksOf("weekly")).map(([k, m]) => [JSON.stringify(k), m] as const),
      );
      expect(weekly.get(JSON.stringify({ week: "2026-12-21" }))).toEqual({
        disputed: 1,
        awaiting: 1,
        flagged: 0,
        premise_changed: 0,
        items: [item("A"), item("Z")],
      });
    },
    T,
  );

  it(
    "a group HAVING drops has members but no row: reading is not disturbed by it",
    async () => {
      await insertRow("2026-12-15", "1", "lake");
      const busy = await query({ table: "busy_routes" });
      expect(busy.result.rows.map((r) => r.key)).not.toContainEqual({ route: "lake" });
      expect(busy.result.rows.every((r) => r.input_marks !== undefined)).toBe(true);
    },
    T,
  );

  it(
    "HAVING: a flag in a dropped group counts nowhere; one in a kept group counts there",
    async () => {
      const kept = await insertRow("2026-12-16", "1", "hill");
      await insertRow("2026-12-17", "1", "hill");
      const dropped = await insertRow("2026-12-16", "1", "cove");
      await flag(kept, "disputed", item("G"), ["f5"]);
      await flag(dropped, "awaiting", item("H"), ["f5"]);
      const busy = await marksByKey("busy_routes");
      expect(busy.has(JSON.stringify({ route: "cove" }))).toBe(false);
      expect(busy.get(JSON.stringify({ route: "hill" }))).toEqual(
        marks({ disputed: 1 }, [item("G")]),
      );
      // Nor does it leak into any other row.
      for (const m of busy.values()) expect(m?.items).not.toContain(item("H"));
    },
    T,
  );

  it(
    "a whole aggregate (key {}): its rows' flags, flagged ones (no fields) too",
    async () => {
      const a = await insertRow("2026-12-18", "2", "meadow");
      const b = await insertRow("2026-12-19", "3", "meadow");
      await insertRow("2026-12-20", "4", "meadow");
      await flag(a, "disputed", item("I"), ["f2"]);
      await flag(b, "flagged", item("J"), null);
      expect(await marksOf("meadow_total")).toEqual([
        [{}, marks({ disputed: 1, flagged: 1 }, [item("I"), item("J")])],
      ]);
    },
    T,
  );

  it(
    "a NULL group key: its rows' flags count on the NULL row",
    async () => {
      const r = await insertRow("2026-12-21", "1", null);
      await flag(r, "awaiting", item("K"), ["f5"]);
      const byRoute = await marksByKey("by_route");
      expect(byRoute.get(JSON.stringify({ route: null }))).toEqual(
        marks({ awaiting: 1 }, [item("K")]),
      );
    },
    T,
  );

  it(
    "a key of two columns: a flag counts on its own (route, week) only",
    async () => {
      const a = await insertRow("2026-12-21", "1", "dune");
      await insertRow("2026-12-22", "1", "dune");
      await insertRow("2026-12-28", "1", "dune");
      await flag(a, "disputed", item("L"), ["f1"]);
      const rw = await marksByKey("route_weeks");
      expect(rw.get(JSON.stringify({ route: "dune", week: "2026-12-21" }))).toEqual(
        marks({ disputed: 1 }, [item("L")]),
      );
      expect(rw.get(JSON.stringify({ route: "dune", week: "2026-12-28" }))).toEqual(NO_MARKS);
    },
    T,
  );

  it(
    "a flag on a row of a later page: its marks there, the pages as one read of it all",
    async () => {
      // The latest week: the last page of weekly, ascending.
      const r = await insertRow("2027-01-04", "1", "pond");
      await flag(r, "disputed", item("M"), ["f2"]);
      const all = (await query({ table: "weekly" })).result.rows;
      const pages: (typeof all)[number][] = [];
      let page = await query({ table: "weekly", limit: 1 });
      pages.push(...page.result.rows);
      while (page.result.next_position !== undefined) {
        page = await query({ table: "weekly", limit: 1, position: page.result.next_position });
        pages.push(...page.result.rows);
      }
      expect(pages.length).toBeGreaterThan(1);
      expect(pages).toEqual(all);
      expect(page.result.rows.map((x) => [x.key, x.input_marks])).toEqual([
        [{ week: "2027-01-04" }, marks({ disputed: 1 }, [item("M")])],
      ]);
    },
    T,
  );
});
