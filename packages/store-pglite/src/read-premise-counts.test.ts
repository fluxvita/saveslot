// The counts of rows resting on changed premises, on PGlite (04-contract §7: a derived row's
// `input_marks.premise_changed`, the base rows it reads whose value of a field its rule depends on
// rests on a changed premise; `sql`'s `marks_summary.premise_changed`, the rows the query read; 04-
// contract-types §3 `InputMarks`). The same reading as a row's marks; one per row.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  loadRsql,
  readBufferOf,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import {
  COMPILED_V1,
  createSlotEvents,
  queryInTx,
  resolveInTx,
  SLOT,
  sqlInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const BASE = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "releases",
      kind: "base",
      description: "releases",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "name", type: "text", required: true, description: "name" },
        { id: "f2", name: "date", type: "date", description: "release day" },
      ],
    },
    {
      id: "t2",
      name: "tasks",
      kind: "base",
      description: "tasks",
      time: { type: "none" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f3", name: "title", type: "text", required: true, description: "title" },
        { id: "f4", name: "due", type: "date", description: "due" },
      ],
    },
    {
      id: "t3",
      name: "budgets",
      kind: "base",
      description: "budgets over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t3_v1" },
      fields: [
        { id: "f5", name: "category", type: "text", required: true, description: "category" },
        { id: "f6", name: "amount", type: "integer", description: "amount" },
      ],
      entity_key: ["f5"],
    },
    {
      id: "t4",
      name: "plans",
      kind: "base",
      description: "plans over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t4_v1" },
      fields: [{ id: "f7", name: "label", type: "text", required: true, description: "label" }],
    },
    {
      id: "t5",
      name: "logs",
      kind: "base",
      description: "a log by day",
      time: { type: "event", field: "f8" },
      physical: { table: "t_t5_v1" },
      fields: [
        { id: "f8", name: "day", type: "date", required: true, description: "day" },
        { id: "f9", name: "text", type: "text", description: "text" },
      ],
    },
  ],
};
/** A derived table `id` named `name` of rule `sql` (its columns `fields`), at `path`. */
const derived = (
  id: string,
  name: string,
  sql: string,
  fields: string[],
  path: string,
  time: "none" | "bucketed" | "now" = "none",
) => ({
  ...(derivedSchema(
    rule(sql, fields, time, {
      tables: BASE.tables as never,
      derivedTables: [name],
      path,
    }),
  ).tables.find((t) => t.id === "t9") as object),
  id,
  name,
  physical: { table: `d_${id}_v1` },
});
/**
 * The slot: the base tables; tasks by title (depends on title), tasks by due (depends on due),
 * budgets summed over the time (a state table with no time condition: the segment
 * holding the evaluation point).
 */
let COMPILED: typeof BASE;
const withDerived = (): typeof BASE => ({
  ...BASE,
  tables: [
    ...BASE.tables,
    derived(
      "t6",
      "titles",
      "SELECT title AS title, count(*) AS n FROM tasks GROUP BY 1",
      ["title", "n"],
      "tables/5/rule/sql",
    ),
    derived(
      "t7",
      "dues",
      "SELECT due AS due, count(*) AS n FROM tasks GROUP BY 1",
      ["due", "n"],
      "tables/6/rule/sql",
      "bucketed",
    ),
    derived(
      "t8",
      "budget_total",
      "SELECT sum(amount) AS total FROM budgets",
      ["total"],
      "tables/7/rule/sql",
      "now",
    ),
  ] as never,
});
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...["t1", "t2", "t3", "t4", "t5"].map((t) => ({ target: { table: t }, change: "add_table" })),
  ...["t6", "t7", "t8"].map((t) => ({ target: { table: t }, change: "add_derived_table" })),
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

let s: ReusableStore;
let minute = 0;
let ids = 0;
const now = () => {
  minute++;
  return new Date(Date.UTC(2026, 10, 5, 1) + 60_000 * minute).toISOString();
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: now(),
    confirmation: null,
  });

type Receipt = {
  seq: number;
  ops: {
    target: { row?: string; entity?: string };
    ver: string;
    premises?: unknown[];
    premise_covered?: number;
  }[];
  warnings?: Record<string, unknown>[];
};

/** Sends `params` through the pipeline; the error, if refused. */
async function send(params: unknown): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params: { sv: 1, ...(params as object) },
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}
const ok = async (params: unknown): Promise<Receipt> => {
  const r = await send(params);
  expect(r["refused"]).toBeUndefined();
  return r;
};
const release = async (name: string, date: string) =>
  (await ok({ ops: [{ intent: "insert", table: "releases", set: { name, date } }] })).ops[0] as {
    target: { row: string };
    ver: string;
  };

beforeAll(async () => {
  await loadRsql();
  COMPILED = withDerived();
  s = await openReusable("saveslot-premises-detect-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
  await createTenant(s.store, ctx());
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

const update = async (r: { target: { row: string }; ver: string }, set: Record<string, unknown>) =>
  ok({ ops: [{ intent: "update", table: "releases", row: r.target.row, ver: r.ver, set }] });
const TASKS_ONLY = {
  kind: "scoped",
  slots: [{ slot: SLOT, tables: [{ table: "t2" }, { table: "t6" }] }],
};

type DerivedRow = { key: Record<string, unknown>; input_marks?: Record<string, unknown> };
/** The `premise_changed` of each row of derived table `table`, by its key's JCS. */
const counts = async (table: string, visibility: unknown = { kind: "all" }) => {
  const r = (await s.store.read((tx) =>
    queryInTx(tx, {
      actor: USER as never,
      task: null,
      now: now() as never,
      visibility: visibility as never,
      params: { table, limit: 200 },
      read: "rd_0000000000000000" as never,
    }),
  )) as unknown as { result: { rows: DerivedRow[] } };
  return Object.fromEntries(
    r.result.rows.map((x) => [JSON.stringify(x.key), x.input_marks?.["premise_changed"]]),
  );
};
/** `sql`'s `marks_summary.premise_changed`, as `visibility` sees it, at `at` (none: now). */
const summed = async (statement: string, visibility: unknown = { kind: "all" }, at?: string) => {
  const r = (await s.store.read((tx) =>
    sqlInTx(tx, {
      actor: USER as never,
      task: null,
      now: now() as never,
      visibility: visibility as never,
      params: { sql: statement, ...(at !== undefined ? { at } : {}) },
      read: "rd_0000000000000000" as never,
    }),
  )) as unknown as { result: { marks_summary: Record<string, unknown> } };
  return r.result.marks_summary["premise_changed"];
};
/** Resolves an item through the pipeline. */
const resolve = async (params: unknown): Promise<Receipt> =>
  (await s.store.write((tx) =>
    resolveInTx(tx, {
      actor: USER as never,
      task: null,
      now: now(),
      windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
      visibility: { kind: "all" },
      params,
      newId,
      reads: readBufferOf(s.store),
    }),
  )) as never;
/** A task titled `title` resting on releases `on` (the whole row), at their versions now. */
const task = async (title: string, ...on: { target: { row: string }; ver: string }[]) =>
  ok({
    ops: [
      {
        intent: "insert",
        table: "tasks",
        set: { title },
        ...(on.length > 0
          ? { premises: on.map((r) => ({ table: "releases", row: r.target.row, ver: r.ver })) }
          : {}),
      },
    ],
  });
const FREEZE = JSON.stringify({ title: "freeze" });
const SHIP = JSON.stringify({ title: "ship" });

describe("a derived row's input_marks.premise_changed", () => {
  it(
    "the base rows of its group resting on a changed premise; changed back: 0",
    async () => {
      const r = await release("v2", "2026-12-01");
      await task("freeze", r);
      await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "freeze" } }] });
      expect(await counts("titles")).toEqual({ [FREEZE]: 0 });
      const w = await update(r, { date: "2026-11-20" });
      expect(await counts("titles")).toEqual({ [FREEZE]: 1 });
      await update({ target: r.target, ver: w.ops[0]?.ver as string }, { date: "2026-12-01" });
      expect(await counts("titles")).toEqual({ [FREEZE]: 0 });
    },
    T,
  );

  it(
    "once per row, however many changed premises; two rows of a group: 2; each group its own",
    async () => {
      const a = await release("v2", "2026-12-01");
      const b = await release("v3", "2027-01-01");
      await task("freeze", a, b);
      await task("freeze", a);
      await task("ship", b);
      await update(a, { date: "2026-11-20" });
      await update(b, { date: "2026-12-20" });
      expect(await counts("titles")).toEqual({ [FREEZE]: 2, [SHIP]: 1 });
    },
    T,
  );

  it(
    "only on a field the rule depends on: a due written later, without premises, rests on none",
    async () => {
      const r = await release("v2", "2026-12-01");
      const t = await task("freeze", r);
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: t.ops[0]?.target.row,
            ver: t.ops[0]?.ver,
            set: { due: "2026-11-30" },
          },
        ],
      });
      await update(r, { date: "2026-11-20" });
      expect(await counts("titles")).toEqual({ [FREEZE]: 1 });
      expect(await counts("dues")).toEqual({ [JSON.stringify({ due: "2026-11-30" })]: 0 });
    },
    T,
  );

  it(
    "changed, then the declarations cleared: 0; restated on the version seen before the change: still 1",
    async () => {
      const r = await release("v2", "2026-12-01");
      const one = await task("freeze", r);
      const two = await task("ship", r);
      await update(r, { date: "2026-11-20" });
      expect(await counts("titles")).toEqual({ [FREEZE]: 1, [SHIP]: 1 });
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: one.ops[0]?.target.row,
            ver: one.ops[0]?.ver,
            premises: [],
          },
        ],
      });
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: two.ops[0]?.target.row,
            ver: two.ops[0]?.ver,
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      expect(await counts("titles")).toEqual({ [FREEZE]: 0, [SHIP]: 1 });
    },
    T,
  );

  it(
    "a state table read with no time condition: a premise counts when what it covers meets the segment holding the evaluation point",
    async () => {
      const r = await release("v2", "2026-12-01");
      const premises = [{ table: "releases", row: r.target.row, ver: r.ver }];
      const budget = (category: string) =>
        ok({
          ops: [
            {
              intent: "update",
              table: "budgets",
              entity_key: { category },
              set: { amount: 100 },
              valid_from: "2026-10-01",
              premises,
            },
          ],
        });
      const food = await budget("food");
      await budget("rent");
      // Food's stretch holding the evaluation point (the clock runs on 2026-11-05) written again,
      // resting on nothing: what the declaration covers there is before and after it.
      await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity: food.ops[0]?.target.entity,
            ver: food.ops[0]?.ver,
            set: { amount: 150 },
            valid_from: "2026-11-01",
            valid_to: "2026-11-20",
          },
        ],
      });
      await update(r, { date: "2026-11-20" });
      // Rent's amount on that day rests on the release, food's does not: 1, not 2.
      expect(await counts("budget_total")).toEqual({ "{}": 1 });
    },
    T,
  );

  it(
    "a premise on a table the reader cannot see counts as well",
    async () => {
      const r = await release("v2", "2026-12-01");
      await task("freeze", r);
      await update(r, { date: "2026-11-20" });
      expect(await counts("titles", TASKS_ONLY)).toEqual({ [FREEZE]: 1 });
    },
    T,
  );
});

describe("a derived row whose base table the caller cannot see", () => {
  it(
    "counts as now (only counts, no item): to be decided with the other three kinds",
    async () => {
      const r = await release("v2", "2026-12-01");
      await task("freeze", r);
      await update(r, { date: "2026-11-20" });
      const titlesOnly = { kind: "scoped", slots: [{ slot: SLOT, tables: [{ table: "t6" }] }] };
      const row = (
        (await s.store.read((tx) =>
          queryInTx(tx, {
            actor: USER as never,
            task: null,
            now: now() as never,
            visibility: titlesOnly as never,
            params: { table: "titles" },
            read: "rd_0000000000000000" as never,
          }),
        )) as unknown as { result: { rows: DerivedRow[] } }
      ).result.rows[0];
      expect(row?.input_marks).toEqual({
        disputed: 0,
        awaiting: 0,
        flagged: 0,
        premise_changed: 1,
        items: [],
      });
    },
    T,
  );
});

describe("sql's marks_summary.premise_changed", () => {
  it(
    "the rows read one by one: those resting on a changed premise, once each",
    async () => {
      const a = await release("v2", "2026-12-01");
      const b = await release("v3", "2027-01-01");
      await task("freeze", a, b);
      await task("ship");
      expect(await summed("SELECT title FROM tasks")).toBe(0);
      await update(a, { date: "2026-11-20" });
      await update(b, { date: "2026-12-20" });
      expect(await summed("SELECT title FROM tasks")).toBe(1);
      expect(await summed("SELECT title FROM tasks WHERE title = 'ship'")).toBe(0);
      // The same row twice in a join: once.
      expect(await summed("SELECT x.title FROM tasks x JOIN tasks y ON x.title = y.title")).toBe(1);
      // Its premise target hidden: still counted.
      expect(await summed("SELECT title FROM tasks", TASKS_ONLY)).toBe(1);
    },
    T,
  );

  it(
    "a table read whole: its rows resting on a changed premise, a taken candidate's and an undo's write-back's too",
    async () => {
      const r = await release("v2", "2026-12-01");
      // A taken candidate: the value comes to the row through what the decision's write carries.
      const t = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "a" } }] });
      const row = t.ops[0]?.target.row as string;
      await ok({
        ops: [{ intent: "update", table: "tasks", row, ver: t.ops[0]?.ver, set: { title: "b" } }],
      });
      const stale = (await send({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: t.ops[0]?.ver,
            set: { title: "c" },
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      })) as Receipt & { pending: { id: string; item_ver: string }[] };
      await resolve({
        id: stale.pending[0]?.id,
        decision: "take_candidate",
        item_ver: stale.pending[0]?.item_ver,
        idempotency_key: "take",
      });
      // An undo's write-back: the earlier contribution and its premise are back.
      const u = await task("u", r);
      const urow = u.ops[0]?.target.row as string;
      const over = await ok({
        ops: [
          { intent: "update", table: "tasks", row: urow, ver: u.ops[0]?.ver, set: { title: "v" } },
        ],
      });
      await ok({
        ops: [{ table: "tasks", row: urow, ver: over.ops[0]?.ver, revert: { undo: over.seq } }],
      });
      await update(r, { name: "x" });
      const WHOLE =
        "SELECT title FROM tasks t WHERE EXISTS (SELECT 1 FROM releases r WHERE r.name = 'x')";
      expect(await summed(WHOLE)).toBe(2);
      expect(await summed("SELECT title FROM tasks")).toBe(2);
    },
    T,
  );

  it(
    "only a derived table read: its base rows are not counted",
    async () => {
      const r = await release("v2", "2026-12-01");
      await task("freeze", r);
      await update(r, { date: "2026-11-20" });
      expect(await counts("titles")).toEqual({ [FREEZE]: 1 });
      expect(await summed("SELECT title, n FROM titles")).toBe(0);
    },
    T,
  );
  it(
    "a revoked row is not read, by row or whole: not counted",
    async () => {
      const r = await release("v2", "2026-12-01");
      const t = await task("freeze", r);
      await task("ship", r);
      await update(r, { date: "2026-11-20" });
      const WHOLE =
        "SELECT title FROM tasks t WHERE EXISTS (SELECT 1 FROM releases r WHERE r.name <> t.title)";
      expect(await summed(WHOLE)).toBe(2);
      await ok({
        ops: [{ intent: "revoke", table: "tasks", row: t.ops[0]?.target.row, ver: t.ops[0]?.ver }],
      });
      expect(await summed("SELECT title FROM tasks")).toBe(1);
      expect(await summed(WHOLE)).toBe(1);
      expect(await counts("titles")).toEqual({ [SHIP]: 1 });
    },
    T,
  );
  it(
    "a state table: by entity, a mark on any of its segments, whatever the segment read or the time asked",
    async () => {
      const r = await release("v2", "2026-12-01");
      const premises = [{ table: "releases", row: r.target.row, ver: r.ver }];
      const at: Record<string, { entity: string; ver: string }> = {};
      const stretch = async (
        category: string,
        amount: number,
        from: string,
        to?: string,
        on = false,
      ) => {
        const known = at[category];
        const w = await ok({
          ops: [
            {
              intent: "update",
              table: "budgets",
              ...(known ? { entity: known.entity, ver: known.ver } : { entity_key: { category } }),
              set: { category, amount },
              valid_from: from,
              ...(to !== undefined ? { valid_to: to } : {}),
              ...(on ? { premises } : {}),
            },
          ],
        });
        let ver = w.ops[0]?.ver as string;
        // A stretch over the past that changes a value is proposed: confirmed at once.
        const p = (w as { pending?: { id: string; item_ver: string }[] }).pending?.[0];
        if ((w as { status?: string }).status === "pending" && p !== undefined) {
          const d = await resolve({
            id: p.id,
            decision: "confirm",
            item_ver: p.item_ver,
            idempotency_key: `confirm-${p.id}`,
          });
          ver = (d as unknown as { write: Receipt }).write.ops[0]?.ver as string;
        }
        at[category] = { entity: w.ops[0]?.target.entity as string, ver };
      };
      // The stretch resting on the release: food's holds the evaluation day (2026-11-05), rent's
      // comes after it, gas's before it.
      await stretch("food", 1, "2026-10-01", "2026-11-20", true);
      await stretch("food", 2, "2026-11-20");
      await stretch("rent", 5, "2026-10-01", "2026-12-01");
      await stretch("rent", 6, "2026-12-01", undefined, true);
      await stretch("gas", 7, "2026-01-01", "2026-02-01", true);
      await stretch("gas", 8, "2026-02-01");
      await update(r, { date: "2026-11-20" });
      // Read at the evaluation day: food's segment alone is marked.
      expect(await counts("budget_total")).toEqual({ "{}": 1 });
      // sql: each entity once, whatever segment it read, at any time.
      expect(await summed("SELECT amount FROM budgets")).toBe(3);
      expect(await summed("SELECT amount FROM budgets", undefined, "2026-12-10T00:00:00Z")).toBe(3);
      expect(await summed("SELECT amount FROM budgets WHERE category = 'gas'")).toBe(1);
    },
    T,
  );

  it(
    "the declarations cleared after the change: not counted",
    async () => {
      const r = await release("v2", "2026-12-01");
      const t = await task("freeze", r);
      await update(r, { date: "2026-11-20" });
      expect(await summed("SELECT title FROM tasks")).toBe(1);
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: t.ops[0]?.target.row,
            ver: t.ops[0]?.ver,
            premises: [],
          },
        ],
      });
      expect(await summed("SELECT title FROM tasks")).toBe(0);
      const WHOLE =
        "SELECT title FROM tasks t WHERE EXISTS (SELECT 1 FROM releases r WHERE r.name <> t.title)";
      expect(await summed(WHOLE)).toBe(0);
    },
    T,
  );
});
