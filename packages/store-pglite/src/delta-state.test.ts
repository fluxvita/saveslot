// `delta`'s `stateAt` on PGlite: a target's state at a version position read from the version table
// (the cells in effect then), and the origin items from the sources table; compared by
// `targetDelta`.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  loadRsql,
  readBufferOf,
  resolve,
  write,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import {
  createSlotEvents,
  decodeColumns,
  SLOT,
  stateAt,
  targetDelta,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

let COMPILED: ReturnType<typeof derivedSchema>;
let s: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const w = (params: Record<string, unknown>) => write(s.store, ctx(), { sv: 1, ...params });

const table = (name: string) =>
  COMPILED.tables.find((t) => t.name === name && t.kind === "base") as never as Parameters<
    typeof stateAt
  >[1];
const idOf = (t: Parameters<typeof stateAt>[1], name: string) =>
  t.fields.find((f) => f.name === name)?.id as `f${number}`;
const at = (name: string, row: string, ver: number, sources = false) =>
  s.store.read((tx) => stateAt(tx, table(name), row, ver, { decode: decodeColumns, sources }));

const km = (value: string) => ({ value, unit: "km" });
const cny = (value: string) => ({ value, unit: "CNY" });
const ops: Record<string, number> = {};
let run: string;
let food: string;

beforeAll(async () => {
  await loadRsql();
  COMPILED = {
    ...derivedSchema(rule("SELECT sum(distance) AS total FROM runs", ["total"], "none")),
    slot: SLOT,
  };
  s = await openReusable("saveslot-delta-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  minute = 0;
  await createTenant(s.store, ctx());
  const changes = [
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
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: changes as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
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
    await w({
      evidence: [{ kind: "user_message", text: "it was hard" }],
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "hard" } }],
    })
  ).seq;
  ops["again"] = (
    await w({
      evidence: [{ kind: "user_message", text: "yes, hard indeed" }],
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "hard" } }],
    })
  ).seq;
  ops["revoke"] = (await w({ ops: [{ intent: "revoke", table: "runs", row: run }] })).seq;
  ops["restore"] = (
    await w({ ops: [{ table: "runs", row: run, revert: { undo: ops["revoke"] } }] })
  ).seq;
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
  readBufferOf(s.store).take();
}, T);

describe("stateAt of a row", () => {
  it("is absent before the row, live after it, revoked while a revoke is in effect", async () => {
    const [before, live, revoked, back] = await Promise.all([
      at("runs", run, (ops["insert"] as number) - 1),
      at("runs", run, ops["insert"] as number),
      at("runs", run, ops["revoke"] as number),
      at("runs", run, ops["restore"] as number),
    ]);
    expect([before, live, revoked, back].map((x) => x.kind === "row" && x.presence)).toEqual([
      "absent",
      "live",
      "revoked",
      "live",
    ]);
  });

  it("gives the values as they stood at the position, decoded", async () => {
    const feeling = idOf(table("runs"), "feeling");
    const early = await at("runs", run, ops["insert"] as number);
    const late = await at("runs", run, ops["update"] as number);
    expect(early.kind === "row" && early.fields[feeling]?.value).toBe("easy");
    expect(late.kind === "row" && late.fields[feeling]?.value).toBe("hard");
    const distance = idOf(table("runs"), "distance");
    expect(early.kind === "row" && early.fields[distance]?.value).toEqual({
      value: "5",
      unit: "km",
    });
  });

  it("compares the creation, the update and the revoke as the version table has them", async () => {
    const pos = (n: string) => ops[n] as number;
    const feeling = idOf(table("runs"), "feeling");
    const created = targetDelta(
      await at("runs", run, pos("insert") - 1),
      await at("runs", run, pos("insert")),
    );
    // A creation is an `existence` with an `after` only, and fields without a `before`.
    expect(created[0]).toEqual({
      comparable: true,
      field: "existence",
      change: "value",
      after: true,
    });
    const made = created.find((d) => d.field === feeling);
    expect(made).toEqual({ comparable: true, field: feeling, change: "value", after: "easy" });
    expect(made).not.toHaveProperty("before");
    const updated = targetDelta(
      await at("runs", run, pos("insert")),
      await at("runs", run, pos("update")),
    );
    expect(updated).toEqual([
      { comparable: true, field: feeling, change: "value", before: "easy", after: "hard" },
    ]);
    const revoked = targetDelta(
      await at("runs", run, pos("again")),
      await at("runs", run, pos("revoke")),
    );
    expect(revoked).toEqual([
      { comparable: true, field: "existence", change: "value", before: true, after: false },
    ]);
  });

  it("reads the origin items only when asked, and tells another giver of the same value apart", async () => {
    const feeling = idOf(table("runs"), "feeling");
    const plain = await at("runs", run, ops["update"] as number);
    expect(plain.kind === "row" && plain.fields[feeling]?.source).toBe("");
    const [first, second] = [
      await at("runs", run, ops["insert"] as number, true),
      await at("runs", run, ops["update"] as number, true),
    ];
    const source = (x: typeof first) => (x.kind === "row" ? (x.fields[feeling]?.source ?? "") : "");
    expect(source(first)).not.toBe("");
    expect(source(second)).not.toBe("");
    expect(source(second)).not.toBe(source(first));
    // The distance's giver is the insert's, at both positions: no change at all there.
    expect(targetDelta(first, second).map((d) => d.field)).toEqual([feeling]);
  });

  it("gives a write of the same value that changed nothing no delta", async () => {
    const [before, after] = [
      await at("runs", run, ops["update"] as number, true),
      await at("runs", run, ops["again"] as number, true),
    ];
    expect(targetDelta(before, after)).toEqual([]);
  });

  it("tells another giver of the same value apart: the value written again by a new contribution is source only", async () => {
    const feeling = idOf(table("runs"), "feeling");
    const evidence = (text: string) => [{ kind: "user_message", text }];
    await w({
      evidence: evidence("medium"),
      ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "medium" } }],
    });
    const again = (
      await w({
        evidence: evidence("hard again"),
        ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "hard" } }],
      })
    ).seq;
    const [was, now] = [
      await at("runs", run, ops["restore"] as number, true),
      await at("runs", run, again, true),
    ];
    expect(targetDelta(was, now)).toMatchObject([{ field: feeling, change: "source_only" }]);
    // Without the sources table nothing is told apart.
    expect(
      targetDelta(await at("runs", run, ops["restore"] as number), await at("runs", run, again)),
    ).toEqual([]);
  });

  it("follows a carried reference to the contribution that gave the value", async () => {
    const feeling = idOf(table("runs"), "feeling");
    const medium = (
      await w({ ops: [{ intent: "update", table: "runs", row: run, set: { feeling: "medium" } }] })
    ).seq;
    const undone = (await w({ ops: [{ table: "runs", row: run, revert: { undo: medium } }] })).seq;
    const [was, now, between] = [
      await at("runs", run, ops["restore"] as number, true),
      await at("runs", run, undone, true),
      await at("runs", run, medium, true),
    ];
    const source = (x: typeof was) => (x.kind === "row" ? (x.fields[feeling]?.source ?? "") : "");
    // The undo writes "hard" back from the earlier contribution: the same origin items as before
    // the update to "medium", though the write that put it back is another item.
    expect(source(now)).toBe(source(was));
    expect(source(between)).not.toBe(source(was));
    expect(targetDelta(was, now)).toEqual([]);
    expect(targetDelta(was, between).map((d) => d.field)).toEqual([feeling]);
  });
});

describe("stateAt of an entity", () => {
  it("cuts the stretches the table holds and leaves a revoked stretch out", async () => {
    const entity = await at("budgets", food, ops["gap"] as number);
    if (entity.kind !== "entity") throw new Error("an entity");
    expect(entity.segments.map((x) => [x.from, x.to])).toEqual([
      ["2026-11-01", "2026-11-10"],
      ["2026-11-10", "2026-11-12"],
      ["2026-11-14", "2026-11-20"],
      ["2026-11-20", null],
    ]);
  });

  it("keeps the stretches apart where the values differ, and runs the equal ones together", async () => {
    const amount = idOf(table("budgets"), "amount");
    const entity = await at("budgets", food, ops["raise"] as number);
    if (entity.kind !== "entity") throw new Error("an entity");
    expect(entity.segments.map((x) => [x.from, x.to, x.values[amount]])).toEqual([
      ["2026-11-01", "2026-11-10", { value: "100", unit: "CNY" }],
      ["2026-11-10", "2026-11-20", { value: "150", unit: "CNY" }],
      ["2026-11-20", null, { value: "100", unit: "CNY" }],
    ]);
  });

  it("gives the change of an operation by stretch, running the pieces together", async () => {
    const amount = idOf(table("budgets"), "amount");
    const d = targetDelta(
      await at("budgets", food, ops["budget"] as number),
      await at("budgets", food, ops["raise"] as number),
    );
    expect(d).toEqual([
      {
        comparable: true,
        field: amount,
        change: "value",
        stretches: [
          {
            from: "2026-11-10",
            to: "2026-11-20",
            change: "value",
            before: { value: "100", unit: "CNY" },
            after: { value: "150", unit: "CNY" },
          },
        ],
      },
    ]);
    // A revoke is the stretch becoming valueless.
    const gap = targetDelta(
      await at("budgets", food, ops["raise"] as number),
      await at("budgets", food, ops["gap"] as number),
    );
    expect(gap.map((x) => x.field)).toEqual([
      "existence",
      idOf(table("budgets"), "category"),
      amount,
    ]);
    expect(gap[0]).toMatchObject({
      stretches: [{ from: "2026-11-12", to: "2026-11-14", before: true, after: false }],
    });
    // The revoked stretch has no value: the field's member for that side is not given.
    expect(gap[2]).toEqual({
      comparable: true,
      field: amount,
      change: "value",
      stretches: [
        {
          from: "2026-11-12",
          to: "2026-11-14",
          change: "value",
          before: { value: "150", unit: "CNY" },
        },
      ],
    });
  });
});

describe("stateAt of an entity: presence by stretch", () => {
  const at_ = (t: string) => `2026-11-${t}:00:00Z`;
  const guest = () => idOf(table("rooms"), "guest");
  const wr = async (o: Record<string, unknown>) =>
    (await w({ ops: [{ table: "rooms", ...o }] })) as unknown as {
      seq: number;
      ops: { target: { entity: string } }[];
    };
  const upd = (entity: string, set: Record<string, unknown>, from: string, to?: string) =>
    wr({
      intent: "update",
      entity,
      set,
      valid_from: at_(from),
      ...(to === undefined ? {} : { valid_to: at_(to) }),
    });
  const delta = async (id: string, b: number, a: number) =>
    targetDelta(await at("rooms", id, b), await at("rooms", id, a));
  const ex = (d: Awaited<ReturnType<typeof delta>>) =>
    (d.find((x) => x.field === "existence") as { stretches?: unknown[] } | undefined)?.stretches;
  const T = (t: string | null) => (t === null ? null : `2026-11-${t}:00:00.000Z`);
  const stretch = (from: string, to: string | null, o: Record<string, unknown>) => ({
    from: T(from),
    to: T(to),
    change: "value",
    ...o,
  });

  it("gives an entity created with nulls only as existence, and no field", async () => {
    const made = await wr({
      intent: "insert",
      set: { guest: null },
      valid_from: at_("01T10"),
    });
    expect(await delta(made.ops[0]?.target.entity as string, made.seq - 1, made.seq)).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [stretch("01T10", null, { after: true })],
      },
    ]);
  });

  it("gives nulls filled into a valueless interval as existence, and the undo of the fill as its loss", async () => {
    const first = await wr({
      intent: "insert",
      set: { guest: "ann" },
      valid_from: at_("01T10"),
      valid_to: at_("01T12"),
    });
    const id = first.ops[0]?.target.entity as string;
    const late = await upd(id, { guest: "bob" }, "01T14");
    const fill = await upd(id, { guest: null }, "01T12", "01T14");
    const filled = await delta(id, late.seq, fill.seq);
    expect(filled).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [stretch("01T12", "01T14", { after: true })],
      },
    ]);
    // The undo of a fill records a cell with no value and no revoke: absent again, not revoked.
    const undone = (await wr({ entity: id, revert: { undo: fill.seq } })).seq;
    expect(await delta(id, fill.seq, undone)).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [stretch("01T12", "01T14", { before: true })],
      },
    ]);
  });

  it("gives a null entity extended by a day as existence of that day", async () => {
    const first = await wr({
      intent: "insert",
      set: { guest: null },
      valid_from: at_("01T10"),
      valid_to: at_("02T10"),
    });
    const id = first.ops[0]?.target.entity as string;
    const more = await upd(id, { guest: null }, "02T10", "03T10");
    // Filling past the end is awaiting confirmation: it is a change when confirmed.
    const item = (more as unknown as { pending: { id: string; item_ver: string }[] }).pending[0];
    const done = (await resolve(s.store, ctx(), {
      id: item?.id,
      decision: "confirm",
      item_ver: item?.item_ver,
    })) as unknown as { write: { seq: number } };
    expect(await delta(id, more.seq, more.seq)).toEqual([]);
    expect(await delta(id, first.seq, done.write.seq)).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [stretch("02T10", "03T10", { after: true })],
      },
    ]);
  });

  it("tells before creation then full revocation from after creation then full revocation", async () => {
    const made = await wr({
      intent: "insert",
      set: { guest: "ann" },
      valid_from: at_("01T10"),
    });
    const id = made.ops[0]?.target.entity as string;
    const gone = await wr({ intent: "revoke", entity: id });
    const fromBefore = await delta(id, made.seq - 1, gone.seq);
    const fromAfter = await delta(id, made.seq, gone.seq);
    expect(ex(fromBefore)).toEqual([stretch("01T10", null, { after: false })]);
    expect(ex(fromAfter)).toEqual([stretch("01T10", null, { before: true, after: false })]);
    // Seen before creation, its values are not a change of a field that was there.
    expect(fromBefore.map((x) => x.field)).toEqual(["existence"]);
    expect(fromAfter.map((x) => x.field)).toEqual(["existence", guest()]);
  });

  it("gives a value filled into a revoked hole as revoked to live", async () => {
    const made = await wr({
      intent: "insert",
      set: { guest: "ann" },
      valid_from: at_("01T10"),
    });
    const id = made.ops[0]?.target.entity as string;
    const gone = await wr({
      intent: "revoke",
      entity: id,
      valid_from: at_("01T11"),
      valid_to: at_("01T15"),
    });
    const fill = await upd(id, { guest: "cat" }, "01T12", "01T13");
    expect(await delta(id, gone.seq, fill.seq)).toEqual([
      {
        comparable: true,
        field: "existence",
        change: "value",
        stretches: [stretch("01T12", "01T13", { before: false, after: true })],
      },
      {
        comparable: true,
        field: guest(),
        change: "value",
        stretches: [stretch("01T12", "01T13", { after: "cat" })],
      },
    ]);
  });
});
