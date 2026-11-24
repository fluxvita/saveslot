// Temporary names (`as`) through the write path (04-contract «临时名 as», §1 `ref`; 03-data-model/
// 04-write-and-read «按来源键写入» «可以带临时名 as»; 09 §5.2 `ops/<i>/refs`): an insert or an op by
// key declares a name, a later op of the request writes it in a ref field as "@name", the ID the
// name is bound to recorded in the value; a name skipped with its op binds nothing.

import {
  createOpsContext,
  createTenant,
  query,
  readEvents,
  readTail,
  reconcileLog,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
// biome-ignore lint/suspicious/noExplicitAny: receipts and blocks read loosely in a test
type Any = any;

// `orders` and `lines`, both timeless and keyed by the source's ID; a line refers to its order.
const ORDERS = {
  name: "orders",
  kind: "base",
  description: "an order",
  time: { type: "none" },
  external_key: ["oid"],
  fields: [
    { name: "oid", type: "text", description: "the source's ID" },
    { name: "total", type: "integer", description: "the total" },
  ],
};
const LINES = {
  name: "lines",
  kind: "base",
  description: "a line of an order",
  time: { type: "none" },
  external_key: ["lid"],
  fields: [
    { name: "lid", type: "text", description: "the source's ID" },
    { name: "item", type: "text", description: "what" },
    {
      name: "order",
      type: "ref",
      description: "its order",
      ref: { table: "orders", target: "row" },
    },
  ],
};
// A state table by entity key, for a premise on an entity this request creates by its key.
const BUDGETS = {
  name: "budgets",
  kind: "base",
  description: "a budget",
  time: { type: "state", granularity: "date" },
  entity_key: ["category"],
  fields: [
    { name: "category", type: "text", required: true, description: "what for" },
    { name: "amount", type: "integer", required: true, description: "how much" },
  ],
};
const DOCUMENT = {
  slot: "shop",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [ORDERS, LINES, BUDGETS],
};

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" } as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const w = (params: unknown): Promise<Any> => write(s.store, ctx(), params);
async function refused(params: unknown) {
  try {
    await w(params);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...x.detail };
  }
  return "accepted";
}
const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
const order = (oid: string, total: number, as?: string) => ({
  intent: "update",
  table: "orders",
  external_key: { oid },
  set: { total },
  ...(as !== undefined ? { as } : {}),
});
const line = (lid: string, ref: string) => ({
  intent: "update",
  table: "lines",
  external_key: { lid },
  set: { item: lid, order: ref },
});
const lineOrders = async () =>
  ((await query(s.store, ctx(), { table: "lines" })) as Any).rows.map(
    (r: Any) => [r.values.item, r.values.order] as const,
  );

beforeAll(async () => {
  s = await openReusable("saveslot-write-as-");
  scratch = await openReusable("saveslot-write-as-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await scratch.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
}, T);

describe("a name declared, then written in a ref field", () => {
  it(
    "an insert's name: the line refers to the order made in the same request; the head records the name, the value the ID",
    async () => {
      const ops = [
        { intent: "insert", table: "orders", set: { total: 30 }, as: "o1" },
        { intent: "insert", table: "lines", set: { item: "tea", order: "@o1" } },
      ];
      const r = await w({ sv: 1, ops });
      const id = r.ops[0].target.row;
      expect(r.ops[0]).toMatchObject({ as: "o1" });
      expect(r.ops[1].as).toBeUndefined();
      expect(r.ops[1].fields.order).toMatchObject({ result: "applied", after: id });
      expect(await lineOrders()).toEqual([["tea", id]]);
      const head = (await s.store.read((tx) => readEvents(tx, r.seq, r.seq)))[0] as Any;
      const blocks = Object.fromEntries(
        [...head.blocks].flatMap(([k, b]: Any) => (b.state === "present" ? [[k, b.value]] : [])),
      );
      expect(blocks["ops/0/refs"]).toEqual({ as: "o1" });
      expect(blocks["ops/1/refs"]).toBeUndefined();
      // The ref value as recorded (`ops/<i>/set/<f>`, the raw value): the ID, never the name.
      const sets = Object.entries(blocks).filter(([k]) => k.startsWith("ops/1/set/"));
      expect(sets.map(([, v]) => v)).toContain(id);
      expect(JSON.stringify(blocks)).not.toContain("@o1");
      const re = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(re.mismatches).toEqual([]);
    },
    T,
  );

  it(
    "by key: created and hit both bind; the line by key refers to its order in one request",
    async () => {
      const first = await w({ sv: 1, ops: [order("A", 30, "o"), line("A-1", "@o")] });
      const a = first.ops[0].target.row;
      expect(first.ops.map((o: Any) => o.outcome)).toEqual(["created", "created"]);
      // Sent again: the order is hit (unchanged), its name bound to it all the same.
      const again = await w({ sv: 1, ops: [order("A", 30, "o"), line("A-2", "@o")] });
      expect(again.ops.map((o: Any) => o.outcome)).toEqual(["unchanged", "created"]);
      expect(again.ops[0]).toMatchObject({ as: "o", target: { row: a } });
      expect((await lineOrders()).sort()).toEqual([
        ["A-1", a],
        ["A-2", a],
      ]);
    },
    T,
  );
});

describe("only a ref field's value is a name", () => {
  it(
    'a text field written "@o1", o1 declared: stored as that text, the ref field resolved',
    async () => {
      const r = await w({
        sv: 1,
        ops: [
          { intent: "insert", table: "orders", set: { total: 30 }, as: "o1" },
          { intent: "insert", table: "lines", set: { item: "@o1", order: "@o1" } },
        ],
      });
      expect(await lineOrders()).toEqual([["@o1", r.ops[0].target.row]]);
    },
    T,
  );

  it(
    'a text field written "@nobody", no name declared: stored as that text',
    async () => {
      const r = await w({
        sv: 1,
        ops: [{ intent: "insert", table: "lines", set: { item: "@nobody" } }],
      });
      expect(r.status).toBe("saved");
      expect(await lineOrders()).toEqual([["@nobody", null]]);
    },
    T,
  );
});

describe("refused when read (step 1)", () => {
  it.each([
    [
      "a name no op declares",
      [{ intent: "insert", table: "lines", set: { item: "x", order: "@nope" } }],
      {
        code: "validation_failed",
        details: [expect.objectContaining({ op: 0, field: "order", code: "ref_not_found" })],
      },
    ],
    [
      "a name a later op declares",
      [
        { intent: "insert", table: "lines", set: { item: "x", order: "@o" } },
        { intent: "insert", table: "orders", set: { total: 1 }, as: "o" },
      ],
      {
        code: "validation_failed",
        details: [expect.objectContaining({ op: 0, field: "order", code: "ref_not_found" })],
      },
    ],
    [
      "a name a later op declares, in an op by key",
      [line("L-1", "@o"), order("O-1", 1, "o")],
      {
        code: "validation_failed",
        details: [expect.objectContaining({ op: 0, field: "order", code: "ref_not_found" })],
      },
    ],
    [
      "the same name twice",
      [
        { intent: "insert", table: "orders", set: { total: 1 }, as: "o" },
        { intent: "insert", table: "orders", set: { total: 2 }, as: "o" },
      ],
      { code: "invalid_argument", reason: "duplicate_name", param: "ops/1/as" },
    ],
    [
      "a name not of letters, digits, _ and -",
      [{ intent: "insert", table: "orders", set: { total: 1 }, as: "o 1" }],
      { code: "invalid_argument", reason: "malformed", param: "ops/0/as" },
    ],
    [
      "a name on an update by row",
      [
        {
          intent: "update",
          table: "orders",
          row: `r_${"0".repeat(26)}`,
          set: { total: 1 },
          as: "o",
        },
      ],
      { code: "invalid_argument", reason: "mutually_exclusive", param: "ops/0/as" },
    ],
  ])("%s", async (_, ops, error) => {
    const before = await tail();
    expect(await refused({ sv: 1, ops })).toMatchObject(error);
    expect(await tail()).toBe(before);
  });
});

describe("a name whose op was skipped binds nothing", () => {
  it(
    "an op by key using it is skipped (ref_skipped, ref_op); an ordinary op using it is refused (ref_not_found)",
    async () => {
      const made = await w({ sv: 1, ops: [order("A", 30)] });
      const a = made.ops[0].target.row;
      await w({
        sv: 1,
        ops: [{ intent: "revoke", table: "orders", row: a, ver: made.ops[0].ver }],
      });
      const r = await w({
        sv: 1,
        ops: [order("A", 31, "o"), line("A-1", "@o")],
      });
      expect(r.ops[0]).toMatchObject({ outcome: "skipped", skip_reason: "revoked", as: "o" });
      expect(r.ops[1]).toMatchObject({ outcome: "skipped", skip_reason: "ref_skipped", ref_op: 0 });
      expect(r.ops[1].target).toMatchObject({ table: "shop.lines", external_key: { lid: "A-1" } });
      expect(r.ops[1].target.row).toBeUndefined();
      expect(r.warnings).toContainEqual({ code: "external_key_skipped", ops: [0, 1] });
      // A line by row ID to a revoked order: refused as any ref to a revoked target.
      const before = await tail();
      expect(
        await refused({
          sv: 1,
          ops: [
            order("A", 32, "o"),
            { intent: "insert", table: "lines", set: { item: "x", order: "@o" } },
          ],
        }),
      ).toMatchObject({
        code: "validation_failed",
        details: [{ op: 1, table: "shop.lines", field: "order", code: "ref_not_found" }],
      });
      expect(await tail()).toBe(before);
    },
    T,
  );
});

describe("a premise on a row this request creates (same_request, seen at the request's end)", () => {
  it(
    "by name: the order an earlier op inserted; its version the request's own; a later change marks the line",
    async () => {
      const r = await w({
        sv: 1,
        ops: [
          { intent: "insert", table: "orders", set: { total: 30 }, as: "o" },
          {
            intent: "insert",
            table: "lines",
            set: { item: "tea" },
            premises: [{ table: "orders", row: "@o", fields: ["total"] }],
          },
        ],
      });
      const order = r.ops[0].target.row;
      expect(r.ops[1].premises).toEqual([
        {
          target: { table: "shop.orders", row: order },
          fields: ["total"],
          ver: `v${r.seq}.0`,
          state: "current",
        },
      ]);
      expect(r.warnings ?? []).not.toContainEqual(
        expect.objectContaining({ code: "premise_ver_fallback" }),
      );
      const head = (await s.store.read((tx) => readEvents(tx, r.seq, r.seq)))[0] as Any;
      const decl = [...head.blocks].find(([k]: Any) => k === "ops/1/premises/0")[1].value;
      expect(decl).toMatchObject({ row: order, ver: { op: r.seq, basis: "same_request" } });
      // Right after the request: the line's premise holds (the order's creation is what it saw).
      const marks = async () =>
        ((await query(s.store, ctx(), { table: "lines" })) as Any).rows[0].marks?.premise_changed;
      expect(await marks()).toBeUndefined();
      // The order changes later: the line's premise changed.
      const changed = await w({
        sv: 1,
        ops: [
          { intent: "update", table: "orders", row: order, ver: r.ops[0].ver, set: { total: 31 } },
        ],
      });
      expect(changed.premise_affected).toMatchObject({ count: 1 });
      expect(await marks()).toEqual([expect.objectContaining({ since: changed.seq })]);
      const re = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(re.mismatches).toEqual([]);
    },
    T,
  );

  it(
    "a ver on an existing row, a later op of the same request changes it: marked changed",
    async () => {
      const made = await w({
        sv: 1,
        ops: [{ intent: "insert", table: "orders", set: { total: 1 } }],
      });
      const row = made.ops[0].target.row;
      await w({
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "lines",
            set: { item: "t" },
            premises: [{ table: "orders", row, ver: made.ops[0].ver, fields: ["total"] }],
          },
          { intent: "update", table: "orders", row, ver: made.ops[0].ver, set: { total: 2 } },
        ],
      });
      const marks = ((await query(s.store, ctx(), { table: "lines" })) as Any).rows[0].marks;
      expect(marks?.premise_changed).toBeDefined();
    },
    T,
  );

  it(
    "by entity key: the entity an earlier op of the request created with it",
    async () => {
      const r = await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 3000 },
            valid_from: "2026-11-01",
          },
          {
            intent: "insert",
            table: "orders",
            set: { total: 1 },
            premises: [{ table: "budgets", entity_key: { category: "food" }, fields: ["amount"] }],
          },
        ],
      });
      expect(r.ops[1].premises).toEqual([
        expect.objectContaining({
          target: { table: "shop.budgets", entity: r.ops[0].target.entity },
          ver: `v${r.seq}.0`,
          state: "current",
        }),
      ]);
    },
    T,
  );

  it(
    "a name bound to a row hit by key: that row as given by ID, its ver as given",
    async () => {
      const made = await w({ sv: 1, ops: [order("A", 30)] });
      const r = await w({
        sv: 1,
        ops: [
          order("A", 30, "o"),
          {
            intent: "insert",
            table: "lines",
            set: { item: "x" },
            premises: [{ table: "orders", row: "@o", ver: made.ops[0].ver }],
          },
        ],
      });
      expect(r.ops[1].premises).toEqual([
        expect.objectContaining({
          target: { table: "shop.orders", row: made.ops[0].target.row },
          ver: made.ops[0].ver,
        }),
      ]);
    },
    T,
  );

  it.each([
    [
      "a ver given for a row this request creates",
      [
        { intent: "insert", table: "orders", set: { total: 1 }, as: "o" },
        {
          intent: "insert",
          table: "lines",
          set: { item: "x" },
          premises: [{ table: "orders", row: "@o", ver: "v1.0" }],
        },
      ],
      { code: "invalid_argument", reason: "mutually_exclusive", param: "ops/1/premises/0/ver" },
    ],
    [
      "a name of another table's row",
      [
        { intent: "insert", table: "lines", set: { item: "y" }, as: "l" },
        {
          intent: "insert",
          table: "lines",
          set: { item: "x" },
          premises: [{ table: "orders", row: "@l" }],
        },
      ],
      { code: "not_found", reason: "row", param: "ops/1/premises/0" },
    ],
    [
      "a name a later op declares",
      [
        {
          intent: "insert",
          table: "lines",
          set: { item: "x" },
          premises: [{ table: "orders", row: "@o" }],
        },
        { intent: "insert", table: "orders", set: { total: 1 }, as: "o" },
      ],
      { code: "not_found", reason: "row", param: "ops/0/premises/0" },
    ],
  ])("refused: %s", async (_, ops, error) => {
    const before = await tail();
    expect(await refused({ sv: 1, ops })).toMatchObject(error);
    expect(await tail()).toBe(before);
  });

  it(
    "a name whose op was skipped: not there",
    async () => {
      const made = await w({ sv: 1, ops: [order("A", 30)] });
      await w({
        sv: 1,
        ops: [
          { intent: "revoke", table: "orders", row: made.ops[0].target.row, ver: made.ops[0].ver },
        ],
      });
      expect(
        await refused({
          sv: 1,
          ops: [
            order("A", 31, "o"),
            {
              intent: "insert",
              table: "lines",
              set: { item: "x" },
              premises: [{ table: "orders", row: "@o" }],
            },
          ],
        }),
      ).toMatchObject({ code: "not_found", reason: "row", param: "ops/1/premises/0" });
    },
    T,
  );
});
