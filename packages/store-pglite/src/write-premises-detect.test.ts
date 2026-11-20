// The detection of premises through the write pipeline on PGlite (03-data-model/02-integrity-and-
// records «写入的前提» «检测»; 09-event-format §5.10 `premise.changed`): which declarations an
// operation marks and takes back, with what reason and since, where the event goes in the
// operation, that nothing of the operation stays when it fails, and that the log the pipeline
// wrote gives the same premise tables replayed into an empty store. The write path takes
// `premises` only behind kernel's test switch.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  loadRsql,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import {
  acceptPremisesForTests,
  COMPILED_V1,
  createSlotEvents,
  failPremiseDetectionForTests,
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
async function send(params: unknown, at?: string): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
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
const ok = async (params: unknown, at?: string): Promise<Receipt> => {
  const r = await send(params, at);
  expect(r["refused"]).toBeUndefined();
  return r;
};
const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
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
const premiseBlocks = async (seq: number) =>
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
const basesOf = async (op: number) =>
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

/** The premise.changed of operation `op`: its blocks, by path; none if there is none. */
const changedIn = async (op: number) => {
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

describe("marking and taking back", () => {
  it(
    "the declared field changed: marked in that operation, reason update; changed back: taken back",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const v2 = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { date: "2026-11-20" },
          },
        ],
      });
      expect(await changedIn(v2.seq)).toEqual({
        "targets/0": {
          table: "t1",
          row: r.target.row,
          by_event: v2.seq + 2,
          changed: [{ op: task.seq, i: 0, j: 0, reason: "update" }],
        },
      });
      expect(await stateOf(task.seq)).toEqual([["changed", "update", v2.seq]]);
      const back = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: v2.ops[0]?.ver,
            set: { date: "2026-12-01" },
          },
        ],
      });
      expect(await changedIn(back.seq)).toEqual({
        "targets/0": {
          table: "t1",
          row: r.target.row,
          by_event: back.seq + 2,
          matched: [{ op: task.seq, i: 0, j: 0 }],
        },
      });
      expect(await stateOf(task.seq)).toEqual([["current", null, null]]);
    },
    T,
  );

  it(
    "a field not declared changed: nothing; the whole row declared: marked",
    async () => {
      const r = await release("v2", "2026-12-01");
      const onDate = await restingOn(r, ["date"]);
      const whole = await restingOn(r);
      const v2 = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "v2.1" },
          },
        ],
      });
      expect((await changedIn(v2.seq))?.["targets/0"]).toMatchObject({
        changed: [{ op: whole.seq, i: 0, j: 0, reason: "update" }],
      });
      expect(await stateOf(onDate.seq)).toEqual([["current", null, null]]);
    },
    T,
  );

  it(
    "the target revoked: revoke; the revoke undone: taken back",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const gone = await ok({
        ops: [{ intent: "revoke", table: "releases", row: r.target.row, ver: r.ver }],
      });
      expect(await stateOf(task.seq)).toEqual([["changed", "revoke", gone.seq]]);
      const undone = await ok({
        ops: [{ table: "releases", row: r.target.row, revert: { undo: gone.seq } }],
      });
      expect((await changedIn(undone.seq))?.["targets/0"]).toMatchObject({
        matched: [{ op: task.seq, i: 0, j: 0 }],
      });
      expect(await stateOf(task.seq)).toEqual([["current", null, null]]);
    },
    T,
  );

  it(
    "not passed on: A changed marks B resting on A, not C resting on B",
    async () => {
      const a = await release("v2", "2026-12-01");
      const b = await restingOn(a, ["date"]);
      const c = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "notes" },
            premises: [{ table: "tasks", row: b.ops[0]?.target.row, ver: b.ops[0]?.ver }],
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
            set: { date: "2026-11-20" },
          },
        ],
      });
      expect((await stateOf(b.seq))[0]?.[0]).toBe("changed");
      expect(await stateOf(c.seq)).toEqual([["current", null, null]]);
    },
    T,
  );
});

describe("from now on, on a date table", () => {
  it(
    "from the slot's day: late in the UTC day, east of UTC, yesterday's stretch is not in the range",
    async () => {
      const b = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 5000 },
            valid_from: "2026-10-01",
          },
        ],
      });
      const entity = b.ops[0]?.target.entity as string;
      // 18:02 UTC on 11-05 is 02:02 on 11-06 in the slot's zone (Asia/Shanghai): today is 11-06.
      const task = await ok(
        {
          ops: [
            {
              intent: "insert",
              table: "tasks",
              set: { title: "t" },
              premises: [{ table: "budgets", entity, ver: b.ops[0]?.ver }],
            },
          ],
        },
        "2026-11-05T18:02:00.000Z",
      );
      expect((await decls()).find((d) => d["op"] === task.seq)).toMatchObject({
        range_kind: "from_now",
      });
      // 11-05, the slot's yesterday: before the range.
      const w = await ok(
        {
          ops: [
            {
              intent: "update",
              table: "budgets",
              entity,
              ver: b.ops[0]?.ver,
              set: { amount: 1 },
              valid_from: "2026-11-05",
              valid_to: "2026-11-06",
            },
          ],
        },
        "2026-11-05T18:03:00.000Z",
      );
      expect(await changedIn(w.seq)).toBeUndefined();
      expect(await stateOf(task.seq)).toEqual([["current", null, null]]);
    },
    T,
  );
});

describe("a declaration cleared", () => {
  it(
    "is no longer in force: the target changing after the clearing marks nothing",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const row = task.ops[0]?.target.row;
      await ok({
        ops: [{ intent: "update", table: "tasks", row, ver: task.ops[0]?.ver, premises: [] }],
      });
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "a" },
          },
        ],
      });
      expect(await changedIn(w.seq)).toBeUndefined();
      expect(await stateOf(task.seq)).toEqual([["current", null, null]]);
    },
    T,
  );
});

describe("another op of the same request changing the target", () => {
  it(
    "after the declaring op: the declaration is current when written, marked by its own operation",
    async () => {
      const r = await release("v2", "2026-12-01");
      const w = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "freeze" },
            premises: [{ table: "releases", row: r.target.row, fields: ["date"], ver: r.ver }],
          },
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { date: "2026-11-20" },
          },
        ],
      });
      expect((await premiseBlocks(w.seq))["ops/0/premises/0"]).toMatchObject({ state: "current" });
      expect(await stateOf(w.seq)).toEqual([["changed", "update", w.seq]]);
    },
    T,
  );

  it(
    "before the declaring op, the version seen being the one before the request: the same",
    async () => {
      const r = await release("v2", "2026-12-01");
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { date: "2026-11-20" },
          },
          {
            intent: "insert",
            table: "tasks",
            set: { title: "freeze" },
            premises: [{ table: "releases", row: r.target.row, fields: ["date"], ver: r.ver }],
          },
        ],
      });
      expect((await premiseBlocks(w.seq))["ops/1/premises/0"]).toMatchObject({ state: "current" });
      expect(await stateOf(w.seq)).toEqual([["changed", "update", w.seq]]);
    },
    T,
  );
});

describe("the event in its operation", () => {
  it(
    "by_event is the first write.base that changed the target, not one whose item only became a candidate",
    async () => {
      const r = await release("v2", "2026-12-01");
      const named = await update(r, { name: "v2.0" });
      await restingOn({ target: r.target, ver: named.ops[0]?.ver as string });
      // op 0 from the first version: name changed since, a candidate; op 1 changes date.
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "a" },
          },
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: named.ops[0]?.ver,
            set: { date: "2026-11-20" },
          },
        ],
      });
      const bases = await basesOf(w.seq);
      expect(bases).toHaveLength(2);
      expect((await changedIn(w.seq))?.["targets/0"]).toMatchObject({ by_event: bases[1] });
    },
    T,
  );

  it(
    "by_event is the first write.base of the operation changing the target",
    async () => {
      const r = await release("v2", "2026-12-01");
      await restingOn(r);
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "a" },
          },
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { date: "2026-11-20" },
          },
        ],
      });
      const bases = await basesOf(w.seq);
      expect(bases).toHaveLength(2);
      expect((await changedIn(w.seq))?.["targets/0"]).toMatchObject({ by_event: bases[0] });
    },
    T,
  );

  it(
    "at most one premise.changed, after every base and item event of the operation",
    async () => {
      const r = await release("v2", "2026-12-01");
      const q = await release("v3", "2027-01-01");
      await restingOn(r);
      await restingOn(q);
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "a" },
          },
          {
            intent: "update",
            table: "releases",
            row: q.target.row,
            ver: q.ver,
            set: { name: "b" },
          },
        ],
      });
      const types = (
        await s.store.read((tx) =>
          tx.query<{ type: string }>("SELECT type FROM events WHERE op = $1 ORDER BY seq", [w.seq]),
        )
      ).rows.map((x) => x.type);
      expect(types.filter((x) => x === "premise.changed")).toHaveLength(1);
      // The derived table over releases is refreshed in the same operation, after it.
      expect(types).toContain("write.derived");
      const at = types.indexOf("premise.changed");
      expect(types.slice(at + 1).every((x) => x === "write.derived")).toBe(true);
      expect(types.slice(0, at).every((x) => x !== "write.derived")).toBe(true);
      // One block a target.
      expect(Object.keys((await changedIn(w.seq)) ?? {})).toEqual(["targets/0", "targets/1"]);
    },
    T,
  );

  it(
    "the detection failing: nothing of the operation stays, nor of either premise table",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r);
      const before = {
        tail: await tail(),
        decls: await decls(),
        edges: (
          await s.store.read((tx) => tx.query("SELECT * FROM premise_edges ORDER BY 1, 2, 3, 4"))
        ).rows,
      };
      failPremiseDetectionForTests(true);
      const refused = await send({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "x" },
          },
        ],
      }).catch((e: unknown) => ({ thrown: String(e) }));
      expect(refused).toMatchObject({
        thrown: expect.stringContaining("premise detection failed"),
      });
      expect({
        tail: await tail(),
        decls: await decls(),
        edges: (
          await s.store.read((tx) => tx.query("SELECT * FROM premise_edges ORDER BY 1, 2, 3, 4"))
        ).rows,
      }).toEqual(before);
      expect(await stateOf(task.seq)).toEqual([["current", null, null]]);
    },
    T,
  );
});

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

describe("the other operations that change values", () => {
  it(
    "a decision taking a candidate that changes the target: marked in the decision's operation",
    async () => {
      const r = await release("v2", "2026-12-01");
      const v2 = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "x" },
          },
        ],
      });
      const task = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "freeze" },
            premises: [
              { table: "releases", row: r.target.row, fields: ["date"], ver: v2.ops[0]?.ver },
            ],
          },
        ],
      });
      // From the first version: date stale against nothing, name against v2's: a candidate on name.
      const stale = (await send({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "y", date: "2026-11-20" },
          },
        ],
      })) as Receipt & { pending?: { id: string; item_ver?: string }[] };
      const item = stale.pending?.[0];
      expect(item).toBeDefined();
      // The date was not in conflict: in effect, so the declaration is marked by the write itself.
      expect(await stateOf(task.seq)).toEqual([["changed", "update", stale.seq]]);
      // A declaration on the whole row at the version after the stale write, current: the
      // decision taking the candidate changes name, and marks it in the decision's operation.
      const whole = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "notes" },
            premises: [{ table: "releases", row: r.target.row, ver: stale.ops[0]?.ver }],
          },
        ],
      });
      expect(await stateOf(whole.seq)).toEqual([["current", null, null]]);
      const decided = await resolve({
        id: item?.id,
        decision: "take_candidate",
        item_ver: item?.item_ver,
        idempotency_key: "take",
      });
      expect((await stateOf(whole.seq))[0]?.slice(0, 1)).toEqual(["changed"]);
      expect((await stateOf(whole.seq))[0]?.[2]).toBe(
        (decided as unknown as { write: { seq: number } }).write.seq,
      );
      // The one on date stays as it was.
      expect(await stateOf(task.seq)).toEqual([["changed", "update", stale.seq]]);
    },
    T,
  );

  it(
    "restated on the new value, the change then undone: marked again, the undo's reason",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await restingOn(r, ["date"]);
      const v2 = await ok({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { date: "2026-11-20" },
          },
        ],
      });
      expect((await stateOf(task.seq))[0]?.[0]).toBe("changed");
      // Restated on the new date: a new declaration, current; the old one superseded.
      const restated = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            premises: [
              { table: "releases", row: r.target.row, fields: ["date"], ver: v2.ops[0]?.ver },
            ],
          },
        ],
      });
      expect(await stateOf(restated.seq)).toEqual([["current", null, null]]);
      const undone = await ok({
        ops: [{ table: "releases", row: r.target.row, revert: { undo: v2.seq } }],
      });
      expect(await stateOf(restated.seq)).toEqual([["changed", "update", undone.seq]]);
    },
    T,
  );

  it(
    "on an entity: retroactive for a change before the write's day, plan_changed after, nothing outside",
    async () => {
      const b = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 5000 },
            valid_from: "2026-10-01",
          },
        ],
      });
      const entity = b.ops[0]?.target.entity as string;
      let ver = b.ops[0]?.ver as string;
      const plan = await ok({
        ops: [
          {
            intent: "insert",
            table: "plans",
            set: { label: "x" },
            valid_from: "2026-10-01",
            premises: [
              { table: "budgets", entity, ver, valid_during: ["2026-11-01", "2026-12-01"] },
            ],
          },
        ],
      });
      const write = async (from: string, to: string, amount: number, status = "saved") => {
        const w = await ok({
          ops: [
            {
              intent: "update",
              table: "budgets",
              entity,
              ver,
              set: { amount },
              valid_from: from,
              valid_to: to,
            },
          ],
        });
        expect((w as unknown as { status: string }).status).toBe(status);
        ver = w.ops[0]?.ver as string;
        return w;
      };
      // Outside November: nothing.
      await write("2026-12-05", "2026-12-10", 1);
      expect(await stateOf(plan.seq)).toEqual([["current", null, null]]);
      // After the writes' day (11-05): a change of plan.
      const later = await write("2026-11-10", "2026-11-15", 2);
      expect(await stateOf(plan.seq)).toEqual([["changed", "plan_changed", later.seq]]);
      // Back: it overwrites write 2's change point, so it waits for confirmation and nothing is
      // taken back yet; the confirmation puts it in effect and takes the mark back.
      const back = (await write("2026-11-10", "2026-11-15", 5000, "pending")) as Receipt & {
        pending: { id: string; item_ver: string }[];
      };
      expect(await stateOf(plan.seq)).toEqual([["changed", "plan_changed", later.seq]]);
      await resolve({
        id: back.pending[0]?.id,
        decision: "confirm",
        item_ver: back.pending[0]?.item_ver,
        idempotency_key: "back",
      });
      expect(await stateOf(plan.seq)).toEqual([["current", null, null]]);
      // Then before 11-05: retroactive.
      const retro = await write("2026-11-01", "2026-11-03", 3);
      expect(await stateOf(plan.seq)).toEqual([["changed", "retroactive", retro.seq]]);
    },
    T,
  );
});

describe("the log the pipeline wrote, replayed", () => {
  it(
    "into an empty store: the same declarations and edges, row for row",
    async () => {
      const r = await release("v2", "2026-12-01");
      const onDate = await restingOn(r, ["date"]);
      const whole = await restingOn(r);
      const w = await update(r, { date: "2026-11-20" });
      const back = await update(
        { target: r.target, ver: w.ops[0]?.ver as string },
        { date: "2026-12-01" },
      );
      const named = await update(
        { target: r.target, ver: back.ops[0]?.ver as string },
        { name: "n" },
      );
      const gone = await ok({
        ops: [{ intent: "revoke", table: "releases", row: r.target.row, ver: named.ops[0]?.ver }],
      });
      await ok({ ops: [{ table: "releases", row: r.target.row, revert: { undo: gone.seq } }] });
      // A restatement (supersedes) and a clearing (an entry on "*").
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: onDate.ops[0]?.target.row,
            ver: onDate.ops[0]?.ver,
            premises: [{ table: "releases", row: r.target.row }],
          },
        ],
      });
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: whole.ops[0]?.target.row,
            ver: whole.ops[0]?.ver,
            premises: [],
          },
        ],
      });
      const tables = (store: ReusableStore["store"]) =>
        store.read(async (tx) => ({
          decls: (await tx.query("SELECT * FROM premise_decls ORDER BY op, op_index, decl_index"))
            .rows,
          edges: (
            await tx.query("SELECT * FROM premise_edges ORDER BY item_event, field_id, k, target")
          ).rows,
        }));
      const here = await tables(s.store);
      expect(here.decls.length).toBeGreaterThan(2);
      expect(here.edges.some((e) => (e as { target: string }).target === "*")).toBe(true);
      const into = await openReusable("saveslot-premises-replay-");
      try {
        const events = await s.store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
        const content = await s.store.read((tx) =>
          tx.query("SELECT * FROM content ORDER BY seq, path"),
        );
        const last = await tail();
        await into.store.write(async (tx) => {
          for (const [table, rows] of [
            ["events", events.rows],
            ["content", content.rows],
          ] as const)
            for (const row of rows as Record<string, unknown>[]) {
              const cols = Object.keys(row);
              await tx.query(
                `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
                Object.values(row) as never,
              );
            }
          await applyEvents(tx, await readEvents(tx, 1 as never, last as never));
        });
        expect(await tables(into.store)).toEqual(here);
      } finally {
        await into.close();
      }
    },
    T,
  );
});
