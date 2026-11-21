// A write at an earlier schema version after a confirmed change (03-data-model/07-schema-evolution.md
// «旧名字还认多久»: names resolve by the request's `sv`, given or taken by fallback, then go by IDs;
// «原则»: `drop_table` refuses old writes; 04-contract §2). The changes a version switches to without
// rebuilding a table: field and table renames, a dropped table. Fictional names.

import {
  catalog,
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

const PAIRS = {
  name: "pairs",
  kind: "base",
  description: "two texts",
  time: { type: "none" },
  fields: [
    { name: "a", type: "text", description: "first" },
    { name: "b", type: "text", description: "second" },
  ],
};
const SETTINGS = {
  name: "settings",
  kind: "base",
  description: "one row per setting",
  time: { type: "none" },
  fields: [{ name: "key", type: "text", required: true, description: "the setting" }],
};

let s: ReusableStore;
let minute = 0;
const ctx = (task: string | null = null) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task,
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
    const x = e as { code?: string; message: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
}
const rows = async (q: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(q, params as never))).rows as Record<string, unknown>[];
/** Writes under task `w`: the decisions are under none, so they move no fallback of the writer. */
const w = (params: unknown, task = "w"): Promise<Any> => write(s.store, ctx(task), params);
const draft = (document: unknown): Promise<Any> =>
  schemaDraft(s.store, ctx("schema"), { document });
/** Submits `document` and confirms it: the slot's next version. */
async function change(document: unknown): Promise<void> {
  const d = await draft(document);
  expect(d).toMatchObject({ outcome: "pending" });
  await resolve(s.store, ctx("schema"), {
    id: d.item.id,
    decision: "confirm",
    item_ver: d.item.item_ver,
  });
}
/** The ID the slot gave a table, by its name now. */
async function tableId(slot: string, name: string): Promise<string> {
  const c = (await catalog(s.store, ctx("schema"), { level: "schema", slot })) as Any;
  return c.document.tables.find((t: Any) => t.name === name).id;
}
/** Slot `slot` with `pairs` and `settings`, at version 1. */
const create = (slot: string) =>
  draft({ slot, base_version: null, timezone: "Asia/Shanghai", tables: [PAIRS, SETTINGS] });
/** `pairs` of `slot` at `base` with its fields named `a` and `b` as given, the table as `name`. */
const pairsAs = async (slot: string, base: number, a: string, b: string, name = "pairs") => ({
  slot,
  base_version: base,
  timezone: "Asia/Shanghai",
  tables: [
    {
      ...PAIRS,
      id: await tableId(slot, "pairs"),
      name,
      fields: [
        { ...PAIRS.fields[0], id: "f1", name: a },
        { ...PAIRS.fields[1], id: "f2", name: b },
      ],
    },
  ],
});
const physical = async (id: string) =>
  rows(`SELECT f_f1, f_f2 FROM "t_${id}_v1" ORDER BY f_f1 NULLS LAST, f_f2`);

beforeAll(async () => {
  s = await openReusable("saveslot-schema-old-sv-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await create("ledger");
}, T);

describe("names by the request's sv after a confirmed rename", () => {
  it(
    "two fields swapping names: sv 1 writes `a` into the field `a` was then; the receipt names it so",
    async () => {
      const pairs = await tableId("ledger", "pairs");
      await change(await pairsAs("ledger", 1, "b", "a"));
      const old = await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] });
      // The receipt: version 1, and the field by the name the request gave, in version 1.
      expect(old).toMatchObject({
        sv: 1,
        ops: [{ fields: { a: { result: "applied", after: "A" } } }],
      });
      const now = await w({ sv: 2, ops: [{ intent: "insert", table: "pairs", set: { a: "B" } }] });
      expect(now).toMatchObject({
        sv: 2,
        ops: [{ fields: { a: { result: "applied", after: "B" } } }],
      });
      // `a` was f1 in version 1, is f2 in version 2.
      expect(await physical(pairs)).toEqual([
        { f_f1: "A", f_f2: null },
        { f_f1: null, f_f2: "B" },
      ]);
    },
    T,
  );

  it(
    "a field renamed: its old name at sv 1 is taken, its new name at sv 1 is not",
    async () => {
      const pairs = await tableId("ledger", "pairs");
      await change(await pairsAs("ledger", 1, "c", "b"));
      expect(
        await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] }),
      ).toMatchObject({ sv: 1, ops: [{ fields: { a: { after: "A" } } }] });
      expect(
        await answer(() =>
          w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { c: "C" } }] }),
        ),
      ).toMatchObject({ code: "unknown_field", name: "c" });
      expect(await physical(pairs)).toEqual([{ f_f1: "A", f_f2: null }]);
    },
    T,
  );

  it(
    "a table renamed: its old name at sv 1 is taken, its new name at sv 1 is unknown_table",
    async () => {
      await change(await pairsAs("ledger", 1, "a", "b", "couples"));
      expect(
        await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] }),
      ).toMatchObject({ sv: 1, ops: [{ target: { table: "ledger.pairs" } }] });
      expect(
        await answer(() =>
          w({ sv: 1, ops: [{ intent: "insert", table: "couples", set: { a: "A" } }] }),
        ),
      ).toMatchObject({ code: "unknown_table", name: "couples" });
      // The current version: its own names only.
      expect(
        await w({ sv: 2, ops: [{ intent: "insert", table: "couples", set: { a: "B" } }] }),
      ).toMatchObject({ sv: 2, ops: [{ target: { table: "ledger.couples" } }] });
      expect(
        await answer(() =>
          w({ sv: 2, ops: [{ intent: "insert", table: "pairs", set: { a: "B" } }] }),
        ),
      ).toMatchObject({ code: "unknown_table", name: "pairs" });
    },
    T,
  );

  it(
    "the same write sent again is the same request: its key is of the parameters as sent",
    async () => {
      await change(await pairsAs("ledger", 1, "b", "a"));
      const params = { sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] };
      const first = await w(params);
      const again = await w(structuredClone(params));
      expect(again).toMatchObject({ seq: first.seq, replayed: true, sv: 1 });
      expect(again.ops).toEqual(first.ops);
    },
    T,
  );
});

describe("a table dropped since the request's sv (07 «原则»: drop_table refuses old writes)", () => {
  it(
    "schema_incompatible, the whole table, drop_table",
    async () => {
      await change({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        drop_tables: ["settings"],
        tables: [],
      });
      expect(
        await answer(() =>
          w({ sv: 1, ops: [{ intent: "insert", table: "settings", set: { key: "k" } }] }),
        ),
      ).toEqual({
        code: "schema_incompatible",
        param: "ops/0/table",
        current_sv: 2,
        changed_fields: [{ field: "*", change: "drop_table" }],
      });
      // At the current version it is a name not there.
      expect(
        await answer(() =>
          w({ sv: 2, ops: [{ intent: "insert", table: "settings", set: { key: "k" } }] }),
        ),
      ).toMatchObject({ code: "unknown_table" });
    },
    T,
  );
});

describe("the sv taken by fallback resolves names the same way (04-contract §2)", () => {
  it(
    "a caller last at version 1: its old names resolve by version 1, the receipt says so",
    async () => {
      const pairs = await tableId("ledger", "pairs");
      // The writer's own write at version 1 is what its fallback finds.
      await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { b: "first" } }] });
      await change(await pairsAs("ledger", 1, "b", "a"));
      const r = await w({ ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] });
      expect(r).toMatchObject({
        sv: 1,
        ops: [{ fields: { a: { after: "A" } } }],
        warnings: [expect.objectContaining({ code: "sv_fallback", sv: 1 })],
      });
      // Once, not twice: the warnings of the request are its own.
      expect(r.warnings.filter((x: Any) => x.code === "sv_fallback")).toHaveLength(1);
      expect(await physical(pairs)).toEqual([
        { f_f1: "A", f_f2: null },
        { f_f1: null, f_f2: "first" },
      ]);
      // A table renamed since, by its old name only: the slot is found by the fallback's version.
      await change(await pairsAs("ledger", 2, "b", "a", "couples"));
      expect(
        await answer(() => w({ ops: [{ intent: "insert", table: "pairs", set: { a: "B" } }] })),
      ).toMatchObject({ sv: 1, ops: [{ target: { table: "ledger.pairs" } }] });
    },
    T,
  );
});

describe("an unqualified table name in two slots, one by the current names, one by the request's", () => {
  it(
    "sv given: ambiguous_table with both",
    async () => {
      await create("books");
      // ledger.pairs becomes couples; books.pairs is still pairs.
      await change(await pairsAs("ledger", 1, "a", "b", "couples"));
      expect(
        await answer(() =>
          w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] }),
        ),
      ).toMatchObject({
        code: "invalid_argument",
        reason: "ambiguous_table",
        candidates: expect.arrayContaining(["ledger.pairs", "books.pairs"]),
      });
      // Qualified, each is its slot's.
      expect(
        await w({ sv: 1, ops: [{ intent: "insert", table: "ledger.pairs", set: { a: "A" } }] }),
      ).toMatchObject({ sv: 1, ops: [{ target: { table: "ledger.pairs" } }] });
    },
    T,
  );

  it(
    "sv by fallback: ambiguous_table with both",
    async () => {
      await create("books");
      await w({ sv: 1, ops: [{ intent: "insert", table: "ledger.pairs", set: { a: "x" } }] });
      await change(await pairsAs("ledger", 1, "a", "b", "couples"));
      expect(
        await answer(() => w({ ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] })),
      ).toMatchObject({
        code: "invalid_argument",
        reason: "ambiguous_table",
        candidates: expect.arrayContaining(["ledger.pairs", "books.pairs"]),
      });
    },
    T,
  );
});

describe("tables added since the request's sv", () => {
  it(
    "a write at sv 1 to an old table after v2 added one: taken, and the derived table reading it refreshed in the receipt",
    async () => {
      await draft({
        slot: "books",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [
          PAIRS,
          {
            name: "pair_count",
            kind: "derived",
            description: "how many pairs",
            rule: { sql: "SELECT count(a) AS n FROM pairs", time_dependency: "none" },
            fields: [{ name: "n", description: "pairs" }],
          },
        ],
      });
      // Version 2 adds a base table (a derived one is not compiled for an existing slot yet).
      const added = await draft({
        slot: "books",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            name: "notes",
            kind: "base",
            description: "free notes",
            time: { type: "none" },
            fields: [{ name: "text", type: "text", description: "the note" }],
          },
        ],
      });
      expect(added).toMatchObject({ outcome: "applied", sv: 2 });
      // An earlier write moves the writer's fallback nowhere: sv given.
      const r = await w({
        sv: 1,
        ops: [{ intent: "insert", table: "books.pairs", set: { a: "A" } }],
      });
      expect(r).toMatchObject({ sv: 1, ops: [{ target: { table: "books.pairs" } }] });
      expect(r.derived).toEqual([expect.objectContaining({ table: "books.pair_count" })]);
    },
    T,
  );
});
