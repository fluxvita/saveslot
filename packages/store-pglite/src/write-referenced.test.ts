// High impact ② through the write path (05-time «高影响写入» ②; 03-data-model/04-write-and-read
// «引用字段»: «高影响 ② 怎么数"仍被引用"»; 09 §5.8 `referencing_row`): revoking a row still referred to
// by another row awaits confirmation; who refers to it is counted with the ops of the request
// before it, over every stretch of a state table's time; when its referrers change, the item's
// impact follows, down to none, and confirming revokes as recorded.

import {
  createOpsContext,
  createTenant,
  pending,
  query,
  readEvents,
  readTail,
  reconcileLog,
  resolve,
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

const MEALS = {
  name: "meals",
  kind: "base",
  description: "a meal",
  time: { type: "none" },
  fields: [
    { name: "name", type: "text", required: true, description: "what" },
    {
      name: "next",
      type: "ref",
      description: "a later meal",
      ref: { table: "meals", target: "row" },
    },
  ],
};
const DISHES = {
  name: "dishes",
  kind: "base",
  description: "a dish of a meal",
  time: { type: "none" },
  fields: [
    { name: "dish", type: "text", required: true, description: "what" },
    { name: "meal", type: "ref", description: "its meal", ref: { table: "meals", target: "row" } },
  ],
};
// A plan over time, naming a meal.
const PLANS = {
  name: "plans",
  kind: "base",
  description: "a plan",
  time: { type: "state", granularity: "date" },
  entity_key: ["plan"],
  fields: [
    { name: "plan", type: "text", required: true, description: "which" },
    { name: "meal", type: "ref", description: "the meal", ref: { table: "meals", target: "row" } },
  ],
};
const DOCUMENT = {
  slot: "food",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [MEALS, DISHES, PLANS],
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
const tail = async () => (await s.store.read(readTail))?.seq ?? 0;
const meal = async (name: string) => {
  const r = await w({ sv: 1, ops: [{ intent: "insert", table: "meals", set: { name } }] });
  return { row: r.ops[0].target.row as string, ver: r.ops[0].ver as string };
};
const dish = async (name: string, mealRow: string) => {
  const r = await w({
    sv: 1,
    ops: [{ intent: "insert", table: "dishes", set: { dish: name, meal: mealRow } }],
  });
  return { row: r.ops[0].target.row as string, ver: r.ops[0].ver as string };
};
const revoke = (table: string, x: { row: string; ver: string }) => ({
  intent: "revoke",
  table,
  row: x.row,
  ver: x.ver,
});
const detail = (id: string) => pending(s.store, ctx(), { id }) as Promise<Any>;
const impactOf = async (id: string) =>
  ((await detail(id)).impact?.referencing_rows ?? (await detail(id)).impact) as Any;
const mealsLeft = async () =>
  ((await query(s.store, ctx(), { table: "meals" })) as Any).rows.map((r: Any) => r.values.name);

beforeAll(async () => {
  s = await openReusable("saveslot-write-referenced-");
  scratch = await openReusable("saveslot-write-referenced-scratch-");
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

describe("revoking a row still referred to awaits confirmation", () => {
  it(
    "the item lists its referrer; confirming revokes it, the dish keeps the ID",
    async () => {
      const m = await meal("lunch");
      const d = await dish("soup", m.row);
      const r = await w({ sv: 1, ops: [revoke("meals", m)] });
      expect(r.status).toBe("pending");
      const item = r.pending.find((p: Any) => p.type === "awaiting_confirmation");
      expect(item).toBeDefined();
      const x = await detail(item.id);
      expect(x).toMatchObject({ type: "awaiting_confirmation", reason: "referenced_row" });
      expect(JSON.stringify(x)).toContain(d.row);
      expect(await mealsLeft()).toEqual(["lunch"]);
      await resolve(s.store, ctx(), { id: item.id, decision: "confirm", item_ver: x.item_ver });
      expect(await mealsLeft()).toEqual([]);
      const dishes = ((await query(s.store, ctx(), { table: "dishes" })) as Any).rows;
      expect(dishes.map((y: Any) => y.values.meal)).toEqual([m.row]);
      const re = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(re.mismatches).toEqual([]);
    },
    T,
  );

  it(
    "rejected: the meal stays",
    async () => {
      const m = await meal("lunch");
      await dish("soup", m.row);
      const r = await w({ sv: 1, ops: [revoke("meals", m)] });
      const item = r.pending[0];
      const x = await detail(item.id);
      await resolve(s.store, ctx(), { id: item.id, decision: "reject", item_ver: x.item_ver });
      expect(await mealsLeft()).toEqual(["lunch"]);
    },
    T,
  );

  it(
    "no referrer, or only itself: revoked at once",
    async () => {
      const m = await meal("lunch");
      const self = await w({
        sv: 1,
        ops: [{ intent: "update", table: "meals", row: m.row, ver: m.ver, set: { next: m.row } }],
      });
      const r = await w({ sv: 1, ops: [revoke("meals", { row: m.row, ver: self.ops[0].ver })] });
      expect([r.status, r.pending]).toEqual(["saved", []]);
    },
    T,
  );

  it(
    "a referrer revoked or pointed elsewhere earlier in the request no longer counts",
    async () => {
      const m = await meal("lunch");
      const other = await meal("dinner");
      const a = await dish("soup", m.row);
      const b = await dish("tea", m.row);
      const r = await w({
        sv: 1,
        ops: [
          revoke("dishes", a),
          { intent: "update", table: "dishes", row: b.row, ver: b.ver, set: { meal: other.row } },
          revoke("meals", m),
        ],
      });
      expect([r.status, r.pending]).toEqual(["saved", []]);
    },
    T,
  );

  it(
    "a referrer revoked by an earlier request no longer counts",
    async () => {
      const m = await meal("lunch");
      const d = await dish("soup", m.row);
      await w({ sv: 1, ops: [revoke("dishes", d)] });
      const r = await w({ sv: 1, ops: [revoke("meals", m)] });
      expect([r.status, r.pending]).toEqual(["saved", []]);
    },
    T,
  );

  it(
    "a stale revoke is a candidate first, not awaiting",
    async () => {
      const m = await meal("lunch");
      await dish("soup", m.row);
      await w({
        sv: 1,
        ops: [
          { intent: "update", table: "meals", row: m.row, ver: m.ver, set: { name: "brunch" } },
        ],
      });
      const r = await w({ sv: 1, ops: [revoke("meals", m)] });
      expect(r.pending.map((p: Any) => p.type)).toEqual(["conflict"]);
    },
    T,
  );
});

describe("the item's referrers follow them", () => {
  it(
    "the meal revoked before its dish in one request: the item opens, its impact as at the request's end, none",
    async () => {
      const m = await meal("lunch");
      const d = await dish("soup", m.row);
      const r = await w({ sv: 1, ops: [revoke("meals", m), revoke("dishes", d)] });
      expect(r.status).toBe("pending");
      const item = r.pending.find((p: Any) => p.type === "awaiting_confirmation");
      expect(JSON.stringify(await detail(item.id))).not.toContain(d.row);
    },
    T,
  );

  it(
    "a later request pointing the dish elsewhere refreshes the item, its impact empty; confirming still revokes",
    async () => {
      const m = await meal("lunch");
      const other = await meal("dinner");
      const d = await dish("soup", m.row);
      const r = await w({ sv: 1, ops: [revoke("meals", m)] });
      const item = r.pending[0];
      const before = await detail(item.id);
      expect(JSON.stringify(before)).toContain(d.row);
      const moved = await w({
        sv: 1,
        ops: [
          { intent: "update", table: "dishes", row: d.row, ver: d.ver, set: { meal: other.row } },
        ],
      });
      const after = await detail(item.id);
      expect(after.status).toBe("open");
      expect(after.item_ver).not.toBe(before.item_ver);
      expect(JSON.stringify(after)).not.toContain(d.row);
      void moved;
      await resolve(s.store, ctx(), { id: item.id, decision: "confirm", item_ver: after.item_ver });
      expect(await mealsLeft()).toEqual(["dinner"]);
      const re = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(re.mismatches).toEqual([]);
    },
    T,
  );
});

describe("a decision changing a referrer refreshes the item too", () => {
  const referrersOf = async (id: string) => (await detail(id)).impact?.referrers ?? [];

  it(
    "take_candidate pointing the dish elsewhere: the meal's item no longer lists it",
    async () => {
      const m = await meal("lunch");
      const o = await meal("dinner");
      const o2 = await meal("supper");
      // The dish's meal: o2, then m in effect, then (stale) o: a candidate.
      const d = await dish("soup", o2.row);
      await w({
        sv: 1,
        ops: [{ intent: "update", table: "dishes", row: d.row, ver: d.ver, set: { meal: m.row } }],
      });
      const item = (await w({ sv: 1, ops: [revoke("meals", m)] })).pending[0].id;
      expect(await referrersOf(item)).toEqual([
        { table: "food.dishes", row: d.row, field: "meal" },
      ]);
      const c = await w({
        sv: 1,
        ops: [{ intent: "update", table: "dishes", row: d.row, ver: d.ver, set: { meal: o.row } }],
      });
      const conflict = c.pending.find((p: Any) => p.type === "conflict");
      const cx = await detail(conflict.id);
      await resolve(s.store, ctx(), {
        id: conflict.id,
        decision: "take_candidate",
        item_ver: cx.item_ver,
      });
      expect(await referrersOf(item)).toEqual([]);
    },
    T,
  );

  it(
    "confirming the revoke of a referrer (itself awaiting for its own): the item drops it",
    async () => {
      const m = await meal("lunch");
      const m2 = await meal("brunch");
      const u = await w({
        sv: 1,
        ops: [{ intent: "update", table: "meals", row: m2.row, ver: m2.ver, set: { next: m.row } }],
      });
      const d = await dish("tea", m2.row);
      const item1 = (await w({ sv: 1, ops: [revoke("meals", m)] })).pending[0].id;
      expect(await referrersOf(item1)).toEqual([
        { table: "food.meals", row: m2.row, field: "next" },
      ]);
      const item2 = (await w({ sv: 1, ops: [revoke("meals", { row: m2.row, ver: u.ops[0].ver })] }))
        .pending[0].id;
      const x2 = await detail(item2);
      expect(JSON.stringify(x2)).toContain(d.row);
      await resolve(s.store, ctx(), { id: item2, decision: "confirm", item_ver: x2.item_ver });
      expect(await referrersOf(item1)).toEqual([]);
    },
    T,
  );

  it(
    "one request, one dish renamed (still refers) and one pointed away: the refresh names the second's write",
    async () => {
      const m = await meal("lunch");
      const o = await meal("dinner");
      const a = await dish("soup", m.row);
      const b = await dish("tea", m.row);
      const item = (await w({ sv: 1, ops: [revoke("meals", m)] })).pending[0].id;
      const r = await w({
        sv: 1,
        ops: [
          { intent: "update", table: "dishes", row: a.row, ver: a.ver, set: { dish: "broth" } },
          { intent: "update", table: "dishes", row: b.row, ver: b.ver, set: { meal: o.row } },
        ],
      });
      const evs = await s.store.read((tx) => readEvents(tx, r.seq, 10_000));
      const target = (e: Any) =>
        Object.fromEntries(
          [...e.blocks].flatMap(([k, x]: Any) => (x.state === "present" ? [[k, x.value]] : [])),
        )["target"];
      const bBase = evs.find((e: Any) => e.header.type === "write.base" && target(e)?.row === b.row)
        ?.header["seq"];
      const refreshed = evs.filter(
        (e: Any) => e.header.type === "item.refreshed" && target(e)?.item === item,
      );
      expect(refreshed.map((e: Any) => target(e).by_event)).toEqual([bBase]);
      expect(await referrersOf(item)).toEqual([
        { table: "food.dishes", row: a.row, field: "meal" },
      ]);
    },
    T,
  );
});

describe("a state table's referrer counts over every stretch", () => {
  it(
    "a plan naming the meal only in a past stretch, another now: revoking the meal still awaits",
    async () => {
      const m = await meal("lunch");
      const other = await meal("dinner");
      const p = await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "plans",
            entity_key: { plan: "week" },
            set: { meal: m.row },
            valid_from: "2026-10-01",
          },
        ],
      });
      const later = await w({
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "plans",
            entity: p.ops[0].target.entity,
            ver: p.ops[0].ver,
            set: { meal: other.row },
            valid_from: "2026-10-10",
          },
        ],
      });
      expect([p.status, later.status]).toEqual(["saved", "saved"]);
      const r = await w({ sv: 1, ops: [revoke("meals", m)] });
      expect(r.status).toBe("pending");
      expect(JSON.stringify(await detail(r.pending[0].id))).toContain(p.ops[0].target.entity);
    },
    T,
  );
});
