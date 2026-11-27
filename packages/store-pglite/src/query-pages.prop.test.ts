// `query`'s two paths, and its pages (04-contract §10 `query`, §13, §15; 03-data-model/05-time.md):
// rows written through `write` with values from small pools (so that conditions meet equal values,
// empty ones, other units, NFC forms, LIKE's own characters), then random queries.
//
// 1. A first page reads the business table and evaluates conditions in SQL; a later page reads the
//    version table as of the first page's operation and evaluates them in the process. For any
//    parameters, both give the same rows (values, intervals, marks, order).
// 2. Pages hold to the first page: with writes between pages (values changed, rows inserted,
//    revoked, a revoke undone), the pages put together are the whole result as the first page saw
//    it, no row repeated or dropped (marks aside: they are those at each read).
//
// A state table with no required field (`marks`) is written with clears too: a stretch whose only
// contribution is a clear has a value, every field empty (05-time «无值区间»), on both paths and on
// every page. Every run has one (the fixed examples).

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  query,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, queryInTx } from "@fluxvita/saveslot-kernel/testing";
import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

vi.setConfig({ testTimeout: 300_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 270_000, markInterruptAsFailure: true });

const RUNS = propRuns(25);
/** `PROP_SEED` fixes the seed. */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const seeded = SEED !== undefined ? { seed: SEED } : {};
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NOW = "2026-11-15T04:00:00.000Z";

const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "spend",
      kind: "base",
      description: "events by day",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "day" },
        { id: "f2", name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
        {
          id: "f3",
          name: "distance",
          type: "quantity",
          description: "how far",
          unit: { code: "km", dimension: "length", to_base: "1000" },
          precision: { scale: 2, rounding: "half_up" },
        },
        { id: "f4", name: "note", type: "text", description: "free text" },
        { id: "f5", name: "pieces", type: "integer", description: "how many" },
        {
          id: "f6",
          name: "rate",
          type: "decimal",
          description: "a rate",
          precision: { scale: 4, rounding: "half_even" },
        },
        { id: "f7", name: "paid", type: "boolean", description: "settled" },
        { id: "f8", name: "at", type: "zoned_datetime", description: "when" },
      ],
    },
    {
      id: "t2",
      name: "budgets",
      kind: "base",
      description: "by the day",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "category", type: "text", required: true, description: "kind" },
        { id: "f2", name: "amount", type: "integer", description: "how much" },
      ],
    },
    {
      id: "t4",
      name: "marks",
      kind: "base",
      description: "by the day, no field required",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t4_v1" },
      fields: [
        { id: "f1", name: "x", type: "text", description: "a mark" },
        { id: "f2", name: "y", type: "integer", description: "a count" },
      ],
    },
    {
      id: "t3",
      name: "notes",
      kind: "base",
      description: "timeless",
      time: { type: "none" },
      physical: { table: "t_t3_v1" },
      fields: [
        { id: "f1", name: "key", type: "text", required: true, description: "a key" },
        { id: "f2", name: "n", type: "integer", description: "a count" },
      ],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...COMPILED.tables.map((t) => ({ target: { table: t.id }, change: "add_table" })),
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

// --- pools -------------------------------------------------------------------------------------

const DAYS = ["2026-11-01", "2026-11-03", "2026-11-05", "2026-11-08", "2026-11-12", "2026-11-20"];
const NOTES = [null, "a", "b", "f%_\\x", "café", "café bar", "%"];
const DISTANCES = [
  null,
  { value: "1", unit: "km" },
  { value: "1200", unit: "m" },
  { value: "1.5", unit: "km" },
  { value: "500", unit: "m" },
];
const PIECES = [null, 0, 1, 2, "5"];
const RATES = [null, "0.5", "0.25", "0.50"];
const PAID = [null, true, false];
const ATS = [
  null,
  "2026-11-01T12:00:00+08:00",
  "2026-11-03T00:30:00+08:00",
  "2026-11-03T23:30:00Z",
];
const CATS = [null, "food", "rent"];
const AMOUNTS = [null, 100, 150, 50];
const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);

const spendRow = fc.record({
  date: pick(DAYS),
  category: pick(CATS),
  distance: pick(DISTANCES),
  note: pick(NOTES),
  pieces: pick(PIECES),
  rate: pick(RATES),
  paid: pick(PAID),
  at: pick(ATS),
});
const segment = fc.record({
  category: pick(["food", "rent", "fun"]),
  amount: pick(AMOUNTS),
  from: fc.nat({ max: DAYS.length - 2 }),
  len: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
});
/** A write on `marks`: values from small pools, or a clear of both fields over its interval. */
const markSegment = fc.record({
  x: pick([null, "p", "q"]),
  y: pick([null, 1, 2]),
  clear: fc.boolean(),
  from: fc.nat({ max: DAYS.length - 2 }),
  len: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
});
const KEYS = ["a", "b", "a_b", "%", "Café"];
const NS = [null, 0, 1, 7];
const noteRow = fc.record({ key: pick(KEYS), n: pick(NS) });
const data = fc.record({
  notes: fc.array(noteRow, { minLength: 2, maxLength: 6 }),
  rows: fc.array(spendRow, { minLength: 4, maxLength: 9 }),
  revoke: fc.array(fc.nat(), { maxLength: 2 }),
  entities: fc.array(fc.array(segment, { minLength: 1, maxLength: 3 }), {
    minLength: 1,
    maxLength: 3,
  }),
  marks: fc.array(fc.array(markSegment, { minLength: 1, maxLength: 3 }), {
    minLength: 1,
    maxLength: 2,
  }),
});

const some = <T>(xs: readonly (T | null)[]) => xs.filter((x): x is T => x !== null);
/** A condition on a spend field: an operator the type takes, a value from its pool (or, for
 *  `is_null`, whether empty). */
const spendCondition = fc.oneof(
  fc.record({
    field: fc.constant("category"),
    op: pick(["=", "!=", "in", "is_null"]),
    v: pick(some(CATS)),
  }),
  fc.record({
    field: fc.constant("distance"),
    op: pick(["=", "!=", "<", "<=", ">", ">=", "in", "is_null"]),
    v: pick(some(DISTANCES)),
  }),
  {
    weight: 3,
    arbitrary: fc.record({
      field: fc.constant("note"),
      op: fc.constant("contains"),
      v: pick(["a", "f", "%", "_", "\\", "fe\u0301", "é", "café"]),
    }),
  },
  fc.record({
    field: fc.constant("note"),
    op: pick(["contains", "=", "!=", "in", "is_null"]),
    v: pick([...some(NOTES), "fe\u0301", "_", "\\", "a"]),
  }),
  fc.record({
    field: fc.constant("pieces"),
    op: pick(["=", "!=", "<", "<=", ">", ">=", "in", "is_null"]),
    v: pick(some(PIECES)),
  }),
  fc.record({
    field: fc.constant("rate"),
    op: pick(["=", "<", "<=", ">=", "!=", "is_null"]),
    v: pick([...some(RATES), "0.375"]),
  }),
  fc.record({ field: fc.constant("paid"), op: pick(["=", "!=", "is_null"]), v: pick(some(PAID)) }),
  fc.record({
    field: fc.constant("date"),
    op: pick(["=", "<", "<=", ">", ">=", "in"]),
    v: pick(DAYS),
  }),
  fc.record({
    field: fc.constant("at"),
    op: pick(["<", "<=", ">=", "!=", "is_null"]),
    v: pick(some(ATS)),
  }),
);
const spendQuery = fc.record({
  where: fc.oneof(
    { weight: 3, arbitrary: fc.tuple(spendCondition) },
    { weight: 1, arbitrary: fc.constant([]) },
  ),
  order: fc.option(
    fc.record({
      field: pick(["note", "distance", "pieces", "at", "paid"]),
      dir: pick(["asc", "desc"]),
    }),
    { nil: undefined },
  ),
  during: fc.option(fc.record({ a: fc.nat({ max: DAYS.length - 1 }), open: fc.boolean() }), {
    nil: undefined,
  }),
  include_revoked: fc.boolean(),
  limit: fc.integer({ min: 1, max: 2 }),
});
const notesQuery = fc.record({
  where: fc.option(
    fc.oneof(
      fc.record({
        field: fc.constant("key"),
        op: pick(["=", "!=", "contains", "in"]),
        v: pick([...KEYS, "_", "é"]),
      }),
      fc.record({
        field: fc.constant("n"),
        op: pick(["=", "!=", "<", "<=", ">", ">=", "is_null"]),
        v: pick(some(NS)),
      }),
    ),
    { nil: undefined },
  ),
  order: fc.option(fc.record({ field: pick(["key", "n"]), dir: pick(["asc", "desc"]) }), {
    nil: undefined,
  }),
  include_revoked: fc.boolean(),
  limit: fc.integer({ min: 1, max: 2 }),
});
const budgetQuery = fc.record({
  kind: pick(["now", "valid_at", "during"]),
  a: fc.nat({ max: DAYS.length - 1 }),
  b: fc.option(fc.nat({ max: DAYS.length - 1 }), { nil: undefined }),
  fields: pick(["all", "category", "amount"]),
  order: fc.option(fc.record({ field: pick(["amount", "category"]), dir: pick(["asc", "desc"]) }), {
    nil: undefined,
  }),
  clip: fc.boolean(),
  coalesce: fc.boolean(),
  where: fc.option(
    fc.oneof(
      fc.record({
        field: fc.constant("amount"),
        op: pick(["=", "!=", "<", ">=", "is_null"]),
        v: pick(AMOUNTS),
      }),
      fc.record({ field: fc.constant("valid_to"), op: pick(["<", ">", "is_null"]), v: pick(DAYS) }),
      fc.record({ field: fc.constant("valid_from"), op: pick([">=", "<"]), v: pick(DAYS) }),
    ),
    { nil: undefined },
  ),
  limit: fc.integer({ min: 1, max: 2 }),
});

const marksQuery = fc.record({
  kind: pick(["now", "valid_at", "during"]),
  a: fc.nat({ max: DAYS.length - 1 }),
  b: fc.option(fc.nat({ max: DAYS.length - 1 }), { nil: undefined }),
  fields: pick(["all", "x", "y"]),
  clip: fc.boolean(),
  coalesce: fc.boolean(),
  where: fc.option(
    fc.oneof(
      fc.record({
        field: fc.constant("y"),
        op: pick(["=", "!=", ">=", "is_null"]),
        v: pick([1, 2]),
      }),
      fc.record({ field: fc.constant("x"), op: pick(["=", "!=", "is_null"]), v: pick(["p", "q"]) }),
    ),
    { nil: undefined },
  ),
  limit: fc.integer({ min: 1, max: 2 }),
});

function condition(c: {
  field: string;
  op: string;
  v: unknown;
}): Record<string, unknown> | undefined {
  if (c.op === "is_null") return { field: c.field, op: c.op, value: c.v === null };
  if (c.v === null) return undefined;
  if (c.op === "in") return { field: c.field, op: c.op, value: [c.v] };
  return { field: c.field, op: c.op, value: c.v };
}

// --- fixed examples: every run begins with them, so what must be covered always is ----------------

/** Rows over the pools: three live, one revoked (r2); two entities, one with equal categories. */
const EXAMPLE_DATA = {
  notes: [
    { key: "a", n: 1 },
    { key: "b", n: null },
    { key: "Café", n: 7 },
  ],
  rows: [
    {
      date: "2026-11-01",
      category: "food",
      distance: { value: "1", unit: "km" },
      note: "a",
      pieces: 1,
      rate: "0.5",
      paid: true,
      at: "2026-11-01T12:00:00+08:00",
    },
    {
      date: "2026-11-03",
      category: "rent",
      distance: { value: "1200", unit: "m" },
      note: "café",
      pieces: 2,
      rate: "0.25",
      paid: false,
      at: "2026-11-03T23:30:00Z",
    },
    {
      date: "2026-11-05",
      category: null,
      distance: null,
      note: null,
      pieces: 0,
      rate: null,
      paid: null,
      at: null,
    },
    {
      date: "2026-11-08",
      category: "food",
      distance: { value: "500", unit: "m" },
      note: "f%_\\x",
      pieces: "5",
      rate: "0.50",
      paid: true,
      at: "2026-11-03T00:30:00+08:00",
    },
  ],
  revoke: [2],
  entities: [
    [
      { category: "food", amount: 100, from: 0, len: undefined },
      { category: "food", amount: 150, from: 2, len: 2 },
    ],
    [{ category: "rent", amount: 50, from: 1, len: undefined }],
  ],
  // An entity with x over [11-01, 11-03), then both fields cleared over [11-05, 11-12): that
  // stretch's only contribution is the clear, so it has a value with every field empty (and comes
  // after the first, so that a page of one row reads it from the version table).
  marks: [
    [
      { x: "p", y: null, clear: false, from: 0, len: 1 },
      { x: null, y: null, clear: true, from: 2, len: 2 },
    ],
  ],
};
const c = (field: string, op: string, value: unknown) => ({ field, op, value });
/** Each operator at least twice with rows, and each kind of query the first property counts. */
const EXAMPLE_QUERIES: Record<string, unknown>[] = [
  { table: "spend", where: [c("category", "=", "food")], include_revoked: false },
  { table: "spend", where: [c("pieces", "=", 1)], include_revoked: false },
  { table: "spend", where: [c("category", "!=", "food")], include_revoked: false },
  { table: "notes", where: [c("n", "!=", 1)], include_revoked: false },
  { table: "spend", where: [c("pieces", "<", 2)], include_revoked: false },
  {
    table: "spend",
    where: [c("distance", "<", { value: "1", unit: "km" })],
    include_revoked: false,
  },
  { table: "spend", where: [c("pieces", "<=", 1)], include_revoked: false },
  { table: "spend", where: [c("rate", "<=", "0.25")], include_revoked: false },
  { table: "spend", where: [c("pieces", ">", 1)], include_revoked: false },
  { table: "spend", where: [c("date", ">", "2026-11-01")], include_revoked: false },
  { table: "spend", where: [c("pieces", ">=", 2)], include_revoked: false },
  { table: "spend", where: [c("date", ">=", "2026-11-03")], include_revoked: false },
  { table: "spend", where: [c("category", "in", ["rent"])], include_revoked: false },
  { table: "spend", where: [c("note", "in", ["a"])], include_revoked: false },
  { table: "spend", where: [c("note", "contains", "a")], include_revoked: false },
  { table: "spend", where: [c("note", "contains", "%")], include_revoked: false },
  { table: "spend", where: [c("note", "is_null", false)], include_revoked: false },
  { table: "notes", where: [c("n", "is_null", true)], include_revoked: false },
  { table: "spend", where: [], valid_during: ["2026-11-03", null], include_revoked: true },
  { table: "spend", where: [], valid_during: ["2026-11-01", "2026-11-05"], include_revoked: true },
  { table: "spend", where: [], include_revoked: true },
  { table: "budgets", valid_during: ["2026-11-03", "2026-11-12"], clip: true, coalesce: false },
  { table: "budgets", valid_during: ["2026-11-01", null], clip: false, coalesce: true },
  {
    table: "budgets",
    fields: ["category"],
    valid_during: ["2026-11-01", null],
    clip: true,
    coalesce: true,
  },
  {
    table: "budgets",
    fields: ["category"],
    valid_during: ["2026-11-01", null],
    clip: false,
    coalesce: true,
  },
  { table: "budgets", order: [{ field: "amount", dir: "desc" }] },
  { table: "budgets", order: [{ field: "category", dir: "asc" }] },
  { table: "notes", order: [{ field: "key", dir: "asc" }], include_revoked: false },
  { table: "marks", valid_during: ["2026-11-01", null], clip: false, coalesce: true },
  { table: "marks", valid_at: "2026-11-08" },
  { table: "marks", valid_during: ["2026-11-01", null], where: [c("y", "is_null", true)] },
];
/** Unconditioned pages of one row, with each kind of write between them; the undo undoes the update. */
const EXAMPLE_PAGES = [
  EXAMPLE_DATA,
  [{ table: "spend", where: [], include_revoked: false }, 1],
  [
    // Values row 0 does not have: an update that changes it, so there is a write to undo.
    { kind: "update", i: 0, row: EXAMPLE_DATA.rows[1] },
    { kind: "undo", i: 0, row: EXAMPLE_DATA.rows[0] },
    { kind: "correct", i: 1, row: EXAMPLE_DATA.rows[1] },
    { kind: "insert", i: 0, row: EXAMPLE_DATA.rows[3] },
    { kind: "revoke", i: 3, row: EXAMPLE_DATA.rows[3] },
  ],
  true,
];

/**
 * Budgets read a row a page, with an entity revoked whole and then written between pages: the
 * write falls where it has no value without its required category (validation_failed write), in
 * every run, not only when a seed draws it.
 */
const EXAMPLE_GAP = [
  EXAMPLE_DATA,
  [{ table: "budgets", valid_during: ["2026-11-01", null], clip: false, coalesce: true }, 1],
  [
    { kind: "revoke", i: 0, row: EXAMPLE_DATA.rows[0] },
    { kind: "update", i: 0, row: EXAMPLE_DATA.rows[0] },
  ],
  true,
];

/**
 * Marks read a row a page, no write between pages: the cleared stretch is one of the rows (the
 * second page on is read from the version table), in every run.
 */
const EXAMPLE_CLEARED = [
  EXAMPLE_DATA,
  [{ table: "marks", valid_during: ["2026-11-01", null], clip: false, coalesce: true }, 1],
  [],
  true,
];

/**
 * The state tables read at a point a row a page, entities written between pages: later pages read
 * pushed down at a point, in every run. `marks` with a second entity, so that the point has two.
 */
const EXAMPLE_BUDGETS_AT = [
  EXAMPLE_DATA,
  [{ table: "budgets", valid_at: "2026-11-05" }, 1],
  [
    { kind: "update", i: 0, row: EXAMPLE_DATA.rows[0] },
    { kind: "update", i: 1, row: EXAMPLE_DATA.rows[1] },
  ],
  true,
];
const EXAMPLE_MARKS_AT = [
  {
    ...EXAMPLE_DATA,
    marks: [...EXAMPLE_DATA.marks, [{ x: "q", y: null, clear: false, from: 0, len: undefined }]],
  },
  [{ table: "marks", valid_at: "2026-11-01" }, 1],
  [
    { kind: "update", i: 1, row: EXAMPLE_DATA.rows[0] },
    { kind: "update", i: 0, row: EXAMPLE_DATA.rows[1] },
  ],
  true,
];

let s: ReusableStore;
beforeAll(async () => {
  s = await openReusable("saveslot-query-pages-");
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 300_000);

let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 0,
    idempotency_key_window: 0,
    now: `2026-11-15T0${Math.floor(++minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const w = (params: Record<string, unknown>) => write(s.store, ctx(), { sv: 1, ...params });

type Data = {
  notes: { key: string; n: number | null }[];
  rows: Record<string, unknown>[];
  revoke: number[];
  entities: { category: string; amount: number | null; from: number; len?: number }[][];
  marks: {
    x: string | null;
    y: number | null;
    clear: boolean;
    from: number;
    len?: number;
  }[][];
};
/** A fresh store with the drawn rows and entities; the row and entity IDs. */
async function dataOf(
  d: Data,
): Promise<{ rows: string[]; entities: string[]; notes: string[]; marks: string[] }> {
  await s.reset();
  minute = 0;
  await createTenant(
    s.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 0,
      idempotency_window: 0,
      now: "2026-11-15T00:00:00.000Z",
      confirmation: null,
    }),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-15T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
  const rows: string[] = [];
  for (const r of d.rows) {
    const set = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null));
    rows.push(
      (await w({ ops: [{ intent: "insert", table: "spend", set }] })).ops[0]?.target.row as string,
    );
  }
  for (const i of d.revoke) {
    const row = rows[i % rows.length] as string;
    await w({ ops: [{ intent: "revoke", table: "spend", row }] }).catch(() => undefined);
  }
  const entities: string[] = [];
  for (const segs of d.entities) {
    let entity: string | undefined;
    for (const seg of segs) {
      const valid_from = DAYS[seg.from] as string;
      const to =
        seg.len === undefined ? undefined : DAYS[Math.min(seg.from + seg.len, DAYS.length - 1)];
      const set =
        seg.amount === null
          ? { category: seg.category }
          : { category: seg.category, amount: seg.amount };
      const op = {
        intent: entity === undefined ? "insert" : "update",
        table: "budgets",
        ...(entity === undefined ? {} : { entity }),
        set,
        valid_from,
        ...(to !== undefined && to > valid_from ? { valid_to: to } : {}),
      };
      const r = await w({ ops: [op] });
      entity ??= r.ops[0]?.target.entity as string;
    }
    entities.push(entity as string);
  }
  const marks: string[] = [];
  for (const segs of d.marks) {
    let entity: string | undefined;
    for (const seg of segs) {
      const valid_from = DAYS[seg.from] as string;
      const to =
        seg.len === undefined ? undefined : DAYS[Math.min(seg.from + seg.len, DAYS.length - 1)];
      // A clear sets both fields empty; otherwise the drawn values, an empty one left out (x
      // when both are, so that the write has something to set).
      const set = seg.clear
        ? { x: null, y: null }
        : seg.x === null && seg.y === null
          ? { x: "p" }
          : { ...(seg.x !== null ? { x: seg.x } : {}), ...(seg.y !== null ? { y: seg.y } : {}) };
      const op = {
        intent: entity === undefined ? "insert" : "update",
        table: "marks",
        ...(entity === undefined ? {} : { entity }),
        set,
        valid_from,
        ...(to !== undefined && to > valid_from ? { valid_to: to } : {}),
      };
      const r = await w({ ops: [op] });
      entity ??= r.ops[0]?.target.entity as string;
    }
    marks.push(entity as string);
  }
  const notes: string[] = [];
  for (const n of d.notes) {
    const set = n.n === null ? { key: n.key } : { key: n.key, n: n.n };
    notes.push(
      (await w({ ops: [{ intent: "insert", table: "notes", set }] })).ops[0]?.target.row as string,
    );
  }
  if (notes.length > 1) await w({ ops: [{ intent: "revoke", table: "notes", row: notes[0] }] });
  return { rows, entities, notes, marks };
}

const toParams = {
  notes(x: {
    where?: { field: string; op: string; v: unknown };
    order?: { field: string; dir: string };
    include_revoked: boolean;
  }): Record<string, unknown> | undefined {
    const where = x.where === undefined ? undefined : condition(x.where);
    if (x.where !== undefined && where === undefined) return undefined;
    return {
      table: "notes",
      ...(where !== undefined ? { where: [where] } : {}),
      ...(x.order !== undefined ? { order: [x.order] } : {}),
      include_revoked: x.include_revoked,
    };
  },
  spend(x: {
    where: { field: string; op: string; v: unknown }[];
    order?: { field: string; dir: string };
    during?: { a: number; open: boolean };
    include_revoked: boolean;
  }): Record<string, unknown> | undefined {
    const where = x.where.map(condition);
    if (where.some((c) => c === undefined)) return undefined;
    const a = x.during === undefined ? undefined : (DAYS[x.during.a] as string);
    const end =
      x.during === undefined ? null : (DAYS[Math.min(x.during.a + 2, DAYS.length - 1)] as string);
    const b = x.during?.open === true || end === null || end <= (a as string) ? null : end;
    return {
      table: "spend",
      where,
      ...(x.order !== undefined ? { order: [x.order] } : {}),
      ...(a !== undefined ? { valid_during: [a, b] } : {}),
      include_revoked: x.include_revoked,
    };
  },
  marks(x: {
    kind: string;
    a: number;
    b?: number;
    fields: string;
    clip: boolean;
    coalesce: boolean;
    where?: { field: string; op: string; v: unknown };
  }): Record<string, unknown> | undefined {
    const a = DAYS[x.a] as string;
    const b = x.b === undefined || x.b <= x.a ? null : (DAYS[x.b] as string);
    const where = x.where === undefined ? undefined : condition(x.where);
    if (x.where !== undefined && where === undefined) return undefined;
    return {
      table: "marks",
      ...(x.fields === "all" ? {} : { fields: [x.fields] }),
      ...(x.kind === "valid_at"
        ? { valid_at: a }
        : x.kind === "during"
          ? { valid_during: [a, b], clip: x.clip, coalesce: x.coalesce }
          : {}),
      ...(where !== undefined ? { where: [where] } : {}),
    };
  },
  budgets(x: {
    kind: string;
    a: number;
    b?: number;
    fields: string;
    order?: { field: string; dir: string };
    clip: boolean;
    coalesce: boolean;
    where?: { field: string; op: string; v: unknown };
  }): Record<string, unknown> | undefined {
    const a = DAYS[x.a] as string;
    const b = x.b === undefined || x.b <= x.a ? null : (DAYS[x.b] as string);
    const where = x.where === undefined ? undefined : condition(x.where);
    if (x.where !== undefined && where === undefined) return undefined;
    // valid_from / valid_to conditions only over an interval.
    if (x.where !== undefined && x.where.field !== "amount" && x.kind !== "during")
      return undefined;
    return {
      table: "budgets",
      ...(x.fields === "all" ? {} : { fields: [x.fields] }),
      ...(x.kind === "valid_at"
        ? { valid_at: a }
        : x.kind === "during"
          ? { valid_during: [a, b], clip: x.clip, coalesce: x.coalesce }
          : {}),
      ...(where !== undefined ? { where: [where] } : {}),
      ...(x.order !== undefined ? { order: [x.order] } : {}),
    };
  },
};

/** The rows of the business table's path and of the version table's path at the latest operation. */
async function bothPaths(params: Record<string, unknown>) {
  const run = (asOf: boolean) =>
    s.store.read(async (tx) => {
      const latest = Number(
        (await tx.query<{ op: unknown }>("SELECT max(op) AS op FROM events")).rows[0]?.op,
      );
      return (
        await queryInTx(tx, {
          actor: USER as never,
          task: null,
          now: NOW as never,
          visibility: { kind: "all" },
          params: { ...params, limit: 200 },
          read: "rd_0000000000000000" as never,
          ...(asOf ? { asOf: latest } : {}),
        })
      ).result;
    });
  return { first: await run(false), later: await run(true) };
}

/**
 * One query paged through with a small limit, each page both pushed down where it can be and as
 * the whole read (`full`): the results and the reads recorded, page by page. Later pages are
 * given the pushed-down path's position.
 */
async function pushedAndFull(params: Record<string, unknown>, limit: number) {
  const pages: { pushed: unknown; full: unknown }[] = [];
  let position: string | undefined;
  for (let i = 0; i < 100; i++) {
    const run = (full: boolean) =>
      s.store.read((tx) =>
        queryInTx(tx, {
          actor: USER as never,
          task: null,
          now: NOW as never,
          visibility: { kind: "all" },
          params: { ...params, limit, ...(position !== undefined ? { position } : {}) },
          read: "rd_0000000000000000" as never,
          ...(full ? { full: true } : {}),
        }),
      );
    const pushed = await run(false);
    const full = await run(true);
    pages.push({ pushed, full });
    position = pushed.result.next_position;
    if (position === undefined) break;
  }
  return pages;
}

/**
 * How a later page was read, from the statements it sent: pushed down (a business table read with
 * LIMIT) or whole (the version table read as of the first page's operation for every row).
 */
function pathOf(sent: readonly string[]): "pushed" | "whole" {
  const whole = sent.some(
    (x) => /FROM "t_[^"]*__ver"/.test(x) && x.includes("rec_from <= $1") && !x.includes("ANY("),
  );
  const pushed = sent.some(
    (x) => /FROM "t_[^"]*"/.test(x) && !x.includes("__ver") && x.includes(" LIMIT "),
  );
  if (whole === pushed) throw new Error(`no single path: ${JSON.stringify(sent)}`);
  return whole ? "whole" : "pushed";
}

/**
 * A later page both ways, pushed down where it can be and as the whole read: result and read, and
 * the path the first took, from the statements it sent.
 */
async function laterBothWays(params: Record<string, unknown>, limit: number, position: string) {
  const sent: string[] = [];
  const run = (full: boolean) =>
    s.store.read((tx) =>
      queryInTx(
        full
          ? tx
          : {
              query: (q, v) => {
                sent.push(q);
                return tx.query(q, v);
              },
            },
        {
          actor: USER as never,
          task: null,
          now: NOW as never,
          visibility: { kind: "all" },
          params: { ...params, limit, position },
          read: "rd_0000000000000000" as never,
          ...(full ? { full: true } : {}),
        },
      ),
    );
  const pushed = await run(false);
  return { pushed, full: await run(true), path: pathOf(sent) };
}

/** A row with every field empty: on `marks`, a stretch whose only contribution is a clear. */
const onlyEmpty = (r: { values?: Record<string, unknown> }) =>
  r.values !== undefined && Object.values(r.values).every((v) => v === null);

const queryOf = (params: Record<string, unknown>) =>
  query(
    s.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_window: 0,
      idempotency_key_window: 0,
      now: NOW,
      confirmation: null,
    }),
    params,
  );

describe("query's two paths and its pages", () => {
  it("a page read as of the latest operation gives the first page's rows, for any parameters", async () => {
    const reached: Record<string, number> = {};
    const reach = (k: string) => {
      reached[k] = (reached[k] ?? 0) + 1;
    };
    await fc.assert(
      fc.asyncProperty(
        data,
        fc.array(
          fc.oneof(
            spendQuery.map((x) => toParams.spend(x as never)),
            budgetQuery.map((x) => toParams.budgets(x as never)),
            notesQuery.map((x) => toParams.notes(x as never)),
            marksQuery.map((x) => toParams.marks(x as never)),
          ),
          { minLength: 8, maxLength: 12 },
        ),
        async (d, queries) => {
          await dataOf(d as never);
          for (const params of queries) {
            if (params === undefined) continue;
            const { first, later } = await bothPaths(params);
            expect({ params, rows: later.rows, total: later.total }).toEqual({
              params,
              rows: first.rows,
              total: first.total,
            });
            reach(`${params["table"]}: ${first.total > 0 ? "rows" : "none"}`);
            for (const c of (params["where"] as { op: string }[] | undefined) ?? [])
              reach(`op ${c.op}${first.total > 0 ? "" : " (none)"}`);
            if ((params["valid_during"] as unknown) !== undefined)
              reach(`${params["table"]} during`);
            if (params["clip"] === true) reach("clip");
            if (params["table"] === "budgets" && params["order"] !== undefined && first.total > 1)
              reach("budgets ordered");
            if (params["coalesce"] === true && params["fields"] !== undefined)
              reach("merged by fields read");
            if (params["include_revoked"] === true && first.rows.some((r) => r.marks?.revoked))
              reach("revoked rows");
            if (params["table"] === "marks" && first.rows.some(onlyEmpty))
              reach("marks: all empty");
          }
        },
      ),
      { numRuns: RUNS, ...seeded, examples: [[EXAMPLE_DATA, EXAMPLE_QUERIES] as never] },
    );
    if (process.env["JUDGE_STATS"]) console.log(JSON.stringify(reached));
    // The example reaches every case below; the floors catch a generator gone degenerate.
    for (const op of ["=", "!=", "<", "<=", ">", ">=", "in", "contains", "is_null"])
      expect({
        op,
        reached: (reached[`op ${op}`] ?? 0) >= 2,
      }).toEqual({ op, reached: true });
    for (const k of [
      "spend: rows",
      "budgets: rows",
      "spend during",
      "budgets during",
      "clip",
      "merged by fields read",
      "revoked rows",
      "budgets ordered",
      "notes: rows",
      "marks: rows",
      "marks: all empty",
    ])
      expect({ k, reached: (reached[k] ?? 0) >= 1 }).toEqual({ k, reached: true });
  });

  it("a first page pushed down to SQL is the whole read's, page by page", async () => {
    const reached: Record<string, number> = {};
    const reach = (k: string) => {
      reached[k] = (reached[k] ?? 0) + 1;
    };
    await fc.assert(
      fc.asyncProperty(
        data,
        fc.array(
          fc.tuple(
            fc.oneof(
              spendQuery.map((x) => toParams.spend(x as never)),
              budgetQuery.map((x) => toParams.budgets(x as never)),
              notesQuery.map((x) => toParams.notes(x as never)),
              marksQuery.map((x) => toParams.marks(x as never)),
            ),
            fc.constantFrom(1, 2, 3, 5),
          ),
          { minLength: 4, maxLength: 8 },
        ),
        async (d, queries) => {
          await dataOf(d as never);
          for (const [params, limit] of queries) {
            if (params === undefined) continue;
            const pages = await pushedAndFull(params, limit);
            pages.forEach((p, i) => {
              expect({ params, limit, page: i, ...(p.pushed as object) }).toEqual({
                params,
                limit,
                page: i,
                ...(p.full as object),
              });
            });
            const first = (pages[0] as { full: { result: { total: number } } }).full.result;
            const state = params["table"] === "budgets" || params["table"] === "marks";
            const during = params["valid_during"] !== undefined;
            // Pushed down: event tables; state tables at a point, and over an interval when no
            // order is asked for (segments streamed an entity at a time).
            const pushable =
              params["table"] === "spend" || (state && (!during || params["order"] === undefined));
            if (pushable && state && during) {
              reach("pushed: over an interval");
              if (first.total > limit) reach("pushed: over an interval, more pages");
              if (params["clip"] === true) reach("pushed: over an interval, clipped");
              if (params["coalesce"] === false) reach("pushed: over an interval, not merged");
            }
            if (pushable) {
              reach(`${params["table"]} pushed`);
              if (first.total > limit) reach("pushed: more pages");
              if (first.total === limit) reach("pushed: exactly one page");
              if (first.total === 0) reach("pushed: none");
              if (params["order"] !== undefined && first.total > 1) reach("pushed: ordered");
              if (params["include_revoked"] === true) reach("pushed: include_revoked");
            }
          }
        },
      ),
      {
        numRuns: RUNS,
        ...seeded,
        examples: [[EXAMPLE_DATA, EXAMPLE_QUERIES.map((q) => [q, 2])] as never],
      },
    );
    if (process.env["JUDGE_STATS"]) console.log(JSON.stringify(reached));
    for (const k of [
      "spend pushed",
      "budgets pushed",
      "marks pushed",
      "pushed: more pages",
      "pushed: none",
      "pushed: ordered",
      "pushed: include_revoked",
      "pushed: over an interval",
      "pushed: over an interval, more pages",
      "pushed: over an interval, clipped",
      "pushed: over an interval, not merged",
    ])
      expect({ k, reached: (reached[k] ?? 0) >= 1 }).toEqual({ k, reached: true });
  });

  it("pages put together are the whole result as the first page saw it, with writes between them", async () => {
    let paged = 0;
    let pagedEmpty = 0;
    /** Later pages read pushed down, by table (state tables over an interval apart). */
    const laterPushed: Record<string, number> = {};
    const done: Record<string, number> = {};
    const refusedWrites: Record<string, number> = {};
    await fc.assert(
      fc.asyncProperty(
        data,
        fc.oneof(
          spendQuery.map((x) => [toParams.spend(x as never), x.limit] as const),
          budgetQuery.map((x) => [toParams.budgets(x as never), x.limit] as const),
          notesQuery.map((x) => [toParams.notes(x as never), x.limit] as const),
          marksQuery.map((x) => [toParams.marks(x as never), x.limit] as const),
        ),
        fc.array(
          fc.record({
            kind: pick(["update", "insert", "revoke", "undo", "undo", "correct"]),
            i: fc.nat(),
            row: spendRow,
          }),
          { minLength: 2, maxLength: 5 },
        ),
        fc.boolean(),
        async (d, [drawnParams, drawn], writes, bare) => {
          if (drawnParams === undefined) return;
          // Half the samples without conditions, so that most have several pages.
          const params: Record<string, unknown> = { ...drawnParams };
          if (bare) delete params["where"];
          // Pages of one or two rows, so that most samples have several.
          const limit = Math.min(drawn, 2);
          const ids = await dataOf(d as never);
          const whole = await queryOf({ ...params, limit: 200 });
          const pages = [await queryOf({ ...params, limit })];
          const undoable = new Map<string, number>();
          while (pages.at(-1)?.next_position !== undefined) {
            // Writes between pages.
            for (const x of writes) {
              const table = params["table"] as string;
              const row = ids.rows[x.i % ids.rows.length] as string;
              const note = ids.notes[x.i % ids.notes.length] as string;
              const entity = (
                table === "marks"
                  ? ids.marks[x.i % ids.marks.length]
                  : ids.entities[x.i % ids.entities.length]
              ) as string;
              const target =
                table === "spend" ? { row } : table === "notes" ? { row: note } : { entity };
              const set = Object.fromEntries(Object.entries(x.row).filter(([, v]) => v !== null));
              const change =
                table === "spend"
                  ? { set: { note: x.row.note, pieces: x.row.pieces } }
                  : table === "notes"
                    ? { set: { n: x.i % 9 } }
                    : table === "marks"
                      ? // Half of them clears.
                        {
                          set: x.i % 2 === 0 ? { y: null } : { y: x.i % 9 },
                          valid_from: DAYS[x.i % DAYS.length],
                        }
                      : { set: { amount: 900 + (x.i % 9) }, valid_from: DAYS[x.i % DAYS.length] };
              const op =
                x.kind === "insert"
                  ? table === "notes"
                    ? { intent: "insert", table, set: { key: "new" } }
                    : { intent: "insert", table: "spend", set }
                  : x.kind === "update" || x.kind === "correct"
                    ? { intent: x.kind, table, ...target, ...change }
                    : x.kind === "revoke"
                      ? { intent: "revoke", table, ...target }
                      : undoable.has(JSON.stringify(target))
                        ? {
                            table,
                            ...target,
                            revert: { undo: undoable.get(JSON.stringify(target)) },
                          }
                        : undefined;
              if (op === undefined) continue;
              try {
                const r = await w({ ops: [op] });
                done[x.kind] = (done[x.kind] ?? 0) + 1;
                // The target's latest write, for an undo of it later.
                if (x.kind !== "insert" && x.kind !== "undo")
                  undoable.set(JSON.stringify(target), r.seq);
              } catch (e) {
                // A write the state refuses (a revoked row, an undo of another row's write): counted.
                const code = (e as { code?: string; detail?: { reason?: string } }).code;
                const reason = (e as { detail?: { reason?: string } }).detail?.reason;
                if (code === undefined) throw e;
                const k = `${x.kind}: ${code}${reason ? ` ${reason}` : ""}`;
                refusedWrites[k] = (refusedWrites[k] ?? 0) + 1;
              }
            }
            const position = pages.at(-1)?.next_position as string;
            // The later page pushed down is the whole read's: result and read recorded.
            const { path, ...later } = await laterBothWays(params, limit, position);
            expect({ params, page: pages.length, ...later.pushed }).toEqual({
              params,
              page: pages.length,
              ...later.full,
            });
            const table = params["table"] as string;
            const during = params["valid_during"] !== undefined;
            // Pushed down, by the statements sent: every later page but those of timeless tables
            // (`notes`) and of state tables over an interval with an order asked for (an event
            // table's interval is a condition like any other); never here a schema switch or a
            // deletion, nor more rows changed than the limit.
            const state = table === "budgets" || table === "marks";
            const pushable =
              table !== "notes" && !(state && during && params["order"] !== undefined);
            expect({ params, page: pages.length, path }).toEqual({
              params,
              page: pages.length,
              path: pushable ? "pushed" : "whole",
            });
            if (path === "pushed") {
              const k = table === "spend" || !during ? table : `${table} during`;
              laterPushed[k] = (laterPushed[k] ?? 0) + 1;
            }
            pages.push(await queryOf({ ...params, limit, position }));
          }
          if (pages.length > 1) paged++;
          if (pages.length > 1 && pages.slice(1).some((p) => p.rows.some(onlyEmpty))) pagedEmpty++;
          for (const p of pages) expect(p.total).toBe(whole.total);
          // Rows and values as the first page saw them; marks are those at each read (04-contract
          // §15): an item a write between pages settles is no longer marked on a later page.
          const unmarked = (rows: readonly { marks?: unknown }[]) =>
            rows.map(({ marks: _, ...r }) => r);
          expect(unmarked(pages.flatMap((p) => p.rows))).toEqual(unmarked(whole.rows));
        },
      ),
      {
        numRuns: RUNS,
        ...seeded,
        examples: [
          EXAMPLE_PAGES as never,
          EXAMPLE_GAP as never,
          EXAMPLE_CLEARED as never,
          EXAMPLE_BUDGETS_AT as never,
          EXAMPLE_MARKS_AT as never,
        ],
      },
    );
    // The example pages; the random samples mostly do (half have no condition).
    expect(paged).toBeGreaterThanOrEqual(1 + Math.floor(RUNS / 10));
    // A stretch only cleared, read on a later page (EXAMPLE_CLEARED).
    expect(pagedEmpty).toBeGreaterThanOrEqual(1);
    if (process.env["JUDGE_STATS"])
      console.log(JSON.stringify({ done, refusedWrites, laterPushed }));
    // Later pages pushed down, on each table and on a state table over an interval: each in
    // every run (EXAMPLE_PAGES, EXAMPLE_GAP, EXAMPLE_CLEARED, EXAMPLE_BUDGETS_AT, EXAMPLE_MARKS_AT).
    for (const k of ["spend", "budgets", "marks", "budgets during", "marks during"])
      expect({ k, reached: (laterPushed[k] ?? 0) >= 1 }).toEqual({ k, reached: true });
    // Each kind of write between pages took effect in some samples.
    // An undo needs an earlier write on the same target in the same sample: rarer.
    for (const k of ["update", "insert", "revoke", "undo", "correct"])
      expect({ k, done: (done[k] ?? 0) >= 1 }).toEqual({ k, done: true });
    // Refusals only of the kinds the state explains, each with its reason as the contract gives
    // it (04-contract-types §9).
    for (const k of Object.keys(refusedWrites))
      expect(k).toMatch(
        // revoked: a write to a revoked row; validation_failed write: a required field missing in
        // a state entity's gap; invalid_argument: an undo of a write no longer undoable.
        /: (revoked|validation_failed write|invalid_argument( [a-z_]+)?)$/,
      );
    // The gap refusal is in every run (EXAMPLE_GAP).
    expect(refusedWrites["update: validation_failed write"] ?? 0).toBeGreaterThanOrEqual(1);
  });
});
