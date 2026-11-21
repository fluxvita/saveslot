// The premises in a row's timeline, on PGlite (04-contract §10 `history` «timeline»; 04-contract-types
// §4.5 `TimelineEntry.premises`): a write that declared premises gives them, their state the one
// now; a restatement and a clearing are entries of their own; a page counts them; a target the
// reader cannot see gives its state and since only.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  loadRsql,
  readBufferOf,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import {
  COMPILED_V1,
  createSlotEvents,
  resolveInTx,
  SLOT,
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
/**
 * The slot: the base tables and a derived table over releases, so that an operation on releases
 * has derived writes (where `premise.changed` goes among them). Compiled once the SQL is loaded.
 */
let COMPILED: typeof BASE;
const withDerived = (): typeof BASE => {
  const d = derivedSchema(
    rule("SELECT name AS name, count(*) AS n FROM releases GROUP BY 1", ["name", "n"], "none", {
      tables: BASE.tables as never,
      derivedTables: ["release_names"],
      path: "tables/5/rule/sql",
    }),
  ).tables.find((t) => t.id === "t9");
  return {
    ...BASE,
    tables: [
      ...BASE.tables,
      { ...d, id: "t6", name: "release_names", physical: { table: "d_t6_v1" } },
    ] as never,
  };
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...["t1", "t2", "t3", "t4", "t5"].map((t) => ({ target: { table: t }, change: "add_table" })),
  { target: { table: "t6" }, change: "add_derived_table" },
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
const ctx = (visibility: unknown = { kind: "all" }) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: visibility as never,
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

/** A task resting on the release's `fields` (none: the whole row), at its current version. */
const restingOn = async (r: { target: { row: string }; ver: string }, fields?: string[]) =>
  ok({
    ops: [
      {
        intent: "insert",
        table: "tasks",
        set: { title: "freeze" },
        premises: [
          { table: "releases", row: r.target.row, ver: r.ver, ...(fields ? { fields } : {}) },
        ],
      },
    ],
  });

type Premise = Record<string, unknown>;
type Entry = { seq: number; intent: string; fields: Record<string, unknown>; premises?: Premise[] };
type Timeline = { total: number; entries: Entry[]; next_position?: string };
/** A task row's timeline, as `visibility` sees it. */
const timeline = async (
  row: string,
  more: Record<string, unknown> = {},
  visibility?: unknown,
): Promise<Timeline> =>
  (await history(s.store, ctx(visibility), {
    table: "tasks",
    row,
    mode: "timeline",
    ...more,
  })) as unknown as Timeline;
const update = async (r: { target: { row: string }; ver: string }, set: Record<string, unknown>) =>
  ok({ ops: [{ intent: "update", table: "releases", row: r.target.row, ver: r.ver, set }] });
/** Restates (`premises` given) or clears (`[]`) the premises of task row `row` at `ver`. */
const restate = async (row: string, ver: string, premises: unknown[]) =>
  ok({ ops: [{ intent: "update", table: "tasks", row, ver, premises }] });
const ACTOR = { kind: "user", id: USER, name: USER };
const TASKS_ONLY = { kind: "scoped", slots: [{ slot: SLOT, tables: [{ table: "t2" }] }] };
/** The entries of a row's timeline read `limit` at a time to the end, and each page's total. */
const paged = async (row: string, limit: number, visibility?: unknown) => {
  const entries: Entry[] = [];
  const totals: number[] = [];
  let position: string | undefined;
  do {
    const t = await timeline(row, { limit, ...(position ? { position } : {}) }, visibility);
    entries.push(...t.entries);
    totals.push(t.total);
    position = t.next_position;
  } while (position !== undefined);
  return { entries, totals };
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
/** A premise on release `r` (the whole row, or `fields`) at version `ver` (its own by default). */
const on = (r: { target: { row: string }; ver: string }, ver = r.ver, fields?: string[]) => ({
  table: "releases",
  row: r.target.row,
  ver,
  ...(fields ? { fields } : {}),
});
/** What a premise says of its target, as a timeline gives it. */
const declared = (r: { target: { row: string } }, ver: string, fields?: string[]) => ({
  target: { table: "ledger.releases", row: r.target.row },
  ...(fields ? { fields } : {}),
  ver,
});

describe("the premises of a row's timeline", () => {
  it(
    "a declaring write gives the premises it declared, their state the one now",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const row = task.ops[0]?.target.row as string;
      const declared = {
        target: { table: "ledger.releases", row: r.target.row },
        fields: ["date"],
        ver: r.ver,
      };
      let t = await timeline(row);
      expect(t.total).toBe(1);
      expect(t.entries[0]).toMatchObject({ seq: task.seq, intent: "insert", actor: ACTOR });
      expect(t.entries[0]?.premises).toEqual([{ ...declared, state: "current" }]);
      const w = await update(r, { date: "2026-11-20" });
      t = await timeline(row);
      expect(t.entries[0]?.premises).toEqual([
        { ...declared, state: "changed", reason: "update", since: w.seq },
      ]);
      await update({ target: r.target, ver: w.ops[0]?.ver as string }, { date: "2026-12-01" });
      expect((await timeline(row)).entries[0]?.premises).toEqual([
        { ...declared, state: "current" },
      ]);
    },
    T,
  );

  it(
    "a write without premises gives none; the whole row declared gives no fields",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const row = task.ops[0]?.target.row as string;
      const plain = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: task.ops[0]?.ver,
            set: { due: "2026-11-30" },
          },
        ],
      });
      const t = await timeline(row);
      expect(t.entries.map((e) => e.seq)).toEqual([plain.seq, task.seq]);
      expect(t.entries[0]).not.toHaveProperty("premises");
      expect(t.entries[1]?.premises).toEqual([
        { target: { table: "ledger.releases", row: r.target.row }, ver: r.ver, state: "current" },
      ]);
    },
    T,
  );

  it(
    "a restatement and a clearing: each an entry of its own, intent update, no field; a clearing's premises empty",
    async () => {
      const r = await release("v2", "2026-12-01");
      const other = await release("v3", "2027-01-01");
      const task = await restingOn(r, ["date"]);
      const row = task.ops[0]?.target.row as string;
      const again = await restate(row, task.ops[0]?.ver as string, [
        { table: "releases", row: other.target.row, ver: other.ver },
      ]);
      const cleared = await restate(row, again.ops[0]?.ver as string, []);
      const t = await timeline(row);
      expect(t.total).toBe(3);
      expect(t.entries).toEqual([
        {
          seq: cleared.seq,
          recorded_at: expect.any(String),
          actor: ACTOR,
          intent: "update",
          fields: {},
          premises: [],
        },
        {
          seq: again.seq,
          recorded_at: expect.any(String),
          actor: ACTOR,
          intent: "update",
          fields: {},
          premises: [
            {
              target: { table: "ledger.releases", row: other.target.row },
              ver: other.ver,
              state: "ended",
            },
          ],
        },
        expect.objectContaining({
          seq: task.seq,
          intent: "insert",
          premises: [
            {
              target: { table: "ledger.releases", row: r.target.row },
              fields: ["date"],
              ver: r.ver,
              state: "ended",
            },
          ],
        }),
      ]);
    },
    T,
  );

  it(
    "pages: a restatement and a clearing count and page with the writes, newest first",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const row = task.ops[0]?.target.row as string;
      const again = await restate(row, task.ops[0]?.ver as string, [
        { table: "releases", row: r.target.row, ver: r.ver },
      ]);
      const plain = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: again.ops[0]?.ver,
            set: { due: "2026-11-30" },
          },
        ],
      });
      const cleared = await restate(row, plain.ops[0]?.ver as string, []);
      const seen: number[] = [];
      let position: string | undefined;
      do {
        const t = await timeline(row, { limit: 1, ...(position ? { position } : {}) });
        expect(t.total).toBe(4);
        expect(t.entries).toHaveLength(1);
        seen.push(t.entries[0]?.seq as number);
        position = t.next_position;
      } while (position !== undefined);
      expect(seen).toEqual([cleared.seq, plain.seq, again.seq, task.seq]);
    },
    T,
  );

  it(
    "a target on a table the reader cannot see: state and since only; the table, row and fields appear nowhere",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const row = task.ops[0]?.target.row as string;
      let t = await timeline(row, {}, TASKS_ONLY);
      expect(t.entries[0]?.premises).toEqual([{ hidden: true, state: "current" }]);
      const w = await update(r, { date: "2026-11-20" });
      const again = await restate(row, task.ops[0]?.ver as string, [
        { table: "releases", row: r.target.row, ver: w.ops[0]?.ver, fields: ["date"] },
      ]);
      t = await timeline(row, {}, TASKS_ONLY);
      expect(t.entries.map((e) => e.premises)).toEqual([
        [{ hidden: true, state: "current" }],
        // The insert's declaration, superseded by the restatement on its target.
        [{ hidden: true, state: "ended" }],
      ]);
      expect(again.seq).toBe(t.entries[0]?.seq);
      const text = JSON.stringify(t);
      for (const secret of ["releases", r.target.row, '"date"', "t1", "f2"])
        expect(text).not.toContain(secret);
    },
    T,
  );
  it(
    "the premises in request order; a later op of a request declaring gives them on its own entry",
    async () => {
      const a = await release("v2", "2026-12-01");
      const b = await release("v3", "2027-01-01");
      const task = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "freeze" } }],
      });
      const row = task.ops[0]?.target.row as string;
      const both = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: a.target.row,
            ver: a.ver,
            set: { name: "v2.1" },
          },
          {
            intent: "update",
            table: "tasks",
            row,
            ver: task.ops[0]?.ver,
            set: { due: "2026-11-30" },
            premises: [
              { table: "releases", row: b.target.row, ver: b.ver },
              { table: "releases", row: a.target.row, ver: a.ver, fields: ["date"] },
            ],
          },
        ],
      });
      const t = await timeline(row);
      expect(t.total).toBe(2);
      expect(t.entries[0]?.seq).toBe(both.seq);
      expect(t.entries[0]?.premises?.map((p) => (p["target"] as { row: string }).row)).toEqual([
        b.target.row,
        a.target.row,
      ]);
      expect(t.entries[1]).not.toHaveProperty("premises");
    },
    T,
  );

  it(
    "a later page stays at the first page's operation: a restatement after it is not there",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const row = task.ops[0]?.target.row as string;
      const plain = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: task.ops[0]?.ver,
            set: { due: "2026-11-30" },
          },
        ],
      });
      const first = await timeline(row, { limit: 1 });
      expect(first.entries.map((e) => e.seq)).toEqual([plain.seq]);
      await restate(row, plain.ops[0]?.ver as string, [
        { table: "releases", row: r.target.row, ver: r.ver },
      ]);
      const second = await timeline(row, { limit: 1, position: first.next_position });
      expect(second.total).toBe(2);
      expect(second.entries.map((e) => e.seq)).toEqual([task.seq]);
      expect(second.next_position).toBeUndefined();
    },
    T,
  );
});

describe("several ops of one request on one row", () => {
  it(
    "each an entry of its own, by op index from the last; read a page of one or two at a time, none lost",
    async () => {
      const a = await release("v2", "2026-12-01");
      const b = await release("v3", "2027-01-01");
      const t0 = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "freeze" } }],
      });
      const row = t0.ops[0]?.target.row as string;
      const three = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: t0.ops[0]?.ver,
            set: { due: "2026-11-30" },
            premises: [on(a)],
          },
          { intent: "update", table: "tasks", row, premises: [on(b)] },
          { intent: "update", table: "tasks", row, premises: [] },
        ],
      });
      const all = await timeline(row, { limit: 200 });
      expect(all.total).toBe(4);
      // The clearing (op 2), the restatement (op 1), the write (op 0), then the insert; the
      // clearing ended the other two.
      expect(all.entries.map((e) => [e.seq, Object.keys(e.fields), e.premises])).toEqual([
        [three.seq, [], []],
        [three.seq, [], [{ ...declared(b, b.ver), state: "ended" }]],
        [three.seq, ["due"], [{ ...declared(a, a.ver), state: "ended" }]],
        [t0.seq, ["title"], undefined],
      ]);
      for (const limit of [1, 2]) {
        const p = await paged(row, limit);
        expect(p.entries).toEqual(all.entries);
        expect(new Set(p.totals)).toEqual(new Set([4]));
      }
      // Two writing ops and a restatement between them, in one request: three entries, by op index.
      const mixed = await ok({
        ops: [
          { intent: "update", table: "tasks", row, set: { title: "a" }, premises: [on(a)] },
          { intent: "update", table: "tasks", row, premises: [on(b)] },
          { intent: "update", table: "tasks", row, set: { due: "2026-12-01" } },
        ],
      });
      const m = await timeline(row, { limit: 200 });
      expect(
        m.entries.slice(0, 3).map((e) => [e.seq, Object.keys(e.fields), e.premises?.length]),
      ).toEqual([
        [mixed.seq, ["due"], undefined],
        [mixed.seq, [], 1],
        [mixed.seq, ["title"], 1],
      ]);
      expect((await paged(row, 1)).entries).toEqual(m.entries);
      // Two restatements in one request, no base write: both there, page by page too.
      const two = await ok({
        ops: [
          { intent: "update", table: "tasks", row, premises: [on(a)] },
          { intent: "update", table: "tasks", row, premises: [on(b)] },
        ],
      });
      const after = await timeline(row, { limit: 200 });
      expect(after.total).toBe(9);
      expect(after.entries.slice(0, 2).map((e) => [e.seq, e.premises])).toEqual([
        [two.seq, [{ ...declared(b, b.ver), state: "current" }]],
        [two.seq, [{ ...declared(a, a.ver), state: "current" }]],
      ]);
      expect((await paged(row, 1)).entries).toEqual(after.entries);
    },
    T,
  );
});

describe("a declaration no longer in force: ended", () => {
  it(
    "superseded on its target by a restatement: ended, no reason or since; the restatement's the one now",
    async () => {
      const a = await release("v2", "2026-12-01");
      const task = await restingOn(a, ["date"]);
      const row = task.ops[0]?.target.row as string;
      const again = await restate(row, task.ops[0]?.ver as string, [on(a, a.ver, ["date"])]);
      const w = await update(a, { date: "2026-11-20" });
      const t = await timeline(row);
      expect(t.entries.map((e) => [e.seq, e.premises])).toEqual([
        [
          again.seq,
          [{ ...declared(a, a.ver, ["date"]), state: "changed", reason: "update", since: w.seq }],
        ],
        [task.seq, [{ ...declared(a, a.ver, ["date"]), state: "ended" }]],
      ]);
      expect((await timeline(row, {}, TASKS_ONLY)).entries.map((e) => e.premises)).toEqual([
        [{ hidden: true, state: "changed", since: w.seq }],
        [{ hidden: true, state: "ended" }],
      ]);
    },
    T,
  );

  it(
    "cleared while current, the target changing after: ended; cleared while changed, the target changed back: ended",
    async () => {
      const a = await release("v2", "2026-12-01");
      const b = await release("v3", "2027-01-01");
      const one = await restingOn(a);
      await restate(one.ops[0]?.target.row as string, one.ops[0]?.ver as string, []);
      await update(a, { name: "x" });
      const two = await restingOn(b);
      const wb = await update(b, { name: "y" });
      await restate(two.ops[0]?.target.row as string, two.ops[0]?.ver as string, []);
      await update({ target: b.target, ver: wb.ops[0]?.ver as string }, { name: "v3" });
      for (const [row, r] of [
        [one.ops[0]?.target.row as string, a],
        [two.ops[0]?.target.row as string, b],
      ] as const)
        expect((await timeline(row)).entries.map((e) => e.premises)).toEqual([
          [],
          [{ ...declared(r, r.ver), state: "ended" }],
        ]);
    },
    T,
  );
});

describe("the premises as they are, pinned", () => {
  it(
    "targets seen and not seen in one entry, in request order; an entity as target",
    async () => {
      const a = await release("v2", "2026-12-01");
      const o = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "other" } }] });
      const bud = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 5 },
            valid_from: "2026-11-01",
          },
        ],
      });
      const entity = bud.ops[0]?.target.entity as string;
      const task = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "freeze" },
            premises: [
              on(a, a.ver, ["date"]),
              { table: "tasks", row: o.ops[0]?.target.row, ver: o.ops[0]?.ver, fields: ["title"] },
              { table: "budgets", entity, ver: bud.ops[0]?.ver, fields: ["amount"] },
            ],
          },
        ],
      });
      const row = task.ops[0]?.target.row as string;
      expect((await timeline(row)).entries[0]?.premises).toEqual([
        { ...declared(a, a.ver, ["date"]), state: "current" },
        {
          target: { table: "ledger.tasks", row: o.ops[0]?.target.row },
          fields: ["title"],
          ver: o.ops[0]?.ver,
          state: "current",
        },
        {
          target: { table: "ledger.budgets", entity },
          fields: ["amount"],
          ver: bud.ops[0]?.ver,
          state: "current",
        },
      ]);
      expect((await timeline(row, {}, TASKS_ONLY)).entries[0]?.premises).toEqual([
        { hidden: true, state: "current" },
        {
          target: { table: "ledger.tasks", row: o.ops[0]?.target.row },
          fields: ["title"],
          ver: o.ops[0]?.ver,
          state: "current",
        },
        { hidden: true, state: "current" },
      ]);
    },
    T,
  );

  it(
    "an entity's timeline: its declaring write, then its clearing",
    async () => {
      const a = await release("v2", "2026-12-01");
      const b = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 1 },
            valid_from: "2026-10-01",
            premises: [on(a)],
          },
        ],
      });
      const entity = b.ops[0]?.target.entity as string;
      const c = await ok({
        ops: [{ intent: "update", table: "budgets", entity, ver: b.ops[0]?.ver, premises: [] }],
      });
      const t = (await history(s.store, ctx(), {
        table: "budgets",
        entity,
        mode: "timeline",
      })) as unknown as Timeline;
      expect(t.entries.map((e) => [e.seq, e.premises])).toEqual([
        [c.seq, []],
        [b.seq, [{ ...declared(a, a.ver), state: "ended" }]],
      ]);
    },
    T,
  );

  it(
    "a candidate's premises on its entry; taken, the decision's entry carries none, nothing twice",
    async () => {
      const a = await release("v2", "2026-12-01");
      const t0 = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "freeze" } }],
      });
      const row = t0.ops[0]?.target.row as string;
      await ok({
        ops: [{ intent: "update", table: "tasks", row, ver: t0.ops[0]?.ver, set: { title: "x" } }],
      });
      const stale = (await send({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: t0.ops[0]?.ver,
            set: { title: "y" },
            premises: [on(a, a.ver, ["date"])],
          },
        ],
      })) as Receipt & { pending: { id: string; item_ver: string }[] };
      const w = await update(a, { date: "2026-11-20" });
      const taken = await resolve({
        id: stale.pending[0]?.id,
        decision: "take_candidate",
        item_ver: stale.pending[0]?.item_ver,
        idempotency_key: "take",
      });
      const t = await timeline(row);
      const withPremises = t.entries.filter((e) => e.premises !== undefined);
      expect(withPremises.map((e) => [e.seq, e.premises])).toEqual([
        [
          stale.seq,
          [{ ...declared(a, a.ver, ["date"]), state: "changed", reason: "update", since: w.seq }],
        ],
      ]);
      expect(t.entries[0]).not.toHaveProperty("premises");
      expect(taken).toBeDefined();
    },
    T,
  );

  it(
    "a declaring write undone: its entry keeps what it declared, the undo's carries none",
    async () => {
      const a = await release("v2", "2026-12-01");
      const t0 = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "freeze" } }],
      });
      const row = t0.ops[0]?.target.row as string;
      const d = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: t0.ops[0]?.ver,
            set: { due: "2026-11-30" },
            premises: [on(a)],
          },
        ],
      });
      const u = await ok({ ops: [{ table: "tasks", row, revert: { undo: d.seq } }] });
      const t = await timeline(row);
      expect(t.entries.map((e) => [e.seq, e.premises?.length])).toEqual([
        [u.seq, undefined],
        [d.seq, 1],
        [t0.seq, undefined],
      ]);
    },
    T,
  );

  it(
    "a declaring write whose one field is a no-op: an entry with no field and its premises",
    async () => {
      const a = await release("v2", "2026-12-01");
      const t0 = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "freeze" } }],
      });
      const row = t0.ops[0]?.target.row as string;
      const noop = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: t0.ops[0]?.ver,
            set: { title: "freeze" },
            premises: [on(a)],
          },
        ],
      });
      const t = await timeline(row);
      expect(t.entries.map((e) => [e.seq, Object.keys(e.fields), e.premises])).toEqual([
        [noop.seq, [], [{ ...declared(a, a.ver), state: "current" }]],
        [t0.seq, ["title"], undefined],
      ]);
    },
    T,
  );

  it(
    "sixteen premises in request order, one changed",
    async () => {
      const rs: { target: { row: string }; ver: string }[] = [];
      for (let i = 0; i < 16; i++) rs.push(await release(`n${i}`, "2026-12-01"));
      const order = [7, 3, 15, 0, 9, 1, 14, 2, 13, 4, 12, 5, 11, 6, 10, 8];
      const task = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "freeze" },
            premises: order.map((i) => on(rs[i] as (typeof rs)[number])),
          },
        ],
      });
      const w = await update(rs[9] as (typeof rs)[number], { date: "2026-11-01" });
      const got = (await timeline(task.ops[0]?.target.row as string)).entries[0]?.premises;
      expect(got?.map((p) => (p["target"] as { row: string }).row)).toEqual(
        order.map((i) => rs[i]?.target.row),
      );
      expect(got?.map((p) => p["state"])).toEqual(
        order.map((i) => (i === 9 ? "changed" : "current")),
      );
      expect(got?.[order.indexOf(9)]).toMatchObject({ reason: "update", since: w.seq });
    },
    T,
  );
});
