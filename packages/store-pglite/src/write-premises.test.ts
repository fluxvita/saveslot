// Declaring premises through the write pipeline on PGlite (03-data-model/02-integrity-and-records
// «写入的前提»; 04-contract §5; 09-event-format §5.7 the premise blocks): what the head records of
// each declaration, step 5's checks, the state when written, restatement and clearing, and the
// cover.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  readBufferOf,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  premiseFanInLimitForTests,
  resolveInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const COMPILED = {
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
    {
      id: "t6",
      name: "rooms",
      kind: "base",
      description: "two values over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t6_v1" },
      fields: [
        { id: "f10", name: "a", type: "integer", description: "a" },
        { id: "f11", name: "b", type: "integer", description: "b" },
      ],
    },
    {
      id: "t7",
      name: "meetings",
      kind: "base",
      description: "meetings at a time",
      time: { type: "event", field: "f12" },
      physical: { table: "t_t7_v1" },
      fields: [
        { id: "f12", name: "at", type: "zoned_datetime", required: true, description: "when" },
      ],
    },
    {
      id: "t8",
      name: "shifts",
      kind: "base",
      description: "who is on, by the instant",
      time: { type: "state", granularity: "instant" },
      physical: { table: "t_t8_v1" },
      fields: [{ id: "f13", name: "who", type: "text", description: "who" }],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((t) => ({
    target: { table: t },
    change: "add_table",
  })),
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
const verOp = (v: string) => Number(/^v(\d+)\./.exec(v)?.[1]);

const release = async (name: string, date: string) =>
  (await ok({ ops: [{ intent: "insert", table: "releases", set: { name, date } }] })).ops[0] as {
    target: { row: string };
    ver: string;
  };
const changeRelease = async (row: string, ver: string, set: Record<string, unknown>) =>
  (await ok({ ops: [{ intent: "update", table: "releases", row, ver, set }] })).ops[0]
    ?.ver as string;

beforeAll(async () => {
  s = await openReusable("saveslot-write-premises-");
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
afterEach(() => premiseFanInLimitForTests(1000));

describe("a declaration as the head records it", () => {
  it(
    "an insert resting on a row's field, its version current: whole, current, no cover beyond its own",
    async () => {
      const r = await release("v2", "2026-12-01");
      const w = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "freeze", due: "2026-11-27" },
            premises: [{ table: "releases", row: r.target.row, fields: ["date"], ver: r.ver }],
          },
        ],
      });
      expect(await premiseBlocks(w.seq)).toEqual({
        "ops/0/premises/0": {
          table: "t1",
          row: r.target.row,
          fields: ["f2"],
          ver: { op: verOp(r.ver), restore_count: 0, basis: "explicit" },
          range: "whole",
          state: "current",
        },
      });
      // The receipt: the premise as recorded, nothing covered beyond the op's own.
      expect(w.ops[0]?.premises).toEqual([
        {
          target: { table: "ledger.releases", row: r.target.row },
          fields: ["date"],
          ver: r.ver,
          state: "current",
        },
      ]);
      expect(w.ops[0]?.premise_covered).toBe(0);
      expect(await decls()).toEqual([
        {
          op: w.seq,
          op_index: 0,
          decl_index: 0,
          dep_row: w.ops[0]?.target.row,
          target_row: r.target.row,
          fields: '["f2"]',
          range_kind: "whole",
          valid: null,
          seen_op: verOp(r.ver),
          state: "current",
          reason: null,
          since: null,
        },
      ]);
    },
    T,
  );

  it(
    "without ver: the fallback (the caller's own write), with premise_ver_fallback",
    async () => {
      const r = await release("v2", "2026-12-01");
      const w = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "freeze" },
            premises: [{ table: "releases", row: r.target.row }],
          },
        ],
      });
      expect((await premiseBlocks(w.seq))["ops/0/premises/0"]).toMatchObject({
        ver: { op: verOp(r.ver), restore_count: 0, basis: "fallback" },
      });
      expect(w.warnings).toContainEqual({
        code: "premise_ver_fallback",
        op: 0,
        premise: 0,
        ver: r.ver,
        from_write: verOp(r.ver),
      });
    },
    T,
  );
});

describe("the state when written, by the criterion", () => {
  const declare = async (row: string, ver: string, fields?: string[]) =>
    ok({
      ops: [
        {
          intent: "insert",
          table: "tasks",
          set: { title: "t" },
          premises: [{ table: "releases", row, ver, ...(fields ? { fields } : {}) }],
        },
      ],
    });

  it(
    "an old ver whose declared field changed since: changed, reason and since the change's, a warning",
    async () => {
      const r = await release("v2", "2026-12-01");
      const v2 = await changeRelease(r.target.row, r.ver, { date: "2026-11-20" });
      const w = await declare(r.target.row, r.ver, ["date"]);
      expect((await premiseBlocks(w.seq))["ops/0/premises/0"]).toMatchObject({
        state: "changed",
        reason: "update",
        since: verOp(v2),
      });
      expect(w.ops[0]?.premises?.[0]).toMatchObject({
        state: "changed",
        reason: "update",
        since: verOp(v2),
      });
      expect(w.warnings).toContainEqual({
        code: "premise_already_changed",
        op: 0,
        premise: 0,
        since: verOp(v2),
      });
    },
    T,
  );

  it(
    "changed and changed back: current, though it changed in between",
    async () => {
      const r = await release("v2", "2026-12-01");
      const v2 = await changeRelease(r.target.row, r.ver, { date: "2026-11-20" });
      await changeRelease(r.target.row, v2, { date: "2026-12-01" });
      const w = await declare(r.target.row, r.ver, ["date"]);
      expect((await premiseBlocks(w.seq))["ops/0/premises/0"]).toMatchObject({ state: "current" });
      expect(w.warnings ?? []).not.toContainEqual(
        expect.objectContaining({ code: "premise_already_changed" }),
      );
    },
    T,
  );

  it(
    "since: the first of the last stretch of versions all differing from the one seen",
    async () => {
      const r = await release("v2", "2026-12-01");
      // A change, back again, a change of another field (still the same date), then the date.
      const a = await changeRelease(r.target.row, r.ver, { date: "2026-11-20" });
      const b = await changeRelease(r.target.row, a, { date: "2026-12-01" });
      const c = await changeRelease(r.target.row, b, { date: "2026-11-25" });
      await changeRelease(r.target.row, c, { name: "v2.1" });
      const w = await declare(r.target.row, r.ver, ["date"]);
      expect((await premiseBlocks(w.seq))["ops/0/premises/0"]).toMatchObject({
        state: "changed",
        since: verOp(c),
      });
      // Not declared on the date: the name's change counts too, but `since` stays at the date's.
      const whole = await declare(r.target.row, r.ver);
      expect((await premiseBlocks(whole.seq))["ops/0/premises/0"]).toMatchObject({
        since: verOp(c),
      });
    },
    T,
  );

  it(
    "a target revoked: written, changed, reason revoke",
    async () => {
      const r = await release("v2", "2026-12-01");
      const gone = await ok({
        ops: [{ intent: "revoke", table: "releases", row: r.target.row, ver: r.ver }],
      });
      const w = await declare(r.target.row, r.ver);
      expect((await premiseBlocks(w.seq))["ops/0/premises/0"]).toMatchObject({
        state: "changed",
        reason: "revoke",
        since: gone.seq,
      });
    },
    T,
  );
});

describe("step 5 refusals: nothing is written", () => {
  const refused = async (premises: unknown[], expected: Record<string, unknown>) => {
    const before = await tail();
    const r = await send({
      ops: [{ intent: "insert", table: "tasks", set: { title: "t" }, premises }],
    });
    expect(r).toEqual(expected);
    expect(await tail()).toBe(before);
  };

  it(
    "a row that is not there, or of another table",
    async () => {
      const r = await release("v2", "2026-12-01");
      const other = `r_${"9".repeat(26)}`;
      await refused([{ table: "releases", row: other, ver: r.ver }], {
        refused: "not_found",
        reason: "row",
        param: "ops/0/premises/0",
      });
      await refused([{ table: "tasks", row: r.target.row, ver: r.ver }], {
        refused: "not_found",
        reason: "row",
        param: "ops/0/premises/0",
      });
    },
    T,
  );

  it(
    "the op's own target; one target twice; a ver of another row",
    async () => {
      const r = await release("v2", "2026-12-01");
      const own = await send({
        ops: [
          {
            intent: "update",
            table: "releases",
            row: r.target.row,
            ver: r.ver,
            set: { name: "x" },
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      expect(own).toEqual({
        refused: "invalid_argument",
        reason: "premise_self",
        param: "ops/0/premises/0",
      });
      await refused(
        [
          { table: "releases", row: r.target.row, fields: ["date"], ver: r.ver },
          { table: "releases", row: r.target.row, fields: ["name"], ver: r.ver },
        ],
        {
          refused: "invalid_argument",
          reason: "premise_duplicate_target",
          param: "ops/0/premises/1",
          premises: [0, 1],
        },
      );
      const q = await release("v3", "2027-01-01");
      await refused([{ table: "releases", row: r.target.row, ver: q.ver }], {
        refused: "invalid_argument",
        reason: "not_this_target",
        param: "ops/0/premises/0/ver",
      });
    },
    T,
  );

  it(
    "pointed at by more than the limit with this one: refused at the limit plus one",
    async () => {
      premiseFanInLimitForTests(2);
      const r = await release("v2", "2026-12-01");
      const on = [{ table: "releases", row: r.target.row, ver: r.ver }];
      await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "a" }, premises: on }] });
      // The second: two with it, at the limit.
      await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "b" }, premises: on }] });
      await refused(on, {
        refused: "too_large",
        reason: "premise_fan_in",
        param: "ops/0/premises/0",
        target: { table: "ledger.releases", row: r.target.row },
        count: 2,
      });
    },
    T,
  );
});

describe("restatement and clearing", () => {
  it(
    "a restatement: the head alone, the row's ver unchanged, its items covered",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "freeze", due: "2026-11-27" } }],
      });
      const row = task.ops[0]?.target.row as string;
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: task.ops[0]?.ver,
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      expect(w.ops[0]?.ver).toBe(task.ops[0]?.ver);
      expect(w.ops[0]?.premise_covered).toBe(2);
      const types = (
        await s.store.read((tx) =>
          tx.query<{ type: string }>("SELECT type FROM events WHERE op = $1 ORDER BY seq", [w.seq]),
        )
      ).rows.map((x) => x.type);
      expect(types).toEqual(["write.head", "source.recorded"]);
      const blocks = await premiseBlocks(w.seq);
      expect(blocks["ops/0/premise_covers"]).toEqual([
        { event: task.seq + 2, field: "f3", k: 0 },
        { event: task.seq + 2, field: "f4", k: 0 },
      ]);
    },
    T,
  );

  it(
    "a clearing: premises_cleared and what it covers; on a revoked row, revoked",
    async () => {
      const task = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "freeze" } }],
      });
      const row = task.ops[0]?.target.row as string;
      const w = await ok({
        ops: [{ intent: "update", table: "tasks", row, ver: task.ops[0]?.ver, premises: [] }],
      });
      expect(await premiseBlocks(w.seq)).toEqual({
        "ops/0/premise_covers": [{ event: task.seq + 2, field: "f3", k: 0 }],
        "ops/0/premises_cleared": true,
      });
      expect(w.ops[0]).toMatchObject({ premises: [], premise_covered: 1 });
      const gone = await ok({
        ops: [{ intent: "revoke", table: "tasks", row, ver: task.ops[0]?.ver }],
      });
      const r = await send({
        ops: [{ intent: "update", table: "tasks", row, ver: gone.ops[0]?.ver, premises: [] }],
      });
      expect(r).toMatchObject({ refused: "revoked", param: "ops/0" });
    },
    T,
  );
});

describe("the range of a premise on an entity", () => {
  it(
    "given, the depending entity's own interval (row_time), and from now on",
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
      const budget = b.ops[0]?.target.entity as string;
      const ver = b.ops[0]?.ver as string;
      const plan = (premise: Record<string, unknown>, interval: Record<string, unknown>) =>
        ok({
          ops: [
            {
              intent: "insert",
              table: "plans",
              set: { label: "dinner" },
              ...interval,
              premises: [{ table: "budgets", entity: budget, ver, ...premise }],
            },
          ],
        });
      const given = await plan(
        { valid_during: ["2026-11-01", "2026-12-01"] },
        { valid_from: "2026-11-10" },
      );
      expect(await premiseBlocks(given.seq)).toEqual({
        "ops/0/premises/0": expect.objectContaining({ range: "given" }),
        "ops/0/premise_valid/0": { during: { from: "2026-11-01", to: "2026-12-01" } },
      });
      const own = await plan({}, { valid_from: "2026-11-10", valid_to: "2026-11-12" });
      expect(await premiseBlocks(own.seq)).toEqual({
        "ops/0/premises/0": expect.objectContaining({ range: "row_time" }),
        "ops/0/premise_valid/0": { during: { from: "2026-11-10", to: "2026-11-12" } },
      });
    },
    T,
  );
});

describe("the request key with premises (04-contract §14)", () => {
  it(
    "a restatement sent again: the same request while its premise stands; a new one once it changed",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "t" } }] });
      const restate = {
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: task.ops[0]?.target.row,
            ver: task.ops[0]?.ver,
            // No ver: the fallback, the caller's own latest write of the release.
            premises: [{ table: "releases", row: r.target.row }],
          },
        ],
      };
      const first = await ok(restate);
      const again = (await ok(restate)) as Receipt & { replayed?: true };
      expect({ seq: again.seq, replayed: again.replayed }).toEqual({
        seq: first.seq,
        replayed: true,
      });
      await changeRelease(r.target.row, r.ver, { date: "2026-11-20" });
      const after = (await ok(restate)) as Receipt & { replayed?: true };
      expect(after.replayed).toBeUndefined();
      expect(after.seq).toBeGreaterThan(first.seq);
    },
    T,
  );
});

describe("the cover, and the range and reason on an entity", () => {
  it(
    "an op with a field become a candidate covers only its own items",
    async () => {
      const r = await release("v2", "2026-12-01");
      // `due` stays as inserted throughout: an item a cover would list.
      const task = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "a", due: "2026-11-27" } }],
      });
      const row = task.ops[0]?.target.row as string;
      await ok({
        ops: [
          { intent: "update", table: "tasks", row, ver: task.ops[0]?.ver, set: { title: "b" } },
        ],
      });
      // From the first version again: title is a candidate.
      const stale = (premises: unknown[]) =>
        send({
          ops: [
            {
              intent: "update",
              table: "tasks",
              row,
              ver: task.ops[0]?.ver,
              set: { title: "c" },
              premises,
            },
          ],
        });
      const declared = await stale([{ table: "releases", row: r.target.row, ver: r.ver }]);
      expect(declared["refused"]).toBeUndefined();
      expect(Object.keys(await premiseBlocks(declared.seq))).toEqual(["ops/0/premises/0"]);
      expect(declared.ops[0]?.premise_covered).toBe(0);
      // A clearing with a field become a candidate clears the whole row all the same.
      const cleared = await stale([]);
      expect(await premiseBlocks(cleared.seq)).toEqual({
        "ops/0/premise_covers": [{ event: task.seq + 2, field: "f4", k: 0 }],
        "ops/0/premises_cleared": true,
      });
    },
    T,
  );

  it(
    "an event row resting on an entity: its time field written, as a point (row_time)",
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
      const w = await ok({
        ops: [
          {
            intent: "insert",
            table: "logs",
            set: { day: "2026-11-03", text: "dinner" },
            premises: [{ table: "budgets", entity: b.ops[0]?.target.entity, ver: b.ops[0]?.ver }],
          },
        ],
      });
      expect(await premiseBlocks(w.seq)).toEqual({
        "ops/0/premises/0": expect.objectContaining({ range: "row_time" }),
        "ops/0/premise_valid/0": { at: "2026-11-03" },
      });
    },
    T,
  );

  it(
    "an entity changed since the version seen: retroactive for a change before that write's day, plan_changed after",
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
      const seen = b.ops[0]?.ver as string;
      const declare = async (valid: Record<string, unknown>) =>
        premiseBlocks(
          (
            await ok({
              ops: [
                {
                  intent: "insert",
                  table: "plans",
                  set: { label: "x" },
                  valid_from: "2026-10-01",
                  premises: [{ table: "budgets", entity, ver: seen, ...valid }],
                },
              ],
            })
          ).seq,
        );
      // From 12-01 on, after the writes' day (11-05): a change of plan.
      const later = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity,
            ver: seen,
            set: { amount: 3000 },
            valid_from: "2026-12-01",
          },
        ],
      });
      expect(
        (await declare({ valid_during: ["2026-11-01", null] }))["ops/0/premises/0"],
      ).toMatchObject({ state: "changed", reason: "plan_changed", since: later.seq });
      // Over [10-15, 10-20), before it: retroactive; over November only, unchanged.
      const retro = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity,
            ver: later.ops[0]?.ver,
            set: { amount: 4000 },
            valid_from: "2026-10-15",
            valid_to: "2026-10-20",
          },
        ],
      });
      expect(
        (await declare({ valid_during: ["2026-10-01", "2026-11-01"] }))["ops/0/premises/0"],
      ).toMatchObject({ state: "changed", reason: "retroactive", since: retro.seq });
      expect(
        (await declare({ valid_during: ["2026-11-01", "2026-12-01"] }))["ops/0/premises/0"],
      ).toMatchObject({ state: "current" });
    },
    T,
  );
});

describe("reasons and counts at their edges", () => {
  const budget = async (category: string) => {
    const b = await ok({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity_key: { category },
          set: { amount: 5000 },
          valid_from: "2026-10-01",
        },
      ],
    });
    return { entity: b.ops[0]?.target.entity as string, ver: b.ops[0]?.ver as string };
  };
  const stateOn = async (entity: string, ver: string) =>
    (
      await premiseBlocks(
        (
          await ok({
            ops: [
              {
                intent: "insert",
                table: "plans",
                set: { label: "x" },
                valid_from: "2026-10-01",
                premises: [{ table: "budgets", entity, ver, valid_during: ["2026-10-01", null] }],
              },
            ],
          })
        ).seq,
      )
    )["ops/0/premises/0"];

  it(
    "a change from the very day of the write that made it: a change of plan, not retroactive",
    async () => {
      const b = await budget("food");
      const today = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity: b.entity,
            ver: b.ver,
            set: { amount: 3000 },
            valid_from: "2026-11-05",
          },
        ],
      });
      expect(await stateOn(b.entity, b.ver)).toMatchObject({
        reason: "plan_changed",
        since: today.seq,
      });
    },
    T,
  );

  it(
    "a correction on an entity: correct",
    async () => {
      const b = await budget("food");
      const fixed = await ok({
        ops: [
          {
            intent: "correct",
            table: "budgets",
            entity: b.entity,
            ver: b.ver,
            set: { amount: 4500 },
            valid_from: "2026-10-01",
          },
        ],
      });
      expect(await stateOn(b.entity, b.ver)).toMatchObject({
        reason: "correct",
        since: fixed.seq,
      });
    },
    T,
  );

  it(
    "premise_covered counts fields, not items: two stretches of one field are one field",
    async () => {
      const food = await budget("food");
      const later = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity: food.entity,
            ver: food.ver,
            set: { amount: 3000 },
            valid_from: "2026-12-01",
          },
        ],
      });
      const rent = await budget("rent");
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity: food.entity,
            ver: later.ops[0]?.ver,
            premises: [{ table: "budgets", entity: rent.entity, ver: rent.ver }],
          },
        ],
      });
      const covers = (await premiseBlocks(w.seq))["ops/0/premise_covers"] as {
        field: string;
      }[];
      expect(covers.filter((c) => c.field === "f6")).toHaveLength(2);
      // Two fields (category, amount), three items.
      expect(covers).toHaveLength(3);
      expect(w.ops[0]?.premise_covered).toBe(2);
    },
    T,
  );
});

describe("the cover is of origin items, carried references followed to their end", () => {
  it(
    "a restatement after an undo covers the item the write-back carries, not the write-back",
    async () => {
      const r = await release("v2", "2026-12-01");
      const task = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "a" } }] });
      const row = task.ops[0]?.target.row as string;
      const changed = await ok({
        ops: [
          { intent: "update", table: "tasks", row, ver: task.ops[0]?.ver, set: { title: "b" } },
        ],
      });
      const undone = await ok({
        ops: [{ table: "tasks", row, ver: changed.ops[0]?.ver, revert: { undo: changed.seq } }],
      });
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: undone.ops[0]?.ver,
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      // The insert's item (its write.base is two after its head: a source between).
      expect((await premiseBlocks(w.seq))["ops/0/premise_covers"]).toEqual([
        { event: task.seq + 2, field: "f3", k: 0 },
      ]);
    },
    T,
  );
});

describe("the depending row's own business time", () => {
  /** A budget entity at its version, from 10-01. */
  const aBudget = async () => {
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
    return { table: "budgets", entity: b.ops[0]?.target.entity, ver: b.ops[0]?.ver };
  };

  it(
    "an op of several fields with different ends: the hull of all of them",
    async () => {
      const on = await aBudget();
      const first = await ok({
        ops: [{ intent: "insert", table: "rooms", set: { a: 1, b: 1 }, valid_from: "2026-11-01" }],
      });
      const room = first.ops[0]?.target.entity as string;
      const second = await ok({
        ops: [
          {
            intent: "update",
            table: "rooms",
            entity: room,
            ver: first.ops[0]?.ver,
            set: { b: 2 },
            valid_from: "2026-11-20",
          },
        ],
      });
      // a runs to the end of time, b stops at 11-20.
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "rooms",
            entity: room,
            ver: second.ops[0]?.ver,
            set: { a: 3, b: 3 },
            valid_from: "2026-11-10",
            premises: [on],
          },
        ],
      });
      // Open at the end, a's own: no deps, b's stop at 11-20 gives no end of it.
      expect((await premiseBlocks(w.seq))["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-11-10" },
      });
    },
    T,
  );

  it(
    "an event row's time field of zoned_datetime: its instant, a day on a date target",
    async () => {
      const on = await aBudget();
      const shift = await ok({
        ops: [
          {
            intent: "insert",
            table: "shifts",
            set: { who: "ann" },
            valid_from: "2026-11-01T00:00:00Z",
          },
        ],
      });
      const w = await ok({
        ops: [
          {
            intent: "insert",
            table: "meetings",
            // 16:01 UTC on 11-03, 11:01 on 11-03 in New York, 00:01 on 11-04 in the slot's zone.
            set: { at: "2026-11-03T11:01:00-05:00[America/New_York]" },
            premises: [
              on,
              { table: "shifts", entity: shift.ops[0]?.target.entity, ver: shift.ops[0]?.ver },
            ],
          },
        ],
      });
      const blocks = await premiseBlocks(w.seq);
      expect(blocks["ops/0/premise_valid/0"]).toEqual({ at: "2026-11-04" });
      expect(blocks["ops/0/premise_valid/1"]).toEqual({ at: "2026-11-03T16:01:00.000Z" });
      expect(blocks["ops/0/premises/1"]).toMatchObject({ range: "row_time" });
    },
    T,
  );

  it(
    "a restatement of an event row: its time field in effect, with the item giving it",
    async () => {
      const on = await aBudget();
      const log = await ok({
        ops: [{ intent: "insert", table: "logs", set: { day: "2026-11-03", text: "a" } }],
      });
      const row = log.ops[0]?.target.row as string;
      const w = await ok({
        ops: [{ intent: "update", table: "logs", row, ver: log.ops[0]?.ver, premises: [on] }],
      });
      expect((await premiseBlocks(w.seq))["ops/0/premise_valid/0"]).toEqual({
        at: "2026-11-03",
        deps: [{ event: log.seq + 2, field: "f8", k: 0 }],
      });
    },
    T,
  );

  it(
    "an update of an event row not writing its time field: the value in effect, with its deps",
    async () => {
      const on = await aBudget();
      const log = await ok({
        ops: [{ intent: "insert", table: "logs", set: { day: "2026-11-03", text: "a" } }],
      });
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "logs",
            row: log.ops[0]?.target.row,
            ver: log.ops[0]?.ver,
            set: { text: "b" },
            premises: [on],
          },
        ],
      });
      expect((await premiseBlocks(w.seq))["ops/0/premise_valid/0"]).toEqual({
        at: "2026-11-03",
        deps: [{ event: log.seq + 2, field: "f8", k: 0 }],
      });
    },
    T,
  );

  it(
    "a restatement of a state row with an interval: that interval; without one: from now on",
    async () => {
      const on = await aBudget();
      const plan = await ok({
        ops: [{ intent: "insert", table: "plans", set: { label: "x" }, valid_from: "2026-11-01" }],
      });
      const entity = plan.ops[0]?.target.entity as string;
      const ver = plan.ops[0]?.ver;
      const given = await ok({
        ops: [
          {
            intent: "update",
            table: "plans",
            entity,
            ver,
            valid_from: "2026-11-05",
            valid_to: "2026-11-09",
            premises: [on],
          },
        ],
      });
      expect(await premiseBlocks(given.seq)).toMatchObject({
        "ops/0/premises/0": expect.objectContaining({ range: "row_time" }),
        "ops/0/premise_valid/0": { during: { from: "2026-11-05", to: "2026-11-09" } },
      });
      const none = await ok({
        ops: [{ intent: "update", table: "plans", entity, ver, premises: [on] }],
      });
      expect((await premiseBlocks(none.seq))["ops/0/premises/0"]).toMatchObject({
        range: "from_now",
      });
    },
    T,
  );
});

describe("counts, revoked versions seen, keys of this request", () => {
  it(
    "the declarations of this request's earlier ops count toward the limit",
    async () => {
      premiseFanInLimitForTests(1);
      const r = await release("v2", "2026-12-01");
      const on = [{ table: "releases", row: r.target.row, ver: r.ver }];
      const before = await tail();
      const two = await send({
        ops: [
          { intent: "insert", table: "tasks", set: { title: "a" }, premises: on },
          { intent: "insert", table: "tasks", set: { title: "b" }, premises: on },
        ],
      });
      expect(two).toEqual({
        refused: "too_large",
        reason: "premise_fan_in",
        param: "ops/1/premises/0",
        target: { table: "ledger.releases", row: r.target.row },
        count: 1,
      });
      expect(await tail()).toBe(before);
    },
    T,
  );

  it(
    "the version seen is the revoke itself: current, no mark (given, or by the fallback to it)",
    async () => {
      const r = await release("v2", "2026-12-01");
      const gone = await ok({
        ops: [{ intent: "revoke", table: "releases", row: r.target.row, ver: r.ver }],
      });
      const given = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "a" },
            premises: [{ table: "releases", row: r.target.row, ver: gone.ops[0]?.ver }],
          },
        ],
      });
      expect((await premiseBlocks(given.seq))["ops/0/premises/0"]).toMatchObject({
        state: "current",
      });
      const fallback = await ok({
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "b" },
            premises: [{ table: "releases", row: r.target.row }],
          },
        ],
      });
      expect((await premiseBlocks(fallback.seq))["ops/0/premises/0"]).toMatchObject({
        ver: { op: gone.seq, basis: "fallback" },
        state: "current",
      });
    },
    T,
  );

  it(
    "an entity_key naming an entity an earlier op of the request created: that entity, seen at the request's end",
    async () => {
      const before = await tail();
      const r = await send({
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "travel" },
            set: { amount: 100 },
            valid_from: "2026-10-01",
          },
          {
            intent: "insert",
            table: "tasks",
            set: { title: "a" },
            premises: [{ table: "budgets", entity_key: { category: "travel" } }],
          },
        ],
      });
      expect(r).toMatchObject({ status: "saved" });
      const w = r as unknown as { seq: number; ops: { premises?: unknown[] }[] };
      expect(w.ops[1]?.premises).toEqual([
        expect.objectContaining({ ver: `v${w.seq}.0`, state: "current" }),
      ]);
      expect(await tail()).toBeGreaterThan(before);
    },
    T,
  );
});

/** Resolves an item through the pipeline. */
const resolve = async (params: unknown) =>
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
  )) as unknown as { write: Receipt };
/** The `write.base` events of operation `op`, in order. */
const basesOf = async (op: number) =>
  (
    await s.store.read((tx) =>
      tx.query<{ seq: unknown }>(
        "SELECT seq FROM events WHERE op = $1 AND type = 'write.base' ORDER BY seq",
        [op],
      ),
    )
  ).rows.map((r) => Number(r.seq));
/** A budget entity from 10-01 at its version, as a premise. */
const aBudget = async () => {
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
  return { table: "budgets", entity: b.ops[0]?.target.entity, ver: b.ops[0]?.ver };
};
/** A room (a, b) from `from`. */
const aRoom = async (set: Record<string, number>, from: string) => {
  const r = await ok({ ops: [{ intent: "insert", table: "rooms", set, valid_from: from }] });
  return { entity: r.ops[0]?.target.entity as string, ver: r.ops[0]?.ver as string, seq: r.seq };
};
const changeRoom = async (
  room: { entity: string; ver: string },
  set: Record<string, number>,
  from: string,
) => {
  const r = await ok({
    ops: [
      {
        intent: "update",
        table: "rooms",
        entity: room.entity,
        ver: room.ver,
        set,
        valid_from: from,
      },
    ],
  });
  return { entity: room.entity, ver: r.ops[0]?.ver as string, seq: r.seq };
};

describe("the interval of row_time", () => {
  it(
    "every field a no-op, the interval in the past: the interval the op wrote",
    async () => {
      const on = await aBudget();
      const room = await aRoom({ a: 1, b: 1 }, "2026-10-01");
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "rooms",
            entity: room.entity,
            ver: room.ver,
            set: { a: 1, b: 1 },
            valid_from: "2026-10-02",
            valid_to: "2026-10-04",
            premises: [on],
          },
        ],
      });
      expect(await basesOf(w.seq)).toEqual([]);
      const blocks = await premiseBlocks(w.seq);
      expect(blocks["ops/0/premises/0"]).toMatchObject({ range: "row_time" });
      expect(blocks["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-10-02", to: "2026-10-04" },
      });
    },
    T,
  );

  it(
    "one field a no-op, one written: the no-op's interval counts (open), b's end at its next change does not",
    async () => {
      const on = await aBudget();
      const room = await changeRoom(
        await aRoom({ a: 7, b: 1 }, "2026-11-01"),
        { b: 2 },
        "2026-11-15",
      );
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "rooms",
            entity: room.entity,
            ver: room.ver,
            set: { a: 7, b: 4 },
            valid_from: "2026-11-10",
            premises: [on],
          },
        ],
      });
      expect((await premiseBlocks(w.seq))["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-11-10" },
      });
    },
    T,
  );

  it(
    "different ends the other way round (a stops, b open); and both stopping at one change: its givers as deps",
    async () => {
      const on = await aBudget();
      const first = await aRoom({ a: 1, b: 1 }, "2026-11-01");
      const aStops = await changeRoom(first, { a: 2 }, "2026-11-20");
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "rooms",
            entity: first.entity,
            ver: aStops.ver,
            set: { a: 3, b: 3 },
            valid_from: "2026-11-10",
            premises: [on],
          },
        ],
      });
      expect((await premiseBlocks(w.seq))["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-11-10" },
      });
      // Both change at 11-20 in one write: the hull ends there, given by that write's two items.
      // Not the first room's content again (that would be the same request replayed).
      const other = await aRoom({ a: 5, b: 5 }, "2026-11-01");
      const both = await changeRoom(other, { a: 2, b: 2 }, "2026-11-20");
      const v = await ok({
        ops: [
          {
            intent: "update",
            table: "rooms",
            entity: other.entity,
            ver: both.ver,
            set: { a: 3, b: 3 },
            valid_from: "2026-11-10",
            premises: [on],
          },
        ],
      });
      const [base] = await basesOf(both.seq);
      expect((await premiseBlocks(v.seq))["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-11-10", to: "2026-11-20" },
        deps: [
          { event: base, field: "f10", k: 0 },
          { event: base, field: "f11", k: 0 },
        ],
      });
    },
    T,
  );

  it(
    "a field held for confirmation: its interval counts as written",
    async () => {
      const on = await aBudget();
      // b's change point at 11-15 is overwritten by a write from 11-10 to the end: held.
      const room = await changeRoom(
        await aRoom({ a: 1, b: 1 }, "2026-11-01"),
        { b: 2 },
        "2026-11-15",
      );
      const w = (await ok({
        ops: [
          {
            intent: "update",
            table: "rooms",
            entity: room.entity,
            ver: room.ver,
            set: { b: 3 },
            valid_from: "2026-11-10",
            valid_to: "open",
            premises: [on],
          },
        ],
      })) as Receipt & { status: string };
      expect(w.status).toBe("pending");
      expect((await premiseBlocks(w.seq))["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-11-10" },
      });
    },
    T,
  );

  it(
    "a restatement with valid_to alone: from the entry day to it; with next_change: to the next change, its giver as deps",
    async () => {
      const on = await aBudget();
      const plan = await ok({
        ops: [{ intent: "insert", table: "plans", set: { label: "x" }, valid_from: "2026-11-01" }],
      });
      const entity = plan.ops[0]?.target.entity as string;
      const later = await ok({
        ops: [
          {
            intent: "update",
            table: "plans",
            entity,
            ver: plan.ops[0]?.ver,
            set: { label: "y" },
            valid_from: "2026-11-25",
          },
        ],
      });
      const ver = later.ops[0]?.ver;
      const to = await ok({
        ops: [
          {
            intent: "update",
            table: "plans",
            entity,
            ver,
            valid_to: "2026-11-20",
            premises: [on],
          },
        ],
      });
      expect((await premiseBlocks(to.seq))["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-11-05", to: "2026-11-20" },
      });
      const next = await ok({
        ops: [
          {
            intent: "update",
            table: "plans",
            entity,
            ver,
            valid_to: "next_change",
            premises: [on],
          },
        ],
      });
      const [base] = await basesOf(later.seq);
      expect((await premiseBlocks(next.seq))["ops/0/premise_valid/0"]).toEqual({
        during: { from: "2026-11-05", to: "2026-11-25" },
        deps: [{ event: base, field: "f7", k: 0 }],
      });
    },
    T,
  );
});

describe("the fan-in counts the edges in force once recorded", () => {
  const aTask = async (title: string) => {
    const t = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title } }] });
    return { row: t.ops[0]?.target.row as string, ver: t.ops[0]?.ver as string };
  };

  it(
    "a declaration this request cleared does not count",
    async () => {
      premiseFanInLimitForTests(1);
      const r = await release("v2", "2026-12-01");
      const on = [{ table: "releases", row: r.target.row, ver: r.ver }];
      const t = await aTask("a");
      await ok({
        ops: [
          { intent: "update", table: "tasks", row: t.row, ver: t.ver, premises: on },
          { intent: "update", table: "tasks", row: t.row, ver: t.ver, premises: [] },
          { intent: "insert", table: "tasks", set: { title: "u" }, premises: on },
        ],
      });
    },
    T,
  );

  it(
    "a declaration this request superseded does not count: one in force after, so another is refused",
    async () => {
      premiseFanInLimitForTests(1);
      const r = await release("v2", "2026-12-01");
      const on = [{ table: "releases", row: r.target.row, ver: r.ver }];
      const t = await aTask("a");
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: t.row,
            ver: t.ver,
            set: { title: "b" },
            premises: on,
          },
          { intent: "update", table: "tasks", row: t.row, ver: t.ver, premises: on },
        ],
      });
      expect(
        await send({
          ops: [{ intent: "insert", table: "tasks", set: { title: "u" }, premises: on }],
        }),
      ).toMatchObject({ refused: "too_large", reason: "premise_fan_in", count: 1 });
    },
    T,
  );

  it(
    "at the limit, the depending row restating on the same target: taken, the old one superseded",
    async () => {
      premiseFanInLimitForTests(1);
      const r = await release("v2", "2026-12-01");
      const on = [{ table: "releases", row: r.target.row, ver: r.ver }];
      const t = await ok({
        ops: [{ intent: "insert", table: "tasks", set: { title: "a" }, premises: on }],
      });
      await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row: t.ops[0]?.target.row,
            ver: t.ops[0]?.ver,
            premises: on,
          },
        ],
      });
    },
    T,
  );
});

describe("covers as judging sees them, and every carried item", () => {
  it(
    "the current value corroborated since the version: a restatement and a clearing at that version cover the corroboration",
    async () => {
      const r = await release("v2", "2026-12-01");
      const on = [{ table: "releases", row: r.target.row, ver: r.ver }];
      const t = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "a" } }] });
      const row = t.ops[0]?.target.row as string;
      const ver = t.ops[0]?.ver as string;
      const corroborated = await ok({
        evidence: [{ kind: "user_message", text: "the title is a" }],
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver,
            set: { title: "a" },
            evidence_by_field: { title: [0] },
            premises: on,
          },
        ],
      });
      // A corroboration leaves the version as it was.
      expect(corroborated.ops[0]?.ver).toBe(ver);
      const [inserted] = await basesOf(t.seq);
      const [corroboration] = await basesOf(corroborated.seq);
      const both = [
        { event: inserted, field: "f3", k: 0 },
        { event: corroboration, field: "f3", k: 0 },
      ];
      const restated = await ok({
        ops: [{ intent: "update", table: "tasks", row, ver, premises: on }],
      });
      expect((await premiseBlocks(restated.seq))["ops/0/premise_covers"]).toEqual(both);
      const cleared = await ok({
        ops: [{ intent: "update", table: "tasks", row, ver, premises: [] }],
      });
      expect((await premiseBlocks(cleared.seq))["ops/0/premise_covers"]).toEqual(both);
    },
    T,
  );

  it(
    "a candidate taken with a same-valued one: a restatement covers both items it carries",
    async () => {
      const r = await release("v2", "2026-12-01");
      const t = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "a" } }] });
      const row = t.ops[0]?.target.row as string;
      const v1 = t.ops[0]?.ver as string;
      await ok({ ops: [{ intent: "update", table: "tasks", row, ver: v1, set: { title: "x" } }] });
      // Two writes from the first version, both "y": two candidates of one item.
      const stale = (key: string) =>
        send({
          idempotency_key: key,
          ops: [{ intent: "update", table: "tasks", row, ver: v1, set: { title: "y" } }],
        }) as Promise<Receipt & { seq: number; pending: { id: string; item_ver: string }[] }>;
      const b = await stale("b");
      const c = await stale("c");
      expect(c.pending[0]).toMatchObject({ id: b.pending[0]?.id, merged: true });
      // Merged into it: the item's version is c's operation.
      const itemVer = b.pending[0]?.item_ver.replace(/\.\d+\.0$/, `.${c.seq}.0`);
      const taken = await resolve({
        id: c.pending[0]?.id,
        decision: "take_candidate",
        candidate: 0,
        item_ver: itemVer,
        idempotency_key: "take",
      });
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: taken.write.ops[0]?.ver,
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      const [fromB] = await basesOf(b.seq);
      const [fromC] = await basesOf(c.seq);
      expect((await premiseBlocks(w.seq))["ops/0/premise_covers"]).toEqual([
        { event: fromB, field: "f3", k: 0 },
        { event: fromC, field: "f3", k: 0 },
      ]);
    },
    T,
  );
});

describe("a return to the merge base", () => {
  it(
    "take_previous: a restatement covers the merge base's item its write-back carries",
    async () => {
      const r = await release("v2", "2026-12-01");
      const t = await ok({ ops: [{ intent: "insert", table: "tasks", set: { title: "a" } }] });
      const row = t.ops[0]?.target.row as string;
      const v1 = t.ops[0]?.ver as string;
      await ok({ ops: [{ intent: "update", table: "tasks", row, ver: v1, set: { title: "x" } }] });
      const stale = (await send({
        ops: [{ intent: "update", table: "tasks", row, ver: v1, set: { title: "y" } }],
      })) as Receipt & { pending: { id: string; item_ver: string }[] };
      const back = await resolve({
        id: stale.pending[0]?.id,
        decision: "take_previous",
        item_ver: stale.pending[0]?.item_ver,
        idempotency_key: "previous",
      });
      const w = await ok({
        ops: [
          {
            intent: "update",
            table: "tasks",
            row,
            ver: back.write.ops[0]?.ver,
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      });
      const [inserted] = await basesOf(t.seq);
      expect((await premiseBlocks(w.seq))["ops/0/premise_covers"]).toEqual([
        { event: inserted, field: "f3", k: 0 },
      ]);
    },
    T,
  );
});

describe("the request key with an explicit idempotency key (04-contract §14)", () => {
  it(
    "the same key and body again, the premise changed in between: the first receipt replayed",
    async () => {
      const r = await release("v2", "2026-12-01");
      const params = {
        idempotency_key: "once",
        ops: [
          {
            intent: "insert",
            table: "tasks",
            set: { title: "a" },
            premises: [{ table: "releases", row: r.target.row, ver: r.ver }],
          },
        ],
      };
      const first = await ok(params);
      expect(first.ops[0]?.premises).toMatchObject([{ state: "current" }]);
      await changeRelease(r.target.row, r.ver, { name: "x" });
      const before = await tail();
      const again = await ok(params);
      expect(await tail()).toBe(before);
      expect(again).toEqual({ ...first, replayed: true });
    },
    T,
  );
});
