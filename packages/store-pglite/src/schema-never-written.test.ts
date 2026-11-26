// A change of type on a table never written (03-data-model/07-schema-evolution.md «从未被写入的表上改结构»;
// 08 «物理做法»): compiled as metadata with no `migrate`, confirmed, switched at once into a new,
// empty physical table; old writes to the table refused whole. What counts as written: any
// `write.base` of the table, a revoked one included; a read does not. Written while the draft
// waits: the confirmation is refused (`draft_outdated`, `table_written`). Fictional names.

import {
  catalog,
  createOpsContext,
  createTenant,
  history,
  query,
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

const LIMITS = {
  name: "limits",
  kind: "base",
  description: "one row per limit",
  time: { type: "none" },
  fields: [{ name: "n", type: "integer", description: "how many" }],
};

let s: ReusableStore;
/** An empty storage the log is replayed into (K12). */
let scratch: ReusableStore;
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
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
}
const rows = async (q: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(q, params as never))).rows as Record<string, unknown>[];
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);
const w = (params: unknown): Promise<Any> => write(s.store, ctx("w"), params);
const draft = (document: unknown): Promise<Any> =>
  schemaDraft(s.store, ctx("schema"), { document });
const confirm = (d: Any): Promise<Any> =>
  answer(() =>
    resolve(s.store, ctx("schema"), {
      id: d.item.id,
      decision: "confirm",
      item_ver: d.item.item_ver,
    }),
  );
async function tableId(name: string): Promise<string> {
  const c = (await catalog(s.store, ctx("schema"), { level: "schema", slot: "ledger" })) as Any;
  return c.document.tables.find((t: Any) => t.name === name).id;
}
/** `pairs` at version 1 with `b` made an integer: a change of type. */
const bAsInteger = async () => ({
  slot: "ledger",
  base_version: 1,
  timezone: "Asia/Shanghai",
  tables: [
    {
      ...PAIRS,
      id: await tableId("pairs"),
      fields: [
        { ...PAIRS.fields[0], id: "f1" },
        { ...PAIRS.fields[1], id: "f2", type: "integer" },
      ],
    },
  ],
});
const insertPair = () => w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "x" } }] });

beforeAll(async () => {
  s = await openReusable("saveslot-schema-never-written-");
  scratch = await openReusable("saveslot-schema-never-written-scratch-");
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
  await draft({
    slot: "ledger",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [PAIRS, SETTINGS, LIMITS],
  });
}, T);

describe("a table never written", () => {
  it(
    "a type changed: waits as metadata, then switches at once into a new empty physical table",
    async () => {
      const id = await tableId("pairs");
      // Another table written, and this one read: neither makes it written.
      await w({ sv: 1, ops: [{ intent: "insert", table: "settings", set: { key: "k" } }] });
      expect((await query(s.store, ctx("r"), { table: "pairs" })).rows).toEqual([]);

      const d = await draft(await bAsInteger());
      expect(d).toMatchObject({
        outcome: "pending",
        changes: [
          {
            target: { table: "pairs", field: "b" },
            change: "change_type",
            class: "metadata",
            compatible_with_old_writes: false,
            destructive: false,
            auto: false,
          },
        ],
      });
      const before = await tail();
      const r = await confirm(d);
      expect(r).toMatchObject({ status: "resolved" });
      // Switched in the confirmation: no migration, nothing listed as rebuilt.
      const types = await rows("SELECT type FROM events WHERE seq > $1 ORDER BY seq", [before]);
      expect(types.map((x) => x["type"])).not.toContain("schema.migration_started");
      expect(types.map((x) => x["type"])).toContain("schema.switched");
      const switched = await rows(
        `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
         WHERE e.type = 'schema.switched' AND e.seq > $1`,
        [before],
      );
      expect(JSON.parse(switched[0]?.["body"] as string)).toMatchObject({
        from_version: 1,
        to_version: 2,
        rebuilt_tables: [],
      });
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 2 }]);

      // The new physical table takes the field as an integer; the earlier one stays, empty.
      const now = await w({
        sv: 2,
        ops: [{ intent: "insert", table: "pairs", set: { a: "x", b: 5 } }],
      });
      expect(now).toMatchObject({ status: "saved", sv: 2 });
      // An integer column now (read as a number or as text, by backend).
      const fresh = await rows(`SELECT f_f1, f_f2 FROM "t_${id}_v2"`);
      expect(fresh.map((x) => [x["f_f1"], Number(x["f_f2"])])).toEqual([["x", 5]]);
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v1"`)).toEqual([{ n: 0 }]);
      // As of before the switch: the earlier version's physical table, empty, answers (08
      // «物理做法»): that version, no row.
      const row = now.ops[0].target.row;
      expect(
        await history(s.store, ctx("r"), { table: "pairs", row, mode: "as_of", as_of: before }),
      ).toMatchObject({ sv: 1, rows: [] });
      expect(
        await history(s.store, ctx("r"), { table: "pairs", row, mode: "as_of", as_of: now.seq }),
      ).toMatchObject({ sv: 2, rows: [{ values: { a: "x", b: "5" } }] });
      const read = await query(s.store, ctx("r"), { table: "pairs" });
      // An integer is returned as a string (04-contract «值的编码»).
      expect(read.rows.map((x: Any) => x.values)).toEqual([{ a: "x", b: "5" }]);
      expect(await rows("SELECT row_count FROM counts WHERE table_id = $1", [id])).toEqual([
        { row_count: expect.anything() },
      ]);

      // An old write to the table is refused whole (07 «带旧 sv 的写入»), to the other table not.
      expect(await answer(() => insertPair())).toMatchObject({
        code: "schema_incompatible",
        param: "ops/0/table",
        current_sv: 2,
        changed_fields: [{ field: "*", change: "change_type" }],
      });
      expect(
        await w({ sv: 1, ops: [{ intent: "insert", table: "settings", set: { key: "j" } }] }),
      ).toMatchObject({ status: "saved" });
      // Replayed into an empty storage, the log gives the same state (K12): the switch builds the
      // new physical table there too, from the event alone.
      const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(replayed.mismatches).toEqual([]);
      expect(replayed.mismatches_total).toBe(0);
    },
    T,
  );

  it(
    "a field added: applies at once, a new empty physical table, no migration",
    async () => {
      const id = await tableId("pairs");
      const r = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...PAIRS,
            id,
            fields: [
              { ...PAIRS.fields[0], id: "f1" },
              { ...PAIRS.fields[1], id: "f2" },
              { name: "c", type: "text", description: "third" },
            ],
          },
        ],
      });
      // An optional field added is automatic; the table needs no build (08 «物理做法»).
      expect(r).toMatchObject({ outcome: "applied", sv: 2 });
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 2 }]);
      expect(
        await rows("SELECT count(*)::int AS n FROM events WHERE type = 'schema.migration_started'"),
      ).toEqual([{ n: 0 }]);
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v2"`)).toEqual([{ n: 0 }]);
      expect(
        await w({ sv: 2, ops: [{ intent: "insert", table: "pairs", set: { a: "x", c: "y" } }] }),
      ).toMatchObject({ status: "saved" });
      const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(replayed.mismatches_total).toBe(0);
    },
    T,
  );

  it(
    "a constraint tightened: no backfill needed (nothing breaks it), switched at once; written meanwhile, table_written",
    async () => {
      const id = await tableId("limits");
      const tighten = {
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [{ ...LIMITS, id, fields: [{ ...LIMITS.fields[0], id: "f1", min: 1 }] }],
      };
      const d = await draft(tighten);
      expect(d).toMatchObject({
        outcome: "pending",
        changes: [{ change: "tighten_constraint", target: { table: "limits", field: "n" } }],
      });
      const before = await tail();
      expect(await confirm(d)).toMatchObject({ status: "resolved" });
      const types = await rows("SELECT type FROM events WHERE seq > $1 ORDER BY seq", [before]);
      expect(types.map((x) => x["type"])).toContain("schema.switched");
      expect(types.map((x) => x["type"])).not.toContain("schema.migration_started");
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v2"`)).toEqual([{ n: 0 }]);
      expect(
        await answer(() =>
          w({ sv: 2, ops: [{ intent: "insert", table: "limits", set: { n: 0 } }] }),
        ),
      ).toMatchObject({ code: "validation_failed" });

      // Another draft on version 2, compiled as on a table never written too; written meanwhile
      // (with a value it would break, but that is not what decides): table_written, nothing logged.
      const again = await draft({
        ...tighten,
        base_version: 2,
        tables: [{ ...tighten.tables[0], fields: [{ ...LIMITS.fields[0], id: "f1", min: 5 }] }],
      });
      expect(again).toMatchObject({ outcome: "pending" });
      await w({ sv: 2, ops: [{ intent: "insert", table: "limits", set: { n: 2 } }] });
      const later = await tail();
      expect(await confirm(again)).toMatchObject({
        code: "draft_outdated",
        reason: "table_written",
        current_sv: 2,
      });
      expect(await tail()).toBe(later);
    },
    T,
  );

  it(
    "a field dropped: metadata, nothing lost, marked; written while it waits, table_written",
    async () => {
      const d = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...PAIRS,
            id: await tableId("pairs"),
            fields: [{ ...PAIRS.fields[0], id: "f1" }],
            drop_fields: ["b"],
          },
        ],
      });
      expect(d.changes).toEqual([
        {
          target: { table: "pairs", field: "b" },
          change: "drop_field",
          class: "metadata",
          compatible_with_old_writes: false,
          destructive: false,
          auto: false,
          as_never_written: true,
        },
      ]);
      await insertPair();
      const before = await tail();
      expect(await confirm(d)).toMatchObject({ code: "draft_outdated", reason: "table_written" });
      expect(await tail()).toBe(before);
    },
    T,
  );

  it(
    "written while the draft waits: the confirmation is refused, table_written, nothing logged",
    async () => {
      const d = await draft(await bAsInteger());
      expect(d).toMatchObject({ outcome: "pending" });
      await insertPair();
      const before = await tail();
      expect(await confirm(d)).toMatchObject({
        code: "draft_outdated",
        reason: "table_written",
        current_sv: 1,
      });
      expect(await tail()).toBe(before);
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 1 }]);
    },
    T,
  );
});

const MEALS = {
  name: "meals",
  kind: "base",
  description: "one row per meal",
  time: { type: "event", field: "date" },
  fields: [
    { name: "date", type: "date", required: true, description: "the day" },
    { name: "energy", type: "quantity", unit: "kcal", description: "energy" },
  ],
};
const DAILY = {
  name: "daily_energy",
  kind: "derived",
  description: "energy per day",
  rule: {
    sql: "SELECT date, sum(energy) AS total FROM meals GROUP BY date",
    time_dependency: "bucketed",
  },
  fields: [
    { name: "date", description: "the day" },
    { name: "total", description: "energy that day" },
  ],
};

describe("a table never written that a derived rule reads", () => {
  it.each([
    ["a dimension", { type: "quantity", unit: "m" }, "tables/0/fields/1/unit"],
    ["a type", { type: "text" }, "tables/0/fields/1/type"],
    ["a unit of the same dimension", { type: "quantity", unit: "kJ" }, "tables/0/fields/1/unit"],
  ])(
    "%s changed on the field it reads: not_in_this_version, nothing logged (the rule would be compiled again)",
    async (_, energy, param) => {
      await draft({
        slot: "diet",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [MEALS, DAILY],
      });
      const c = (await catalog(s.store, ctx("schema"), { level: "schema", slot: "diet" })) as Any;
      const id = c.document.tables.find((t: Any) => t.name === "meals").id;
      const before = await tail();
      expect(
        await answer(() =>
          draft({
            slot: "diet",
            base_version: 1,
            timezone: "Asia/Shanghai",
            tables: [
              {
                ...MEALS,
                id,
                fields: [
                  { ...MEALS.fields[0], id: "f1" },
                  { name: "energy", id: "f2", description: "energy", ...energy },
                ],
              },
            ],
          }),
        ),
      ).toEqual({ code: "not_in_this_version", reason: "not_implemented", param });
      expect(await tail()).toBe(before);
    },
    T,
  );
});

describe("a table written", () => {
  it(
    "a type changed is not in this version, table_written, at the type; a revoked row still counts",
    async () => {
      const r = await insertPair();
      await w({
        sv: 1,
        ops: [{ intent: "revoke", table: "pairs", row: r.ops[0].target.row, ver: r.ops[0].ver }],
      });
      expect((await query(s.store, ctx("r"), { table: "pairs" })).rows).toEqual([]);
      const before = await tail();
      expect(await answer(async () => draft(await bAsInteger()))).toEqual({
        code: "not_in_this_version",
        reason: "table_written",
        param: "tables/0/fields/1/type",
      });
      expect(await tail()).toBe(before);
    },
    T,
  );
});
