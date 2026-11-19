// Writing by `entity_key` on PGlite, case by case (03-data-model/05-time «按 entity_key 写入»;
// 04-contract §5.1, §14 «重放返回什么»; 09-event-format §5.7): the entity holding the key is
// written, or created; the key joins the op's `set`; key fields cannot change; a receipt of a
// creation lists the table's keys before it, which a replay leaves out.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  query,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 60_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const money = (id: string, name: string) => ({
  id,
  name,
  type: "decimal",
  required: true,
  description: name,
  precision: { scale: 2, rounding: "half_up" },
});
const state = { type: "state", granularity: "date" };
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t2",
      name: "budgets",
      kind: "base",
      description: "budgets",
      time: state,
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "category", type: "text", required: true, description: "category" },
        money("f2", "amount"),
        { id: "f3", name: "note", type: "text", description: "note" },
      ],
      entity_key: ["f1"],
    },
    {
      id: "t4",
      name: "limits",
      kind: "base",
      description: "limits by region and level",
      time: state,
      physical: { table: "t_t4_v1" },
      fields: [
        { id: "f1", name: "region", type: "text", required: true, description: "region" },
        money("f5", "level"),
        money("f2", "amount"),
      ],
      entity_key: ["f1", "f5"],
    },
    {
      id: "t5",
      name: "bookings",
      kind: "base",
      description: "bookings by when and deposit",
      time: state,
      physical: { table: "t_t5_v1" },
      fields: [
        { id: "f6", name: "at", type: "zoned_datetime", required: true, description: "when" },
        {
          id: "f7",
          name: "deposit",
          type: "quantity",
          required: true,
          description: "deposit",
          unit: { code: "CNY", dimension: "currency:CNY" },
          precision: { scale: 2, rounding: "half_up" },
        },
        money("f2", "amount"),
      ],
      entity_key: ["f6", "f7"],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t2" }, change: "add_table" },
  { target: { table: "t4" }, change: "add_table" },
  { target: { table: "t5" }, change: "add_table" },
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
  return `2026-11-05T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

type Receipt = {
  seq: number;
  replayed?: true;
  omitted?: string[];
  warnings?: { code: string }[];
  ops: {
    target: { entity?: string };
    ver?: string;
    created_entity?: true;
    existing_keys?: unknown[];
    fields: Record<string, unknown>;
  }[];
};
type Refusal = { refused: string; reason?: string; param?: string };

/** Sends `params` through the pipeline; the error, if refused. */
async function send(params: unknown): Promise<Receipt & Refusal> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
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
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}

async function eventsOfOp(op: number) {
  return s.store.read(async (tx) =>
    (await readEvents(tx, op, (await readTail(tx))?.seq ?? op)).map((e) => ({
      type: e.header["type"] as string,
      blocks: Object.fromEntries(
        [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
      ) as Record<string, unknown>,
    })),
  );
}
const headOf = async (op: number) => (await eventsOfOp(op))[0]?.blocks as Record<string, unknown>;

/** How many entities the table has (rows of its version table by entity). */
const entities = async (table: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ n: unknown }>(
      `SELECT count(DISTINCT row_id) AS n FROM "t_${table}_v1__ver"`,
    );
    return Number(r.rows[0]?.n);
  });

const budget = (
  category: unknown,
  set: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  intent: "update",
  table: "budgets",
  entity_key: { category },
  set,
  valid_from: "2026-10-01",
  ...extra,
});
const one = (op: Record<string, unknown>) => send({ sv: 1, ops: [op] });

beforeAll(async () => {
  s = await openReusable("saveslot-write-entity-key-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  ids = 0;
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
}, T);

describe("locating by key", () => {
  it(
    "no entity holds the key: created, the key written as its key field, no ver; existing_keys",
    async () => {
      const r = await one(budget("food", { amount: "5000" }));
      const entity = "e_00000000000000000000000001";
      expect(r.ops).toEqual([
        {
          target: { table: "ledger.budgets", entity, entity_key: { category: "food" } },
          intent: "update",
          ver: `v${r.seq}.0`,
          created_entity: true,
          existing_keys: [],
          fields: {
            category: [
              {
                result: "applied",
                after: "food",
                valid: { valid_from: "2026-10-01", valid_to: null },
              },
            ],
            amount: [
              {
                result: "applied",
                after: "5000",
                valid: { valid_from: "2026-10-01", valid_to: null },
              },
            ],
          },
          // Each field: the start given (10-01); the end not given, so by default to the next
          // change (04-contract §4); the entity is new, with none after it: lasting, no next_change.
          resolved: {
            category: {
              valid_from: "2026-10-01",
              valid_to: null,
              from_as: "given",
              to_as: "next_change",
            },
            amount: {
              valid_from: "2026-10-01",
              valid_to: null,
              from_as: "given",
              to_as: "next_change",
            },
          },
        },
      ]);
      const head = await headOf(r.seq);
      expect(head["ops/0/target"]).toEqual({
        table: "t2",
        entity,
        intent: "update",
        by_entity_key: true,
        created: true,
      });
      expect(head["ops/0/set/f1"]).toBe("food");
      expect(head["ops/0/set/f2"]).toBe("5000");
      expect(head["ops/0/noop"]).toBeUndefined();
    },
    T,
  );

  it(
    "an entity holds the key: written with its ver; the key fields a no-op, the api_call source unchanged",
    async () => {
      const a = await one(budget("food", { amount: "5000" }));
      const r = await one(budget("food", { amount: "4000" }, { ver: a.ops[0]?.ver }));
      expect(r.ops[0]?.target.entity).toBe(a.ops[0]?.target.entity);
      expect(r.ops[0]?.created_entity).toBeUndefined();
      expect(r.ops[0]?.existing_keys).toBeUndefined();
      expect(r.ops[0]?.fields["category"]).toEqual([{ result: "noop" }]);
      const events = await eventsOfOp(r.seq);
      const head = events[0]?.blocks as Record<string, unknown>;
      expect(head["ops/0/target"]).toEqual({
        table: "t2",
        entity: a.ops[0]?.target.entity,
        intent: "update",
        by_entity_key: true,
        ver: { op: a.seq, restore_count: 0, basis: "explicit" },
      });
      expect(head["ops/0/noop"]).toEqual(["f1"]);
      expect(head["ops/0/set/f1"]).toBeUndefined();
      const source = events.find((e) => e.type === "source.recorded")?.blocks;
      expect(source?.["request"]).toEqual(
        budget("food", { amount: "4000" }, { ver: a.ops[0]?.ver }),
      );
      expect(await entities("t2")).toBe(1);
    },
    T,
  );

  it(
    "an entity holds the key, the op without ver and nothing read: read_first (concurrent first creation)",
    async () => {
      await one(budget("food", { amount: "5000" }));
      // Another caller, who never read it, writes the same key.
      const r = await s.store
        .write((tx) =>
          writeInTx(tx, {
            actor: `ci_${"2".repeat(26)}` as never,
            task: null,
            now: now(),
            windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
            visibility: { kind: "all" },
            params: { sv: 1, ops: [budget("food", { amount: "4000" })] },
            newId,
            reads: readBufferOf(s.store),
          }),
        )
        .catch((e: { code: string; detail: Record<string, unknown> }) => ({
          refused: e.code,
          ...e.detail,
        }));
      expect(r).toMatchObject({ refused: "read_first", param: "ops/0/ver" });
      expect(await entities("t2")).toBe(1);
    },
    T,
  );

  it(
    "created by an earlier op of the request: a later op by the same key needs no ver, no fallback",
    async () => {
      const r = await send({
        sv: 1,
        ops: [
          budget("food", { amount: "5000" }),
          budget("food", { amount: "3000" }, { valid_from: "2026-11-01" }),
        ],
      });
      expect(r.warnings).toBeUndefined();
      expect(r.ops[1]?.target.entity).toBe(r.ops[0]?.target.entity);
      expect(r.ops[1]?.created_entity).toBeUndefined();
      const head = await headOf(r.seq);
      expect(head["ops/1/target"]).toMatchObject({
        by_entity_key: true,
        ver: { op: r.seq, basis: "same_request" },
      });
      expect(head["ops/1/target"]).not.toHaveProperty("created");
      expect(await entities("t2")).toBe(1);
    },
    T,
  );

  it(
    "the same value written another way is the same key: decimals by scale, text by NFC",
    async () => {
      const a = await one({
        intent: "update",
        table: "limits",
        entity_key: { region: "Montréal", level: "5" },
        set: { amount: "1" },
        valid_from: "2026-10-01",
      });
      const r = await one({
        intent: "update",
        table: "limits",
        entity_key: { region: "Montréal", level: "5.00" },
        set: { amount: "2", level: 5.0 },
        valid_from: "2026-10-01",
        ver: a.ops[0]?.ver,
      });
      expect(r.refused).toBeUndefined();
      expect(r.ops[0]?.target.entity).toBe(a.ops[0]?.target.entity);
      expect(await entities("t4")).toBe(1);
    },
    T,
  );

  it(
    "a key of several fields: another value in one of them is another entity",
    async () => {
      const lim = (level: string) => ({
        intent: "update",
        table: "limits",
        entity_key: { region: "north", level },
        set: { amount: "1" },
        valid_from: "2026-10-01",
      });
      const a = await one(lim("1"));
      const b = await one(lim("2"));
      expect(b.ops[0]?.created_entity).toBe(true);
      expect(b.ops[0]?.target.entity).not.toBe(a.ops[0]?.target.entity);
      expect(b.ops[0]?.existing_keys).toEqual([{ region: "north", level: "1" }]);
      expect(await entities("t4")).toBe(2);
    },
    T,
  );

  it(
    "an entity revoked as a whole keeps its key: a write by it fills the gap, key fields taken from the key",
    async () => {
      const a = await one(budget("food", { amount: "5000" }));
      const entity = a.ops[0]?.target.entity as string;
      const v = await one({ intent: "revoke", table: "budgets", entity, ver: a.ops[0]?.ver });
      expect(v.refused).toBeUndefined();
      const r = await one(budget("food", { amount: "6000" }, { ver: v.ops[0]?.ver }));
      expect(r.refused).toBeUndefined();
      expect(r.ops[0]?.target.entity).toBe(entity);
      expect(r.ops[0]?.created_entity).toBeUndefined();
      expect(r.ops[0]?.fields["category"]).toEqual([
        { result: "applied", after: "food", valid: { valid_from: "2026-10-01", valid_to: null } },
      ]);
      expect(await entities("t2")).toBe(1);
    },
    T,
  );

  it(
    "revoking or undoing by a key no entity holds: not_found, nothing written",
    async () => {
      expect(
        await one({ intent: "revoke", table: "budgets", entity_key: { category: "none" } }),
      ).toMatchObject({ refused: "not_found", param: "ops/0/entity_key" });
      expect(await entities("t2")).toBe(0);
    },
    T,
  );
});

describe("key fields cannot change", () => {
  it(
    "by entity: a key field in set unlike the entity's key is refused at it; the same value written another way is not",
    async () => {
      const a = await one({
        intent: "update",
        table: "limits",
        entity_key: { region: "north", level: "5" },
        set: { amount: "1" },
        valid_from: "2026-10-01",
      });
      const entity = a.ops[0]?.target.entity as string;
      const ver = a.ops[0]?.ver;
      expect(
        await one({ intent: "update", table: "limits", entity, ver, set: { region: "south" } }),
      ).toMatchObject({
        refused: "invalid_argument",
        reason: "key_field_changed",
        param: "ops/0/set/region",
      });
      expect(
        await one({ intent: "update", table: "limits", entity, ver, set: { level: "6" } }),
      ).toMatchObject({ reason: "key_field_changed", param: "ops/0/set/level" });
      const same = await one({
        intent: "update",
        table: "limits",
        entity,
        ver,
        set: { level: "5.00", amount: "2" },
      });
      expect(same.refused).toBeUndefined();
      expect(same.ops[0]?.fields["level"]).toEqual([{ result: "noop" }]);
    },
    T,
  );

  it(
    "by key: a key field in set unlike entity_key is refused, whether the entity exists or not",
    async () => {
      expect(await one(budget("food", { category: "drink", amount: "1" }))).toMatchObject({
        refused: "invalid_argument",
        reason: "key_field_changed",
        param: "ops/0/set/category",
      });
      expect(await entities("t2")).toBe(0);
      const a = await one(budget("food", { amount: "1" }));
      expect(
        await one(budget("food", { category: "drink", amount: "2" }, { ver: a.ops[0]?.ver })),
      ).toMatchObject({ reason: "key_field_changed", param: "ops/0/set/category" });
    },
    T,
  );

  it(
    "an entity created by an earlier op of the request: a key field unlike its key is refused",
    async () => {
      const r = await send({
        sv: 1,
        ops: [
          budget("food", { amount: "1" }),
          {
            intent: "update",
            table: "budgets",
            entity: "e_00000000000000000000000001",
            set: { category: "drink" },
          },
        ],
      });
      expect(r).toMatchObject({ reason: "key_field_changed", param: "ops/1/set/category" });
      expect(await entities("t2")).toBe(0);
    },
    T,
  );
});

describe("existing_keys", () => {
  it(
    "the table's keys before the creation, at most 10, the latest written first, revoked ones included",
    async () => {
      const made: { category: string; entity: string; ver: string }[] = [];
      for (let i = 0; i < 11; i++) {
        const r = await one(budget(`c${i}`, { amount: "1" }));
        made.push({
          category: `c${i}`,
          entity: r.ops[0]?.target.entity as string,
          ver: r.ops[0]?.ver as string,
        });
      }
      // c0 written again (now the latest written), c1 revoked as a whole (the next latest).
      const c0 = made[0] as (typeof made)[number];
      const c1 = made[1] as (typeof made)[number];
      expect((await one(budget("c0", { amount: "2" }, { ver: c0.ver }))).refused).toBeUndefined();
      const v = await one({ intent: "revoke", table: "budgets", entity: c1.entity, ver: c1.ver });
      expect(v.refused).toBeUndefined();
      const r = await one(budget("new", { amount: "1" }));
      expect(r.ops[0]?.existing_keys).toEqual([
        "c1",
        "c0",
        "c10",
        "c9",
        "c8",
        "c7",
        "c6",
        "c5",
        "c4",
        "c3",
      ]);
    },
    T,
  );

  it(
    "a replay gives no existing_keys and lists them in omitted",
    async () => {
      await one(budget("drink", { amount: "1" }));
      const params = { sv: 1, ops: [budget("food", { amount: "5000" })] };
      const first = await send(params);
      expect(first.ops[0]?.existing_keys).toEqual(["drink"]);
      const again = await send(params);
      expect(again.replayed).toBe(true);
      expect(again.seq).toBe(first.seq);
      expect(again.omitted).toEqual(["existing_keys"]);
      expect(again.ops[0]?.existing_keys).toBeUndefined();
      expect(again.ops[0]?.created_entity).toBe(true);
    },
    T,
  );

  it(
    "a replay of a write by key to an existing entity omits nothing",
    async () => {
      const a = await one(budget("food", { amount: "5000" }));
      const params = { sv: 1, ops: [budget("food", { amount: "4000" }, { ver: a.ops[0]?.ver })] };
      await send(params);
      const again = await send(params);
      expect(again.replayed).toBe(true);
      expect(again.omitted).toBeUndefined();
    },
    T,
  );
});

describe("the key of an entity comes from the event that created it", () => {
  it(
    "created and revoked by key in one request: a later write by the key is the same entity",
    async () => {
      const r = await send({
        sv: 1,
        ops: [
          budget("zz", { amount: "1" }),
          { intent: "revoke", table: "budgets", entity_key: { category: "zz" } },
        ],
      });
      expect(r.refused).toBeUndefined();
      const entity = r.ops[0]?.target.entity;
      expect(r.ops[1]?.target.entity).toBe(entity);
      const again = await one(budget("zz", { amount: "2" }, { ver: r.ops[1]?.ver }));
      expect(again.refused).toBeUndefined();
      expect(again.ops[0]?.target.entity).toBe(entity);
      expect(again.ops[0]?.created_entity).toBeUndefined();
      expect(await entities("t2")).toBe(1);
    },
    T,
  );

  it(
    "created and revoked over an interval in one request: the same",
    async () => {
      const r = await send({
        sv: 1,
        ops: [
          budget("zz", { amount: "1" }, { valid_to: "2026-10-05" }),
          {
            intent: "revoke",
            table: "budgets",
            entity_key: { category: "zz" },
            valid_from: "2026-10-01",
            valid_to: "2026-10-05",
          },
        ],
      });
      expect(r.refused).toBeUndefined();
      const again = await one(budget("zz", { amount: "2" }, { ver: r.ops[1]?.ver }));
      expect(again.refused).toBeUndefined();
      expect(again.ops[0]?.target.entity).toBe(r.ops[0]?.target.entity);
      expect(await entities("t2")).toBe(1);
    },
    T,
  );

  it(
    "by entity ID, a key field given another entity's key is refused as a change of key",
    async () => {
      const a = await one(budget("a", { amount: "1" }));
      await one(budget("b", { amount: "1" }));
      expect(
        await one({
          intent: "update",
          table: "budgets",
          entity: a.ops[0]?.target.entity,
          ver: a.ops[0]?.ver,
          set: { category: "b" },
        }),
      ).toMatchObject({ refused: "invalid_argument", reason: "key_field_changed" });
    },
    T,
  );

  it(
    "existing_keys lists the request's earlier new keys first",
    async () => {
      await one(budget("old", { amount: "1" }));
      const r = await send({
        sv: 1,
        ops: [budget("k3", { amount: "1" }), budget("k4", { amount: "1" })],
      });
      expect(r.ops[0]?.existing_keys).toEqual(["old"]);
      expect(r.ops[1]?.existing_keys).toEqual(["k3", "old"]);
    },
    T,
  );

  it(
    "the receipt's target gives the key of an entity located by it",
    async () => {
      const a = await one(budget("food", { amount: "1" }));
      const r = await one(budget("food", { amount: "2" }, { ver: a.ops[0]?.ver }));
      expect(r.ops[0]?.target).toEqual({
        table: "ledger.budgets",
        entity: a.ops[0]?.target.entity,
        entity_key: { category: "food" },
      });
    },
    T,
  );
});

describe("keys that are not text", () => {
  const booking = (at: string, deposit: unknown, extra: Record<string, unknown> = {}) => ({
    intent: "update",
    table: "bookings",
    entity_key: {
      at,
      deposit: typeof deposit === "string" ? { value: deposit, unit: "CNY" } : deposit,
    },
    set: { amount: "1" },
    valid_from: "2026-10-01",
    ...extra,
  });

  it(
    "a zoned key shown as text that writes back to the same entity",
    async () => {
      const a = await one(booking("2026-11-05T10:00:00+08:00[Asia/Shanghai]", "5"));
      const b = await one(booking("2026-11-06T10:00:00+08:00[Asia/Shanghai]", "5"));
      const [shown] = (b.ops[0]?.existing_keys ?? []) as { at: string; deposit: string }[];
      expect(shown).toEqual({
        at: "2026-11-05T10:00:00+08:00[Asia/Shanghai]",
        deposit: "5 CNY",
      });
      const again = await one(
        booking((shown as { at: string }).at, { value: "5", unit: "CNY" }, { ver: a.ops[0]?.ver }),
      );
      expect(again.refused).toBeUndefined();
      expect(again.ops[0]?.target.entity).toBe(a.ops[0]?.target.entity);
    },
    T,
  );

  it(
    "a zoned key whose zone's offset has seconds: existing_keys gives the receipt's text, which writes back",
    async () => {
      // Africa/Monrovia before 1972: -00:44:30, written -00:45 (04-contract-types §1.3).
      const text = "1971-06-01T11:15:30-00:45[Africa/Monrovia]";
      const a = await one(booking(text, "7"));
      expect((a.ops[0]?.target as { entity_key?: unknown } | undefined)?.entity_key).toEqual({
        at: text,
        deposit: { value: "7", unit: "CNY" },
      });
      const b = await one(booking("1971-06-02T11:15:30-00:45[Africa/Monrovia]", "7"));
      const shown = ((b.ops[0]?.existing_keys ?? []) as { at: string }[]).find((k) =>
        k.at.startsWith("1971-06-01"),
      );
      expect(shown?.at).toBe(text);
      const again = await one(booking(shown?.at as string, "7", { ver: a.ops[0]?.ver }));
      expect(again.refused).toBeUndefined();
      expect(again.ops[0]?.target.entity).toBe(a.ops[0]?.target.entity);
    },
    T,
  );

  it(
    "the key query gives finds the entity's history, a zoned field among its fields",
    async () => {
      const a = await one(booking("1971-06-01T11:15:30-00:45[Africa/Monrovia]", "8"));
      const ctx = createOpsContext({
        tenant: TENANT,
        actor: USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 600_000,
        now: "2026-11-06T00:00:00.000Z",
        confirmation: null,
      });
      const row = (await query(s.store, ctx, { table: "bookings" })).rows.find(
        (x) => x.entity === a.ops[0]?.target.entity,
      );
      expect(row?.entity_key?.["at"]).toBe("1971-06-01T11:15:30-00:45[Africa/Monrovia]");
      const h = (await history(s.store, ctx, {
        table: "bookings",
        entity_key: row?.entity_key,
      })) as unknown as { target: { entity: string } };
      expect(h.target.entity).toBe(a.ops[0]?.target.entity);
    },
    T,
  );

  it(
    "the same instant in another zone is another key",
    async () => {
      const a = await one(booking("2026-11-05T10:00:00+08:00[Asia/Shanghai]", "5"));
      const b = await one(booking("2026-11-05T11:00:00+09:00[Asia/Tokyo]", "5"));
      expect(b.ops[0]?.created_entity).toBe(true);
      expect(b.ops[0]?.target.entity).not.toBe(a.ops[0]?.target.entity);
    },
    T,
  );

  it(
    "two keys of one request sharing their first field are two entities",
    async () => {
      const r = await send({
        sv: 1,
        ops: [
          booking("2026-11-05T10:00:00+08:00[Asia/Shanghai]", "5"),
          booking("2026-11-05T10:00:00+08:00[Asia/Shanghai]", "6"),
        ],
      });
      expect(r.ops.map((o) => o.created_entity)).toEqual([true, true]);
      expect(r.ops[1]?.target.entity).not.toBe(r.ops[0]?.target.entity);
    },
    T,
  );

  it(
    "set giving the key's values again, written another way, is not a change of key",
    async () => {
      const a = await one(booking("2026-11-05T10:00:00+08:00[Asia/Shanghai]", "5"));
      const r = await one(
        booking("2026-11-05T10:00:00+08:00[Asia/Shanghai]", "5", {
          ver: a.ops[0]?.ver,
          set: {
            amount: "2",
            deposit: { value: "5.0", unit: "CNY" },
            at: "2026-11-05T10:00:00.000+08:00[asia/shanghai]",
          },
        }),
      );
      expect(r.refused).toBeUndefined();
      expect(r.ops[0]?.target.entity).toBe(a.ops[0]?.target.entity);
    },
    T,
  );
});
