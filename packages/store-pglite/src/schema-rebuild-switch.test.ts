// A `schema.switched` that rebuilds tables, applied on a log the write path makes (09-event-format
// §5.5; 03-data-model/08-schema-migration «物理做法»; 07-schema-evolution «确定性转换怎么重放»;
// the decision record schema-change-p4.md §2). Confirming such a draft is not open yet, so the
// switch is appended to the log as a migration would write it. Fixed cases: a unit changed, a field
// dropped and one added on an event-less table; a precision lowered and a required field added with
// a constant on a state table. Each case that applies ends with the log replayed into an empty
// storage. Fictional names.

import { createHash } from "node:crypto";
import {
  ApplyError,
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  query,
  type ReadTx,
  history as readHistory,
  reconcileLog,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { startMigrationForTests } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const RUNS = {
  name: "runs",
  kind: "base",
  description: "one row per run",
  time: { type: "none" },
  fields: [
    {
      name: "distance",
      type: "quantity",
      required: true,
      description: "how far",
      unit: "km",
      scale: 3,
    },
    { name: "note", type: "text", description: "how it went" },
  ],
};
const BUDGET = {
  name: "budget",
  kind: "base",
  description: "the monthly budget over time",
  time: { type: "state", granularity: "date" },
  fields: [
    { name: "amount", type: "decimal", required: true, description: "how much", scale: 2 },
    { name: "note", type: "text", description: "why" },
  ],
};
/** Version 2: runs in metres, its note dropped, a shoe added; the budget to one decimal, with an owner. */
const RUNS_2 = {
  ...RUNS,
  fields: [
    { ...RUNS.fields[0], unit: "m" },
    { name: "shoe", type: "text", description: "which shoe" },
  ],
  drop_fields: ["note"],
};
const BUDGET_2 = {
  ...BUDGET,
  fields: [
    { ...BUDGET.fields[0], scale: 1 },
    BUDGET.fields[1],
    {
      name: "owner",
      type: "text",
      required: true,
      description: "whose",
      backfill: { const: "me" },
    },
  ],
};

const TXT = (name: string) => ({ name, type: "text", description: name });
const K = (scale: number) => ({ name: "k", type: "decimal", description: "k", scale });
/** No field required: a row exists where some field has a value. */
const NOTES = {
  name: "notes",
  kind: "base",
  description: "notes",
  time: { type: "none" },
  fields: [TXT("a"), TXT("b"), K(2)],
};
const PLAN = {
  name: "plan",
  kind: "base",
  description: "a plan over time",
  time: { type: "state", granularity: "date" },
  fields: [TXT("a"), TXT("b"), K(2)],
};

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const now = () => `2026-11-10T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "w",
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: now(),
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
let n = 0;
const w = (op: Record<string, unknown>, sv = 1): Promise<Any> =>
  write(s.store, ctx(), {
    sv,
    evidence: [{ kind: "user_message", text: `said ${++n}` }],
    idempotency_key: `k-${n}`,
    ops: [op],
  });
const rows = (table: string): Promise<Any[]> =>
  query(s.store, ctx(), {
    table,
    ...(table === "budget" ? { valid_during: ["2026-01-01", null] } : {}),
  } as never).then((r: Any) => r.rows);
const read = <R>(fn: (tx: ReadTx) => Promise<R>) => s.store.read(fn);
const replaysTheSame = async () => {
  await scratch.reset();
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
};

beforeAll(async () => {
  s = await openReusable("saveslot-schema-rebuild-switch-");
  scratch = await openReusable("saveslot-schema-rebuild-switch-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: {
      slot: "home",
      base_version: null,
      timezone: "UTC",
      tables: [RUNS, BUDGET, NOTES, PLAN],
    },
  });
}, T);

/** Writes on both tables in version 1. */
async function history() {
  const r1 = await w({
    table: "runs",
    intent: "insert",
    set: { distance: { value: "5.123", unit: "km" }, note: "easy" },
  });
  const r2 = await w({
    table: "runs",
    intent: "insert",
    set: { distance: { value: "10", unit: "km" }, note: "long" },
  });
  const run1 = r1.ops[0].target.row as string;
  const run2 = r2.ops[0].target.row as string;
  const u1 = await w({
    table: "runs",
    intent: "update",
    row: run1,
    ver: r1.ops[0].ver,
    set: { note: "hard" },
  });
  await w({ table: "runs", intent: "revoke", row: run2, ver: r2.ops[0].ver });
  const b1 = await w({
    table: "budget",
    intent: "insert",
    valid_from: "2026-10-01",
    set: { amount: "100.25" },
  });
  const entity = b1.ops[0].target.entity as string;
  const b2 = await w({
    table: "budget",
    intent: "update",
    entity,
    ver: b1.ops[0].ver,
    valid_from: "2026-11-01",
    set: { amount: "90.5" },
  });
  const b3 = await w({
    table: "budget",
    intent: "update",
    entity,
    ver: b2.ops[0].ver,
    valid_from: "2026-11-15",
    set: { note: "tight" },
  });
  return { run1, run2, u1, entity, b1, b3 };
}

/** The draft of version 2, submitted and pending: its draft ID and compiled definition. */
async function draft2() {
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: 1, timezone: "UTC", tables: [RUNS_2, BUDGET_2] },
  });
  return read(async (tx) => {
    const r = await tx.query<{ draft_id: string; slot_id: string; body: string }>(
      `SELECT v.draft_id, v.slot_id, c.body FROM schema_versions v
       JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
       WHERE v.sv = 2 AND v.state = 'pending'`,
    );
    const x = r.rows[0] as { draft_id: string; slot_id: string; body: string };
    return { draft: x.draft_id, slot: x.slot_id, compiled: JSON.parse(x.body) as Any };
  });
}

/** Appends one operation as a migration writes its switch, and applies it. */
const append = (events: unknown[]) =>
  s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: "system" as never,
      now: now() as never,
      events: events as never,
    });
    await applyEvents(tx, eventsOf(op));
    return op;
  });

const MIGRATION = `m_${"7".repeat(16)}`;

/** JCS of the values these checks hold: objects (keys sorted), strings, null. */
const jcs = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`)
        .join(",")}}`;

/**
 * A table's check as 09 §5.13 has it, from the logical rows the test expects: each as
 * `{id, valid?, fields}`, by `id` then `valid.from`, JCS joined by newlines, SHA-256.
 */
const check = (
  rows: { id: string; valid?: { from: string; to?: string }; fields: Record<string, unknown> }[],
) => ({
  rows: rows.length,
  checksum: createHash("sha256")
    .update(
      [...rows]
        .sort((a, b) =>
          a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : (a.valid?.from ?? "") < (b.valid?.from ?? "")
                ? -1
                : 1,
        )
        .map((r) => jcs(r))
        .join("\n"),
    )
    .digest("hex"),
});

/** The confirmation starting the migration, then (by the caller) its switch. */
const start = (slot: string) =>
  s.store.write((tx) =>
    startMigrationForTests(tx, { slot, from: 1, to: 2, id: MIGRATION, actor: USER, now: now() }),
  );

const switched = (slot: string, draft: string, blocks: Record<string, unknown>) => ({
  type: "schema.switched",
  slot,
  trigger: "migration",
  blocks: {
    target: {
      draft_id: draft,
      from_version: 1,
      to_version: 2,
      migration_id: MIGRATION,
      rebuilt_tables: ["t1", "t2"],
    },
    ...blocks,
  },
});

/** A draft changing the slot from version `base`, pending: its draft ID and compiled definition. */
async function draftFrom(base: number, tables: unknown[]) {
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: base, timezone: "UTC", tables },
  });
  return read(async (tx) => {
    const r = await tx.query<{ draft_id: string; slot_id: string; body: string }>(
      `SELECT v.draft_id, v.slot_id, c.body FROM schema_versions v
       JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
       WHERE v.sv = $1 AND v.state = 'pending'`,
      [base + 1],
    );
    const x = r.rows[0] as { draft_id: string; slot_id: string; body: string };
    return { draft: x.draft_id, slot: x.slot_id, compiled: JSON.parse(x.body) as Any };
  });
}

/** Version `from` to `from + 1` through migration `id`: started, then switched with `blocks`. */
async function migrate(
  d: { draft: string; slot: string },
  from: number,
  id: string,
  rebuilt: string[],
  blocks: Record<string, unknown>,
) {
  await s.store.write((tx) =>
    startMigrationForTests(tx, { slot: d.slot, from, to: from + 1, id, actor: USER, now: now() }),
  );
  return append([
    {
      type: "schema.switched",
      slot: d.slot,
      trigger: "migration",
      blocks: {
        target: {
          draft_id: d.draft,
          from_version: from,
          to_version: from + 1,
          migration_id: id,
          rebuilt_tables: rebuilt,
        },
        ...blocks,
      },
    },
  ]);
}

describe("a switch rebuilding tables", () => {
  it(
    "converts, drops, adds and fills: the new tables, the rows' ver, the version table's history; replayed the same",
    async () => {
      const h = await history();
      const before = { runs: await rows("runs"), budget: await rows("budget") };
      const { draft, slot, compiled } = await draft2();
      const runsT = compiled.tables.find((t: Any) => t.id === "t1");
      const budgetT = compiled.tables.find((t: Any) => t.id === "t2");
      expect([runsT.physical.table, budgetT.physical.table]).toEqual(["t_t1_v2", "t_t2_v2"]);
      const owner = budgetT.fields.find((f: Any) => f.name === "owner").id;
      const id = (t: Any, name: string) => t.fields.find((f: Any) => f.name === name).id;
      const t1 = check([
        {
          id: h.run1,
          fields: {
            [id(runsT, "distance")]: { value: "5123", unit: "m" },
            [id(runsT, "shoe")]: null,
          },
        },
      ]);
      const fields = (amount: string, note: string | null) => ({
        [id(budgetT, "amount")]: amount,
        [id(budgetT, "note")]: note,
        [owner]: "me",
      });
      const t2 = check([
        {
          id: h.entity,
          valid: { from: "2026-10-01", to: "2026-11-01" },
          fields: fields("100.3", null),
        },
        {
          id: h.entity,
          valid: { from: "2026-11-01", to: "2026-11-15" },
          fields: fields("90.5", null),
        },
        { id: h.entity, valid: { from: "2026-11-15" }, fields: fields("90.5", "tight") },
      ]);
      await start(slot);
      // The owner filled where the entity exists: from 10-01 on.
      const sw = await append([
        switched(slot, draft, {
          "tables/t1": t1,
          "tables/t2": t2,
          [`backfill/t2/${owner}/0`]: {
            entity: h.entity,
            valid: { from: "2026-10-01" },
            deps: [{ event: h.b1.seq + 2, existence: 0 }],
          },
        }),
      ]);

      // Runs: in metres, no note, no shoe; the revoked run not listed; its ver back at the insert.
      const runs = await rows("runs");
      expect(runs.map((r: Any) => [r.entity ?? r.row, r.values])).toEqual([
        [h.run1, { distance: { value: "5123", unit: "m" }, shoe: null }],
      ]);
      const run1Before = before.runs.find((r: Any) => r.row === h.run1);
      expect(run1Before.ver).toBe(h.u1.ops[0].ver);
      expect(runs[0].ver).not.toBe(run1Before.ver);
      expect(Number(runs[0].ver.slice(1).split(".")[0])).toBeLessThan(
        Number(run1Before.ver.slice(1).split(".")[0]),
      );

      // Budget: one decimal (half up), the owner everywhere it exists; its ver unchanged.
      const budget = await rows("budget");
      expect(budget.map((r: Any) => [r.valid_from, r.valid_to, r.values])).toEqual([
        ["2026-10-01", "2026-11-01", { amount: "100.3", note: null, owner: "me" }],
        ["2026-11-01", "2026-11-15", { amount: "90.5", note: null, owner: "me" }],
        ["2026-11-15", null, { amount: "90.5", note: "tight", owner: "me" }],
      ]);
      expect(budget.map((r: Any) => r.ver)).toEqual(before.budget.map((r: Any) => r.ver));

      // The version tables: every cell carried, the note's gone, the constant's opened at the switch.
      const cells = await read(async (tx) => ({
        oldRuns: (
          await tx.query<Any>(`SELECT field_id, rec_from, rec_to FROM "t_t1_v1__ver" ORDER BY 1, 2`)
        ).rows,
        newRuns: (
          await tx.query<Any>(
            `SELECT field_id, rec_from, rec_to, intent FROM "t_t1_v2__ver" ORDER BY 1, 2`,
          )
        ).rows,
        newBudget: (
          await tx.query<Any>(
            `SELECT field_id, valid_from::text AS vf, rec_from, rec_to, intent FROM "t_t2_v2__ver" ORDER BY 1, 3, 2`,
          )
        ).rows,
        oldBudget: (await tx.query<Any>(`SELECT count(*)::int AS n FROM "t_t2_v1__ver"`)).rows[0].n,
      }));
      const note = runsT.fields.find((f: Any) => f.name === "distance").id === "f1" ? "f2" : "f1";
      // Every cell carried but the note's; the shoe, added and empty, gets no cell from the switch
      // (a switch makes no version but its constants'), and reads as empty.
      expect(cells.newRuns.map((c: Any) => [c.field_id, c.rec_from, c.rec_to])).toEqual(
        cells.oldRuns
          .filter((c: Any) => c.field_id !== note)
          .map((c: Any) => [c.field_id, c.rec_from, c.rec_to]),
      );
      const asOf: Any = await readHistory(s.store, ctx(), {
        table: "runs",
        row: h.run1,
        mode: "as_of",
        as_of: sw.op,
      } as never);
      expect(asOf.rows.map((r: Any) => r.values)).toEqual([
        { distance: { value: "5123", unit: "m" }, shoe: null },
      ]);
      const filled = cells.newBudget.filter((c: Any) => c.field_id === owner);
      expect(filled.map((c: Any) => [c.vf, c.rec_to, c.intent])).toEqual([
        ["2026-10-01", null, "schema_switch"],
      ]);
      expect(cells.newBudget.length).toBe(cells.oldBudget + 1);
      // A cell closed before the switch is converted too: 100.25 from 10-01 on, closed when 90.5
      // from 11-01 cut it, is 100.3 at one decimal.
      const amountId = id(budgetT, "amount");
      const closed = await read(
        async (tx) =>
          (
            await tx.query<Any>(
              `SELECT valid_to::text AS vt, f_${amountId}::text AS v FROM "t_t2_v2__ver"
               WHERE field_id = $1 AND valid_from = '2026-10-01' AND rec_to IS NOT NULL ORDER BY rec_from`,
              [amountId],
            )
          ).rows,
      );
      expect(closed[0]).toEqual({ vt: null, v: "100.3" });

      // The source table: the constant's item, of the switch, kind schema_const.
      const consts = await read(
        async (tx) =>
          (
            await tx.query<Any>(
              "SELECT row_id, field_id, source_kind, schema_const_sv FROM base_sources WHERE source_kind = 'schema_const'",
            )
          ).rows,
      );
      expect(consts).toEqual([
        { row_id: h.entity, field_id: owner, source_kind: "schema_const", schema_const_sv: 2 },
      ]);
      // Counts as the new tables have them.
      const counts = await read(
        async (tx) =>
          (await tx.query<Any>("SELECT table_id, row_count::int AS n FROM counts ORDER BY 1")).rows,
      );
      expect(counts.filter((c: Any) => c.table_id === "t1" || c.table_id === "t2")).toEqual([
        { table_id: "t1", n: 1 },
        { table_id: "t2", n: 3 },
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a check the rebuilt table does not match stops apply with nothing written",
    async () => {
      await history();
      const { draft, slot } = await draft2();
      await start(slot);
      const wrong = { rows: 9, checksum: "0".repeat(64) };
      const e = await append([
        switched(slot, draft, { "tables/t1": wrong, "tables/t2": wrong }),
      ]).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApplyError);
      expect((e as ApplyError).message).toMatch(/table t1 rebuilt to 1 rows/);
      const sv = await read(
        async (tx) => (await tx.query<Any>("SELECT current_sv FROM slots")).rows[0].current_sv,
      );
      expect(Number(sv)).toBe(1);
    },
    T,
  );
  it(
    "two switches: the first's constant converted by the second, which tightens a field it converts, with a constant",
    async () => {
      const h = await history();
      // Version 2: a limit added, required, with a constant of two decimals.
      const LIMIT = {
        name: "limit",
        type: "decimal",
        required: true,
        description: "at most",
        scale: 2,
      };
      const B2 = {
        ...BUDGET,
        fields: [...BUDGET.fields, { ...LIMIT, backfill: { const: "12.34" } }],
      };
      const d2 = await draftFrom(1, [B2]);
      const t2v2 = d2.compiled.tables.find((t: Any) => t.id === "t2");
      const id = (t: Any, name: string) => t.fields.find((f: Any) => f.name === name).id;
      const [amount, note, limit] = ["amount", "note", "limit"].map((x) => id(t2v2, x));
      const row = (a: string, nt: string | null, l: string) => ({
        [amount]: a,
        [note]: nt,
        [limit]: l,
      });
      const stretches = [
        { from: "2026-10-01", to: "2026-11-01" },
        { from: "2026-11-01", to: "2026-11-15" },
        { from: "2026-11-15" },
      ];
      const dep = [{ event: h.b1.seq + 2, existence: 0 }];
      await migrate(d2, 1, `m_${"1".repeat(16)}`, ["t2"], {
        "tables/t2": check(
          [
            row("100.25", null, "12.34"),
            row("90.5", null, "12.34"),
            row("90.5", "tight", "12.34"),
          ].map((fields, i) => ({ id: h.entity, valid: stretches[i] as never, fields })),
        ),
        [`backfill/t2/${limit}/0`]: { entity: h.entity, valid: { from: "2026-10-01" }, deps: dep },
      });
      const v2 = await rows("budget");

      // Version 3: the limit and the amount to fewer decimals; the amount at least 95, filled with 95
      // where its value, rounded, is below it (from 11-01 on: 90.5 rounds to 91).
      const B3 = {
        ...BUDGET,
        fields: [
          { ...BUDGET.fields[0], scale: 0, min: 95, backfill: { const: "95" } },
          BUDGET.fields[1],
          { ...LIMIT, scale: 1 },
        ],
      };
      const d3 = await draftFrom(2, [B3]);
      expect(d3.compiled.tables.find((t: Any) => t.id === "t2").physical.table).toBe("t_t2_v3");
      await migrate(d3, 2, `m_${"2".repeat(16)}`, ["t2"], {
        "tables/t2": check(
          [row("100", null, "12.3"), row("95", null, "12.3"), row("95", "tight", "12.3")].map(
            (fields, i) => ({ id: h.entity, valid: stretches[i] as never, fields }),
          ),
        ),
        [`backfill/t2/${amount}/0`]: { entity: h.entity, valid: { from: "2026-11-01" }, deps: dep },
      });
      const v3 = await rows("budget");
      expect(v3.map((r: Any) => [r.valid_from, r.valid_to, r.values])).toEqual([
        ["2026-10-01", "2026-11-01", { amount: "100", note: null, limit: "12.3" }],
        ["2026-11-01", "2026-11-15", { amount: "95", note: null, limit: "12.3" }],
        ["2026-11-15", null, { amount: "95", note: "tight", limit: "12.3" }],
      ]);
      // Neither switch changes a ver.
      expect(v3.map((r: Any) => r.ver)).toEqual(v2.map((r: Any) => r.ver));
      // The constants: the limit's of version 2 (converted, still of that switch), the amount's of 3.
      const consts = await read(
        async (tx) =>
          (
            await tx.query<Any>(
              "SELECT field_id, schema_const_sv FROM base_sources WHERE source_kind = 'schema_const' ORDER BY 2",
            )
          ).rows,
      );
      expect(consts).toEqual([
        { field_id: limit, schema_const_sv: 2 },
        { field_id: amount, schema_const_sv: 3 },
      ]);
      // The amount's converted cell from 11-01 closed at the second switch, the constant's opened.
      const amountCells = await read(
        async (tx) =>
          (
            await tx.query<Any>(
              `SELECT valid_from::text AS vf, f_${amount}::text AS v, rec_to IS NULL AS open, intent
               FROM "t_t2_v3__ver" WHERE field_id = $1 ORDER BY rec_from, valid_from`,
              [amount],
            )
          ).rows,
      );
      expect(amountCells.filter((c: Any) => c.open)).toEqual([
        { vf: "2026-10-01", v: "100", open: true, intent: "update" },
        { vf: "2026-11-01", v: "95", open: true, intent: "schema_switch" },
      ]);
      expect(amountCells).toContainEqual({
        vf: "2026-11-01",
        v: "91",
        open: false,
        intent: "update",
      });
      // Closed before either switch (100.25 from 10-01 on, cut at 11-01): 100.25 → 100.25 → 100.
      expect(amountCells).toContainEqual({
        vf: "2026-10-01",
        v: "100",
        open: false,
        intent: "insert",
      });
      await replaysTheSame();
    },
    T,
  );
  it(
    "a dropped field that was a row's only value: the row still exists, every field empty (existence is not recomputed)",
    async () => {
      const r1 = await w({ table: "notes", intent: "insert", set: { b: "only-b" } });
      const r2 = await w({ table: "notes", intent: "insert", set: { a: "has-a", b: "and-b" } });
      const [id1, id2] = [r1.ops[0].target.row as string, r2.ops[0].target.row as string];
      const d = await draftFrom(1, [{ ...NOTES, fields: [TXT("a"), K(1)], drop_fields: ["b"] }]);
      const t = d.compiled.tables.find((x: Any) => x.name === "notes");
      const [a, k] = ["a", "k"].map((n) => t.fields.find((f: Any) => f.name === n).id);
      await migrate(d, 1, `m_${"3".repeat(16)}`, [t.id], {
        [`tables/${t.id}`]: check([
          { id: id1, fields: { [a]: null, [k]: null } },
          { id: id2, fields: { [a]: "has-a", [k]: null } },
        ]),
      });
      const got = (await rows("notes")).map((r: Any) => [r.row, r.values]);
      expect(Object.fromEntries(got)).toEqual({
        [id1]: { a: null, k: null },
        [id2]: { a: "has-a", k: null },
      });
      await replaysTheSame();
    },
    T,
  );

  it(
    "a dropped field that was a stretch's only value: the stretch still exists, every field empty",
    async () => {
      const b1 = await w({
        table: "plan",
        intent: "insert",
        valid_from: "2026-10-01",
        valid_to: "2026-11-01",
        set: { a: "a1" },
      });
      const e = b1.ops[0].target.entity as string;
      await w({
        table: "plan",
        intent: "update",
        entity: e,
        ver: b1.ops[0].ver,
        valid_from: "2026-10-15",
        valid_to: "2026-12-01",
        set: { b: "b1" },
      });
      const d = await draftFrom(1, [{ ...PLAN, fields: [TXT("a"), K(1)], drop_fields: ["b"] }]);
      const t = d.compiled.tables.find((x: Any) => x.name === "plan");
      const [a, k] = ["a", "k"].map((n) => t.fields.find((f: Any) => f.name === n).id);
      await migrate(d, 1, `m_${"4".repeat(16)}`, [t.id], {
        [`tables/${t.id}`]: check([
          {
            id: e,
            valid: { from: "2026-10-01", to: "2026-11-01" },
            fields: { [a]: "a1", [k]: null },
          },
          {
            id: e,
            valid: { from: "2026-11-01", to: "2026-12-01" },
            fields: { [a]: null, [k]: null },
          },
        ]),
      });
      const plan = await query(s.store, ctx(), {
        table: "plan",
        valid_during: ["2026-01-01", null],
      } as never).then((r: Any) => r.rows);
      expect(plan.map((r: Any) => [r.valid_from, r.valid_to, r.values])).toEqual([
        ["2026-10-01", "2026-11-01", { a: "a1", k: null }],
        ["2026-11-01", "2026-12-01", { a: null, k: null }],
      ]);
      await replaysTheSame();
    },
    T,
  );
  /** The plan's entity: a1 over [10-01, 11-01), b1 over [10-15, 12-01); then b dropped. */
  async function planWithoutB() {
    const b1 = await w({
      table: "plan",
      intent: "insert",
      valid_from: "2026-10-01",
      valid_to: "2026-11-01",
      set: { a: "a1" },
    });
    const e = b1.ops[0].target.entity as string;
    await w({
      table: "plan",
      intent: "update",
      entity: e,
      ver: b1.ops[0].ver,
      valid_from: "2026-10-15",
      valid_to: "2026-12-01",
      set: { b: "b1" },
    });
    const d = await draftFrom(1, [{ ...PLAN, fields: [TXT("a"), K(1)], drop_fields: ["b"] }]);
    const t = d.compiled.tables.find((x: Any) => x.name === "plan");
    const [a, k] = ["a", "k"].map((x) => t.fields.find((f: Any) => f.name === x).id);
    await migrate(d, 1, `m_${"5".repeat(16)}`, [t.id], {
      [`tables/${t.id}`]: check([
        {
          id: e,
          valid: { from: "2026-10-01", to: "2026-11-01" },
          fields: { [a]: "a1", [k]: null },
        },
        {
          id: e,
          valid: { from: "2026-11-01", to: "2026-12-01" },
          fields: { [a]: null, [k]: null },
        },
      ]),
    });
    return e;
  }
  const planRows = async () =>
    (
      await query(s.store, ctx(), { table: "plan", valid_during: ["2026-01-01", null] } as never)
    ).rows.map((r: Any) => [r.valid_from, r.valid_to, r.values.a]);
  const planVer = async () =>
    (
      (await query(s.store, ctx(), {
        table: "plan",
        valid_during: ["2026-01-01", null],
      } as never)) as Any
    ).rows[0].ver as string;

  it(
    "after a drop, a write elsewhere on the entity keeps the stretch whose only value was the dropped field",
    async () => {
      const e = await planWithoutB();
      const r = await w(
        {
          table: "plan",
          intent: "update",
          entity: e,
          ver: await planVer(),
          valid_from: "2026-10-01",
          valid_to: "2026-10-05",
          set: { a: "z" },
        },
        2,
      );
      expect(r.ops[0].fields.a[0].result).toBe("applied");
      expect(await planRows()).toEqual([
        ["2026-10-01", "2026-10-05", "z"],
        ["2026-10-05", "2026-11-01", "a1"],
        ["2026-11-01", "2026-12-01", null],
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "after a drop, a revocation inside that stretch leaves the rest of it; undoing it brings the whole back",
    async () => {
      const e = await planWithoutB();
      const rv = await w(
        {
          table: "plan",
          intent: "revoke",
          entity: e,
          ver: await planVer(),
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
        2,
      );
      expect(await planRows()).toEqual([
        ["2026-10-01", "2026-11-01", "a1"],
        ["2026-11-01", "2026-11-10", null],
        ["2026-11-20", "2026-12-01", null],
      ]);
      await w(
        {
          table: "plan",
          intent: "update",
          entity: e,
          ver: rv.ops[0].ver,
          revert: { undo: rv.seq },
        },
        2,
      );
      expect(await planRows()).toEqual([
        ["2026-10-01", "2026-11-01", "a1"],
        ["2026-11-01", "2026-12-01", null],
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "after a drop, revoking the row whose only value was the dropped field, then undoing it: the row is back",
    async () => {
      const r1 = await w({ table: "notes", intent: "insert", set: { b: "only-b" } });
      const id1 = r1.ops[0].target.row as string;
      const d = await draftFrom(1, [{ ...NOTES, fields: [TXT("a"), K(1)], drop_fields: ["b"] }]);
      const t = d.compiled.tables.find((x: Any) => x.name === "notes");
      const [a, k] = ["a", "k"].map((x) => t.fields.find((f: Any) => f.name === x).id);
      await migrate(d, 1, `m_${"6".repeat(16)}`, [t.id], {
        [`tables/${t.id}`]: check([{ id: id1, fields: { [a]: null, [k]: null } }]),
      });
      const ver = (await rows("notes"))[0].ver as string;
      const rv = await w({ table: "notes", intent: "revoke", row: id1, ver }, 2);
      expect(await rows("notes")).toEqual([]);
      await w(
        {
          table: "notes",
          intent: "update",
          row: id1,
          ver: rv.ops[0].ver,
          revert: { undo: rv.seq },
        },
        2,
      );
      expect((await rows("notes")).map((r: Any) => [r.row, r.values])).toEqual([
        [id1, { a: null, k: null }],
      ]);
      const count = await read(
        async (tx) =>
          (
            await tx.query<Any>("SELECT row_count::int AS n FROM counts WHERE table_id = $1", [
              t.id,
            ])
          ).rows[0].n,
      );
      expect(count).toBe(1);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a constant recorded on part of a converted cell (a stretch a deletion took away): the cell is cut there",
    async () => {
      const h = await history();
      // Version 2: the amount at least 95, with a constant. Its value from 11-01 on (90.5) breaks
      // it; the fill is recorded from 11-15 on only, as if the block for [11-01, 11-15) were gone.
      const B2 = {
        ...BUDGET,
        fields: [{ ...BUDGET.fields[0], min: 95, backfill: { const: "95" } }, BUDGET.fields[1]],
      };
      const d = await draftFrom(1, [B2]);
      const t2 = d.compiled.tables.find((x: Any) => x.id === "t2");
      const [amount, note] = ["amount", "note"].map(
        (x) => t2.fields.find((f: Any) => f.name === x).id,
      );
      await migrate(d, 1, `m_${"8".repeat(16)}`, ["t2"], {
        "tables/t2": check([
          {
            id: h.entity,
            valid: { from: "2026-10-01", to: "2026-11-01" },
            fields: { [amount]: "100.25", [note]: null },
          },
          {
            id: h.entity,
            valid: { from: "2026-11-01", to: "2026-11-15" },
            fields: { [amount]: "90.5", [note]: null },
          },
          {
            id: h.entity,
            valid: { from: "2026-11-15" },
            fields: { [amount]: "95", [note]: "tight" },
          },
        ]),
        [`backfill/t2/${amount}/0`]: {
          entity: h.entity,
          valid: { from: "2026-11-15" },
          deps: [{ event: h.b1.seq + 2, existence: 0 }],
        },
      });
      expect(
        (await rows("budget")).map((r: Any) => [r.valid_from, r.valid_to, r.values.amount]),
      ).toEqual([
        ["2026-10-01", "2026-11-01", "100.25"],
        ["2026-11-01", "2026-11-15", "90.5"],
        ["2026-11-15", null, "95"],
      ]);
      await replaysTheSame();
    },
    T,
  );
});
