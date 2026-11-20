// Derived tables computed when read on PGlite (06-derived.md «时间依赖»; 11-restricted-sql.md «何时求值»;
// 04-contract.md §4 `at`, §7 `computed_at_read`, §15): rules depending on today, and a rule reading a
// state table with no time condition. The rows are computed at `at` (its day in the slot's zone for
// today), carry `computed_at_read` and no `ver`; a write gives them no derived write; a later page is
// computed again at the first page's `at`, or expires when a base table the rule reads changed; the
// read is recorded at table level under the derived table only.
//
// Writes go through the pipeline (writeInTx), so that the version tables a later page checks are
// what a real write leaves. The slot's zone is Asia/Shanghai (UTC+8).

import {
  appendOperation,
  applyEvents,
  catalog,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  loadRsql,
  ReadError,
  readBufferOf,
  readTail,
  writeReads,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, queryInTx, SLOT, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { runSql } from "./testing/sql-tenant.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

type Schema = ReturnType<typeof derivedSchema>;
type Derived = Extract<Schema["tables"][number], { kind: "derived" }>;

const RULES = [
  // A whole aggregate over the last 7 days up to today.
  [
    "t9",
    "last_7",
    "SELECT sum(distance) AS total, count(*) AS runs FROM runs WHERE date > saveslot_today() - 7 AND date <= saveslot_today()",
    ["total", "runs"],
    "now",
  ],
  // Grouped, the same window.
  [
    "t10",
    "routes_7",
    "SELECT route AS route, count(*) AS runs FROM runs WHERE date > saveslot_today() - 7 AND date <= saveslot_today() GROUP BY 1",
    ["route", "runs"],
    "now",
  ],
  // A state table read with no time condition: each budget's segment holding today.
  ["t11", "budget_now", "SELECT sum(amount) AS total FROM budgets", ["total"], "now"],
  // Stored, for contrast: refreshed by writes as before.
  ["t12", "all_runs", "SELECT sum(distance) AS total FROM runs", ["total"], "none"],
  // Today only in an output column, and only in HAVING: the members' statement has neither.
  [
    "t13",
    "routes_due",
    "SELECT route AS route, count(*) FILTER (WHERE date <= saveslot_today()) AS runs FROM runs GROUP BY 1",
    ["route", "runs"],
    "now",
  ],
  [
    "t14",
    "routes_past",
    "SELECT route AS route, count(distance) AS runs FROM runs GROUP BY 1 HAVING max(date) <= saveslot_today()",
    ["route", "runs"],
    "now",
  ],
] as const;

let schema: Schema;
let s: ReusableStore;
let minute = 0;
let ids = 0;
const now = () => {
  minute++;
  return `2026-11-10T${String(8 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

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
  s = await openReusable("saveslot-read-derived-today-");
}, T);

afterAll(async () => {
  await s?.close();
}, T);

beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
  await createTenant(
    s.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
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
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-10T04:00:30.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

async function send(params: unknown): Promise<Record<string, unknown>> {
  const r = (await s.store.write((tx) =>
    writeInTx(tx, {
      actor: USER as never,
      task: null,
      now: now(),
      windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
      visibility: { kind: "all" },
      params,
      newId,
      reads: readBufferOf(s.store),
    }),
  )) as unknown as Record<string, unknown>;
  return r;
}
const run = (date: string, distance: string, route: "park" | "river") =>
  send({
    sv: 1,
    ops: [
      {
        intent: "insert",
        table: "runs",
        set: { date, distance: { value: distance, unit: "km" }, route },
      },
    ],
  });
const budget = (category: string, amount: string, from: string) =>
  send({
    sv: 1,
    ops: [
      {
        intent: "update",
        table: "budgets",
        entity_key: { category },
        set: { amount: { value: amount, unit: "CNY" } },
        valid_from: from,
      },
    ],
  });

type Out = {
  result: { rows: Record<string, unknown>[]; next_position?: string; total: number };
  entry: { at: string; pos: number; coarse: readonly string[]; rows: readonly unknown[] };
};
async function query(params: Record<string, unknown>, entryNow = "2026-11-20T02:00:00.000Z") {
  return (await s.store.read((tx) =>
    queryInTx(tx, {
      actor: USER as never,
      task: null,
      now: entryNow as never,
      visibility: { kind: "all" },
      params,
      read: "rd_0000000000000000" as never,
    }),
  )) as unknown as Out;
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
const values = (o: Out) => o.result.rows.map((r) => r["values"]);
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq);

/** Runs on 11-05, 11-12, 11-15, 11-18 (dates in the slot's zone). */
async function runs() {
  await run("2026-11-05", "5", "river");
  await run("2026-11-12", "2", "park");
  await run("2026-11-15", "1.5", "river");
  await run("2026-11-18", "4", "park");
}

describe("rows computed at `at`", () => {
  it(
    "the same log at two instants: each result fixed by its day, no ver, computed_at_read",
    async () => {
      await runs();
      const a = await query({ table: "last_7", at: "2026-11-10T04:00:00Z" });
      // Today 11-10: (11-03, 11-10] holds 11-05.
      expect(a.result.rows).toEqual([
        {
          table: "health.last_7",
          key: {},
          values: { total: { value: "5", unit: "km" }, runs: "1" },
          marks: { computed_at_read: true },
          input_marks: { disputed: 0, awaiting: 0, flagged: 0, premise_changed: 0, items: [] },
        },
      ]);
      // Today 11-20: (11-13, 11-20] holds 11-15 and 11-18.
      const b = await query({ table: "last_7", at: "2026-11-20T04:00:00Z" });
      expect(values(b)).toEqual([{ total: { value: "5.5", unit: "km" }, runs: "2" }]);
      // Read again, and with no `at`: the entry's instant (11-20 10:00 in Shanghai).
      expect(values(await query({ table: "last_7", at: "2026-11-20T04:00:00Z" }))).toEqual(
        values(b),
      );
      expect(values(await query({ table: "last_7" }))).toEqual(values(b));
    },
    T,
  );

  it(
    "today is the day in the slot's zone: one second apart across midnight in Shanghai",
    async () => {
      await runs();
      // 2026-11-18T15:59:59Z is 11-18 23:59:59 in Shanghai: (11-11, 11-18] holds 11-12, 11-15, 11-18.
      const before = await query({ table: "last_7", at: "2026-11-18T15:59:59Z" });
      expect(values(before)).toEqual([{ total: { value: "7.5", unit: "km" }, runs: "3" }]);
      // One second later it is 11-19 in Shanghai (still 11-18 in UTC): 11-12 has left.
      const after = await query({ table: "last_7", at: "2026-11-18T16:00:00Z" });
      expect(values(after)).toEqual([{ total: { value: "5.5", unit: "km" }, runs: "2" }]);
    },
    T,
  );

  it(
    "no derived write: writes refresh only the stored table, and reading at another `at` appends nothing",
    async () => {
      await runs();
      const events = await s.store.read(async (tx) =>
        tx.query<{ target_table: string }>(
          "SELECT target_table FROM events WHERE type = 'write.derived' ORDER BY seq",
        ),
      );
      expect(new Set(events.rows.map((r) => r.target_table))).toEqual(new Set(["t12"]));
      const physical = await s.store.read(async (tx) =>
        Promise.all(
          ["d_t9_v1", "d_t10_v1", "d_t11_v1"].map(
            async (t) => (await tx.query(`SELECT 1 FROM "${t}"`)).rows.length,
          ),
        ),
      );
      expect(physical).toEqual([0, 0, 0]);
      const end = await tail();
      await query({ table: "last_7", at: "2026-11-10T04:00:00Z" });
      await query({ table: "last_7", at: "2026-11-20T04:00:00Z" });
      expect(await tail()).toBe(end);
    },
    T,
  );

  it(
    "a write's receipt lists the stored table's change only: derived[] and derived_total leave it out",
    async () => {
      // Inside the window of last_7 and routes_7 at the write's day (11-10 in Shanghai).
      const r = await run("2026-11-09", "3", "park");
      expect(new Set((r["derived"] as { table: string }[]).map((d) => d.table))).toEqual(
        new Set(["health.all_runs"]),
      );
      expect(r["derived_total"]).toBe(1);
    },
    T,
  );

  it(
    "a revoked run leaves the window",
    async () => {
      await runs();
      const r = await run("2026-11-19", "10", "park");
      const op = (r["ops"] as { target: { row: string }; ver: string }[])[0];
      const at = "2026-11-20T04:00:00Z";
      expect(values(await query({ table: "last_7", at }))).toEqual([
        { total: { value: "15.5", unit: "km" }, runs: "3" },
      ]);
      await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "runs", row: op?.target.row, ver: op?.ver }],
      });
      expect(values(await query({ table: "last_7", at }))).toEqual([
        { total: { value: "5.5", unit: "km" }, runs: "2" },
      ]);
    },
    T,
  );

  it(
    "a state table read with no time condition: the segment holding today",
    async () => {
      await budget("food", "3000", "2026-11-01");
      await budget("food", "3500", "2026-11-15");
      await budget("transport", "500", "2026-11-10");
      const total = async (day: string) =>
        values(await query({ table: "budget_now", at: `${day}T04:00:00Z` }));
      expect(await total("2026-11-05")).toEqual([{ total: { value: "3000", unit: "CNY" } }]);
      expect(await total("2026-11-12")).toEqual([{ total: { value: "3500", unit: "CNY" } }]);
      expect(await total("2026-11-16")).toEqual([{ total: { value: "4000", unit: "CNY" } }]);
      // Before any segment: a whole aggregate with no input row has no row.
      expect(
        (await query({ table: "budget_now", at: "2026-10-01T04:00:00Z" })).result.rows,
      ).toEqual([]);
    },
    T,
  );
});

describe("conditions, order and pages", () => {
  it(
    "conditions apply to the computed rows; rows are ordered by the group key",
    async () => {
      await runs();
      const at = "2026-11-20T04:00:00Z";
      const all = await query({ table: "routes_7", at });
      expect(all.result.rows.map((r) => [r["key"], r["values"]])).toEqual([
        [{ route: "park" }, { route: "park", runs: "1" }],
        [{ route: "river" }, { route: "river", runs: "1" }],
      ]);
      const river = await query({
        table: "routes_7",
        at,
        where: [{ field: "route", op: "=", value: "river" }],
      });
      expect(values(river)).toEqual([{ route: "river", runs: "1" }]);
      const none = await query({
        table: "routes_7",
        at,
        where: [{ field: "runs", op: ">", value: 1 }],
      });
      expect(none.result.rows).toEqual([]);
    },
    T,
  );

  it(
    "a later page is computed at the first page's `at`; a write to a table the rule does not read leaves it",
    async () => {
      await runs();
      const first = await query({ table: "routes_7", at: "2026-11-20T04:00:00Z", limit: 1 });
      expect(values(first)).toEqual([{ route: "park", runs: "1" }]);
      await budget("food", "3000", "2026-11-01");
      // No `at` on the later page, and the entry is days later: the first page's `at` holds.
      const next = await query(
        { table: "routes_7", limit: 1, position: first.result.next_position },
        "2026-12-30T02:00:00.000Z",
      );
      expect(values(next)).toEqual([{ route: "river", runs: "1" }]);
    },
    T,
  );

  it(
    "a later page expires when a base table the rule reads changed after the first page",
    async () => {
      await runs();
      const first = await query({ table: "routes_7", at: "2026-11-20T04:00:00Z", limit: 1 });
      // A run inside the window: page 2 would count it, page 1 did not.
      await run("2026-11-19", "3", "river");
      expect(
        await refused({ table: "routes_7", limit: 1, position: first.result.next_position }),
      ).toEqual({ code: "handle_expired", reason: "derived_changed", param: "position" });
    },
    T,
  );
});

/** The error `history` refuses with. */
async function historyRefused(params: Record<string, unknown>): Promise<unknown> {
  try {
    await history(
      s.store,
      createOpsContext({
        tenant: TENANT,
        actor: USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 600_000,
        now: "2026-11-20T02:00:00.000Z",
        confirmation: null,
      }),
      params,
    );
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  return "read";
}

describe("what is refused and what is recorded", () => {
  it(
    "history: timeline and as_of are not_in_this_version (no operation made the rows); changes stays derived_table",
    async () => {
      // Without a target: `key` is not a parameter `history` takes yet, on any derived table.
      const refusedTable = { code: "not_in_this_version", reason: "value", param: "table" };
      expect(await historyRefused({ table: "last_7" })).toEqual(refusedTable);
      expect(await historyRefused({ table: "last_7", mode: "as_of", as_of: 1 })).toEqual(
        refusedTable,
      );
      expect(await historyRefused({ table: "last_7", mode: "changes", since: 0 })).toEqual({
        code: "invalid_argument",
        reason: "derived_table",
        param: "table",
      });
    },
    T,
  );

  it(
    "detail: detailed is not_in_this_version: no operation, record time or sources to give",
    async () => {
      expect(await refused({ table: "last_7", detail: "detailed" })).toEqual({
        code: "not_in_this_version",
        reason: "value",
        param: "detail",
        value: "detailed",
      });
    },
    T,
  );

  it(
    "valid_at / valid_during are derived_table, as on any derived table",
    async () => {
      expect(await refused({ table: "last_7", valid_at: "2026-11-10" })).toEqual({
        code: "invalid_argument",
        reason: "derived_table",
        param: "valid_at",
      });
    },
    T,
  );

  it(
    "the read is recorded at table level under the derived table, never under the base table",
    async () => {
      await runs();
      const out = await query({ table: "last_7", at: "2026-11-10T04:00:00Z" });
      expect(out.entry.coarse).toEqual(["t9"]);
      expect(out.entry.rows).toEqual([]);
      // The position of the state read: the latest operation number.
      const op = await s.store.read(async (tx) =>
        Number((await tx.query<{ op: unknown }>("SELECT max(op) AS op FROM events")).rows[0]?.op),
      );
      expect(Number(out.entry.pos)).toBe(op);
    },
    T,
  );

  it(
    "the read log keeps the rule's version and the evaluation time, apart from the entry's instant",
    async () => {
      await runs();
      // The entry is 11-20 10:00 in Shanghai; the rows are computed at 11-10.
      const out = await query({ table: "last_7", at: "2026-11-10T04:00:00Z" });
      await s.store.write((tx) => writeReads(tx, [out.entry as never]));
      const stored = await s.store.read(async (tx) =>
        tx.query<Record<string, unknown>>(
          "SELECT at, rule_version, evaluated_at, table_id FROM read_log WHERE read_id = $1",
          ["rd_0000000000000000"],
        ),
      );
      expect(stored.rows).toEqual([
        {
          at: "2026-11-20T02:00:00.000Z",
          rule_version: 1,
          evaluated_at: "2026-11-10T04:00:00.000Z",
          table_id: "t9",
        },
      ]);
      // A stored derived table's read has neither.
      await s.store.write(async (tx) => {
        await tx.query("DELETE FROM read_log_rows");
        await tx.query("DELETE FROM last_read");
        await tx.query("DELETE FROM read_log");
      });
      const other = await query({ table: "all_runs" });
      await s.store.write((tx) => writeReads(tx, [other.entry as never]));
      const plain = await s.store.read(async (tx) =>
        tx.query<Record<string, unknown>>("SELECT rule_version, evaluated_at FROM read_log"),
      );
      expect(plain.rows).toEqual([{ rule_version: null, evaluated_at: null }]);
    },
    T,
  );
});

const sql = (text: string, at: string) => runSql(s, { sql: text, at });

describe("sql", () => {
  it(
    "reads the rule as a subquery at `at`: the values query gives, never the physical table",
    async () => {
      await runs();
      for (const at of ["2026-11-10T04:00:00Z", "2026-11-20T04:00:00Z"]) {
        const r = await sql("SELECT total, runs FROM last_7", at);
        // sql gives a quantity's number (its unit is the column's); query the value with its unit.
        const q = values(await query({ table: "last_7", at })) as {
          total: { value: string };
          runs: string;
        }[];
        expect(r.result.rows).toEqual(q.map((x) => [x.total.value, x.runs]));
      }
      // The same as the rule written out, at the same day.
      const at = "2026-11-20T04:00:00Z";
      const direct = await sql(
        "SELECT sum(distance) AS total, count(*) AS runs FROM runs WHERE date > saveslot_today() - 7 AND date <= saveslot_today()",
        at,
      );
      expect(direct.result.rows).toEqual(
        (await sql("SELECT total, runs FROM last_7", at)).result.rows,
      );
    },
    T,
  );

  it(
    "is recorded on the base tables the rule reads, whole; a state table at the instant's day",
    async () => {
      await runs();
      const r = await sql("SELECT total FROM last_7", "2026-11-20T04:00:00Z");
      expect(r.entry.coarse).toEqual(["t1"]);
      expect(r.entry.rows).toEqual([]);
      await budget("food", "3000", "2026-11-01");
      const b = await sql("SELECT total FROM budget_now", "2026-11-20T04:00:00Z");
      expect(b.entry.coarse).toEqual(["t3"]);
      expect(b.entry.valid).toEqual({ at: "2026-11-20" });
      expect(b.result.rows).toEqual([["3000"]]);
    },
    T,
  );
});

/** An open item's flag on a base row, as the write pipeline leaves it (spans: state tables). */
const flag = (
  table: string,
  row: string,
  fields: string[],
  spans: { from?: string; to?: string }[] | null = null,
) =>
  s.store.write((tx) =>
    tx.query(
      "INSERT INTO flags (table_id, row_id, flag, item_id, fields, spans) VALUES ($1, $2, 'disputed', $3, $4, $5)",
      [
        table,
        row,
        `pi_${"D".repeat(16)}`,
        JSON.stringify(fields),
        spans === null ? null : JSON.stringify(spans),
      ],
    ),
  );
const rowOf = (r: Record<string, unknown>) =>
  (r["ops"] as { target: { row?: string; entity?: string } }[])[0]?.target;

describe("input marks", () => {
  it(
    "today only in an output column or HAVING, with a flagged base row: query and sql read, the flag counted",
    async () => {
      const r = await run("2026-11-05", "5", "river");
      // On `date`, which both rules depend on.
      await flag("t1", rowOf(r)?.row as string, ["f1"]);
      const at = "2026-11-20T04:00:00Z";
      const one = {
        disputed: 1,
        awaiting: 0,
        flagged: 0,
        premise_changed: 0,
        items: [`pi_${"D".repeat(16)}`],
      };
      for (const table of ["routes_due", "routes_past"]) {
        const q = await query({ table, at });
        expect(
          q.result.rows.map((x) => [x["values"], x["input_marks"]]),
          table,
        ).toEqual([[{ route: "river", runs: "1" }, one]]);
        expect((await sql(`SELECT route, runs FROM ${table}`, at)).result.rows, table).toEqual([
          ["river", "1"],
        ]);
      }
    },
    T,
  );

  it(
    "a state table: a flag counts only when its spans meet the segment holding the evaluation day",
    async () => {
      const a = await budget("food", "3000", "2026-11-01");
      await budget("food", "3500", "2026-11-15");
      const food = rowOf(a)?.entity as string;
      // Disputed on [11-01, 11-05): the 3000 segment, not the 3500 one.
      await flag("t3", food, ["f2"], [{ from: "2026-11-01", to: "2026-11-05" }]);
      const marks = async (day: string) =>
        (await query({ table: "budget_now", at: `${day}T04:00:00Z` })).result.rows.map(
          (x) => (x["input_marks"] as { disputed: number }).disputed,
        );
      // 11-20 reads 3500 from 11-15: the flag's span does not meet it, as the base table read
      // that day would not mark it.
      expect(await marks("2026-11-20")).toEqual([0]);
      // 11-03 reads 3000 from 11-01 to 11-15, which the span meets.
      expect(await marks("2026-11-03")).toEqual([1]);
    },
    T,
  );
});

describe("catalog", () => {
  it(
    "gives the rule and its time dependency, and no profile: there are no stored rows to count",
    async () => {
      await runs();
      const out = (await catalog(
        s.store,
        createOpsContext({
          tenant: TENANT,
          actor: USER,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 86_400_000,
          idempotency_window: 600_000,
          now: "2026-11-20T02:00:00.000Z",
          confirmation: null,
        }),
        { level: "table", tables: ["last_7", "all_runs"] },
      )) as unknown as { tables: Record<string, unknown>[] };
      const [today, stored] = out.tables;
      expect(today?.["rule"]).toMatchObject({ time_dependency: "now" });
      expect(today).not.toHaveProperty("profile");
      expect(stored?.["profile"]).toEqual({ rows: 1 });
    },
    T,
  );
});

describe("every entry that reads a table computed when read", () => {
  it(
    "sends no statement to its empty physical table",
    async () => {
      await runs();
      const seen: string[] = [];
      const read = (params: Record<string, unknown>) =>
        s.store.read(async (tx) => {
          const watched = {
            ...tx,
            query: (text: string, p?: readonly unknown[]) => {
              seen.push(text);
              return tx.query(text, p as never);
            },
          } as typeof tx;
          return (await queryInTx(watched, {
            actor: USER as never,
            task: null,
            now: "2026-11-20T02:00:00.000Z" as never,
            visibility: { kind: "all" },
            params,
            read: "rd_0000000000000000" as never,
          })) as unknown as Out;
        });
      // query: whole, filtered, a later page, each table.
      const first = await read({ table: "routes_7", limit: 1 });
      await read({ table: "routes_7", limit: 1, position: first.result.next_position });
      await read({ table: "routes_7", where: [{ field: "route", op: "=", value: "park" }] });
      await read({ table: "last_7" });
      await read({ table: "budget_now" });
      // sql: alone, and joined with a base table.
      for (const text of [
        "SELECT total FROM last_7",
        "SELECT route, runs FROM routes_7",
        "SELECT l.total, r.distance FROM last_7 l CROSS JOIN runs r",
        "SELECT total FROM budget_now",
      ])
        seen.push(...(await sql(text, "2026-11-20T04:00:00Z")).statements.map((x) => x.text));
      // catalog gives no profile, so it counts nothing of it (the case above).
      // history (timeline, as_of) and detail: detailed refuse before reading (above).
      expect(seen.length).toBeGreaterThan(0);
      const physical = /"d_t(9|10|11|13|14)_v1"/;
      expect(seen.filter((x) => physical.test(x))).toEqual([]);
    },
    T,
  );
});
