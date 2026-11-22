// A receipt's `premise_affected` on PGlite (04-contract §5.1; 04-contract-types §5.1
// `PremiseAffected`): the dependent rows a write made a mark appear on and took one off, counted by
// row and reason, at most 20 listed; the same when the receipt is rebuilt for a replay later.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  issueConnection,
  loadRsql,
  readBufferOf,
  readTail,
  renameConnection,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import {
  COMPILED_V1,
  createSlotEvents,
  failPremiseDetectionForTests,
  premiseAffected,
  premiseFanInLimitForTests,
  resolveInTx,
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
/** Sends `params` through the pipeline at `at` (default: the next minute); the error, if refused. */
async function send(
  params: unknown,
  at?: string,
  as: string = USER,
): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: as as never,
        task: null,
        now: at ?? now(),
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
const ok = async (params: unknown, at?: string, as?: string): Promise<Receipt> => {
  const r = await send(params, at, as);
  expect(r["refused"]).toBeUndefined();
  return r;
};
const _tail = async () => (await s.store.read(readTail))?.seq ?? 0;
/** The blocks of an event, by path. */
const blocksOf = async (seq: number) =>
  Object.fromEntries(
    (
      await s.store.read((tx) =>
        tx.query<{ path: string; body: string | null }>(
          "SELECT path, body FROM content WHERE seq = $1 ORDER BY path",
          [seq],
        ),
      )
    ).rows.map((r) => [r.path, r.body === null ? null : JSON.parse(r.body)]),
  );
const _premiseBlocks = async (seq: number) =>
  Object.fromEntries(Object.entries(await blocksOf(seq)).filter(([p]) => /premise/.test(p)));
const decls = async () =>
  (
    await s.store.read((tx) =>
      tx.query(
        `SELECT op::int, op_index, decl_index, dep_row, target_row, fields, range_kind, valid,
                seen_op::int, state, reason, since::int
         FROM premise_decls ORDER BY op, op_index, decl_index`,
      ),
    )
  ).rows;

const release = async (name: string, date: string) =>
  (await ok({ ops: [{ intent: "insert", table: "releases", set: { name, date } }] })).ops[0] as {
    target: { row: string };
    ver: string;
  };

/** Changes a release from its version `r.ver`. */
const update = async (r: { target: { row: string }; ver: string }, set: Record<string, unknown>) =>
  ok({ ops: [{ intent: "update", table: "releases", row: r.target.row, ver: r.ver, set }] });
/** The `write.base` events of operation `op`, in order. */
const _basesOf = async (op: number) =>
  (
    await s.store.read((tx) =>
      tx.query<{ seq: unknown }>(
        "SELECT seq FROM events WHERE op = $1 AND type = 'write.base' ORDER BY seq",
        [op],
      ),
    )
  ).rows.map((x) => Number(x.seq));

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
afterEach(() => {
  premiseFanInLimitForTests(1000);
  failPremiseDetectionForTests(false);
});

/** The premise.changed of operation `op`: its blocks, by path; none if there is none. */
const _changedIn = async (op: number) => {
  const r = await s.store.read((tx) =>
    tx.query<{ seq: unknown }>(
      "SELECT seq FROM events WHERE op = $1 AND type = 'premise.changed'",
      [op],
    ),
  );
  expect(r.rows.length).toBeLessThanOrEqual(1);
  const seq = r.rows[0]?.seq;
  return seq === undefined ? undefined : blocksOf(Number(seq));
};
const stateOf = async (op: number) =>
  (await decls()).filter((d) => d["op"] === op).map((d) => [d["state"], d["reason"], d["since"]]);
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

/** Resolves an item through the pipeline, as a caller with `visibility` (default: every slot). */
const resolve = async (params: unknown, visibility: unknown = { kind: "all" }): Promise<Receipt> =>
  (await s.store.write((tx) =>
    resolveInTx(tx, {
      actor: USER as never,
      task: null,
      now: now(),
      windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
      visibility: visibility as never,
      params,
      newId,
      reads: readBufferOf(s.store),
    }),
  )) as never;

type Affected = {
  count: number;
  matched: number;
  by_reason: Record<string, number>;
  rows: { target: { row: string }; fields: string[]; declared: { seq: number } }[];
};
const affected = (r: unknown) => (r as { premise_affected?: Affected }).premise_affected;
const ACTOR = { kind: "user", id: USER, name: USER };

describe("premise_affected", () => {
  it(
    "a change of the premise: the row marked, by reason, listed; changed back: taken off",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const w = await update(r, { date: "2026-11-20" });
      expect(affected(w)).toEqual({
        count: 1,
        matched: 0,
        by_reason: { update: 1 },
        rows: [
          {
            target: { table: "ledger.tasks", row: task.ops[0]?.target.row },
            fields: ["title"],
            declared: { seq: task.seq, actor: ACTOR },
          },
        ],
      });
      const back = await update(
        { target: r.target, ver: w.ops[0]?.ver as string },
        {
          date: "2026-12-01",
        },
      );
      expect(affected(back)).toEqual({ count: 0, matched: 1, by_reason: {}, rows: [] });
      // A change no declaration rests on: none.
      expect(
        affected(
          await update({ target: r.target, ver: back.ops[0]?.ver as string }, { name: "x" }),
        ),
      ).toBeUndefined();
    },
    T,
  );

  it(
    "the value resting on it written over: the declaration is marked, the row shows nothing, none",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            set: { title: "other" },
          },
        ],
      });
      const w = await update(r, { name: "x" });
      expect(await stateOf(task.seq)).toEqual([["changed", "update", w.seq]]);
      expect(affected(w)).toBeUndefined();
    },
    T,
  );

  it(
    "a replay rebuilds it as it was, after the dependent row's premises were cleared and its value written over",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const params = {
        idempotency_key: "once",
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "x" },
          },
        ],
      };
      const first = await ok(params);
      expect(affected(first)?.count).toBe(1);
      // Then its premises cleared, and its value written over: as of the write, neither.
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            premises: [],
          },
        ],
      });
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            set: { title: "other" },
          },
        ],
      });
      // Derived values aside (a replay omits them, 04-contract §14): the same.
      const again = await ok(params);
      expect((again as { replayed?: true }).replayed).toBe(true);
      expect(affected(again)).toEqual(affected(first));
    },
    T,
  );

  it(
    "two targets of one request, revoked and changed: a row for each reason",
    async () => {
      const a = await release("a", "2026-12-01");
      const b = await release("b", "2026-12-01");
      await restingOn(a);
      await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "on b" },
            premises: [{ table: "releases", row: b.target.row, ver: b.ver }],
          },
        ],
      });
      const w = await ok({
        ops: [
          { intent: "revoke", table: "releases", row: a.target.row, ver: a.ver },
          {
            intent: "update",
            table: "releases",
            row: b.target.row,
            ver: b.ver,
            set: { name: "x" },
          },
        ],
      });
      expect(affected(w)).toMatchObject({
        count: 2,
        matched: 0,
        by_reason: { revoke: 1, update: 1 },
      });
      expect(affected(w)?.rows).toHaveLength(2);
    },
    T,
  );

  it(
    "twenty-one rows marked: all counted, twenty listed",
    async () => {
      const r = await release("v2", "2026-12-01");
      for (let i = 0; i < 21; i++)
        await ok({
          ops: [
            {
              intent: "insert",
              table: "tasks",
              set: { title: `t${i}` },
              premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
            },
          ],
        });
      const w = await update(r, { name: "x" });
      expect(affected(w)?.count).toBe(21);
      expect(affected(w)?.rows).toHaveLength(20);
    },
    T,
  );

  it(
    "a decision's write marks the row: its receipt has it",
    async () => {
      const r = await release("v2", "2026-12-01");
      const named = await update(r, { name: "x" });
      await restingOn({ target: r.target, ver: named.ops[0]?.ver as string });
      const stale = (await send({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "y" },
          },
        ],
      })) as Receipt & { pending: { id: string; item_ver: string }[] };
      const decided = (await resolve({
        id: stale.pending[0]?.id,
        decision: "take_candidate",
        item_ver: stale.pending[0]?.item_ver,
        idempotency_key: "take",
      })) as unknown as { write: unknown };
      expect(affected(decided.write)).toMatchObject({ count: 1, by_reason: { update: 1 } });
    },
    T,
  );

  it(
    "a decision by a credential whose range lists only the table decided on: the row it marked out of range is counted, not listed",
    async () => {
      const r = await release("v2", "2026-12-01");
      const named = await update(r, { name: "x" });
      await restingOn({ target: r.target, ver: named.ops[0]?.ver as string });
      const stale = (await send({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "y" },
          },
        ],
      })) as Receipt & { pending: { id: string; item_ver: string }[] };
      // "releases" in range, "tasks" (where the marked row is) not (04-contract «名字只在可见范围内解析»).
      const releasesOnly = {
        kind: "scoped",
        slots: [{ slot: COMPILED.slot, tables: [{ table: "t1" }] }],
      };
      const params = {
        id: stale.pending[0]?.id,
        decision: "take_candidate",
        item_ver: stale.pending[0]?.item_ver,
        idempotency_key: "take",
      };
      const first = (await resolve(params, releasesOnly)) as unknown as { write: unknown };
      // Again: the same request (its key), and the same decision under another key (the item's).
      const again = (await resolve(params, releasesOnly)) as unknown as { write: unknown };
      const same = (await resolve(
        { ...params, idempotency_key: "take-2" },
        releasesOnly,
      )) as unknown as {
        write: unknown;
      };
      const whole = (await resolve(params)) as unknown as { write: unknown };
      for (const [k, x] of [
        ["first", first],
        ["again", again],
        ["same", same],
      ] as const) {
        expect([k, affected(x.write)]).toEqual([
          k,
          expect.objectContaining({ count: 1, by_reason: { update: 1 }, rows: [] }),
        ]);
      }
      // The same decision read with every slot in range lists it: there was a row to leave out.
      expect(affected(whole.write)?.rows).toHaveLength(1);
    },
    T,
  );

  it(
    "taken off: a mark that showed before the operation; in one request the row written over and the premise changed back",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const w = await update(r, { name: "x" });
      const both = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            set: { title: "other" },
          },
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: w.ops[0]?.ver,
            set: { name: "v2" },
          },
        ],
      });
      expect(affected(both)).toEqual({ count: 0, matched: 1, by_reason: {}, rows: [] });
    },
    T,
  );

  it(
    "not taken off: a mark that did not show before (the value it rested on written over earlier)",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const w = await update(r, { name: "x" });
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            set: { title: "other" },
          },
        ],
      });
      const back = await update({ target: r.target, ver: w.ops[0]?.ver as string }, { name: "v2" });
      expect(await stateOf(task.seq)).toEqual([["current", null, null]]);
      expect(affected(back)).toBeUndefined();
    },
    T,
  );

  it(
    "a declaration in force by an item no more current, the current one cleared: marked, shows nothing",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "a", due: "2026-12-01" },
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      const row = task.ops[0]?.target.row as string;
      const retitled = await ok({
        ops: [
          { intent: "update", table: "tasks", row, ver: task.ops[0]?.ver, set: { title: "b" } },
        ],
      });
      // Clears what is in effect: the new title and the due date; the old title's edge stays.
      await ok({
        ops: [{ intent: "update", table: "tasks", row, ver: retitled.ops[0]?.ver, premises: [] }],
      });
      const w = await update(r, { name: "x" });
      expect(await stateOf(task.seq)).toEqual([["changed", "update", w.seq]]);
      expect(affected(w)).toBeUndefined();
    },
    T,
  );

  it(
    "one row resting on two targets changed in one request: one row, by reason one, two entries",
    async () => {
      const a = await release("a", "2026-12-01");
      const b = await release("b", "2026-12-01");
      await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "both" },
            premises: [
              { table: "releases", row: a.target.row, ver: a.ver },
              { table: "releases", row: b.target.row, ver: b.ver },
            ],
          },
        ],
      });
      const w = await ok({
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
      expect(affected(w)).toMatchObject({ count: 1, matched: 0, by_reason: { update: 1 } });
      expect(affected(w)?.rows).toHaveLength(2);
    },
    T,
  );

  it(
    "declared, then restated on the same target: the restatement is the one in force and listed",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const restated = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      const w = await update(r, { name: "x" });
      expect(affected(w)?.rows.map((x) => x.declared.seq)).toEqual([restated.seq]);
    },
    T,
  );

  it(
    "the declarer as named at the write: the replay after a rename gives the same name",
    async () => {
      const d = (await issueConnection(s.store, ctx(), { name: "Desk · Host", via: "token" })).id;
      const r = await release("v2", "2026-12-01");
      const task = await ok(
        {
          ops: [
            {
              intent: "insert",
              table: "tasks",
              set: { title: "by desk" },
              premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
            },
          ],
        },
        undefined,
        d,
      );
      const params = {
        idempotency_key: "named",
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "x" },
          },
        ],
      };
      const first = await ok(params);
      expect(affected(first)?.rows[0]?.declared).toEqual({
        seq: task.seq,
        actor: { kind: "connection", id: d, name: "Desk · Host" },
      });
      await renameConnection(s.store, ctx(), { id: d as never, name: "Laptop · Host" });
      expect(affected(await ok(params))).toEqual(affected(first));
    },
    T,
  );

  it(
    "a candidate taken earlier, its premise changing later: the row its value was carried to is marked",
    async () => {
      const r = await release("v2", "2026-12-01");
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
      const w = await update(r, { name: "x" });
      expect(affected(w)).toMatchObject({ count: 1, by_reason: { update: 1 } });
    },
    T,
  );
  it(
    "a corroboration left alone under the declaration, then reverted: the replay reads its revert as of the operation",
    async () => {
      const r = await release("v2", "2026-12-01");
      const t = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "a", due: "2026-12-01" } }],
      });
      const row = t.ops[0]?.target.row as string;
      const v0 = t.ops[0]?.ver as string;
      // The title corroborated, the due applied: one op, declaring.
      const b = await ok({
        evidence: [{ kind: "user_message", text: "the title is a, due on the 2nd" }],
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: v0,
            set: { title: "a", due: "2026-12-02" },
            evidence_by_field: { title: [0], due: [0] },
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      // A clearing at the version before it: the insert's title item, not the corroboration.
      await ok({ ops: [{ intent: "update", table: "tasks", row, ver: v0, premises: [] }] });
      await ok({
        ops: [
          { intent: "update", table: "tasks", row, ver: b.ops[0]?.ver, set: { due: "2026-12-03" } },
        ],
      });
      const params = {
        idempotency_key: "once",
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "x" },
          },
        ],
      };
      const first = await ok(params);
      expect(affected(first)).toMatchObject({
        count: 1,
        // The due written over since: the title, by the corroboration alone.
        rows: [{ target: { row }, fields: ["title"], declared: { seq: b.seq } }],
      });
      // The corroborating operation undone: its corroboration is registered as reverted after it.
      await ok({ ops: [{ table: "tasks", row, revert: { undo: b.seq } }] });
      const again = await ok(params);
      expect((again as { replayed?: true }).replayed).toBe(true);
      expect(affected(again)).toEqual(affected(first));
    },
    T,
  );

  it(
    "twenty entries, not twenty rows: a row marked by two declarations is listed twice; by_reason may sum past count",
    async () => {
      const a = await release("a", "2026-12-01");
      const b = await release("b", "2026-12-01");
      for (let i = 0; i < 11; i++)
        await ok({
          ops: [
            {
              intent: "insert",
              table: "tasks",
              set: { title: `t${i}` },
              premises: [
                { table: "releases", row: a.target.row, ver: a.ver },
                { table: "releases", row: b.target.row, ver: b.ver },
              ],
            },
          ],
        });
      const w = await ok({
        ops: [
          { intent: "revoke", table: "releases", row: a.target.row, ver: a.ver },
          {
            intent: "update",
            table: "releases",
            row: b.target.row,
            ver: b.ver,
            set: { name: "y" },
          },
        ],
      });
      const got = affected(w) as Affected;
      expect(got.count).toBe(11);
      expect(got.by_reason).toEqual({ revoke: 11, update: 11 });
      expect(got.rows).toHaveLength(20);
      expect(new Set(got.rows.map((x) => x.target.row)).size).toBe(10);
    },
    T,
  );

  it(
    "a dependent row's table the caller cannot see: counted, by reason, not listed; nothing of it told",
    async () => {
      const r = await release("v2", "2026-12-01");
      const dependent = (title: string) =>
        ok({
          ops: [
            {
              intent: "insert",
              table: "tasks",
              set: { title },
              premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
            },
          ],
        });
      const one = await dependent("one");
      const two = await dependent("two");
      const w = await ok({
        ops: [{ intent: "revoke", table: "releases", row: r.target.row, ver: r.ver }],
      });
      const hidden = await s.store.read((tx) =>
        premiseAffected(tx, w.seq as never, {
          tableOf: (id) => COMPILED.tables.find((t) => t.id === id) as never,
          slotName: "ledger",
          visible: (id) => id !== "t2",
        }),
      );
      expect(hidden).toMatchObject({ count: 2, matched: 0, by_reason: { revoke: 2 } });
      expect(hidden?.rows ?? []).toEqual([]);
      const text = JSON.stringify(hidden);
      for (const secret of [
        "tasks",
        "t2",
        one.ops[0]?.target.row as string,
        two.ops[0]?.target.row as string,
        "title",
        USER,
      ])
        expect(text).not.toContain(secret);
      // Visible, the same counts and both listed.
      expect(affected(w)).toMatchObject({ count: 2, by_reason: { revoke: 2 } });
      expect(affected(w)?.rows).toHaveLength(2);
    },
    T,
  );
});
