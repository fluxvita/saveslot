// The marks of changed premises on the rows a query reads, on PGlite (03-data-model/02-integrity-and-
// records «写入的前提» «标记出现在哪一行»; 04-contract §7; 04-contract-types §3
// `Marks.premise_changed`): on which rows and segments they show, their shape, the fields read, the
// ten shown and the total, and a target the reader cannot see. The write path takes `premises`
// only behind kernel's test switch.

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
  acceptPremisesForTests,
  COMPILED_V1,
  createSlotEvents,
  failPremiseDetectionForTests,
  premiseFanInLimitForTests,
  queryInTx,
  resolveInTx,
  SLOT,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  acceptPremisesForTests(true);
}, T);
afterAll(async () => {
  acceptPremisesForTests(false);
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
afterEach(() => {
  premiseFanInLimitForTests(1000);
  failPremiseDetectionForTests(false);
});

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

type ReadRow = {
  row?: string;
  entity?: string;
  valid_from?: string;
  valid_to?: string | null;
  marks?: Record<string, unknown>;
};
/** A page of a query on `table`, as `visibility` sees it. */
const page = async (
  params: Record<string, unknown>,
  visibility: unknown = { kind: "all" },
): Promise<{ rows: ReadRow[]; next_position?: string }> =>
  (
    (await s.store.read((tx) =>
      queryInTx(tx, {
        actor: USER as never,
        task: null,
        now: now() as never,
        visibility: visibility as never,
        params: { limit: 200, ...params },
        read: "rd_0000000000000000" as never,
      }),
    )) as unknown as { result: { rows: ReadRow[]; next_position?: string } }
  ).result;
/** The rows of a query on `table`, as `visibility` sees them. */
const query = async (params: Record<string, unknown>, visibility?: unknown): Promise<ReadRow[]> =>
  (await page(params, visibility)).rows;
/** The marks of a task row. */
const marksOf = async (row: string, more: Record<string, unknown> = {}, visibility?: unknown) =>
  (await query({ table: "tasks", ...more }, visibility)).find((r) => r.row === row)?.marks;
const update = async (r: { target: { row: string }; ver: string }, set: Record<string, unknown>) =>
  ok({ ops: [{ intent: "update", table: "releases", row: r.target.row, ver: r.ver, set }] });
const ACTOR = { kind: "user", id: USER, name: USER };

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

describe("the mark on the row whose value rests on the premise", () => {
  it(
    "changed: the premise, its fields, the version seen, reason, since, the fields covered and the declaration; changed back: gone",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const row = task.ops[0]?.target.row as string;
      expect(await marksOf(row)).toBeUndefined();
      const w = await update(r, { date: "2026-11-20" });
      expect(await marksOf(row)).toEqual({
        premise_changed: [
          {
            premise: { table: "ledger.releases", row: r.target.row },
            premise_fields: ["date"],
            seen: r.ver,
            reason: "update",
            since: w.seq,
            fields: ["title"],
            declared: { seq: task.seq, actor: ACTOR },
          },
        ],
      });
      await update({ target: r.target, ver: w.ops[0]?.ver as string }, { date: "2026-12-01" });
      expect(await marksOf(row)).toBeUndefined();
    },
    T,
  );

  it(
    "only where the value read would change: fields asked for without a field covered, no mark",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const row = task.ops[0]?.target.row as string;
      await update(r, { name: "x" });
      expect(await marksOf(row, { fields: ["due"] })).toBeUndefined();
      expect((await marksOf(row, { fields: ["title"] }))?.["premise_changed"]).toHaveLength(1);
    },
    T,
  );

  it(
    "a value written over has its premise no more; undone, the earlier contribution and its premise are back",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const row = task.ops[0]?.target.row as string;
      await update(r, { name: "x" });
      // The title written again without premises: its premise was on the value written over.
      const over = await ok({
        ops: [
          { intent: "update", table: "tasks", row, ver: task.ops[0]?.ver, set: { title: "b" } },
        ],
      });
      expect(await marksOf(row)).toBeUndefined();
      // Undone: the title is the insert's value again, and the premise is on it.
      await ok({
        ops: [{ table: "tasks", row, ver: over.ops[0]?.ver, revert: { undo: over.seq } }],
      });
      expect((await marksOf(row))?.["premise_changed"]).toMatchObject([
        { premise: { row: r.target.row }, declared: { seq: task.seq } },
      ]);
    },
    T,
  );

  it(
    "ten shown, the latest since first, and the total",
    async () => {
      const rs = [];
      for (let i = 0; i < 11; i++) rs.push(await release(`v${i}`, "2026-12-01"));
      const task = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "t" },
            premises: rs.map((r) => ({ table: "releases", row: r.target.row, ver: r.ver })),
          },
        ],
      });
      const row = task.ops[0]?.target.row as string;
      const since: number[] = [];
      for (const r of rs) since.push((await update(r, { name: `${r.target.row}!` })).seq);
      const m = (await marksOf(row)) as {
        premise_changed: { since: number }[];
        premise_changed_total: number;
      };
      expect(m.premise_changed.map((x) => x.since)).toEqual(since.slice(1).reverse());
      expect(m.premise_changed_total).toBe(11);
    },
    T,
  );

  it(
    "a target on a table the reader cannot see: only what is of this row, hidden",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const row = task.ops[0]?.target.row as string;
      const w = await update(r, { date: "2026-11-20" });
      const tasksOnly = { kind: "scoped", slots: [{ slot: SLOT, tables: [{ table: "t2" }] }] };
      expect(await marksOf(row, {}, tasksOnly)).toEqual({
        premise_changed: [{ hidden: true, since: w.seq, fields: ["title"] }],
      });
    },
    T,
  );

  it(
    "on an entity: on the segments whose values rest on it, not on a later stretch another write gave",
    async () => {
      const r = await release("v2", "2026-12-01");
      const plan = await ok({
        ops: [
          {
            intent: "insert",
            table: "plans",
            set: { label: "x" },
            valid_from: "2026-10-01",
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      const entity = plan.ops[0]?.target.entity as string;
      await ok({
        ops: [
          {
            intent: "update",
            table: "plans",
            entity,
            ver: plan.ops[0]?.ver,
            set: { label: "y" },
            valid_from: "2026-11-15",
          },
        ],
      });
      const w = await update(r, { name: "x" });
      const rows = (
        await query({ table: "plans", valid_during: ["2026-10-01", "2027-01-01"] })
      ).filter((x) => x.entity === entity);
      expect(rows.map((x) => [x.valid_from, x.marks?.["premise_changed"] !== undefined])).toEqual([
        ["2026-10-01", true],
        ["2026-11-15", false],
      ]);
      expect(rows[0]?.marks?.["premise_changed"]).toMatchObject([
        { since: w.seq, fields: ["label"] },
      ]);
    },
    T,
  );

  it(
    "the interval's sources in base_sources are not where a value came from: the same rows and marks without them",
    async () => {
      // A state write given an interval and no `evidence_by_field`: its interval rests on all its
      // sources (`valid_sources`), so base_sources has a row of kind interval for each of its
      // items (02-architecture §8). Reading the rows and their premise marks must not take those
      // rows for where a value came from: dropping them leaves the read unchanged.
      const r = await release("v2", "2026-12-01");
      const plan = await ok({
        ops: [
          {
            intent: "insert",
            table: "plans",
            set: { label: "x" },
            valid_from: "2026-10-01",
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      const entity = plan.ops[0]?.target.entity as string;
      await ok({
        ops: [
          {
            intent: "update",
            table: "plans",
            entity,
            ver: plan.ops[0]?.ver,
            set: { label: "y" },
            valid_from: "2026-11-15",
          },
        ],
      });
      await update(r, { name: "x" });
      const read = async () =>
        (await query({ table: "plans", valid_during: ["2026-10-01", "2027-01-01"] })).filter(
          (x) => x.entity === entity,
        );
      const withRows = await read();
      expect(withRows[0]?.marks?.["premise_changed"]).toBeDefined();
      const dropped = await s.store.write((tx) =>
        tx.query("DELETE FROM base_sources WHERE source_kind = 'interval' RETURNING 1"),
      );
      expect(dropped.rows.length).toBeGreaterThan(0);
      expect(await read()).toEqual(withRows);
    },
    T,
  );

  it(
    "changed, then cleared: the clearing voids the declaration, the mark goes",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const row = task.ops[0]?.target.row as string;
      await update(r, { name: "x" });
      expect((await marksOf(row))?.["premise_changed"]).toHaveLength(1);
      await ok({
        ops: [{ intent: "update", table: "tasks", row, ver: task.ops[0]?.ver, premises: [] }],
      });
      expect(await marksOf(row)).toBeUndefined();
    },
    T,
  );

  it(
    "segments merged: the merged row carries the mark; clipped, only what is covered within the clip",
    async () => {
      const r = await release("v2", "2026-12-01");
      // A budget resting on the release from 10-01 (category and amount covered), its amount
      // written again from 11-15 without premises.
      const b = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 1 },
            valid_from: "2026-10-01",
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      const entity = b.ops[0]?.target.entity as string;
      await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity,
            ver: b.ops[0]?.ver,
            set: { amount: 2 },
            valid_from: "2026-11-15",
          },
        ],
      });
      await update(r, { name: "x" });
      // Reading the category alone, the two segments are one row.
      const merged = await query({
        table: "budgets",
        fields: ["category"],
        valid_during: ["2026-10-01", "2027-01-01"],
      });
      expect(merged).toHaveLength(1);
      expect(merged[0]?.marks?.["premise_changed"]).toMatchObject([
        { fields: ["category", "amount"] },
      ]);
      // Clipped to a stretch of the later segment: the amount is not covered there.
      const clipped = await query({
        table: "budgets",
        fields: ["category"],
        valid_during: ["2026-11-20", "2026-12-01"],
        clip: true,
      });
      expect(clipped[0]?.marks?.["premise_changed"]).toMatchObject([{ fields: ["category"] }]);
    },
    T,
  );

  it(
    "a later page: the values as of the first page's position, and the premises they rest on",
    async () => {
      const r = await release("v2", "2026-12-01");
      const a = await restingOn(r);
      // Another task (not the same request again, which would be a replay).
      await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "second" },
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      await update(r, { name: "x" });
      // The latest change first: the second task, then the first.
      const first = await page({ table: "tasks", limit: 1 });
      expect(first.rows).toHaveLength(1);
      expect(first.next_position).toBeDefined();
      // The first task's title written over after the first page: the next page reads it as of
      // the first page, its title the one that rests on the premise.
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: a.ops[0]?.target.row,
            ver: a.ops[0]?.ver,
            set: { title: "other" },
          },
        ],
      });
      const next = await page({
        table: "tasks",
        limit: 1,
        position: first.next_position,
      });
      expect(next.rows.map((x) => x.row)).toEqual([a.ops[0]?.target.row]);
      expect(next.rows[0]?.marks?.["premise_changed"]).toHaveLength(1);
    },
    T,
  );

  it(
    "a candidate taken: the value is carried from the candidate's write, and so is its premise",
    async () => {
      const r = await release("v2", "2026-12-01");
      const t = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "a" } }] });
      const row = t.ops[0]?.target.row as string;
      await ok({
        ops: [{ intent: "update", table: "tasks", row, ver: t.ops[0]?.ver, set: { title: "b" } }],
      });
      // From the first version, resting on the release: a candidate.
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
      const w = await update(r, { name: "x" });
      // Before the decision: the item open on the row, no premise under the value shown.
      expect((await marksOf(row))?.["premise_changed"]).toBeUndefined();
      await resolve({
        id: stale.pending[0]?.id,
        decision: "take_candidate",
        item_ver: stale.pending[0]?.item_ver,
        idempotency_key: "take",
      });
      expect((await marksOf(row))?.["premise_changed"]).toMatchObject([
        { premise: { row: r.target.row }, since: w.seq, declared: { seq: stale.seq } },
      ]);
    },
    T,
  );

  it(
    "a proposal confirmed: the value is carried from the write held for confirmation, and so is its premise",
    async () => {
      const r = await release("v2", "2026-12-01");
      const b = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 1 },
            valid_from: "2026-10-01",
          },
        ],
      });
      const entity = b.ops[0]?.target.entity as string;
      const split = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity,
            ver: b.ops[0]?.ver,
            set: { amount: 2 },
            valid_from: "2026-11-10",
          },
        ],
      });
      // Over the change point at 11-10, resting on the release: held for confirmation.
      const held = (await send({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity,
            ver: split.ops[0]?.ver,
            set: { amount: 3 },
            valid_from: "2026-11-01",
            valid_to: "open",
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      })) as Receipt & { status: string; pending: { id: string; item_ver: string }[] };
      expect(held.status).toBe("pending");
      await resolve({
        id: held.pending[0]?.id,
        decision: "confirm",
        item_ver: held.pending[0]?.item_ver,
        idempotency_key: "confirm",
      });
      const w = await update(r, { name: "x" });
      const rows = (
        await query({ table: "budgets", valid_during: ["2026-11-01", "2027-01-01"] })
      ).filter((x) => x.entity === entity);
      expect(rows.length).toBeGreaterThan(0);
      for (const x of rows)
        expect(x.marks?.["premise_changed"]).toMatchObject([
          { since: w.seq, declared: { seq: held.seq } },
        ]);
    },
    T,
  );

  it(
    "two marks of one since: the later declaration first",
    async () => {
      const a = await release("a", "2026-12-01");
      const b = await release("b", "2026-12-01");
      const task = await restingOn(a);
      const row = task.ops[0]?.target.row as string;
      const restated = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: task.ops[0]?.ver,
            premises: [{ table: "releases", row: b.target.row, ver: b.ver }],
          },
        ],
      });
      await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: a.target.row,
            ver: a.ver,
            set: { name: "x" },
          },
          {
            intent: "update",
            table: "releases",
            row: b.target.row,
            ver: b.ver,
            set: { name: "y" },
          },
        ],
      });
      const m = (await marksOf(row))?.["premise_changed"] as { declared: { seq: number } }[];
      expect(m.map((x) => x.declared.seq)).toEqual([restated.seq, task.seq]);
    },
    T,
  );

  it(
    "the statements a page costs do not grow with the rows that rest on premises",
    async () => {
      const r = await release("v2", "2026-12-01");
      const statements = async () => {
        let n = 0;
        await s.store.read((tx) =>
          queryInTx(
            {
              query: (sql: string, params?: readonly unknown[]) => {
                n++;
                return tx.query(sql, params as never);
              },
            } as never,
            {
              actor: USER as never,
              task: null,
              now: now() as never,
              visibility: { kind: "all" },
              params: { table: "tasks", limit: 200 },
              read: "rd_0000000000000000" as never,
            },
          ),
        );
        return n;
      };
      const declare = (i: number) =>
        ok({
          ops: [
            {
              intent: "insert",
              table: "tasks",
              set: { title: `t${i}` },
              premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
            },
          ],
        });
      await declare(0);
      const w = await update(r, { name: "x" });
      const one = await statements();
      for (let i = 1; i < 12; i++) await declare(i);
      await update({ target: r.target, ver: w.ops[0]?.ver as string }, { name: "y" });
      expect((await query({ table: "tasks" })).filter((x) => x.marks !== undefined)).toHaveLength(
        12,
      );
      expect(await statements()).toBe(one);
    },
    T,
  );
});
