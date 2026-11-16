// derivedWrites on PGlite (06-derived.md «刷新范围与写入准入», «行身份»; 09-event-format.md §4.2
// step 6, §5.7 `write.derived`): after each base change, the derived writes it gives, applied to the
// derived table and `partitions`, leave the derived table equal to the rule recomputed over the rows
// not revoked; a group keeps its partition ID for good, emptied or not; and with nothing changed
// there is no write.
//
// The derived table is built here from its layout (rules derivedLayout) and the derived writes are
// applied here by hand: apply builds and writes it in a later version, and this test then uses it.

import { PGlite } from "@electric-sql/pglite";
import {
  type DerivedWrite,
  derivedLayout,
  derivedWrites,
  evaluateRule,
  KERNEL_TABLES,
  loadRsql,
  type Query,
  SESSION_SETTINGS,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, fc, propRuns, rule, TABLES } from "@fluxvita/saveslot-kernel/rsql-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000 });

type Schema = ReturnType<typeof derivedSchema>;
type Cell = string | boolean | null;

const COLUMN: Readonly<Record<string, string>> = {
  text: 'text COLLATE "C"',
  enum: 'text COLLATE "C"',
  ref: 'text COLLATE "C"',
  integer: "bigint",
  decimal: "numeric",
  quantity: "numeric",
  boolean: "boolean",
  date: "date",
  zoned_datetime: "timestamptz",
};

const RUNS = TABLES.find((t) => t.id === "t1") as (typeof TABLES)[number];

let db: PGlite;
const query: Query = async (sql, params) =>
  db.query<Record<string, unknown>>(sql, params as unknown[]);

const RULES = {
  weekly: [
    "SELECT date_trunc('week', date::timestamp)::date AS w, sum(distance) AS total, count(*) AS n FROM runs GROUP BY 1",
    ["w", "total", "n"],
    "bucketed",
  ],
  route: [
    "SELECT route AS r, max(pace) AS p, count(feeling) AS f FROM runs GROUP BY 1",
    ["r", "p", "f"],
    "none",
  ],
  whole: [
    "SELECT sum(distance) AS total, avg(laps) AS laps FROM runs WHERE race",
    ["total", "laps"],
    "none",
  ],
} as const;
type RuleName = keyof typeof RULES;
const schemas = new Map<RuleName, Schema>();

beforeAll(async () => {
  await loadRsql();
  db = await PGlite.create();
  for (const s of SESSION_SETTINGS) await db.exec(s);
  const partitions = KERNEL_TABLES.find((t) => t.name === "partitions");
  if (partitions === undefined) throw new Error("no partitions table");
  await db.exec(partitions.ddl);
  const cols = RUNS.fields.flatMap((f) => [
    `"f_${f.id}" ${COLUMN[f.type]}`,
    ...(f.type === "zoned_datetime" ? [`"f_${f.id}__zone" text COLLATE "C"`] : []),
  ]);
  await db.exec(
    `CREATE TABLE "${RUNS.physical.table}" (row_id text COLLATE "C" PRIMARY KEY, revoked boolean NOT NULL DEFAULT FALSE, ${cols.join(", ")})`,
  );
  for (const [name, [sql, fields, td]] of Object.entries(RULES))
    schemas.set(name as RuleName, derivedSchema(rule(sql, fields, td)));
});

afterAll(async () => {
  await db.close();
});

/** Empty base, derived and partitions tables, the derived one laid out for `schema`. */
async function reset(schema: Schema): Promise<void> {
  const t9 = schema.tables.find((t) => t.id === "t9");
  if (t9 === undefined || t9.kind !== "derived") throw new Error("no t9");
  const l = derivedLayout(t9);
  const cols = l.fields.map(({ field, column }) => `"${column}" ${COLUMN[field.type]}`);
  await db.exec(`
    TRUNCATE "${RUNS.physical.table}"; TRUNCATE partitions;
    DROP TABLE IF EXISTS "${l.table}";
    CREATE TABLE "${l.table}" (${l.partition} text COLLATE "C" PRIMARY KEY, ${cols.join(", ")}, ${l.ver} bigint NOT NULL);
  `);
}

/** A field value as a column parameter. */
const param = (v: unknown) =>
  v !== null && typeof v === "object" && "value" in v ? (v as { value: string }).value : v;

/** Applies derived writes by hand: the derived row set, emptied or changed; the key registered. */
async function applyWrites(schema: Schema, writes: readonly DerivedWrite[], op: number) {
  const t9 = schema.tables.find((t) => t.id === "t9");
  if (t9 === undefined || t9.kind !== "derived") throw new Error("no t9");
  const l = derivedLayout(t9);
  for (const w of writes) {
    const p = w.target.partition;
    if (w.key !== undefined)
      await db.query("INSERT INTO partitions VALUES ($1, $2, $3)", [
        "t9",
        p,
        JSON.stringify(w.key.values),
      ]);
    if (w.target.emptied) {
      await db.query(`DELETE FROM "${l.table}" WHERE ${l.partition} = $1`, [p]);
      continue;
    }
    const exists =
      (await db.query(`SELECT 1 FROM "${l.table}" WHERE ${l.partition} = $1`, [p])).rows.length > 0;
    if (!exists)
      await db.query(`INSERT INTO "${l.table}" (${l.partition}, ${l.ver}) VALUES ($1, $2)`, [
        p,
        op,
      ]);
    for (const c of w.changes) {
      await db.query(
        `UPDATE "${l.table}" SET "f_${c.field}" = $1, ${l.ver} = $2 WHERE ${l.partition} = $3`,
        [param(c.after), op, p],
      );
    }
  }
}

/** The derived table by partition, and the rule recomputed, both keyed by the JCS of the group key. */
async function compare(schema: Schema) {
  const t9 = schema.tables.find((t) => t.id === "t9");
  if (t9 === undefined || t9.kind !== "derived") throw new Error("no t9");
  const e = evaluateRule(schema, "t9");
  const want = new Map<string, unknown>();
  for (const r of (await query(e.all.sql, [])).rows) {
    const d = e.decode(r);
    if (d !== undefined) want.set(JSON.stringify(d.key), d.values);
  }
  const keys = new Map<string, string>();
  for (const r of (await query("SELECT partition_id, group_key FROM partitions", [])).rows)
    keys.set(String(r["partition_id"]), String(r["group_key"]));
  const l = derivedLayout(t9);
  const cols = l.fields.map(({ field, column }) =>
    field.type === "boolean"
      ? `"${column}" AS "${field.id}"`
      : `CAST("${column}" AS text) AS "${field.id}"`,
  );
  const got = new Map<string, unknown>();
  for (const r of (await query(`SELECT ${l.partition}, ${cols.join(", ")} FROM "${l.table}"`, []))
    .rows) {
    const key = keys.get(String(r["partition_id"]));
    if (key === undefined) throw new Error(`row ${String(r["partition_id"])} without a partition`);
    const d = e.decode({ ...r, inputs: "1" });
    got.set(key, d?.values);
  }
  return { got: [...got].sort(), want: [...want].sort() };
}

// --- base changes ------------------------------------------------------------------------------

type Step =
  | { readonly k: "insert"; readonly cells: Readonly<Record<string, Cell>> }
  | { readonly k: "update"; readonly row: number; readonly cells: Readonly<Record<string, Cell>> }
  | { readonly k: "revoke"; readonly row: number }
  | { readonly k: "restore"; readonly row: number };

const DATES = ["2026-10-28", "2026-11-01", "2026-11-02", "2026-11-05", "2026-11-09", "2026-12-31"];
const cells = fc.record(
  {
    f1: fc.constantFrom(...DATES),
    f2: fc.constantFrom("1", "2.5", "7", "0.01"),
    f4: fc.option(fc.constantFrom("ok", "说"), { nil: null }),
    f5: fc.option(fc.constantFrom("park", "river"), { nil: null }),
    f6: fc.option(fc.constantFrom("0", "3", "8"), { nil: null }),
    f7: fc.option(fc.constantFrom("4.5", "5.25", "-1"), { nil: null }),
    f10: fc.option(fc.boolean(), { nil: null }),
  },
  { requiredKeys: [] },
);
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: cells.map((c) => ({
      k: "insert" as const,
      cells: { f1: "2026-11-02", f2: "1", ...c },
    })),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("update" as const), row: fc.nat(9), cells }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("revoke" as const), row: fc.nat(9) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("restore" as const), row: fc.nat(9) }) },
);

/** Applies a base step; the row it touched, or undefined when it touched none. */
async function base(s: Step, inserted: number): Promise<string | undefined> {
  const table = `"${RUNS.physical.table}"`;
  if (s.k === "insert") {
    const id = `r${inserted}`;
    const fields = Object.keys(s.cells);
    await db.query(
      `INSERT INTO ${table} (row_id, ${fields.map((f) => `"f_${f}"`).join(", ")}) VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(", ")})`,
      [id, ...fields.map((f) => s.cells[f])],
    );
    return id;
  }
  if (inserted === 0) return undefined;
  const id = `r${s.row % inserted}`;
  if (s.k === "revoke" || s.k === "restore") {
    await db.query(`UPDATE ${table} SET revoked = $1 WHERE row_id = $2`, [s.k === "revoke", id]);
    return id;
  }
  const fields = Object.keys(s.cells);
  if (fields.length === 0) return undefined;
  await db.query(
    `UPDATE ${table} SET ${fields.map((f, i) => `"f_${f}" = $${i + 2}`).join(", ")} WHERE row_id = $1`,
    [id, ...fields.map((f) => s.cells[f])],
  );
  return id;
}

/** Runs the steps; after each, the writes are applied and checked. Returns every step's writes. */
async function run(name: RuleName, steps: readonly Step[]) {
  const schema = schemas.get(name) as Schema;
  await reset(schema);
  let inserted = 0;
  let next = 0;
  const partitionOf = new Map<string, string>();
  const all: DerivedWrite[][] = [];
  for (const [i, s] of steps.entries()) {
    const row = await base(s, inserted);
    if (s.k === "insert") inserted++;
    const op = 100 + i;
    const changes = row === undefined ? [] : [{ table: "t1" as const, row, fields: [] }];
    const writes = await derivedWrites({
      query,
      schema,
      changes,
      newPartitionId: () => `p_${String(++next).padStart(16, "0")}` as const,
      readPos: op,
    });
    await applyWrites(schema, writes, op);
    all.push(writes);
    const where = `${name} step ${i} ${JSON.stringify(s)}`;
    const { got, want } = await compare(schema);
    expect(got, where).toEqual(want);
    // A group keeps its partition for good.
    for (const w of writes) {
      const k = JSON.stringify(w.groupKey);
      const before = partitionOf.get(k);
      if (before !== undefined) expect(w.target.partition, where).toBe(before);
      partitionOf.set(k, w.target.partition);
      expect(w.key !== undefined, where).toBe(before === undefined);
    }
    // Nothing changed since: no write.
    const again = await derivedWrites({
      query,
      schema,
      changes: [{ table: "t1", row: "r0", fields: [] }],
      newPartitionId: () => "p_ZZZZZZZZZZZZZZZZ",
      readPos: op,
    });
    expect(again, where).toEqual([]);
  }
  return all;
}

describe("derived writes keep the derived table equal to the rule", () => {
  it("random inserts, updates, revokes and restores", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<RuleName>("weekly", "route", "whole"),
        fc.array(step, { minLength: 1, maxLength: 10 }),
        async (name, steps) => {
          await run(name, steps);
        },
      ),
      { numRuns: propRuns(60) },
    );
  });
});

const ins = (cells: Record<string, Cell>): Step => ({
  k: "insert",
  cells: { f1: "2026-11-02", f2: "1", ...cells },
});
const shape = (ws: readonly DerivedWrite[]) =>
  ws.map((w) => ({
    partition: w.target.partition,
    emptied: w.target.emptied,
    key: w.key?.values,
    changed: w.changes.map((c) => c.field),
  }));
const P = (n: number) => `p_${String(n).padStart(16, "0")}`;

describe("fixed cases", () => {
  it("a new group, a change, a result unchanged, emptied, back under the same partition", async () => {
    const ws = await run("weekly", [
      ins({ f1: "2026-11-02", f2: "5" }),
      ins({ f1: "2026-11-03", f2: "2" }),
      { k: "update", row: 0, cells: { f4: "说" } },
      { k: "revoke", row: 0 },
      { k: "revoke", row: 1 },
      ins({ f1: "2026-11-04", f2: "1" }),
    ]);
    expect(ws.map(shape)).toEqual([
      [{ partition: P(1), emptied: false, key: ["2026-11-02"], changed: ["f1", "f2", "f3"] }],
      [{ partition: P(1), emptied: false, key: undefined, changed: ["f2", "f3"] }],
      // feeling is not read by the rule's results: the result is the same, no write.
      [],
      [{ partition: P(1), emptied: false, key: undefined, changed: ["f2", "f3"] }],
      [{ partition: P(1), emptied: true, key: undefined, changed: ["f1", "f2", "f3"] }],
      // The group comes back under its partition, without a key block.
      [{ partition: P(1), emptied: false, key: undefined, changed: ["f1", "f2", "f3"] }],
    ]);
  });

  it("a row moved to another group: one emptied, one new, in partition order", async () => {
    const ws = await run("weekly", [
      ins({ f1: "2026-11-02" }),
      { k: "update", row: 0, cells: { f1: "2026-11-09" } },
    ]);
    expect(ws.map(shape)[1]).toEqual([
      { partition: P(1), emptied: true, key: undefined, changed: ["f1", "f2", "f3"] },
      { partition: P(2), emptied: false, key: ["2026-11-09"], changed: ["f1", "f2", "f3"] },
    ]);
  });

  it("a NULL group key is a group of its own", async () => {
    const ws = await run("route", [ins({ f5: null, f7: "4.5" }), ins({ f5: "park", f7: "5" })]);
    // The NULL key field is null on both sides of a new row: not listed.
    expect(ws.map(shape)).toEqual([
      [{ partition: P(1), emptied: false, key: [null], changed: ["f2", "f3"] }],
      [{ partition: P(2), emptied: false, key: ["park"], changed: ["f1", "f2", "f3"] }],
    ]);
  });

  it("a whole aggregate: no row, a row (key []), none again, and back under its partition", async () => {
    const ws = await run("whole", [
      ins({ f10: false }),
      ins({ f10: true, f6: "3" }),
      { k: "revoke", row: 1 },
      { k: "restore", row: 1 },
    ]);
    expect(ws.map(shape)).toEqual([
      [],
      [{ partition: P(1), emptied: false, key: [], changed: ["f1", "f2"] }],
      [{ partition: P(1), emptied: true, key: undefined, changed: ["f1", "f2"] }],
      [{ partition: P(1), emptied: false, key: undefined, changed: ["f1", "f2"] }],
    ]);
  });
});
