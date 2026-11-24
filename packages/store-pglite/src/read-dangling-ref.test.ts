// `dangling_ref` on reads (04-contract §7; 03-data-model/04-write-and-read «引用字段»: 目标被撤销,
// 引用方不动、保留原 ID，读取时带标记): a row whose ref field names a row or entity revoked since
// keeps the ID and is read with the mark, the field and `revoked`; the revoke undone, the mark goes.
// `query` (with `fields`: only a ref field read) and `history` `as_of` (as the target was then).

import {
  createOpsContext,
  createTenant,
  history,
  pending,
  query,
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
  fields: [{ name: "name", type: "text", required: true, description: "what" }],
};
const CHEFS = {
  name: "chefs",
  kind: "base",
  description: "a chef over time",
  time: { type: "state", granularity: "date" },
  entity_key: ["chef"],
  fields: [
    { name: "chef", type: "text", required: true, description: "who" },
    { name: "station", type: "text", required: true, description: "where" },
  ],
};
const DISHES = {
  name: "dishes",
  kind: "base",
  description: "a dish",
  time: { type: "none" },
  fields: [
    { name: "dish", type: "text", required: true, description: "what" },
    { name: "meal", type: "ref", description: "its meal", ref: { table: "meals", target: "row" } },
    {
      name: "chef",
      type: "ref",
      description: "who cooks",
      ref: { table: "chefs", target: "entity" },
    },
  ],
};
const DOCUMENT = {
  slot: "food",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [MEALS, CHEFS, DISHES],
};

let s: ReusableStore;
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
/**
 * A revoke carried out, and the write that carried it out: a revoke of a row still referred to
 * awaits confirmation (high impact ②, 04-write-and-read «引用字段»: 目标被撤销), and the write the
 * confirmation triggers is the one that takes effect, the one an `undo` takes back; otherwise the
 * revoke's own.
 */
async function carriedOut(r: Any): Promise<{ seq: number; ver: string; confirmed: boolean }> {
  const item = (r.pending ?? []).find((p: Any) => p.type === "awaiting_confirmation");
  if (item === undefined) return { seq: r.seq, ver: r.ops[0].ver, confirmed: false };
  const d = (await pending(s.store, ctx(), { id: item.id })) as Any;
  const done = (await resolve(s.store, ctx(), {
    id: item.id,
    decision: "confirm",
    item_ver: d.item_ver,
  })) as Any;
  return { seq: done.write.seq, ver: done.write.ops[0].ver, confirmed: true };
}
const dishes = async (fields?: string[]) =>
  ((await query(s.store, ctx(), { table: "dishes", ...(fields ? { fields } : {}) })) as Any).rows;

beforeAll(async () => {
  s = await openReusable("saveslot-read-dangling-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
}, T);

describe("a ref to a row revoked since", () => {
  it(
    "query: the dish keeps the meal's ID, marked; the revoke undone, unmarked; with fields, only when the ref is read",
    async () => {
      const m = (
        await w({ sv: 1, ops: [{ intent: "insert", table: "meals", set: { name: "lunch" } }] })
      ).ops[0];
      await w({
        sv: 1,
        ops: [{ intent: "insert", table: "dishes", set: { dish: "soup", meal: m.target.row } }],
      });
      expect((await dishes())[0].marks?.dangling_ref).toBeUndefined();
      const rv = await carriedOut(
        await w({
          sv: 1,
          ops: [{ intent: "revoke", table: "meals", row: m.target.row, ver: m.ver }],
        }),
      );
      // The meal still referred to by the dish: its revoke awaited confirmation.
      expect(rv.confirmed).toBe(true);
      const [d] = await dishes();
      expect(d.values.meal).toBe(m.target.row);
      expect(d.marks.dangling_ref).toEqual([{ field: "meal", state: "revoked" }]);
      expect((await dishes(["dish"]))[0].marks?.dangling_ref).toBeUndefined();
      expect((await dishes(["dish", "meal"]))[0].marks.dangling_ref).toEqual([
        { field: "meal", state: "revoked" },
      ]);
      // As of before the revoke: not revoked then.
      const before = (await history(s.store, ctx(), {
        table: "dishes",
        row: d.row,
        mode: "as_of",
        as_of: rv.seq - 1,
      })) as Any;
      expect(before.rows[0].marks?.dangling_ref).toBeUndefined();
      const after = (await history(s.store, ctx(), {
        table: "dishes",
        row: d.row,
        mode: "as_of",
        as_of: (
          await w({ sv: 1, ops: [{ intent: "insert", table: "meals", set: { name: "x" } }] })
        ).seq,
      })) as Any;
      expect(after.rows[0].marks.dangling_ref).toEqual([{ field: "meal", state: "revoked" }]);
      // The revoke undone: the meal is back, the mark gone.
      await w({ sv: 1, ops: [{ table: "meals", row: m.target.row, revert: { undo: rv.seq } }] });
      expect((await dishes())[0].marks?.dangling_ref).toBeUndefined();
    },
    T,
  );
});

describe("a ref to a state entity", () => {
  it(
    "revoked whole: marked; a stretch revoked only: not",
    async () => {
      const c = (
        await w({
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "chefs",
              entity_key: { chef: "ann" },
              set: { station: "grill" },
              valid_from: "2026-10-01",
            },
          ],
        })
      ).ops[0];
      await w({
        sv: 1,
        ops: [{ intent: "insert", table: "dishes", set: { dish: "steak", chef: c.target.entity } }],
      });
      const part = await carriedOut(
        await w({
          sv: 1,
          ops: [
            {
              intent: "revoke",
              table: "chefs",
              entity: c.target.entity,
              ver: c.ver,
              valid_from: "2026-10-05",
              valid_to: "2026-10-07",
            },
          ],
        }),
      );
      expect((await dishes())[0].marks?.dangling_ref).toBeUndefined();
      await carriedOut(
        await w({
          sv: 1,
          ops: [{ intent: "revoke", table: "chefs", entity: c.target.entity, ver: part.ver }],
        }),
      );
      expect((await dishes())[0].marks.dangling_ref).toEqual([{ field: "chef", state: "revoked" }]);
    },
    T,
  );
});
