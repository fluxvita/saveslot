// Drafts whose changes rebuild a table (03-data-model/07-schema-evolution.md «改动分类与迁移手段», «收紧约束»;
// 08-schema-migration.md «物理做法»; 04-contract «schema_draft», `resolve` 5): compiled, a tightened
// constraint checked against the positions in effect, a field ID never used twice. Building and
// switching come later: a draft that would apply at once is refused, and confirming one that waits
// is refused, nothing logged either way. Fictional names.

import {
  createOpsContext,
  createTenant,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const ITEMS = {
  name: "items",
  kind: "base",
  description: "one row per item",
  time: { type: "none" },
  fields: [
    { name: "size", type: "integer", description: "how big" },
    { name: "kind", type: "enum", values: ["a", "b"], description: "which kind" },
    { name: "note", type: "text", description: "anything" },
  ],
};
const PLANS = {
  name: "plans",
  kind: "base",
  description: "a plan over time",
  time: { type: "state", granularity: "date" },
  entity_key: ["who"],
  fields: [
    { name: "who", type: "text", required: true, description: "whose" },
    { name: "level", type: "integer", description: "how much" },
  ],
};

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
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
async function answer(f: () => Promise<unknown>): Promise<Any> {
  try {
    return await f();
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
}
const draft = (document: unknown): Promise<Any> => schemaDraft(s.store, ctx(), { document });
const tail = async () =>
  Number(
    (await s.store.read((tx) => tx.query<{ n: unknown }>("SELECT max(seq) AS n FROM events")))
      .rows[0]?.n,
  );
/** The items table at `base`, its fields as given (by position, with their IDs). */
const items = (base: number, f: (fields: Any[]) => void, more: Record<string, unknown> = {}) => {
  const fields: Any[] = ITEMS.fields.map((x, i) => ({ ...x, id: `f${i + 1}` }));
  f(fields);
  return {
    slot: "ledger",
    base_version: base,
    timezone: "Asia/Shanghai",
    tables: [{ ...ITEMS, id: "t1", fields, ...more }],
  };
};

beforeAll(async () => {
  s = await openReusable("saveslot-schema-rebuild-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await draft({
    slot: "ledger",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [ITEMS, PLANS],
  });
}, T);

describe("a constraint tightened without a backfill (07 «收紧约束»)", () => {
  it(
    "rows in effect breaking it: backfill_required, how many and which, no values; a revoked row does not count",
    async () => {
      const w = await write(s.store, ctx(), {
        sv: 1,
        ops: [
          { intent: "insert", table: "items", set: { size: 1, note: "secret" } },
          { intent: "insert", table: "items", set: { size: 2 } },
          { intent: "insert", table: "items", set: { size: 9 } },
          { intent: "insert", table: "items", set: { size: 0 } },
        ],
      });
      const ids = w.ops.map((o: Any) => o.target.row);
      // The one of size 0 revoked: it no longer exists.
      await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "revoke", table: "items", row: ids[3], ver: (w.ops[3] as Any).ver }],
      });
      const before = await tail();
      const r = await answer(() => draft(items(1, (f) => (f[0].min = 3))));
      expect(r).toMatchObject({ code: "validation_failed", reason: "schema" });
      expect(r.details).toEqual([
        {
          path: "tables/0/fields/0",
          code: "backfill_required",
          rows: 2,
          samples: [...ids.slice(0, 2)]
            .sort()
            .map((row: string) => ({ table: "ledger.items", row })),
        },
      ]);
      expect(JSON.stringify(r)).not.toContain("secret");
      expect(await tail()).toBe(before);
      // None breaking it: the draft waits for confirmation.
      expect(await draft(items(1, (f) => (f[0].min = 0)))).toMatchObject({ outcome: "pending" });
    },
    T,
  );

  it(
    "an enum value taken away, on a state table: counted by entity",
    async () => {
      await write(s.store, ctx(), {
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "plans",
            entity_key: { who: "ann" },
            set: { level: 5 },
            valid_from: "2026-01-01",
          },
          {
            intent: "update",
            table: "plans",
            entity_key: { who: "ann" },
            set: { level: 7 },
            valid_from: "2026-03-01",
          },
          {
            intent: "update",
            table: "plans",
            entity_key: { who: "bob" },
            set: { level: 1 },
            valid_from: "2026-01-01",
          },
        ],
      });
      const r = await answer(() =>
        draft({
          slot: "ledger",
          base_version: 1,
          timezone: "Asia/Shanghai",
          tables: [
            {
              ...PLANS,
              id: "t2",
              fields: [
                { ...PLANS.fields[0], id: "f1" },
                { ...PLANS.fields[1], id: "f2", max: 4 },
              ],
            },
          ],
        }),
      );
      // ann's two stretches break it: one entity.
      expect(r.details).toEqual([
        {
          path: "tables/0/fields/1",
          code: "backfill_required",
          rows: 1,
          samples: [{ table: "ledger.plans", entity: expect.stringMatching(/^e_/) }],
        },
      ]);
    },
    T,
  );
});

describe("building and switching come later", () => {
  it(
    "a draft that would apply at once and rebuilds a table: not_in_this_version, nothing logged",
    async () => {
      // Written, so the table is rebuilt from the log (one never written switches at once:
      // ./schema-never-written.test.ts).
      await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "items", set: { kind: "a" } }],
      });
      const before = await tail();
      expect(
        await answer(() =>
          draft(items(1, (f) => f.push({ name: "tip", type: "integer", description: "a tip" }))),
        ),
      ).toEqual({ code: "not_in_this_version", reason: "not_implemented", param: "document" });
      expect(await tail()).toBe(before);
    },
    T,
  );

  it(
    "confirming a draft that rebuilds a table: not_in_this_version, nothing logged, the item open",
    async () => {
      // Written, with a value the draft keeps: rebuilt from the log.
      await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "items", set: { kind: "a" } }],
      });
      const d = await draft(items(1, (f) => (f[1].values = ["a"])));
      expect(d).toMatchObject({ outcome: "pending" });
      const before = await tail();
      const decide = () =>
        answer(() =>
          resolve(s.store, ctx(), {
            id: d.item.id,
            decision: "confirm",
            item_ver: d.item.item_ver,
          }),
        );
      expect(await decide()).toEqual({
        code: "not_in_this_version",
        reason: "not_implemented",
        param: "id",
      });
      expect(await tail()).toBe(before);
      // A value the draft takes away written while it waits: counted again on confirming.
      const w = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "items", set: { kind: "b" } }],
      });
      const later = await tail();
      expect(await decide()).toEqual({
        code: "draft_outdated",
        reason: "backfill_required",
        current_sv: 1,
        details: [
          {
            path: "tables/0/fields/1",
            code: "backfill_required",
            rows: 1,
            samples: [{ table: "ledger.items", row: (w.ops[0] as Any).target.row }],
          },
        ],
      });
      expect(await tail()).toBe(later);
      // Rejecting it still works.
      expect(
        await resolve(s.store, ctx(), {
          id: d.item.id,
          decision: "reject",
          item_ver: d.item.item_ver,
        }),
      ).toMatchObject({ status: "resolved" });
    },
    T,
  );

  it(
    "counted again on confirming, a finding names the field where the draft has it, not where the definition does",
    async () => {
      // Written first, with a value the draft keeps: a table written, rebuilt from the log (one
      // never written is judged otherwise: ./schema-never-written.test.ts).
      await write(s.store, ctx(), {
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "plans",
            entity_key: { who: "bob" },
            set: { level: 1 },
            valid_from: "2026-01-01",
          },
        ],
      });
      // The draft lists only plans: tables/0 in it, tables/1 in the compiled definition.
      const d = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...PLANS,
            id: "t2",
            fields: [
              { ...PLANS.fields[0], id: "f1" },
              { ...PLANS.fields[1], id: "f2", max: 4 },
            ],
          },
        ],
      });
      expect(d).toMatchObject({ outcome: "pending" });
      await write(s.store, ctx(), {
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "plans",
            entity_key: { who: "ann" },
            set: { level: 5 },
            valid_from: "2026-01-01",
          },
        ],
      });
      expect(
        await answer(() =>
          resolve(s.store, ctx(), {
            id: d.item.id,
            decision: "confirm",
            item_ver: d.item.item_ver,
          }),
        ),
      ).toMatchObject({
        code: "draft_outdated",
        reason: "backfill_required",
        details: [{ path: "tables/0/fields/1", code: "backfill_required", rows: 1 }],
      });
    },
    T,
  );
});

describe("a field ID is never used twice (09 §7)", () => {
  it(
    "a field a rejected draft added keeps its number taken",
    async () => {
      const tip = {
        name: "tip",
        type: "integer",
        required: true,
        description: "a tip",
        backfill: { const: 0 },
      };
      const first = await draft(items(1, (f) => f.push(tip)));
      expect(first).toMatchObject({ outcome: "pending", target_sv: 2 });
      expect(first.document.tables[0].fields.at(-1)).toMatchObject({ id: "f4", name: "tip" });
      await resolve(s.store, ctx(), {
        id: first.item.id,
        decision: "reject",
        item_ver: first.item.item_ver,
      });
      // Another draft (the same one again would be a repeat, answered with the first receipt).
      const again = await draft(items(1, (f) => f.push({ ...tip, description: "a tip, again" })));
      expect(again.document.tables[0].fields.at(-1)).toMatchObject({ id: "f5", name: "tip" });
    },
    T,
  );
});
