// `history` with `mode: "changes"` on PGlite (04-contract §10 `history`; 04-contract-types §4.5):
// what changed in a table, or in one row or entity, after `since` and up to `until`, read from the
// version table; each refusal; the window by an operation number, an instant and `my_last_read`.

import {
  appendOperation,
  applyEvents,
  catalog,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  loadRsql,
  query,
  readBufferOf,
  resolve,
  write,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;

// The slot's tables: runs (event), budgets (state by date, keyed by category), shoes (timeless), and
// a derived table over runs.
let COMPILED: ReturnType<typeof derivedSchema>;
let CHANGES: Record<string, unknown>[];

let s: ReusableStore;
let minute = 0;
const clock = () => {
  minute++;
  return `2026-11-05T03:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const ctx = (
  o: { actor?: string; now?: string; task?: string | null; visibility?: unknown } = {},
) =>
  createOpsContext({
    tenant: TENANT,
    actor: o.actor ?? USER,
    trigger: null,
    task: o.task ?? null,
    visibility: (o.visibility ?? { kind: "all" }) as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: o.now ?? clock(),
    confirmation: null,
  });
type Receipt = Awaited<ReturnType<typeof write>>;
const w = (params: Record<string, unknown>, actor = USER): Promise<Receipt> =>
  write(s.store, ctx({ actor }), { sv: 1, ...params });
type Result = Record<string, unknown>;
const h = (params: Record<string, unknown>, o: Parameters<typeof ctx>[0] = {}) =>
  history(s.store, ctx(o), { mode: "changes", ...params }) as unknown as Promise<Result>;
async function refused(params: unknown, o: Parameters<typeof ctx>[0] = {}) {
  try {
    await history(s.store, ctx(o), params);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}
const changes = (r: Result) => r["changes"] as Record<string, unknown>[];

/** Confirms the item a write left awaiting: the operation of the write it then makes. */
async function confirm(receipt: Receipt): Promise<number> {
  const item = (receipt as unknown as { pending: { id: string; item_ver: string }[] }).pending[0];
  const r = (await resolve(s.store, ctx(), {
    id: item?.id,
    decision: "confirm",
    item_ver: item?.item_ver,
  })) as unknown as { write: { seq: number } };
  return r.write.seq;
}

let run: string;
let run2: string;
let food: string;
let rent: string;
const ops: Record<string, number> = {};

beforeAll(async () => {
  await loadRsql();
  COMPILED = {
    ...derivedSchema(rule("SELECT sum(distance) AS total FROM runs", ["total"], "none")),
    slot: SLOT,
  };
  // A state table with two fields that change on their own: a stretch of one is cut where the
  // other changes.
  const budgets = COMPILED.tables.find((t) => t.name === "budgets") as never as Record<
    string,
    unknown
  >;
  COMPILED = {
    ...COMPILED,
    tables: [
      ...COMPILED.tables,
      {
        ...budgets,
        id: "t10",
        name: "plans",
        physical: { table: "t_t10_v1" },
        fields: [
          ...(budgets["fields"] as unknown[]),
          { id: "f3", name: "note", type: "text", description: "a note" },
        ],
      } as never,
    ],
  };
  CHANGES = [
    { target: { slot: true }, change: "create_slot" },
    ...COMPILED.tables.map((t) => ({
      target: { table: t.id },
      change: t.kind === "base" ? "add_table" : "add_derived_table",
    })),
  ].map((c) => ({
    ...c,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  }));
  s = await openReusable("saveslot-changes-", { buffered: true });
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  minute = 0;
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
      now: "2026-11-05T00:00:00.000Z",
      confirmation: null,
    }),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
  const km = (value: string) => ({ value, unit: "km" });
  const cny = (value: string) => ({ value, unit: "CNY" });
  const ins = await w({
    evidence: [{ kind: "user_message", text: "ran 5 km on the 1st, easy" }],
    ops: [
      {
        intent: "insert",
        table: "runs",
        set: { date: "2026-11-01", distance: km("5"), feeling: "easy" },
      },
    ],
  });
  run = ins.ops[0]?.target.row as string;
  ops["insert"] = ins.seq;
  ops["update"] = (
    await w({ ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "hard" } }] })
  ).seq;
  ops["correct"] = (
    await w({
      ops: [{ intent: "correct", table: "runs", row: run, set: { distance: km("6") } }],
    })
  ).seq;
  ops["revoke"] = (await w({ ops: [{ intent: "revoke", table: "runs", row: run }] })).seq;
  ops["restore"] = (
    await w({ ops: [{ table: "runs", row: run, revert: { undo: ops["revoke"] } }] })
  ).seq;
  ops["undo_correct"] = (
    await w({ ops: [{ table: "runs", row: run, revert: { undo: ops["correct"] } }] })
  ).seq;
  const two = await w({
    ops: [{ intent: "insert", table: "runs", set: { date: "2026-11-02", distance: km("3") } }],
  });
  run2 = two.ops[0]?.target.row as string;
  ops["insert2"] = two.seq;
  const b = await w({
    ops: [
      {
        intent: "update",
        table: "budgets",
        entity_key: { category: "food" },
        set: { amount: cny("100") },
        valid_from: "2026-11-01",
      },
    ],
  });
  food = b.ops[0]?.target.entity as string;
  ops["budget"] = b.seq;
  ops["raise"] = (
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity: food,
          set: { amount: cny("150") },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    })
  ).seq;
  // Over a change point: awaiting confirmation, no change until it is confirmed.
  const over = await w({
    ops: [
      {
        intent: "update",
        table: "budgets",
        entity: food,
        set: { amount: cny("120") },
        valid_from: "2026-11-05",
        valid_to: "2026-11-15",
      },
    ],
  });
  ops["overlap"] = over.seq;
  ops["confirm"] = await confirm(over);
  ops["gap"] = (
    await w({
      ops: [
        {
          intent: "revoke",
          table: "budgets",
          entity: food,
          valid_from: "2026-11-12",
          valid_to: "2026-11-14",
        },
      ],
    })
  ).seq;
  const r = await w({
    ops: [
      {
        intent: "update",
        table: "budgets",
        entity_key: { category: "rent" },
        set: { amount: cny("2000") },
        valid_from: "2026-11-01",
      },
    ],
  });
  rent = r.ops[0]?.target.entity as string;
  ops["rent"] = r.seq;
  readBufferOf(s.store).take();
}, T);

const seqs = (r: Result) => changes(r).map((c) => c["seq"]);
const km = (value: string) => ({ value, unit: "km" });
const cny = (value: string) => ({ value, unit: "CNY" });
const day = (from: string, to: string | null, last?: string) => ({
  valid_from: from,
  valid_to: to,
  ...(last !== undefined ? { valid_to_inclusive: last } : {}),
});

describe("the changes of an event table", () => {
  it("lists what each operation changed, newest first: a correct, a revoke, and an undo", async () => {
    const r = await h({ table: "runs", since: 0 });
    expect(r).toMatchObject({
      mode: "changes",
      target: { table: "health.runs" },
      timezone: "Asia/Shanghai",
      since: 0,
      until: ops["rent"],
      total: 7,
    });
    expect(seqs(r)).toEqual([
      ops["insert2"],
      ops["undo_correct"],
      ops["restore"],
      ops["revoke"],
      ops["correct"],
      ops["update"],
      ops["insert"],
    ]);
    expect(r).not.toHaveProperty("next_cursor");
    const [i2, undoCorrect, restore, revoke, correct, update, insert] = changes(r);
    const t = (row: string) => ({ table: "health.runs", row });
    expect(insert).toMatchObject({
      intent: "insert",
      target: t(run),
      actor: { kind: "user", id: USER },
      fields: {
        date: { after: "2026-11-01" },
        distance: { after: km("5") },
        feeling: { after: "easy" },
      },
    });
    // What changed, and nothing else: no `before` of a field that had no value.
    expect(Object.keys((insert as { fields: object }).fields).sort()).toEqual([
      "date",
      "distance",
      "feeling",
    ]);
    expect(update).toMatchObject({
      intent: "update",
      fields: { feeling: { before: "easy", after: "hard" } },
    });
    expect(Object.keys((update as { fields: object }).fields)).toEqual(["feeling"]);
    expect(correct).toMatchObject({
      intent: "correct",
      fields: { distance: { before: km("5"), after: km("6") } },
    });
    // A revoke changes whether the row exists, not its fields; taking it back is the other way.
    expect(revoke).toMatchObject({
      intent: "revoke",
      fields: { "*": { before: true, after: false } },
    });
    expect(Object.keys((revoke as { fields: object }).fields)).toEqual(["*"]);
    expect(restore).toMatchObject({ fields: { "*": { before: false, after: true } } });
    expect(Object.keys((restore as { fields: object }).fields)).toEqual(["*"]);
    // An undo is a write that puts back the value: the change is the values, intent as recorded.
    expect(undoCorrect).toMatchObject({
      intent: "correct",
      target: t(run),
      fields: { distance: { before: km("6"), after: km("5") } },
    });
    expect(i2).toMatchObject({ intent: "insert", target: t(run2) });
    expect(insert).toHaveProperty("recorded_at");
  });

  it("is the changes of one row when given it, and of its table when not", async () => {
    const one = await h({ table: "runs", row: run2, since: 0 });
    expect(one).toMatchObject({ target: { table: "health.runs", row: run2 }, total: 1 });
    expect(seqs(one)).toEqual([ops["insert2"]]);
    const first = await h({ table: "runs", row: run, since: 0 });
    expect(first["total"]).toBe(6);
    expect(first["target"]).toEqual({ table: "health.runs", row: run });
  });

  it("counts existence and fields apart: a field written and the row revoked by one request gives both", async () => {
    await w({ ops: [{ intent: "update", table: "runs", row: run2, set: { feeling: "ok" } }] });
    const both = await w({
      ops: [
        { intent: "update", table: "runs", row: run2, set: { feeling: "gone" } },
        { intent: "revoke", table: "runs", row: run2 },
      ],
    });
    const r = await h({ table: "runs", row: run2, since: both.seq - 1 });
    const fields = (changes(r)[0] as { fields: Record<string, unknown> }).fields;
    expect(fields).toEqual({
      "*": { before: true, after: false },
      feeling: { before: "ok", after: "gone" },
    });
    expect(Object.keys(fields)).toEqual(["*", "feeling"]);
  });

  it("gives the values a row comes back with when the revoke is undone together with an update", async () => {
    await w({ ops: [{ intent: "update", table: "runs", row: run2, set: { feeling: "fine" } }] });
    const revoke = await w({ ops: [{ intent: "revoke", table: "runs", row: run2 }] });
    const back = await w({
      ops: [
        { table: "runs", row: run2, revert: { undo: revoke.seq } },
        { intent: "update", table: "runs", row: run2, set: { feeling: "new" } },
      ],
    });
    const r = await h({ table: "runs", row: run2, since: back.seq - 1 });
    const fields = (changes(r)[0] as { fields: Record<string, unknown> }).fields;
    expect(fields).toEqual({
      "*": { before: false, after: true },
      feeling: { before: "fine", after: "new" },
    });
    expect(Object.keys(fields)).toEqual(["*", "feeling"]);
  });

  it("takes the operation's net change: a row written twice by one request is one entry", async () => {
    const both = await w({
      ops: [
        { intent: "update", table: "runs", row: run, set: { feeling: "tired" } },
        { intent: "update", table: "runs", row: run, set: { feeling: "fine" } },
        { intent: "update", table: "runs", row: run2, set: { feeling: "ok" } },
      ],
    });
    const r = await h({ table: "runs", since: both.seq - 1 });
    // Two entries of one operation, by target ID.
    expect(seqs(r)).toEqual([both.seq, both.seq]);
    const rows = changes(r).map((c) => (c["target"] as { row: string }).row);
    expect(rows).toEqual([run, run2].sort());
    const byRow = new Map(changes(r).map((c) => [(c["target"] as { row: string }).row, c]));
    expect(byRow.get(run)).toMatchObject({
      fields: { feeling: { before: "hard", after: "fine" } },
    });
    expect(byRow.get(run2)).toMatchObject({ fields: { feeling: { after: "ok" } } });
  });

  it("gives a write that changes nothing no entry: the same value again", async () => {
    const same = await w({
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "hard" } }],
    });
    const r = await h({ table: "runs", since: same.seq - 1 });
    expect(changes(r)).toEqual([]);
    expect(r).toMatchObject({ total: 0, since: ops["rent"], until: same.seq });
  });

  it("covers a table without time too", async () => {
    const shoe = await w({ ops: [{ intent: "insert", table: "shoes", set: { model: "air" } }] });
    const row = shoe.ops[0]?.target.row as string;
    const up = await w({ ops: [{ intent: "update", table: "shoes", row, set: { model: "max" } }] });
    const r = await h({ table: "shoes", since: 0 });
    expect(seqs(r)).toEqual([up.seq, shoe.seq]);
    expect(changes(r)[0]).toMatchObject({ fields: { model: { before: "air", after: "max" } } });
    expect(changes(r)[1]).toMatchObject({ intent: "insert", fields: { model: { after: "air" } } });
  });
});

describe("the changes of a state table", () => {
  it("gives only the stretch a write changed, not the pieces its cut left as they were", async () => {
    // 100 from 11-01 on, 150 written over [11-10, 11-20): the segment is cut in three; two keep
    // their value.
    const r = await h({
      table: "budgets",
      entity: food,
      since: ops["budget"] as number,
      until: ops["raise"],
    });
    expect(r).toMatchObject({ target: { table: "health.budgets", entity: food }, total: 1 });
    expect(changes(r)).toHaveLength(1);
    const [raise] = changes(r);
    expect(raise).toMatchObject({ seq: ops["raise"], intent: "update", target: { entity: food } });
    expect((raise as { fields: object }).fields).toEqual({
      amount: [
        {
          before: cny("100"),
          after: cny("150"),
          valid: day("2026-11-10", "2026-11-20", "2026-11-19"),
        },
      ],
    });
  });

  it("gives a first write's whole stretch, a field's stretches as they run together", async () => {
    const r = await h({ table: "budgets", entity: food, since: 0, until: ops["budget"] });
    expect(changes(r)).toHaveLength(1);
    expect((changes(r)[0] as { fields: object }).fields).toEqual({
      category: [{ after: "food", valid: day("2026-11-01", null) }],
      amount: [{ after: cny("100"), valid: day("2026-11-01", null) }],
    });
  });

  it("gives no change for a write awaiting confirmation, and the stretches of it once confirmed", async () => {
    const waiting = await h({
      table: "budgets",
      since: ops["raise"] as number,
      until: ops["overlap"],
    });
    expect(changes(waiting)).toEqual([]);
    const r = await h({ table: "budgets", since: ops["raise"] as number, until: ops["confirm"] });
    expect(seqs(r)).toEqual([ops["confirm"]]);
    // 120 over [11-05, 11-15): it changed a stretch of 100 and one of 150, two parts.
    expect((changes(r)[0] as { fields: object }).fields).toEqual({
      amount: [
        {
          before: cny("100"),
          after: cny("120"),
          valid: day("2026-11-05", "2026-11-10", "2026-11-09"),
        },
        {
          before: cny("150"),
          after: cny("120"),
          valid: day("2026-11-10", "2026-11-15", "2026-11-14"),
        },
      ],
    });
    expect(changes(r)[0]).toMatchObject({ intent: "update", target: { entity: food } });
  });

  it("gives a revoked stretch as `*` and the values it takes away", async () => {
    const r = await h({ table: "budgets", since: ops["confirm"] as number, until: ops["gap"] });
    expect(seqs(r)).toEqual([ops["gap"]]);
    const fields = (changes(r)[0] as { fields: Record<string, unknown> }).fields;
    const gap = day("2026-11-12", "2026-11-14", "2026-11-13");
    expect(fields["*"]).toEqual([{ before: true, after: false, valid: gap }]);
    expect(fields["amount"]).toEqual([{ before: cny("120"), valid: gap }]);
    expect(changes(r)[0]).toMatchObject({ intent: "revoke" });
  });

  it("gives a whole entity's revoke, and an undo that puts back only what it still can", async () => {
    const rev = await w({ ops: [{ intent: "revoke", table: "budgets", entity: rent }] });
    const r = await h({ table: "budgets", entity: rent, since: rev.seq - 1 });
    expect(changes(r)).toHaveLength(1);
    expect((changes(r)[0] as { fields: Record<string, unknown> }).fields["*"]).toEqual([
      { before: true, after: false, valid: day("2026-11-01", null) },
    ]);
    // The undo of the raise: its 150 is still in effect only on [11-15, 11-20), the rest was
    // overwritten (11-05 to 11-15 by the confirmed 120) or revoked (11-12 to 11-14).
    const undo = await w({
      ops: [{ table: "budgets", entity: food, revert: { undo: ops["raise"] } }],
    });
    // It puts back over a change point: awaiting confirmation, no change until then.
    expect(
      changes(await h({ table: "budgets", entity: food, since: ops["gap"] as number })),
    ).toEqual([]);
    const done = await confirm(undo);
    const u = await h({ table: "budgets", entity: food, since: undo.seq });
    expect(seqs(u)).toEqual([done]);
    expect((changes(u)[0] as { fields: object }).fields).toEqual({
      amount: [
        {
          before: cny("150"),
          after: cny("100"),
          valid: day("2026-11-15", "2026-11-20", "2026-11-19"),
        },
      ],
    });
  });

  it("finds the entity by its key", async () => {
    const byKey = await h({ table: "budgets", entity_key: { category: "rent" }, since: 0 });
    expect(byKey).toMatchObject({ target: { table: "health.budgets", entity: rent }, total: 1 });
    expect(seqs(byKey)).toEqual([ops["rent"]]);
  });

  it("gives the whole table's entities, newest first", async () => {
    const r = await h({ table: "budgets", since: 0 });
    expect(seqs(r)).toEqual([ops["rent"], ops["gap"], ops["confirm"], ops["raise"], ops["budget"]]);
    expect(r["total"]).toBe(5);
  });
});

describe("the corners of the changes of a write", () => {
  const cny2 = (v: string) => ({ value: v, unit: "CNY" });
  const km2 = (v: string) => ({ value: v, unit: "km" });
  const onRun = async (extra: Record<string, unknown>[], target = run) =>
    w({ ops: extra.map((o) => ({ table: "runs", row: target, ...o })) });

  it("gives an operation that opened and closed cells with no net change no entry", async () => {
    // run2 has no feeling: a request that sets one and clears it again nets to nothing.
    const net = await w({
      ops: [
        { intent: "update", table: "runs", row: run2, set: { feeling: "tmp" } },
        { intent: "update", table: "runs", row: run2, set: { feeling: null } },
      ],
    });
    const r = await h({ table: "runs", row: run2, since: net.seq - 1 });
    expect(changes(r)).toEqual([]);
    expect(r).toMatchObject({ total: 0, until: net.seq });
  });

  it("takes the intent of the latest contribution when one operation mixes intents", async () => {
    // The request's last op is the one the entry is named for, whichever way round they come.
    const a = await onRun([
      { intent: "update", set: { feeling: "m1" } },
      { intent: "correct", set: { distance: km2("7") } },
    ]);
    const b = await onRun([
      { intent: "correct", set: { distance: km2("8") } },
      { intent: "update", set: { feeling: "m2" } },
    ]);
    const r = await h({ table: "runs", row: run, since: a.seq - 1 });
    expect(changes(r).map((c) => [c["seq"], c["intent"]])).toEqual([
      [b.seq, "update"],
      [a.seq, "correct"],
    ]);
    // Both fields are in the entry whatever its intent.
    expect(Object.keys(changes(r)[0]?.["fields"] as object).sort()).toEqual([
      "distance",
      "feeling",
    ]);
  });

  it("merges the stretches of `*` an operation puts back when they were taken one by one", async () => {
    const e = await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity_key: { category: "fun" },
          set: { amount: cny2("100") },
          valid_from: "2026-11-01",
        },
      ],
    });
    const fun = e.ops[0]?.target.entity as string;
    const cut = (from: string, to: string) =>
      w({
        ops: [{ intent: "revoke", table: "budgets", entity: fun, valid_from: from, valid_to: to }],
      });
    const [a, b] = [await cut("2026-11-05", "2026-11-10"), await cut("2026-11-10", "2026-11-15")];
    // One request takes both back: two cells close at one operation.
    const back = await w({
      ops: [
        { table: "budgets", entity: fun, revert: { undo: a.seq } },
        { table: "budgets", entity: fun, revert: { undo: b.seq } },
      ],
    });
    const r = await h({ table: "budgets", entity: fun, since: back.seq - 1 });
    const fields = (changes(r)[0] as { fields: Record<string, unknown[]> }).fields;
    expect(fields["*"]).toEqual([
      { before: false, after: true, valid: day("2026-11-05", "2026-11-15", "2026-11-14") },
    ]);
    // The values put back are the cells', stretch by stretch, as written.
    expect(fields["amount"]).toEqual([
      { after: cny2("100"), valid: day("2026-11-05", "2026-11-15", "2026-11-14") },
    ]);
  });

  it("merges a field's stretches that run together though another field cut them", async () => {
    const e = await w({
      ops: [
        {
          intent: "update",
          table: "plans",
          entity_key: { category: "trip" },
          set: { amount: cny2("100"), note: "a" },
          valid_from: "2026-11-01",
        },
      ],
    });
    const plan = e.ops[0]?.target.entity as string;
    // The note changes on the 10th: the entity has two segments, which have one amount.
    await w({
      ops: [
        {
          intent: "update",
          table: "plans",
          entity: plan,
          set: { note: "b" },
          valid_from: "2026-11-10",
        },
      ],
    });
    const raise = await w({
      ops: [
        {
          intent: "update",
          table: "plans",
          entity: plan,
          set: { amount: cny2("150") },
          valid_from: "2026-11-05",
          valid_to: "2026-11-15",
        },
      ],
    });
    const r = await h({ table: "plans", entity: plan, since: raise.seq - 1 });
    const fields = (changes(r)[0] as { fields: Record<string, unknown[]> }).fields;
    // One stretch, not one for each segment the note's change left.
    expect(fields["amount"]).toEqual([
      {
        before: cny2("100"),
        after: cny2("150"),
        valid: day("2026-11-05", "2026-11-15", "2026-11-14"),
      },
    ]);
    expect(fields["note"]).toBeUndefined();
  });

  it("gives an instant-granularity state table's stretches, with an open end", async () => {
    const first = await w({
      ops: [
        {
          intent: "insert",
          table: "rooms",
          set: { guest: "ann" },
          valid_from: "2026-11-01T10:00:00Z",
        },
      ],
    });
    const room = first.ops[0]?.target.entity as string;
    const next = await w({
      ops: [
        {
          intent: "update",
          table: "rooms",
          entity: room,
          set: { guest: "bob" },
          valid_from: "2026-11-02T10:00:00Z",
        },
      ],
    });
    const r = await h({ table: "rooms", entity: room, since: 0 });
    expect(changes(r).map((c) => c["fields"])).toEqual([
      {
        guest: [
          {
            before: "ann",
            after: "bob",
            valid: { valid_from: "2026-11-02T10:00:00.000Z", valid_to: null },
          },
        ],
      },
      {
        guest: [
          { after: "ann", valid: { valid_from: "2026-11-01T10:00:00.000Z", valid_to: null } },
        ],
      },
    ]);
    expect(seqs(r)).toEqual([next.seq, first.seq]);
  });
});

describe("the window", () => {
  it("excludes `since` and includes `until`", async () => {
    const r = await h({ table: "runs", since: ops["update"] as number, until: ops["correct"] });
    expect(seqs(r)).toEqual([ops["correct"]]);
    expect(r).toMatchObject({ since: ops["update"], until: ops["correct"] });
    const upTo = await h({ table: "runs", since: 0, until: ops["update"] });
    expect(seqs(upTo)).toEqual([ops["update"], ops["insert"]]);
    // Before the first operation of the table and after the last: nothing; `since` = `until`: nothing.
    expect(changes(await h({ table: "runs", since: ops["insert2"] as number }))).toEqual([]);
    expect(
      changes(await h({ table: "runs", since: ops["update"] as number, until: ops["update"] })),
    ).toEqual([]);
  });

  it("is empty, and says where it was resolved to, when `since` is not before `until`", async () => {
    const r = await h({ table: "runs", since: ops["correct"] as number, until: ops["update"] });
    expect(changes(r)).toEqual([]);
    expect(r).toMatchObject({ since: ops["correct"], until: ops["update"], total: 0 });
  });

  it("goes to the latest operation by default, and a `until` past it is the latest", async () => {
    const latest = (await h({ table: "runs", since: 0 }))["until"];
    expect(await h({ table: "runs", since: 0, until: 100000 })).toMatchObject({ until: latest });
  });

  it("takes an instant as the last operation recorded by then", async () => {
    const all = changes(await h({ table: "runs", row: run, since: 0 }));
    const at = (op: unknown) => all.find((c) => c["seq"] === op)?.["recorded_at"] as string;
    // At the update's own instant, and after it before the next: the update is `since`.
    expect(
      await h({ table: "runs", since: at(ops["update"]), until: at(ops["correct"]) }),
    ).toMatchObject({
      since: ops["update"],
      until: ops["correct"],
    });
    const between = new Date(Date.parse(at(ops["update"])) + 30_000).toISOString();
    expect(await h({ table: "runs", since: between })).toMatchObject({ since: ops["update"] });
    // Before the first operation: from the start.
    expect(await h({ table: "runs", since: "2020-01-01T00:00:00Z" })).toMatchObject({ since: 0 });
    // A time zone given as an offset is the same instant.
    const offset = new Date(Date.parse(at(ops["update"])) + 8 * 3_600_000)
      .toISOString()
      .replace("Z", "+08:00");
    expect(await h({ table: "runs", since: offset })).toMatchObject({ since: ops["update"] });
  });

  it("refuses a point that is not one", async () => {
    for (const since of ["yesterday", "2026-11-05", -1, 1.5, true, null, {}]) {
      expect(await refused({ mode: "changes", table: "runs", since })).toMatchObject({
        code: "invalid_argument",
        param: "since",
      });
    }
    expect(
      await refused({ mode: "changes", table: "runs", since: 1, until: "soon" }),
    ).toMatchObject({
      code: "invalid_argument",
      reason: "malformed",
      param: "until",
    });
    expect(await refused({ mode: "changes", table: "runs" })).toMatchObject({
      code: "invalid_argument",
      reason: "missing",
      param: "since",
    });
  });
});

describe("my_last_read", () => {
  const q = (table: string, o: Parameters<typeof ctx>[0] = {}) => query(s.store, ctx(o), { table });
  const refusedFirst = (o: Parameters<typeof ctx>[0] = {}) =>
    refused({ mode: "changes", table: "runs", since: "my_last_read" }, o);

  it("is read_first when this connection has not read the table", async () => {
    expect(await refusedFirst()).toMatchObject({
      code: "read_first",
      reason: "no_read",
      target: "table",
      ref: { table: "health.runs" },
      param: "since",
    });
    // A read of another table, or by another connection, is not it; nor is a read of a derived
    // table (a read of the sums, not of the rows they sum).
    await q("budgets");
    await q("runs", { actor: OTHER });
    await q("weekly");
    expect(await refusedFirst()).toMatchObject({ code: "read_first", reason: "no_read" });
  });

  it("starts after the position of the connection's last read of the table", async () => {
    await q("runs");
    const mark = ops["rent"] as number;
    const more = await w({
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "x" } }],
    });
    const r = await h({ table: "runs", since: "my_last_read" });
    expect(r).toMatchObject({ since: mark, until: more.seq });
    expect(seqs(r)).toEqual([more.seq]);
  });

  it("counts the buffered reads and the written ones alike", async () => {
    await q("runs");
    // A write puts the buffered reads into the read log.
    const a = await w({
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "a" } }],
    });
    expect(readBufferOf(s.store).size).toBe(0);
    expect(await h({ table: "runs", since: "my_last_read" })).toMatchObject({
      since: ops["rent"],
      until: a.seq,
    });
  });

  it("is the call's task: only a read under the same task", async () => {
    await q("runs", { task: "a" });
    expect(await refusedFirst({ task: "b" })).toMatchObject({ code: "read_first" });
    expect(await refusedFirst()).toMatchObject({ code: "read_first" });
    expect(await h({ table: "runs", since: "my_last_read" }, { task: "a" })).toMatchObject({
      since: ops["rent"],
    });
    // Without a task, only a read without one.
    await q("runs");
    expect(await h({ table: "runs", since: "my_last_read" })).toMatchObject({ since: ops["rent"] });
  });

  describe("task_mismatch", () => {
    const mismatch = (readTask: string | null, task: string | null) => ({
      code: "read_first",
      reason: "task_mismatch",
      target: "table",
      ref: { table: "health.runs" },
      param: "since",
      read_task: readTask,
      task,
    });

    it("names both tasks when the table was read under another one", async () => {
      await q("runs", { task: "A" });
      expect(await refusedFirst({ task: "B" })).toEqual(mismatch("A", "B"));
    });

    it("names no task on the side that has none", async () => {
      await q("runs");
      expect(await refusedFirst({ task: "B" })).toEqual(mismatch(null, "B"));
    });

    it("is also the answer for a read without a task when this call has one, and the reverse", async () => {
      await q("runs", { task: "A" });
      expect(await refusedFirst()).toEqual(mismatch("A", null));
    });

    it("finds a read in the read log as well as in the buffer", async () => {
      await q("runs", { task: "A" });
      await w({ ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "z" } }] });
      expect(readBufferOf(s.store).size).toBe(0);
      expect(await refusedFirst({ task: "B" })).toEqual(mismatch("A", "B"));
    });

    it("prefers a read under the same task, and the latest other one otherwise", async () => {
      await q("runs", { task: "A" });
      await q("runs", { task: "C" });
      expect(await refusedFirst({ task: "B" })).toEqual(mismatch("C", "B"));
      await q("runs", { task: "B" });
      expect(await h({ table: "runs", since: "my_last_read" }, { task: "B" })).toMatchObject({
        total: 0,
      });
    });

    it("does not count a self-check read in the log either: no_read", async () => {
      // A read of the table that the log marks as the connect self-check (the buffer path is the
      // test below): written, as the log keeps it.
      const row = (id: string, selfcheck: boolean) =>
        s.store.write(async (tx) => {
          await tx.query(
            `INSERT INTO read_log (read_id, actor, task, at, pos, operation, selfcheck, table_id)
             VALUES ($1, $2, NULL, '2026-11-05T05:00:00.000Z', $3, 'query', $4, 't1')`,
            [id, USER, ops["rent"], selfcheck] as never,
          );
        });
      await row("rd_selfcheck", true);
      expect(await refusedFirst()).toMatchObject({ code: "read_first", reason: "no_read" });
      // The same row as an ordinary read counts.
      await s.store.write(async (tx) => {
        await tx.query("UPDATE read_log SET selfcheck = FALSE WHERE read_id = 'rd_selfcheck'");
      });
      expect(await h({ table: "runs", since: "my_last_read" })).toMatchObject({
        since: ops["rent"],
      });
    });

    it("does not count the connect self-check read: no_read", async () => {
      await catalog(s.store, ctx({ task: "saveslot-connect-selfcheck" }), {});
      expect(await refusedFirst()).toMatchObject({ code: "read_first", reason: "no_read" });
      expect(await refusedFirst({ task: "B" })).toMatchObject({ reason: "no_read" });
    });
  });

  it("is moved on by the call itself, not by a timeline of one row", async () => {
    await q("runs");
    const a = await w({
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "a" } }],
    });
    const first = await h({ table: "runs", since: "my_last_read" });
    expect(seqs(first)).toEqual([a.seq]);
    // The first call read the table up to `until`: the next one has nothing new.
    const next = await h({ table: "runs", since: "my_last_read" });
    expect(next).toMatchObject({ since: a.seq, until: a.seq, total: 0 });
    const b = await w({
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "b" } }],
    });
    await history(s.store, ctx(), { table: "runs", row: run });
    const c = await w({
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "c" } }],
    });
    // The timeline read one row: the table's position stays at the last whole-table read.
    expect(await h({ table: "runs", since: "my_last_read" })).toMatchObject({
      since: a.seq,
      until: c.seq,
    });
    expect(seqs(await h({ table: "runs", since: a.seq }))).toEqual([c.seq, b.seq]);
  });

  it("is the table's reads only: an as_of of one row is the row's, at its point", async () => {
    await q("runs");
    await history(s.store, ctx(), { table: "runs", row: run, mode: "as_of", as_of: ops["update"] });
    // The newer of the table's read and the row's is the row's (recorded later), at its point.
    expect(await h({ table: "runs", row: run, since: "my_last_read" })).toMatchObject({
      since: ops["update"],
    });
    expect(await h({ table: "runs", since: "my_last_read" })).toMatchObject({
      since: ops["rent"],
    });
  });
});

describe("my_last_read by scope", () => {
  const km = (value: string) => ({ value, unit: "km" });
  const q = (table: string, o: Parameters<typeof ctx>[0] = {}) => query(s.store, ctx(o), { table });
  const edit = (row: string, feeling: string, actor = USER) =>
    w({ ops: [{ intent: "update", table: "runs", row, set: { feeling } }] }, actor);
  const insert = async (actor = OTHER) =>
    (
      await w(
        {
          ops: [
            { intent: "insert", table: "runs", set: { date: "2026-11-03", distance: km("2") } },
          ],
        },
        actor,
      )
    ).ops[0]?.target.row as string;
  const whole = (extra: Record<string, unknown> = {}, o: Parameters<typeof ctx>[0] = {}) =>
    h({ table: "runs", since: "my_last_read", ...extra }, o);

  it("a read of one row is not a read of the table: no_read for a whole-table call", async () => {
    // Probe 1: another connection inserts a row X has never seen, X looks at the first row only,
    // then the new row is edited. The window (insert, edit] would hide the insert.
    const fresh = await insert();
    await history(s.store, ctx(), { table: "runs", row: run });
    await edit(fresh, "late", OTHER);
    expect(await refused({ mode: "changes", table: "runs", since: "my_last_read" })).toMatchObject({
      code: "read_first",
      reason: "no_read",
      target: "table",
      ref: { table: "health.runs" },
      param: "since",
    });
  });

  it("a read of the row counts for a call on that row, whichever is newer than a table read", async () => {
    const mine = { table: "runs", row: run };
    const call = (o: Parameters<typeof ctx>[0] = {}) => h({ ...mine, since: "my_last_read" }, o);
    await history(s.store, ctx(), { ...mine });
    const a = await edit(run, "a");
    expect(seqs(await call())).toEqual([a.seq]);
    // A table read newer than the row read moves it on; so does a row read newer than a table read.
    await q("runs");
    const b = await edit(run, "b");
    await history(s.store, ctx(), { ...mine, mode: "as_of", as_of: a.seq });
    expect(await call()).toMatchObject({ since: a.seq, until: b.seq });
    await q("runs");
    const c = await edit(run, "c");
    expect(await call()).toMatchObject({ since: b.seq, until: c.seq });
  });

  it("a whole-table changes call counts for the table; one on a row counts for that row only", async () => {
    await h({ table: "runs", since: 0, limit: 100 });
    const a = await edit(run, "a");
    expect(await whole()).toMatchObject({ since: expect.any(Number), until: a.seq });
    const b = await edit(run, "b");
    await h({ table: "runs", row: run, since: a.seq });
    // The row call read up to b for that row; a whole-table call still starts at the last read of
    // the table (the call before it), and the row's own `my_last_read` starts after b.
    expect(await whole()).toMatchObject({ since: a.seq, until: b.seq });
    const c = await edit(run, "c");
    expect(await h({ table: "runs", row: run, since: "my_last_read" })).toMatchObject({
      since: b.seq,
      until: c.seq,
    });
  });

  it("a read of another row is not this row's", async () => {
    await history(s.store, ctx(), { table: "runs", row: run2 });
    expect(
      await refused({ mode: "changes", table: "runs", row: run, since: "my_last_read" }),
    ).toMatchObject({ code: "read_first", reason: "no_read" });
  });

  it("the position moves only when the whole window was given: a first page that cuts it does not", async () => {
    // Probe 2: three changes since the last read, a page of two. The oldest is on the next page;
    // the connection that does not turn the page has not read it.
    await q("runs");
    const a = await edit(run, "a");
    const b = await edit(run, "b");
    const c = await edit(run, "c");
    const first = await whole({ limit: 2 });
    expect(seqs(first)).toEqual([c.seq, b.seq]);
    expect(first).toHaveProperty("next_position");
    const again = await whole({ limit: 2 });
    expect(seqs(again)).toEqual([c.seq, b.seq]);
    // Turning to the last page is what records the read.
    const next = await whole({
      limit: 2,
      position: (first as { next_position: string }).next_position,
    });
    expect(seqs(next)).toEqual([a.seq]);
    expect(next).not.toHaveProperty("next_position");
    expect(await whole()).toMatchObject({ since: c.seq, total: 0 });
  });

  it("a first page that holds the whole window records it at once", async () => {
    await q("runs");
    const a = await edit(run, "a");
    expect(seqs(await whole({ limit: 5 }))).toEqual([a.seq]);
    expect(await whole()).toMatchObject({ since: a.seq, total: 0 });
  });

  it("a middle page of three does not record either", async () => {
    await q("runs");
    const edits = [await edit(run, "a"), await edit(run, "b"), await edit(run, "c")];
    const p1 = (await whole({ limit: 1 })) as { next_position: string };
    const p2 = (await whole({ limit: 1, position: p1.next_position })) as {
      next_position: string;
    };
    expect(p2).toHaveProperty("next_position");
    const last = await whole();
    expect(seqs(last)).toEqual(edits.map((e) => e.seq).reverse());
  });
});

describe("pages", () => {
  const page = (o: Record<string, unknown> = {}) => h({ table: "runs", since: 0, limit: 3, ...o });

  it("pages newest first by limit and position, whole", async () => {
    const all = seqs(await h({ table: "runs", since: 0 }));
    const p1 = await page();
    expect(seqs(p1)).toEqual(all.slice(0, 3));
    expect(p1["total"]).toBe(7);
    const p2 = await page({ position: p1["next_position"] });
    expect(seqs(p2)).toEqual(all.slice(3, 6));
    const p3 = await page({ position: p2["next_position"] });
    expect(seqs(p3)).toEqual(all.slice(6));
    expect(p3).not.toHaveProperty("next_position");
    // The window is the first page's on every page.
    for (const p of [p1, p2, p3])
      expect(p).toMatchObject({ since: 0, until: ops["rent"], total: 7 });
  });

  it("keeps the first page's window while writes go on", async () => {
    const p1 = await page({ until: ops["correct"], limit: 2 });
    await w({ ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "later" } }] });
    const p2 = await page({ until: ops["correct"], limit: 2, position: p1["next_position"] });
    expect(p2).toMatchObject({ until: ops["correct"] });
    expect(seqs(p1).concat(seqs(p2))).toEqual(
      [ops["correct"], ops["update"], ops["insert"]].slice(0, 3),
    );
    // Without `until`: later writes are after the window.
    const q1 = await page();
    const written = await w({
      ops: [{ intent: "update", table: "runs", row: run2, set: { feeling: "z" } }],
    });
    const q2 = await page({ position: q1["next_position"] });
    expect(seqs(q1).concat(seqs(q2))).not.toContain(written.seq);
    expect(q2["until"]).toBe(q1["until"]);
    expect(q1["until"]).toBeLessThan(written.seq);
  });

  it("keeps `my_last_read` of the first page on later pages, though the first page was a read", async () => {
    await query(s.store, ctx(), { table: "runs" });
    for (let n = 0; n < 4; n++) {
      await w({ ops: [{ intent: "update", table: "runs", row: run, set: { feeling: `f${n}` } }] });
    }
    const p1 = await h({ table: "runs", since: "my_last_read", limit: 2 });
    expect(p1).toMatchObject({ since: ops["rent"], total: 4 });
    // The first page is a read of the table now; a later page does not take it for `since`.
    const p2 = await h({
      table: "runs",
      since: "my_last_read",
      limit: 2,
      position: p1["next_position"],
    });
    expect(p2).toMatchObject({ since: ops["rent"], until: p1["until"], total: 4 });
    expect(seqs(p1).concat(seqs(p2))).toHaveLength(4);
    expect(p2).not.toHaveProperty("next_position");
  });

  it("refuses a position of another call", async () => {
    const p1 = await page();
    const position = p1["next_position"];
    for (const other of [
      { since: 1 },
      { until: ops["rent"] },
      { table: "budgets" },
      { row: run },
      { limit: 2 + 1, since: 1 },
    ]) {
      expect(
        await refused({ mode: "changes", table: "runs", since: 0, limit: 3, ...other, position }),
      ).toMatchObject({
        code: "invalid_argument",
        reason: "malformed",
        param: "position",
      });
    }
    // Nor a changes position given to a timeline.
    expect(await refused({ table: "runs", row: run, limit: 3, position })).toMatchObject({
      reason: "malformed",
      param: "position",
    });
  });

  it("refuses a position whose window start is missing, or later than the latest operation", async () => {
    const p1 = await page();
    const forged = (edit: (x: Record<string, unknown>) => void) => {
      const x = JSON.parse(Buffer.from(p1["next_position"] as string, "base64url").toString());
      edit(x);
      return Buffer.from(JSON.stringify(x)).toString("base64url");
    };
    for (const position of [
      forged((x) => {
        delete x["f"];
      }),
      forged((x) => {
        x["f"] = 1_000_000;
      }),
      forged((x) => {
        x["f"] = "3";
      }),
    ]) {
      expect(
        await refused({ mode: "changes", table: "runs", since: 0, limit: 3, position }),
      ).toMatchObject({ code: "invalid_argument", reason: "malformed", param: "position" });
    }
  });

  it("refuses a position from before a restore", async () => {
    // The restore count is part of the position (04-contract §15); a position made up with another is refused.
    const p1 = await page();
    const forged = JSON.parse(Buffer.from(p1["next_position"] as string, "base64url").toString());
    forged.r = 1;
    const position = Buffer.from(JSON.stringify(forged)).toString("base64url");
    expect(
      await refused({ mode: "changes", table: "runs", since: 0, limit: 3, position }),
    ).toMatchObject({
      code: "handle_expired",
      reason: "restored",
    });
  });
});

describe("what a call may see", () => {
  const scoped = (...tables: string[]) => ({
    kind: "scoped",
    slots: [{ slot: SLOT, tables: tables.map((table) => ({ table })) }],
  });

  it("does not see a table out of the visible range: as a table that does not exist", async () => {
    const elsewhere = { kind: "scoped", slots: [{ slot: `sl_${"9".repeat(16)}` }] };
    const out = await refused(
      { mode: "changes", table: "runs", since: 0 },
      { visibility: elsewhere },
    );
    const none = await refused(
      { mode: "changes", table: "nothing", since: 0 },
      { visibility: elsewhere },
    );
    expect(out).toMatchObject({ code: "unknown_table", param: "table", nearest: [] });
    expect({ ...out, name: undefined }).toEqual({ ...none, name: undefined });
    // A table of a slot in range, but not itself: the same, with the tables of the range as the near ones.
    const only = await refused(
      { mode: "changes", table: "runs", since: 0 },
      { visibility: scoped("t3") },
    );
    expect(only).toMatchObject({ code: "unknown_table", nearest: ["budgets"] });
    // The whole table, without a target, is as far as the table is in range.
    const seen = await h({ table: "budgets", since: 0 }, { visibility: scoped("t3") });
    expect(seen["total"]).toBe(5);
    expect(
      await refused(
        { mode: "changes", table: "runs", row: run, since: 0 },
        { visibility: scoped("t3") },
      ),
    ).toMatchObject({ code: "unknown_table" });
  });

  it("does not take a derived table", async () => {
    expect(await refused({ mode: "changes", table: "weekly", since: 0 })).toMatchObject({
      code: "invalid_argument",
      reason: "derived_table",
      param: "table",
    });
    expect(await refused({ mode: "changes", table: "health.weekly", since: 0 })).toMatchObject({
      reason: "derived_table",
    });
  });
});

describe("the parameters of a mode", () => {
  it("refuses the other modes' parameters with the mode's example", async () => {
    for (const p of [
      { as_of: 3 },
      { valid_at: "2026-11-01" },
      { expand_sources: true },
      { detail: "concise" },
    ]) {
      const e = await refused({ mode: "changes", table: "runs", since: 0, ...p });
      expect(e).toMatchObject({
        code: "invalid_argument",
        reason: "mode_mismatch",
        param: Object.keys(p)[0],
        example: { table: "runs", mode: "changes", since: 25 },
      });
    }
    // And `changes`' parameters with the others: they say what is for `changes`.
    for (const mode of [undefined, "timeline", "as_of"]) {
      for (const p of [{ since: 3 }, { until: 3 }]) {
        expect(
          await refused({
            table: "runs",
            row: run,
            ...(mode !== undefined ? { mode } : {}),
            ...(mode === "as_of" ? { as_of: 1 } : {}),
            ...p,
          }),
        ).toMatchObject({ reason: "mode_mismatch", param: Object.keys(p)[0] });
      }
    }
    expect(await refused({ mode: "changes", table: "runs", since: 0, nonsense: 1 })).toMatchObject({
      reason: "malformed",
      param: "nonsense",
    });
  });

  it("refuses a target that is not one, as the other modes do", async () => {
    const ghost = `r_${"1".repeat(26)}`;
    expect(await refused({ mode: "changes", table: "runs", row: ghost, since: 0 })).toMatchObject({
      code: "not_found",
      reason: "row",
    });
    expect(
      await refused({ mode: "changes", table: "runs", row: run, entity: food, since: 0 }),
    ).toMatchObject({
      reason: "mutually_exclusive",
    });
    expect(await refused({ mode: "changes", table: "budgets", row: run, since: 0 })).toMatchObject({
      reason: "malformed",
      param: "row",
    });
    expect(await refused({ mode: "changes", table: "runs", entity: food, since: 0 })).toMatchObject(
      {
        reason: "not_state_table",
      },
    );
    // An ID that names no row of this table: not found, as for timeline. Its last character is
    // changed to one it is not, so it never comes out equal to the row it was made from.
    const other = run2.slice(0, -1) + (run2.endsWith("0") ? "1" : "0");
    expect(await refused({ mode: "changes", table: "runs", row: other, since: 0 })).toMatchObject({
      code: "not_found",
    });
  });
});

describe("the read recorded", () => {
  it("is a read of the table at `until`, with no version given: not a row read for the fallback", async () => {
    readBufferOf(s.store).take();
    await h({ table: "runs", since: 0, until: ops["update"] });
    const [e] = readBufferOf(s.store).entries();
    expect(e).toMatchObject({
      operation: "history",
      table: "t1",
      pos: ops["update"],
      rows: [],
      coarse: [],
      // The slot's `sv` counts as read (04-contract §2).
      lastRead: [{ kind: "sv", op: 1, restoreCount: 0 }],
    });
    expect(e?.shape).toBe(JSON.stringify({ mode: "changes", table: "t1", target: null }));
    // The timeline of the row does not list it among the reads of the row's versions.
    const tl = (await history(s.store, ctx({ actor: OTHER }), {
      table: "runs",
      row: run,
    })) as unknown as {
      reads?: unknown[];
    };
    expect(tl.reads ?? []).toEqual([]);
  });

  it("counts as a read of the slot's sv: a write without sv passes by sv_fallback", async () => {
    readBufferOf(s.store).take();
    await h({ table: "runs", since: 0 }, { actor: OTHER });
    const [e] = readBufferOf(s.store).entries();
    const r = (await write(s.store, ctx({ actor: OTHER }), {
      ops: [{ intent: "insert", table: "runs", set: { date: "2026-11-04", distance: km("1") } }],
    })) as unknown as { warnings: unknown[] };
    expect(r.warnings).toContainEqual({ code: "sv_fallback", sv: 1, read: e?.read });
  });

  it("is kept to what the caller keeps: the next page starts at the first entry not kept", async () => {
    readBufferOf(s.store).take();
    const kept = (await history(
      s.store,
      ctx(),
      { mode: "changes", table: "runs", since: 0 },
      () => 2,
    )) as unknown as Result;
    expect(changes(kept)).toHaveLength(2);
    expect(kept["total"]).toBe(7);
    expect(kept["next_position"]).toEqual(expect.any(String));
    expect(readBufferOf(s.store).size).toBe(1);
  });
});
