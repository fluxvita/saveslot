// `query` on PGlite (04-contract §4, §7, §10 `query`; 04-contract-types §4.3; 05-time «查询»): rows
// written through `write`, read back by table kind, time, conditions, order and page; the marks;
// each refusal; the read as recorded; and the fallback of a write taking `ver` from a query.

import {
  appendOperation,
  applyEvents,
  catalog,
  createOpsContext,
  createTenant,
  eventsOf,
  flushReads,
  history,
  pending,
  query,
  readBufferOf,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, queryInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
const SLOT = COMPILED_V1.slot;

const km = { code: "km", dimension: "length", to_base: "1000" };
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
          unit: km,
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
      name: "visits",
      kind: "base",
      description: "events by the instant",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "at", type: "zoned_datetime", required: true, description: "when" },
        { id: "f2", name: "who", type: "text", description: "who" },
      ],
    },
    {
      id: "t3",
      name: "budgets",
      kind: "base",
      description: "by the day",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t3_v1" },
      fields: [
        { id: "f1", name: "category", type: "text", required: true, description: "kind" },
        { id: "f2", name: "amount", type: "integer", description: "how much" },
      ],
    },
    {
      id: "t4",
      name: "rooms",
      kind: "base",
      description: "by the instant",
      time: { type: "state", granularity: "instant" },
      physical: { table: "t_t4_v1" },
      fields: [{ id: "f1", name: "guest", type: "text", description: "who" }],
    },
    {
      id: "t5",
      name: "settings",
      kind: "base",
      description: "timeless",
      time: { type: "none" },
      physical: { table: "t_t5_v1" },
      fields: [{ id: "f1", name: "key", type: "text", required: true, description: "a key" }],
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

let s: ReusableStore;
let minute = 0;
const NOW = "2026-11-05T04:00:00.000Z"; // 2026-11-05 12:00 in Asia/Shanghai
const clock = () => {
  minute++;
  return `2026-11-05T03:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};

const ctx = (
  o: { actor?: string; now?: string; visibility?: unknown; task?: string | null } = {},
) =>
  createOpsContext({
    tenant: TENANT,
    actor: o.actor ?? USER,
    trigger: null,
    task: o.task ?? null,
    visibility: o.visibility ?? { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: o.now ?? clock(),
    confirmation: null,
  });

type Receipt = Awaited<ReturnType<typeof write>>;
async function w(params: unknown, actor = USER): Promise<Receipt> {
  return write(s.store, ctx({ actor }), params);
}
/** A write by the user at the slot's version (setup: no read to fall back to). */
const w1 = (params: Record<string, unknown>) => w({ sv: 1, ...params });
const target = (r: Receipt, i = 0) => r.ops[i]?.target as { row?: string; entity?: string };

type QR = Awaited<ReturnType<typeof query>>;
async function q(params: unknown, o: Parameters<typeof ctx>[0] = {}): Promise<QR> {
  return query(s.store, ctx({ now: NOW, ...o }), params);
}
async function refused(params: unknown, o: Parameters<typeof ctx>[0] = {}) {
  try {
    await q(params, o);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}
const values = (r: QR) => r.rows.map((x) => x.values);

const ins = (table: string, set: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
  ops: [{ intent: "insert", table, set, ...more }],
});

let r1: string;
let r2: string;
let r3: string;
let r4: string;
let entityA: string;
let entityB: string;

beforeAll(async () => {
  s = await openReusable("saveslot-query-");
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
  const spend = (set: Record<string, unknown>) => w1(ins("spend", set));
  r1 = target(
    await spend({
      date: "2026-11-01",
      category: "food",
      distance: { value: "1.5", unit: "km" },
      note: "lunch",
      pieces: 2,
      rate: "0.5",
      paid: true,
      at: "2026-11-01T12:00:00+08:00",
    }),
  ).row as string;
  r2 = target(
    await spend({
      date: "2026-11-03",
      category: "rent",
      distance: { value: "1200", unit: "m" },
      note: "Café",
      pieces: 1,
    }),
  ).row as string;
  r3 = target(
    await spend({ date: "2026-11-03", category: "food", distance: { value: "3", unit: "km" } }),
  ).row as string;
  r4 = target(
    await spend({ date: "2026-11-05", category: "food", distance: { value: "0.5", unit: "km" } }),
  ).row as string;
  await w1({ ops: [{ intent: "revoke", table: "spend", row: r4 }] });
  await w1({
    ops: [
      {
        intent: "correct",
        table: "spend",
        row: r1,
        set: { distance: { value: "1.75", unit: "km" } },
      },
    ],
  });

  entityA = target(
    await w1(ins("budgets", { category: "food", amount: 100 }, { valid_from: "2026-11-01" })),
  ).entity as string;
  await w1({
    ops: [
      {
        intent: "update",
        table: "budgets",
        entity: entityA,
        set: { amount: 150 },
        valid_from: "2026-11-10",
        valid_to: "2026-11-20",
      },
    ],
  });
  entityB = target(
    await w1(
      ins(
        "budgets",
        { category: "rent", amount: 50 },
        { valid_from: "2026-10-01", valid_to: "2026-10-15" },
      ),
    ),
  ).entity as string;
  await w1(
    ins(
      "rooms",
      { guest: "ann" },
      {
        valid_from: "2026-11-01T10:00:00Z",
        valid_to: "2026-11-02T10:00:00Z",
      },
    ),
  );
  await w1(ins("visits", { at: "2026-11-02T23:30:00+08:00", who: "bo" }));
  await w1(ins("visits", { at: "2026-11-03T00:30:00+08:00", who: "cy" }));
  await w1(ins("settings", { key: "b" }));
  await w1(ins("settings", { key: "a" }));
  readBufferOf(s.store).take();
}, T);

describe("the profile of the tables written above (`catalog`, 04-contract §10 «概况»)", () => {
  it("gives the rows and the business time range of each kind of table, in the form the table keeps it", async () => {
    const r = await catalog(s.store, ctx(), {
      level: "table",
      tables: ["spend", "visits", "budgets", "rooms", "settings"],
    });
    const profiles = Object.fromEntries(
      (r as unknown as { tables: { table: string; profile: unknown }[] }).tables.map((t) => [
        t.table,
        t.profile,
      ]),
    );
    expect(profiles).toEqual({
      // Three rows not revoked: the revoked fourth (2026-11-05) is neither counted nor in the range.
      spend: { rows: 3, time_range: { from: "2026-11-01", to: "2026-11-03" } },
      // A zoned_datetime time field: the instants, in UTC as the event format writes them.
      visits: {
        rows: 2,
        time_range: { from: "2026-11-02T15:30:00.000Z", to: "2026-11-02T16:30:00.000Z" },
      },
      // Segments: the first entity cut in three, the second one segment.
      // The first entity's last segment runs on: no end.
      budgets: { rows: 4, time_range: { from: "2026-10-01" } },
      // Every segment has an end: the latest valid_to.
      rooms: {
        rows: 1,
        time_range: { from: "2026-11-01T10:00:00.000Z", to: "2026-11-02T10:00:00.000Z" },
      },
      settings: { rows: 2 },
    });
  });
});

describe("event tables", () => {
  it("reads the rows not revoked, by day descending then row ID, with ver and marks", async () => {
    const r = await q({ table: "spend" });
    expect(r).toMatchObject({ table: "ledger.spend", slot: "ledger", sv: 1, total: 3 });
    expect(r.rows.map((x) => x.row)).toEqual([...[r2, r3].sort(), r1]);
    expect(r.rows[2]).toEqual({
      table: "ledger.spend",
      row: r1,
      ver: expect.stringMatching(/^v\d+\.0$/),
      values: {
        date: "2026-11-01",
        category: "food",
        distance: { value: "1.75", unit: "km" },
        note: "lunch",
        pieces: "2",
        rate: "0.5",
        paid: true,
        at: "2026-11-01T12:00:00+08:00[Asia/Shanghai]",
      },
      marks: { corrected: true },
    });
    expect(r.rows.find((x) => x.row === r2)?.values["distance"]).toEqual({
      value: "1.2",
      unit: "km",
    });
    // No warnings: no `warnings` key.
    expect(Object.keys(r).sort()).toEqual(["rows", "slot", "sv", "table", "total"]);
  });

  it("gives revoked rows on request, with the revoking operation", async () => {
    const r = await q({ table: "spend", include_revoked: true, fields: ["date"] });
    expect(r.total).toBe(4);
    expect(r.rows[0]).toMatchObject({ row: r4, marks: { revoked: { seq: expect.any(Number) } } });
  });

  it("filters by the time field over a day range, and a zoned time field by natural days", async () => {
    expect((await q({ table: "spend", valid_during: ["2026-11-02", "2026-11-04"] })).total).toBe(2);
    const v = await q({ table: "visits", valid_during: ["2026-11-03", null] });
    expect(values(v).map((x) => x["who"])).toEqual(["cy"]);
    const all = await q({ table: "visits", valid_during: ["2026-11-02T00:00:00Z", null] });
    expect(values(all).map((x) => x["who"])).toEqual(["cy", "bo"]);
  });

  it("takes a time field instant on a date field by its day, with time_truncated", async () => {
    const r = await q({ table: "spend", valid_during: ["2026-11-02T20:00:00Z", null] });
    expect(r.total).toBe(2);
    expect(r.warnings).toEqual([
      {
        code: "time_truncated",
        param: "valid_during/0",
        from: "2026-11-02T20:00:00.000Z",
        to: "2026-11-03",
      },
    ]);
  });
});

describe("conditions", () => {
  const rows = async (where: unknown[]) =>
    (await q({ table: "spend", where, order: [{ field: "date" }] })).rows.map((x) => x.row);
  it("compares each type, quantities in any unit of the dimension, exactly", async () => {
    expect(await rows([{ field: "category", op: "=", value: "rent" }])).toEqual([r2]);
    expect(await rows([{ field: "category", op: "!=", value: "rent" }])).toEqual(
      expect.arrayContaining([r1, r3]),
    );
    expect(
      await rows([{ field: "distance", op: ">", value: { value: "1200", unit: "m" } }]),
    ).toEqual([r1, r3]);
    expect(
      await rows([{ field: "distance", op: ">=", value: { value: "1.2", unit: "km" } }]),
    ).toHaveLength(3);
    // Not rounded to the field's scale: 1.745 km is below 1.75 km.
    expect(
      await rows([{ field: "distance", op: "<", value: { value: "1.745", unit: "km" } }]),
    ).toEqual([r2]);
    expect(await rows([{ field: "pieces", op: "<=", value: "1" }])).toEqual([r2]);
    expect(await rows([{ field: "pieces", op: "in", value: [2, "5"] }])).toEqual([r1]);
    expect(await rows([{ field: "note", op: "is_null", value: true }])).toEqual([r3]);
    expect(await rows([{ field: "note", op: "contains", value: "fé" }])).toEqual([r2]);
    // Text compares after NFC: "e" + U+0301 finds "é".
    expect(await rows([{ field: "note", op: "=", value: "Café" }])).toEqual([r2]);
    expect(await rows([{ field: "paid", op: "=", value: true }])).toEqual([r1]);
    expect(await rows([{ field: "date", op: ">", value: "2026-11-01" }])).toHaveLength(2);
    expect(
      await rows([
        { field: "at", op: "<", value: "2026-11-01T05:00:00Z" },
        { field: "pieces", op: "=", value: 2 },
      ]),
    ).toEqual([r1]);
    expect(await rows([{ field: "rate", op: "=", value: "0.50" }])).toEqual([r1]);
    // A condition's value is only compared, never stored: no wall-clock year check (10000-01-01
    // in the slot's Asia/Shanghai), only the instant's range in UTC.
    expect(
      await rows([
        { field: "at", op: "<", value: "9999-12-31T23:59:59Z" },
        { field: "pieces", op: "=", value: 2 },
      ]),
    ).toEqual([r1]);
  });

  it("refuses an operator for the type, a wrong value, a zoned field given a date", async () => {
    expect(
      await refused({ table: "spend", where: [{ field: "note", op: "<", value: "a" }] }),
    ).toEqual({
      code: "invalid_argument",
      reason: "operator_type",
      param: "where/0/op",
    });
    expect(
      await refused({ table: "spend", where: [{ field: "pieces", op: "contains", value: "1" }] }),
    ).toMatchObject({ reason: "operator_type" });
    expect(
      await refused({ table: "spend", where: [{ field: "at", op: ">", value: "2026-11-01" }] }),
    ).toMatchObject({ reason: "malformed", param: "where/0/value", example: expect.any(Object) });
    expect(
      await refused({
        table: "spend",
        where: [{ field: "distance", op: ">", value: { value: "1", unit: "kg" } }],
      }),
    ).toMatchObject({ reason: "malformed", param: "where/0/value" });
    expect(
      await refused({ table: "spend", where: [{ field: "category", op: "=", value: "fun" }] }),
    ).toMatchObject({ reason: "malformed", allowed_values: ["food", "rent"] });
    expect(await refused({ table: "spend", where: [{ field: "note", op: "=" }] })).toMatchObject({
      reason: "missing",
      param: "where/0/value",
    });
    expect(
      await refused({ table: "spend", where: [{ field: "note", op: "in", value: [] }] }),
    ).toMatchObject({ reason: "malformed" });
    expect(
      await refused({
        table: "spend",
        where: [{ field: "valid_from", op: "=", value: "2026-11-01" }],
      }),
    ).toMatchObject({ reason: "malformed", param: "where/0/field" });
  });
});

describe("state tables", () => {
  it("reads each entity's segment at now (its day in the slot's zone), with its interval", async () => {
    const r = await q({ table: "budgets" });
    expect(r.rows).toEqual([
      {
        table: "ledger.budgets",
        entity: entityA,
        ver: expect.stringMatching(/^v\d+\.0$/),
        values: { category: "food", amount: "100" },
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        valid_to_inclusive: "2026-11-09",
      },
    ]);
    expect(
      (await q({ table: "budgets", at: "2026-11-15T00:00:00Z" })).rows[0]?.values["amount"],
    ).toBe("150");
    // 2026-11-09T17:00Z is already 11-10 in Asia/Shanghai.
    expect(
      (await q({ table: "budgets", at: "2026-11-09T17:00:00Z" })).rows[0]?.values["amount"],
    ).toBe("150");
  });

  it("reads a point, and an interval with merging and clipping", async () => {
    const october = await q({ table: "budgets", valid_at: "2026-10-05" });
    expect(october.rows.map((x) => [x.entity, x.values])).toEqual([
      [entityB, { category: "rent", amount: "50" }],
    ]);
    const during = await q({ table: "budgets", valid_during: ["2026-11-05", "2026-11-25"] });
    expect(during.rows.map((x) => [x.values["amount"], x.valid_from, x.valid_to])).toEqual([
      ["100", "2026-11-01", "2026-11-10"],
      ["150", "2026-11-10", "2026-11-20"],
      ["100", "2026-11-20", null],
    ]);
    const clipped = await q({
      table: "budgets",
      valid_during: ["2026-11-05", "2026-11-25"],
      clip: true,
    });
    expect(clipped.rows.map((x) => [x.valid_from, x.valid_to])).toEqual([
      ["2026-11-05", "2026-11-10"],
      ["2026-11-10", "2026-11-20"],
      ["2026-11-20", "2026-11-25"],
    ]);
    // Only the category read: the three segments are one value.
    const merged = await q({
      table: "budgets",
      fields: ["category"],
      valid_during: ["2026-11-05", "2026-11-25"],
    });
    expect(merged.rows.map((x) => [x.valid_from, x.valid_to])).toEqual([["2026-11-01", null]]);
    expect(merged.total).toBe(1);
    const unmerged = await q({
      table: "budgets",
      fields: ["category"],
      valid_during: ["2026-11-05", "2026-11-25"],
      coalesce: false,
    });
    expect(unmerged.total).toBe(3);
  });

  it("conditions on valid_from / valid_to only with valid_during; an open end is later", async () => {
    const r = await q({
      table: "budgets",
      valid_during: ["2026-10-01", null],
      coalesce: false,
      where: [{ field: "valid_to", op: ">", value: "2026-11-15" }],
    });
    expect(r.rows.map((x) => x.valid_from)).toEqual(["2026-11-10", "2026-11-20"]);
    expect(
      (
        await q({
          table: "budgets",
          valid_during: ["2026-10-01", null],
          where: [{ field: "valid_to", op: "is_null", value: true }],
          coalesce: false,
        })
      ).rows.map((x) => x.valid_from),
    ).toEqual(["2026-11-20"]);
  });

  it("on an instant table: an instant point; a date is granularity with the day's bounds", async () => {
    expect(values(await q({ table: "rooms", valid_at: "2026-11-02T09:59:59Z" }))).toEqual([
      { guest: "ann" },
    ]);
    expect(await q({ table: "rooms", valid_at: "2026-11-02T10:00:00Z" })).toMatchObject({
      total: 0,
    });
    expect(await refused({ table: "rooms", valid_at: "2026-11-02" })).toEqual({
      code: "invalid_argument",
      reason: "granularity",
      param: "valid_at",
      example: { valid_during: ["2026-11-01T16:00:00.000Z", "2026-11-02T16:00:00.000Z"] },
    });
    // Without an offset: the slot's zone, with timezone_assumed.
    const r = await q({ table: "rooms", valid_at: "2026-11-02T17:00:00" });
    expect(r.total).toBe(1);
    expect(r.warnings).toEqual([
      { code: "timezone_assumed", param: "valid_at", timezone: "Asia/Shanghai" },
    ]);
  });

  it("orders the segments of a state table by each segment's own value", async () => {
    const r = await q({
      table: "budgets",
      valid_during: ["2026-10-01", null],
      coalesce: false,
      order: [{ field: "amount" }],
    });
    expect(r.rows.map((x) => [x.values["amount"], x.valid_from])).toEqual([
      ["50", "2026-10-01"],
      ["100", "2026-11-01"],
      ["100", "2026-11-20"],
      ["150", "2026-11-10"],
    ]);
  });

  it("merges by the fields read before keeping what meets the interval, then conditions, then clip", async () => {
    // The category has been food since 11-01; 11-10 and 11-20 are where the amount changes.
    const merged = await q({
      table: "budgets",
      fields: ["category"],
      valid_during: ["2026-11-12", "2026-11-25"],
    });
    expect(merged.rows.map((x) => [x.values["category"], x.valid_from, x.valid_to])).toEqual([
      ["food", "2026-11-01", null],
    ]);
    // valid_from of the merged segment: 11-01, before 11-05.
    const cond = await q({
      table: "budgets",
      fields: ["category"],
      valid_during: ["2026-11-12", null],
      where: [{ field: "valid_from", op: "<", value: "2026-11-05" }],
    });
    expect(cond.rows.map((x) => x.valid_from)).toEqual(["2026-11-01"]);
    const clipped = await q({
      table: "budgets",
      fields: ["category"],
      valid_during: ["2026-11-12", "2026-11-25"],
      clip: true,
    });
    expect(clipped.rows.map((x) => [x.valid_from, x.valid_to])).toEqual([
      ["2026-11-12", "2026-11-25"],
    ]);
  });

  it("marks corrected the segments whose values read come from a correction", async () => {
    const r = await w1({
      ops: [
        {
          intent: "correct",
          table: "budgets",
          entity: entityA,
          set: { amount: 175 },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    });
    expect(r.status).toBe("saved");
    const rows = await q({
      table: "budgets",
      fields: ["amount"],
      valid_during: ["2026-10-01", null],
    });
    expect(
      rows.rows
        .filter((x) => x.entity === entityA)
        .map((x) => [x.valid_from, x.values["amount"], x.marks ?? null]),
    ).toEqual([
      ["2026-11-01", "100", null],
      ["2026-11-10", "175", { corrected: true }],
      ["2026-11-20", "100", null],
    ]);
    // Reading the category only: no value read comes from a correction.
    const category = await q({
      table: "budgets",
      fields: ["category"],
      valid_during: ["2026-10-01", null],
    });
    expect(category.rows.every((x) => x.marks === undefined)).toBe(true);
  });

  it("merges adjacent segments by the values read alone, the merged row carrying every segment's marks", async () => {
    // Category rent from 11-20; the amount on [11-10, 11-20) corrected to 100. Read: the amount only,
    // 100 on both [11-01, 11-20) (from a correction in part) and [11-20, …) (not).
    // Confirmed in the request: it overwrites a change point (high impact).
    const ver = (await q({ table: "budgets" })).rows.find((x) => x.entity === entityA)?.ver;
    const c = await w1({
      ops: [
        {
          intent: "correct",
          table: "budgets",
          entity: entityA,
          set: { amount: 100 },
          ver,
          acknowledge: ["overwrite"],
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    });
    await w1({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity: entityA,
          set: { category: "rent" },
          valid_from: "2026-11-20",
        },
      ],
    });
    expect(c.status).toBe("saved");
    const r = await q({ table: "budgets", fields: ["amount"], valid_during: ["2026-11-01", null] });
    expect(
      r.rows
        .filter((x) => x.entity === entityA)
        .map((x) => [x.valid_from, x.valid_to, x.marks ?? null]),
    ).toEqual([["2026-11-01", null, { corrected: true }]]);
  });

  it("include_revoked adds nothing on a state table", async () => {
    await w1({ ops: [{ intent: "revoke", table: "budgets", entity: entityA }] });
    expect(await q({ table: "budgets", include_revoked: true })).toMatchObject({ total: 0 });
  });
});

describe("marks from open items", () => {
  it("marks a state table's segments within the item's spans only, the spans cut to each row", async () => {
    // A stale write of the category on [11-10, 11-20): a conflict item over those days.
    const before = (await q({ table: "budgets" })).rows.find((x) => x.entity === entityA)
      ?.ver as string;
    await w1({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity: entityA,
          set: { category: "rent" },
          valid_from: "2026-11-12",
          valid_to: "2026-11-16",
        },
      ],
    });
    const r = await w(
      {
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity: entityA,
            ver: before,
            set: { category: "fun" },
            valid_from: "2026-11-10",
            valid_to: "2026-11-20",
          },
        ],
      },
      OTHER,
    );
    expect(r.pending).toHaveLength(1);
    const item = r.pending[0]?.id;
    const marksOf = async (params: Record<string, unknown>) =>
      (await q({ table: "budgets", ...params })).rows
        .filter((x) => x.entity === entityA)
        .map((x) => [x.valid_from, x.valid_to, x.marks?.disputed ?? null]);
    // Spans as read results give intervals (04-contract-types §1 `Interval`), not the event
    // format's `{from, to}`; the table is date-grained, so each has its last day.
    const last = (to: string) =>
      new Date(Date.parse(`${to}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const d = (from: string, to: string) => [
      {
        item,
        fields: ["category"],
        spans: [{ valid_from: from, valid_to: to, valid_to_inclusive: last(to) }],
      },
    ];
    // The user's rent on [11-12, 11-16) splits the item's days: each segment within them carries
    // the item with its spans cut to the segment; those outside carry nothing.
    expect(await marksOf({ valid_during: ["2026-11-01", null], coalesce: false })).toEqual([
      ["2026-11-01", "2026-11-10", null],
      ["2026-11-10", "2026-11-12", d("2026-11-10", "2026-11-12")],
      ["2026-11-12", "2026-11-16", d("2026-11-12", "2026-11-16")],
      ["2026-11-16", "2026-11-20", d("2026-11-16", "2026-11-20")],
      ["2026-11-20", null, null],
    ]);
    // Merged by the category read: the item's spans within each merged row.
    expect(await marksOf({ fields: ["category"], valid_during: ["2026-11-01", null] })).toEqual([
      ["2026-11-01", "2026-11-12", d("2026-11-10", "2026-11-12")],
      ["2026-11-12", "2026-11-16", d("2026-11-12", "2026-11-16")],
      ["2026-11-16", null, d("2026-11-16", "2026-11-20")],
    ]);
    // Clipped: the spans cut to the clipped row; outside the item's days, no mark.
    expect(
      await marksOf({
        fields: ["category"],
        valid_during: ["2026-11-17", "2026-11-19"],
        clip: true,
      }),
    ).toEqual([["2026-11-17", "2026-11-19", d("2026-11-17", "2026-11-19")]]);
    expect(
      await marksOf({
        fields: ["category"],
        valid_during: ["2026-11-21", "2026-11-23"],
        clip: true,
      }),
    ).toEqual([["2026-11-21", "2026-11-23", null]]);
    // A point within and outside the item's days.
    expect(await marksOf({ valid_at: "2026-11-14" })).toEqual([
      ["2026-11-12", "2026-11-16", d("2026-11-12", "2026-11-16")],
    ]);
    expect(await marksOf({ valid_at: "2026-11-05" })).toEqual([["2026-11-01", "2026-11-10", null]]);
  });

  it("marks a disputed field, only when the field is read", async () => {
    // A stale write of the note: a candidate and a conflict item on the note (f4).
    const before = (
      await q({ table: "spend", where: [{ field: "note", op: "=", value: "lunch" }] })
    ).rows[0]?.ver as string;
    await w1({
      ops: [{ intent: "update", table: "spend", row: r1, ver: before, set: { note: "x" } }],
    });
    const r = await w(
      {
        sv: 1,
        ops: [{ intent: "update", table: "spend", row: r1, ver: before, set: { note: "y" } }],
      },
      OTHER,
    );
    expect(r.pending).toHaveLength(1);
    const item = r.pending[0]?.id;
    const row = async (fields?: string[]) =>
      (await q({ table: "spend", ...(fields ? { fields } : {}) })).rows.find((x) => x.row === r1);
    expect((await row())?.marks).toEqual({
      corrected: true,
      disputed: [{ item, fields: ["note"] }],
    });
    expect((await row(["note"]))?.marks?.disputed).toEqual([{ item, fields: ["note"] }]);
    expect((await row(["date"]))?.marks).toEqual({ corrected: true });
  });
});

describe("order and pages", () => {
  it("orders by fields asked, nulls last, then the default keys; timeless by latest change", async () => {
    const r = await q({ table: "spend", order: [{ field: "note", dir: "desc" }] });
    expect(r.rows.map((x) => x.values["note"])).toEqual(["lunch", "Café", null]);
    const t = await q({ table: "settings" });
    expect(values(t)).toEqual([{ key: "a" }, { key: "b" }]);
  });

  it("pages by limit and cursor; the pages together are the whole, total on each", async () => {
    const all = (await q({ table: "spend", include_revoked: true })).rows.map((x) => x.row);
    const seen: string[] = [];
    let position: string | undefined;
    for (;;) {
      const p = await q({
        table: "spend",
        include_revoked: true,
        limit: 1,
        ...(position ? { position } : {}),
      });
      expect(p.total).toBe(4);
      seen.push(...p.rows.map((x) => x.row as string));
      if (p.next_position === undefined) break;
      position = p.next_position;
    }
    expect(seen).toEqual(all);
  });

  it("keeps later pages to the first page's state: writes meanwhile neither drop nor repeat rows", async () => {
    const all = (await q({ table: "spend", include_revoked: true })).rows.map((x) => [
      x.row,
      x.values,
    ]);
    const p1 = await q({ table: "spend", include_revoked: true, limit: 2 });
    // Meanwhile: a row inserted on a later day (it would sort first), one revoked, one changed.
    await w1(ins("spend", { date: "2026-11-30", category: "rent" }));
    await w1({ ops: [{ intent: "revoke", table: "spend", row: r2 }] });
    await w1({ ops: [{ intent: "update", table: "spend", row: r3, set: { note: "late" } }] });
    const p2 = await q({
      table: "spend",
      include_revoked: true,
      limit: 2,
      position: p1.next_position,
    });
    expect(p2.total).toBe(4);
    expect([...p1.rows, ...p2.rows].map((x) => [x.row, x.values])).toEqual(all);
    // A fresh first page sees the writes.
    expect((await q({ table: "spend", include_revoked: true })).total).toBe(5);
  });

  it("keeps a state table's later pages to the first page's evaluation time", async () => {
    const first = await q(
      { table: "budgets", valid_during: ["2026-10-01", null], coalesce: false, limit: 1 },
      { now: "2026-11-05T04:00:00.000Z" },
    );
    const rest = await q(
      {
        table: "budgets",
        valid_during: ["2026-10-01", null],
        coalesce: false,
        limit: 10,
        position: first.next_position,
      },
      { now: "2026-12-30T04:00:00.000Z" },
    );
    const whole = await q({
      table: "budgets",
      valid_during: ["2026-10-01", null],
      coalesce: false,
    });
    expect([...first.rows, ...rest.rows]).toEqual(whole.rows);
  });

  it("keeps a state table's default now to the first page's evaluation time", async () => {
    await w1(ins("budgets", { category: "fun", amount: 1 }, { valid_from: "2026-11-01" }));
    const at5 = { now: "2026-11-05T04:00:00.000Z" };
    const whole = await q({ table: "budgets" }, at5);
    expect(whole.total).toBe(2);
    const first = await q({ table: "budgets", limit: 1 }, at5);
    // A later now (11-15, where A's amount is 150): the page still reads 11-05.
    const second = await q(
      { table: "budgets", limit: 1, position: first.next_position },
      { now: "2026-11-15T04:00:00.000Z" },
    );
    expect([...first.rows, ...second.rows]).toEqual(whole.rows);
  });

  it("binds clip and at in the position", async () => {
    const during = {
      table: "budgets",
      valid_during: ["2026-10-01", null],
      coalesce: false,
      limit: 1,
    };
    const clipped = await q({ ...during, clip: true });
    expect(
      await refused({ ...during, clip: false, position: clipped.next_position }),
    ).toMatchObject({
      reason: "malformed",
      param: "position",
    });
    const at = await q({ table: "spend", at: "2026-11-05T04:00:00Z", limit: 1 });
    expect(
      await refused({
        table: "spend",
        at: "2026-11-06T04:00:00Z",
        limit: 1,
        position: at.next_position,
      }),
    ).toMatchObject({ reason: "malformed", param: "position" });
    // limit may change between pages.
    expect(
      (
        await q({
          table: "spend",
          at: "2026-11-05T04:00:00Z",
          limit: 5,
          position: at.next_position,
        })
      ).rows,
    ).toHaveLength(2);
  });

  it("gives a later page's revoked and corrected as they were at the first page", async () => {
    const ordered = { table: "spend", include_revoked: true, order: [{ field: "date" }], limit: 1 };
    const first = await q(ordered);
    expect(first.rows.map((x) => x.row)).toEqual([r1]);
    const before = (await q({ ...ordered, limit: 10 })).rows;
    const r4revoke = before.find((x) => x.row === r4)?.marks?.revoked?.seq as number;
    // Meanwhile: r2 revoked, r3 corrected, r4's revoke undone.
    await w1({ ops: [{ intent: "revoke", table: "spend", row: r2 }] });
    await w1({ ops: [{ intent: "correct", table: "spend", row: r3, set: { note: "fixed" } }] });
    await w1({ ops: [{ table: "spend", row: r4, revert: { undo: r4revoke } }] });
    const later = await q({ ...ordered, limit: 10, position: first.next_position });
    const by = new Map<string, unknown>(later.rows.map((x) => [x.row as string, x.marks]));
    expect(by.get(r2)).toBeUndefined();
    expect(by.get(r3)).toBeUndefined();
    expect(by.get(r4)).toEqual({ revoked: { seq: r4revoke } });
    // A fresh read sees them.
    const now = new Map<string, unknown>(
      (await q({ ...ordered, limit: 10 })).rows.map((x) => [x.row as string, x.marks]),
    );
    expect(now.get(r2)).toMatchObject({ revoked: expect.any(Object) });
    expect(now.get(r3)).toEqual({ corrected: true });
    expect(now.get(r4)).toBeUndefined();
  });

  it("makes a write without ver after a later page read an older row a candidate, not an overwrite", async () => {
    const p1 = await q({ table: "spend", limit: 1 }, { actor: OTHER });
    await w1({ ops: [{ intent: "update", table: "spend", row: r1, set: { note: "newer" } }] });
    const p2 = await q({ table: "spend", limit: 10, position: p1.next_position }, { actor: OTHER });
    const seen = p2.rows.find((x) => x.row === r1);
    expect(seen?.values["note"]).toBe("lunch");
    const r = await w(
      { sv: 1, ops: [{ intent: "update", table: "spend", row: r1, set: { note: "mine" } }] },
      OTHER,
    );
    expect(r.status).toBe("pending");
    expect(r.ops[0]?.fields).toMatchObject({ note: { result: "candidate" } });
    expect(r.warnings).toContainEqual(
      expect.objectContaining({ code: "ver_fallback", ver: seen?.ver }),
    );
    const now = await q({
      table: "spend",
      where: [{ field: "date", op: "=", value: "2026-11-01" }],
    });
    expect(now.rows[0]?.values["note"]).toBe("newer");
  });

  it("refuses a position of another query, one not made here, one from before a restore", async () => {
    const p = await q({ table: "spend", limit: 1 });
    expect(p.next_position).toEqual(expect.any(String));
    expect(
      await refused({ table: "spend", limit: 1, position: p.next_position, fields: ["date"] }),
    ).toEqual({ code: "invalid_argument", reason: "malformed", param: "position" });
    const o = JSON.parse(Buffer.from(p.next_position as string, "base64url").toString());
    const forged = (x: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...o, ...x })).toString("base64url");
    for (const bad of [
      "x",
      "!!",
      Buffer.from('{"v":1,"q":"a","k":[]}').toString("base64url"),
      forged({ s: 1e9 }),
      forged({ s: -1 }),
      forged({ t: "yesterday" }),
      forged({ t: "2026-13-45T04:00:00.000Z" }),
      forged({ k: [] }),
      forged({ k: [1, 2] }),
      forged({ extra: 1 }),
    ])
      expect(await refused({ table: "spend", limit: 1, position: bad })).toMatchObject({
        code: "invalid_argument",
        param: "position",
      });
    expect(await refused({ table: "spend", limit: 1, position: forged({ r: 1 }) })).toEqual({
      code: "handle_expired",
      reason: "restored",
      param: "position",
    });
    for (const limit of [0, 201, 1.5, "2"])
      expect(await refused({ table: "spend", limit })).toMatchObject({ param: "limit" });
  });
});

describe("a later page's path: the state after an operation, conditions evaluated in the process", () => {
  /** The rows of the business table's path and of the version table's path at the latest operation. */
  async function both(params: Record<string, unknown>) {
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
            params: { limit: 200, ...params },
            read: "rd_0000000000000000" as never,
            ...(asOf ? { asOf: latest } : {}),
          })
        ).result;
      });
    return { first: await run(false), later: await run(true) };
  }

  it.each<[string, Record<string, unknown>]>([
    ["= on enum", { table: "spend", where: [{ field: "category", op: "=", value: "rent" }] }],
    [
      "!= with empty values",
      { table: "spend", where: [{ field: "note", op: "!=", value: "lunch" }] },
    ],
    [
      "< on quantity in m",
      {
        table: "spend",
        where: [{ field: "distance", op: "<", value: { value: "1745", unit: "m" } }],
      },
    ],
    ["<= on integer", { table: "spend", where: [{ field: "pieces", op: "<=", value: "1" }] }],
    ["> on date", { table: "spend", where: [{ field: "date", op: ">", value: "2026-11-01" }] }],
    [">= on decimal", { table: "spend", where: [{ field: "rate", op: ">=", value: "0.5" }] }],
    ["in on integer", { table: "spend", where: [{ field: "pieces", op: "in", value: [2, "5"] }] }],
    [
      "contains with % _ \\",
      { table: "spend", where: [{ field: "note", op: "contains", value: "f%_\\" }] },
    ],
    [
      "contains, NFC",
      { table: "spend", where: [{ field: "note", op: "contains", value: "fe\u0301" }] },
    ],
    ["is_null", { table: "spend", where: [{ field: "pieces", op: "is_null", value: true }] }],
    [
      "< on zoned",
      { table: "spend", where: [{ field: "at", op: "<", value: "2026-11-01T05:00:00Z" }] },
    ],
    ["= on boolean", { table: "spend", where: [{ field: "paid", op: "=", value: true }] }],
    ["revoked rows", { table: "spend", include_revoked: true }],
    ["event days", { table: "visits", valid_during: ["2026-11-03", null] }],
    ["event days, end excluded", { table: "spend", valid_during: ["2026-11-01", "2026-11-03"] }],
    [
      "state ordered",
      {
        table: "budgets",
        valid_during: ["2026-10-01", null],
        coalesce: false,
        order: [{ field: "amount", dir: "desc" }],
      },
    ],
    ["state now", { table: "budgets" }],
    [
      "state merged, clipped",
      {
        table: "budgets",
        fields: ["category"],
        valid_during: ["2026-11-05", "2026-11-25"],
        clip: true,
      },
    ],
    [
      "state, an open end",
      {
        table: "budgets",
        valid_during: ["2026-10-01", null],
        coalesce: false,
        where: [{ field: "valid_to", op: ">", value: "2026-11-15" }],
      },
    ],
    [
      "state, valid_to null",
      {
        table: "budgets",
        valid_during: ["2026-10-01", null],
        coalesce: false,
        where: [{ field: "valid_to", op: "is_null", value: true }],
      },
    ],
    ["instant state", { table: "rooms", valid_at: "2026-11-02T09:59:59Z" }],
    ["ordered", { table: "spend", order: [{ field: "distance", dir: "desc" }] }],
  ])("%s: the same rows on both paths", async (_, params) => {
    await w1({ ops: [{ intent: "update", table: "spend", row: r3, set: { note: "f%_\\ café" } }] });
    const { first, later } = await both(params);
    expect(first.total).toBeGreaterThan(0);
    expect(later).toEqual(first);
  });
});

describe("condition warnings, refusals, names echoed, edges", () => {
  it("gives timezone_assumed for a condition's date-time with neither an offset nor a zone", async () => {
    const r = await q({
      table: "spend",
      where: [{ field: "at", op: "<", value: "2026-11-01T13:00:00" }],
    });
    expect(r.rows.map((x) => x.row)).toEqual([r1]);
    expect(r.warnings).toEqual([
      { code: "timezone_assumed", param: "where/0/value", timezone: "Asia/Shanghai" },
    ]);
    // With an offset, or a zone, nothing is assumed: comparisons are by instant.
    for (const value of ["2026-11-01T05:00:00Z", "2026-11-01T13:00:00[Asia/Shanghai]"]) {
      const x = await q({ table: "spend", where: [{ field: "at", op: "<", value }] });
      expect(x.rows.map((y) => y.row)).toEqual([r1]);
      expect(x).not.toHaveProperty("warnings");
    }
  });

  it("applies valid_from / valid_to conditions after merging, an open end later than any point, before clip", async () => {
    const ge = await q({
      table: "budgets",
      valid_during: ["2026-11-01", null],
      coalesce: false,
      where: [{ field: "valid_to", op: ">=", value: "2026-11-20" }],
    });
    expect(
      ge.rows.filter((x) => x.entity === entityA).map((x) => [x.valid_from, x.valid_to]),
    ).toEqual([
      ["2026-11-10", "2026-11-20"],
      ["2026-11-20", null],
    ]);
    // valid_from is 11-20 before clip: no segment starts on 11-22.
    const clipped = await q({
      table: "budgets",
      valid_during: ["2026-11-22", null],
      clip: true,
      where: [{ field: "valid_from", op: "=", value: "2026-11-22" }],
    });
    expect(clipped.total).toBe(0);
  });

  it("refuses clip and coalesce where they do not apply", async () => {
    expect(await refused({ table: "spend", clip: true })).toEqual({
      code: "invalid_argument",
      reason: "not_state_table",
      param: "clip",
    });
    expect(await refused({ table: "settings", coalesce: false })).toMatchObject({
      reason: "not_state_table",
    });
    expect(await refused({ table: "budgets", coalesce: false })).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "coalesce",
    });
    expect(await refused({ table: "budgets", valid_at: "2026-11-05", clip: true })).toMatchObject({
      reason: "malformed",
      param: "clip",
    });
  });

  it("echoes at most 200 characters of a name", async () => {
    const e = await refused({ table: "x".repeat(100_000) });
    expect(e).toMatchObject({ code: "unknown_table", name: "x".repeat(200) });
    const f = await refused({ table: "spend", fields: ["y".repeat(100_000)] });
    expect(f).toMatchObject({ code: "unknown_field", name: "y".repeat(200) });
    expect(JSON.stringify(f).length).toBeLessThan(1_000);
  });

  it("excludes the end of an event table's interval, on both paths", async () => {
    const r = await q({ table: "spend", valid_during: ["2026-11-01", "2026-11-03"] });
    expect(r.rows.map((x) => x.row)).toEqual([r1]);
  });

  it("gives rows with an empty value for !=", async () => {
    const r = await q({ table: "spend", where: [{ field: "pieces", op: "!=", value: 2 }] });
    expect(r.rows.map((x) => x.row).sort()).toEqual([r2, r3].sort());
  });

  it("records only the rows of the page given", async () => {
    await q({ table: "spend", limit: 1 });
    const [entry] = readBufferOf(s.store).take();
    expect(entry?.rows).toHaveLength(1);
  });

  it("refuses a position of a query with another include_revoked", async () => {
    const p = await q({ table: "spend", include_revoked: true, limit: 1 });
    expect(
      await refused({
        table: "spend",
        include_revoked: false,
        limit: 1,
        position: p.next_position,
      }),
    ).toMatchObject({
      reason: "malformed",
      param: "position",
    });
  });
});

describe("refusals", () => {
  it.each<[string, unknown, Record<string, unknown>]>([
    ["no table", {}, { code: "invalid_argument", reason: "missing", param: "table" }],
    [
      "an unknown key",
      { table: "spend", select: [] },
      { code: "invalid_argument", reason: "malformed", param: "select" },
    ],
    [
      "valid_at on an event table",
      { table: "spend", valid_at: "2026-11-01" },
      {
        code: "invalid_argument",
        reason: "event_table_valid_at",
        param: "valid_at",
        example: { valid_during: ["2026-11-01", "2026-11-02"] },
      },
    ],
    [
      "time on a timeless table",
      { table: "settings", valid_during: ["2026-11-01", null] },
      { code: "invalid_argument", reason: "no_time_table", param: "valid_during" },
    ],
    [
      "valid_at and valid_during",
      { table: "budgets", valid_at: "2026-11-01", valid_during: ["2026-11-01", null] },
      { code: "invalid_argument", reason: "mutually_exclusive", param: "valid_during" },
    ],
    [
      "an interval not forward",
      { table: "budgets", valid_during: ["2026-11-02", "2026-11-02"] },
      { code: "invalid_argument", reason: "malformed", param: "valid_during/1" },
    ],
    [
      "at without an offset",
      { table: "budgets", at: "2026-11-02T10:00:00" },
      { code: "invalid_argument", reason: "malformed", param: "at" },
    ],
    [
      "a field twice",
      { table: "spend", fields: ["date", "DATE"] },
      { code: "invalid_argument", reason: "malformed", param: "fields/1" },
    ],
    [
      "detail: detailed (not yet)",
      { table: "spend", detail: "detailed" },
      { code: "internal", reason: "not_implemented", param: "detail" },
    ],
  ])("refuses %s", async (_, params, error) => {
    expect(await refused(params)).toEqual(error);
  });

  it("names tables and fields without case, unknown ones with the nearest names", async () => {
    expect((await q({ table: "LEDGER.Spend", fields: ["DATE"] })).total).toBe(3);
    expect(await refused({ table: "spnd" })).toEqual({
      code: "unknown_table",
      param: "table",
      name: "spnd",
      nearest: ["spend", "rooms", "visits"],
    });
    expect(await refused({ table: "spend", fields: ["dates"] })).toMatchObject({
      code: "unknown_field",
      param: "fields/0",
      nearest: expect.arrayContaining(["date"]),
    });
  });

  it("does not see a slot out of the visible range", async () => {
    const scoped = { kind: "scoped", slots: [{ slot: `sl_${"9".repeat(16)}` }] };
    expect(await refused({ table: "spend" }, { visibility: scoped })).toEqual({
      code: "unknown_table",
      param: "table",
      name: "spend",
      nearest: [],
    });
    const tableScoped = { kind: "scoped", slots: [{ slot: SLOT, tables: [{ table: "t3" }] }] };
    expect(await refused({ table: "spend" }, { visibility: tableScoped })).toMatchObject({
      code: "unknown_table",
      nearest: ["budgets"],
    });
  });
});

describe("the read recorded", () => {
  it("records the page's rows with versions, one per entity, a shape without values", async () => {
    const r = await q(
      {
        table: "budgets",
        valid_during: ["2026-11-05", null],
        coalesce: false,
        where: [{ field: "category", op: "=", value: "food" }],
        limit: 5,
      },
      { actor: OTHER, task: "t1" },
    );
    expect(r.total).toBe(3);
    const [entry] = readBufferOf(s.store).take();
    expect(entry).toEqual({
      read: expect.stringMatching(/^rd_[0-9A-HJKMNP-TV-Z]{16}$/),
      actor: OTHER,
      task: "t1",
      at: NOW,
      pos: expect.any(Number),
      operation: "query",
      slot: SLOT,
      sv: 1,
      table: "t3",
      shape:
        '{"fields":["f1","f2"],"order":[],"page":true,"table":"t3","time":"during","where":[{"field":"f1","op":"=","value":"?"}]}',
      valid: { during: ["2026-11-05", null] },
      rows: [{ table: "t3", target: entityA, ver: { op: expect.any(Number), restoreCount: 0 } }],
      coarse: [],
      lastRead: [
        { kind: "ver", target: entityA, op: expect.any(Number), restoreCount: 0 },
        { kind: "sv", target: SLOT, op: 1, restoreCount: 0 },
      ],
    });
    expect(entry?.shape).not.toContain("food");
    // A default read of a state table records "now" as its day.
    await q({ table: "budgets" });
    expect(readBufferOf(s.store).take()[0]?.valid).toEqual({ at: "2026-11-05" });
  });

  it("is what a write without ver falls back to", async () => {
    const r = await q(
      { table: "spend", where: [{ field: "note", op: "=", value: "lunch" }] },
      { actor: OTHER },
    );
    const read = readBufferOf(s.store).lastRead({
      actor: OTHER as never,
      task: null,
      kind: "ver",
      target: r1,
    })?.read;
    expect(read).toEqual(expect.stringMatching(/^rd_/));
    const receipt = await w(
      { ops: [{ intent: "update", table: "spend", row: r1, set: { note: "dinner" } }] },
      OTHER,
    );
    expect(receipt.warnings).toContainEqual({
      code: "ver_fallback",
      op: 0,
      ver: r.rows[0]?.ver,
      read,
    });
    expect(receipt.warnings).toContainEqual(
      expect.objectContaining({ code: "sv_fallback", sv: 1, read }),
    );
    // The write flushed the read first.
    const n = await s.store.read((tx) =>
      tx.query<{ n: number }>("SELECT count(*)::int AS n FROM read_log WHERE read_id = $1", [
        read as string,
      ]),
    );
    expect(n.rows[0]?.n).toBe(1);
    await flushReads(
      s.store,
      createOpsContext({ ...ctx(), actor: "system", trigger: "flushReads" }),
    );
  });
});

describe("zoned_datetime values out as RFC 9557 text, and back in (04-contract-types §1.3)", () => {
  const TEXTS = [
    "2026-11-11T09:00:00.250-05:00[America/New_York]",
    // The hour America/New_York goes back: one wall-clock time, two instants.
    "2026-11-01T01:30:00-04:00[America/New_York]",
    "2026-11-01T01:30:00-05:00[America/New_York]",
    // An offset with seconds (-00:44:30, -00:45 written) and the ends of the range.
    "1971-06-01T11:15:30-00:45[Africa/Monrovia]",
    "0001-01-01T08:05:43+08:06[Asia/Shanghai]",
    "9999-12-31T23:59:59.999+08:00[Asia/Shanghai]",
  ];

  it(
    "written, read and written again: the same text, the same value (noop); the replay gives it too",
    async () => {
      for (const [i, text] of TEXTS.entries()) {
        const params = {
          ...ins("spend", { date: "2026-11-20", at: text }),
          idempotency_key: `z-${i}`,
        };
        const a = await w1(params);
        expect(a.ops[0]?.fields["at"], text).toEqual({ result: "applied", after: text });
        const again = await w1(params);
        expect(again.replayed).toBe(true);
        expect(again.ops[0]?.fields["at"], text).toEqual({ result: "applied", after: text });
        const row = target(a).row as string;
        const read = (await q({ table: "spend", limit: 200 })).rows.find((x) => x.row === row);
        expect(read?.values["at"], text).toBe(text);
        const back = await w1({
          ops: [
            {
              intent: "update",
              table: "spend",
              row,
              ver: a.ops[0]?.ver,
              set: { at: read?.values["at"] },
            },
          ],
        });
        expect(back.ops[0]?.fields["at"], text).toEqual({ result: "noop" });
      }
    },
    T,
  );

  it(
    "written with the zone only, the offset only, or an alias: read back and written again, a noop",
    async () => {
      for (const [written, read] of [
        ["2026-11-10T12:31:00[Asia/Shanghai]", "2026-11-10T12:31:00+08:00[Asia/Shanghai]"],
        // The offset only: the slot's zone (Asia/Shanghai) is recorded.
        ["2026-11-10T13:31:00+09:00", "2026-11-10T12:31:00+08:00[Asia/Shanghai]"],
        // An alias the runtime maps to another name: kept as written (10-types-and-units).
        ["2026-11-09T23:31:00-05:00[US/Eastern]", "2026-11-09T23:31:00-05:00[US/Eastern]"],
      ] as const) {
        const a = await w1(ins("spend", { date: "2026-11-22", at: written }));
        const row = target(a).row as string;
        const got = (await q({ table: "spend", limit: 200 })).rows.find((x) => x.row === row);
        expect(got?.values["at"], written).toBe(read);
        const back = await w1({
          ops: [{ intent: "update", table: "spend", row, ver: a.ops[0]?.ver, set: { at: read } }],
        });
        expect(back.ops[0]?.fields["at"], written).toEqual({ result: "noop" });
      }
    },
    T,
  );

  it(
    "a conflict on one: the receipt's effective and merge base, and the item's details, as text",
    async () => {
      const first = "2026-11-10T12:31:00+08:00[Asia/Shanghai]";
      const theirs = "2026-11-10T13:00:00+08:00[Asia/Shanghai]";
      const a = await w1(ins("spend", { date: "2026-11-21", at: first }));
      const row = target(a).row as string;
      const b = await w1({
        ops: [{ intent: "update", table: "spend", row, ver: a.ops[0]?.ver, set: { at: theirs } }],
      });
      expect(b.ops[0]?.fields["at"]).toEqual({ result: "applied", after: theirs });
      // The row's timeline gives the value before and after as text too.
      const tl = (await history(s.store, ctx({ now: NOW }), {
        table: "spend",
        row,
      })) as unknown as {
        entries: { seq: number; fields: Record<string, { before?: unknown; after?: unknown }> }[];
      };
      expect(tl.entries.find((e) => e.seq === b.seq)?.fields["at"]).toMatchObject({
        before: first,
        after: theirs,
      });
      const conflicting = {
        ops: [
          {
            intent: "update",
            table: "spend",
            row,
            ver: a.ops[0]?.ver,
            set: { at: "2026-11-10T14:00:00+08:00[Asia/Shanghai]" },
          },
        ],
        idempotency_key: "z-conflict",
      };
      const c = await w1(conflicting);
      // Replayed from the log: the same op results, effective and merge base as text too.
      const replay = await w1(conflicting);
      expect(replay.replayed).toBe(true);
      expect(replay.ops).toEqual(c.ops);
      const part = c.ops[0]?.fields["at"] as {
        result: string;
        item: string;
        effective: unknown;
        previous: { values: Record<string, unknown> };
      };
      expect(part.result).toBe("candidate");
      expect(part.effective).toBe(theirs);
      expect(part.previous.values["at"]).toBe(first);
      const detail = (await pending(s.store, ctx({ now: NOW }), { id: part.item })) as unknown as {
        effective: { values: Record<string, unknown> };
        previous: { values: Record<string, unknown> };
        candidates: { values: Record<string, unknown> }[];
      };
      expect(detail.effective.values["at"]).toBe(theirs);
      expect(detail.previous.values["at"]).toBe(first);
      expect(detail.candidates[0]?.values["at"]).toBe("2026-11-10T14:00:00+08:00[Asia/Shanghai]");
    },
    T,
  );
});
