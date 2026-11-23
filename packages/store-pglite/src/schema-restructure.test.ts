// A table's structure changed while it was never written (03-data-model/07-schema-evolution.md
// «从未被写入的表上改结构»; 08 «物理做法»): its time type, granularity or entity key. Compiled as
// metadata, confirmed, switched at once into a new, empty physical table; old writes to the table
// refused whole; the log replayed into an empty storage gives the same state. Written once (a write
// revoked included): not in this version; written while the draft waits: the confirmation is
// refused (`draft_outdated`, `table_written`). Fictional names.

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
import { acceptExternalKeyForTests } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"7".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

/** A budget per kind, built as an event table by mistake. */
const BUDGETS = {
  name: "budgets",
  kind: "base",
  description: "monthly budgets",
  time: { type: "event", field: "date" },
  fields: [
    { name: "date", type: "date", required: true, description: "the day" },
    { name: "category", type: "text", required: true, description: "the kind" },
    { name: "amount", type: "integer", required: true, min: 0, description: "how much" },
  ],
};
/** Items synced from another system, by their code there. */
const ITEMS = {
  name: "items",
  kind: "base",
  description: "items from a shop",
  time: { type: "none" },
  external_key: ["code"],
  fields: [
    { name: "code", type: "text", required: true, description: "the shop's code" },
    { name: "label", type: "text", description: "its label" },
  ],
};
/** A link to something, written as text by mistake. */
const LINKS = {
  name: "links",
  kind: "base",
  description: "what a note points at",
  time: { type: "none" },
  fields: [
    { name: "to", type: "text", description: "what it points at" },
    { name: "why", type: "text", description: "the reason" },
  ],
};
/** Tags, some from another system by an optional code there: rows without a key can be written. */
const TAGS = {
  name: "tags",
  kind: "base",
  description: "tags, some synced",
  time: { type: "none" },
  external_key: ["code"],
  fields: [
    { name: "code", type: "text", description: "the other system's code" },
    { name: "label", type: "text", description: "its label" },
  ],
};
/** TAGS as a draft writes it without its external key. */
const { external_key: _, ...withoutKey } = TAGS;
const ROOMS = {
  name: "rooms",
  kind: "base",
  description: "who is in a room",
  time: { type: "state", granularity: "instant" },
  fields: [{ name: "guest", type: "text", description: "who" }],
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
    now: `2026-11-05T04:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
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
  answer(() => schemaDraft(s.store, ctx("schema"), { document }));
const confirm = (d: Any): Promise<Any> =>
  answer(() =>
    resolve(s.store, ctx("schema"), {
      id: d.item.id,
      decision: "confirm",
      item_ver: d.item.item_ver,
    }),
  );
async function tableId(name: string): Promise<string> {
  const c = (await catalog(s.store, ctx("schema"), { level: "schema", slot: "plan" })) as Any;
  return c.document.tables.find((t: Any) => t.name === name).id;
}
/** The decision's example: budgets made a state table keyed by category, its date dropped. */
const asState = async () => ({
  slot: "plan",
  base_version: 1,
  timezone: "Asia/Shanghai",
  tables: [
    {
      ...BUDGETS,
      id: await tableId("budgets"),
      time: { type: "state", granularity: "date" },
      entity_key: ["category"],
      fields: [
        { ...BUDGETS.fields[1], id: "f2" },
        { ...BUDGETS.fields[2], id: "f3" },
      ],
      drop_fields: ["date"],
    },
  ],
});
const insertBudget = () =>
  w({
    sv: 1,
    ops: [
      {
        intent: "insert",
        table: "budgets",
        set: { date: "2026-11-01", category: "food", amount: 5 },
      },
    ],
  });

beforeAll(async () => {
  s = await openReusable("saveslot-schema-restructure-");
  scratch = await openReusable("saveslot-schema-restructure-scratch-");
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
    slot: "plan",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [BUDGETS, ROOMS, ITEMS, LINKS, TAGS],
  });
}, T);

describe("a table never written, restructured", () => {
  it(
    "an event table made a state table: waits, then switches at once into a new empty physical table",
    async () => {
      const id = await tableId("budgets");
      // Read, not written: still never written.
      expect((await query(s.store, ctx("r"), { table: "budgets" })).rows).toEqual([]);
      const d = await draft(await asState());
      const record = (change: string, field?: string) => ({
        target: { table: "budgets", ...(field !== undefined ? { field } : {}) },
        change,
        class: "metadata",
        compatible_with_old_writes: false,
        destructive: false,
        auto: false,
      });
      expect(d).toMatchObject({
        outcome: "pending",
        changes: [
          record("change_time_type"),
          record("change_entity_key"),
          record("drop_field", "date"),
        ],
      });
      const before = await tail();
      expect(await confirm(d)).toMatchObject({ status: "resolved" });
      const types = await rows("SELECT type FROM events WHERE seq > $1 ORDER BY seq", [before]);
      expect(types.map((x) => x["type"])).not.toContain("schema.migration_started");
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
      // The new physical table is a state table's: written by the entity key.
      const now = await w({
        sv: 2,
        ops: [
          {
            intent: "update",
            table: "budgets",
            entity_key: { category: "food" },
            set: { amount: 300 },
            valid_from: "2026-11-01",
          },
        ],
      });
      expect(now).toMatchObject({ status: "saved", sv: 2 });
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v2"`)).toEqual([{ n: 1 }]);
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v1"`)).toEqual([{ n: 0 }]);
      const read = await query(s.store, ctx("r"), { table: "budgets" });
      expect(read.rows.map((x: Any) => x.values)).toEqual([{ category: "food", amount: "300" }]);
      // As of before the switch: that version, no row.
      const entity = now.ops[0].target.entity;
      expect(
        await history(s.store, ctx("r"), {
          table: "budgets",
          entity,
          mode: "as_of",
          as_of: before,
        }),
      ).toMatchObject({ sv: 1, rows: [] });
      // An old write to the table is refused whole, with the table-level change's code.
      expect(await answer(() => insertBudget())).toMatchObject({
        code: "schema_incompatible",
        current_sv: 2,
        changed_fields: [{ field: "*", change: "change_time_type" }],
      });
      // Replayed into an empty storage, the log gives the same state (K12).
      const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(replayed.mismatches).toEqual([]);
      expect(replayed.mismatches_total).toBe(0);
    },
    T,
  );

  it(
    "a granularity changed: a new physical table whose interval columns are dates",
    async () => {
      const id = await tableId("rooms");
      const d = await draft({
        slot: "plan",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [{ ...ROOMS, id, time: { type: "state", granularity: "date" } }],
      });
      expect(d.changes.map((c: Any) => c.change)).toEqual(["change_granularity"]);
      expect(await confirm(d)).toMatchObject({ status: "resolved" });
      const cols = await rows(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'valid_from'`,
        [`t_${id}_v2`],
      );
      expect(cols).toEqual([{ data_type: "date" }]);
      expect(
        await w({
          sv: 2,
          ops: [
            { intent: "insert", table: "rooms", set: { guest: "x" }, valid_from: "2026-11-01" },
          ],
        }),
      ).toMatchObject({ status: "saved" });
      const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(replayed.mismatches_total).toBe(0);
    },
    T,
  );
});

describe("a field made a ref on a table never written (change_ref)", () => {
  it(
    "waits, switches at once into a new empty physical table; old writes refused whole; replays the same",
    async () => {
      const id = await tableId("links");
      const d = await draft({
        slot: "plan",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...LINKS,
            id,
            fields: [
              {
                ...LINKS.fields[0],
                id: "f1",
                type: "ref",
                ref: { table: "rooms", target: "entity" },
              },
              { ...LINKS.fields[1], id: "f2" },
            ],
          },
        ],
      });
      expect(d).toMatchObject({
        outcome: "pending",
        changes: [
          {
            target: { table: "links", field: "to" },
            change: "change_ref",
            class: "metadata",
            compatible_with_old_writes: false,
            destructive: false,
            auto: false,
          },
        ],
      });
      expect(await confirm(d)).toMatchObject({ status: "resolved" });
      const c = (await catalog(s.store, ctx("schema"), { level: "schema", slot: "plan" })) as Any;
      const to = c.document.tables.find((t: Any) => t.name === "links").fields[0];
      expect(to).toMatchObject({ type: "ref", ref: { table: "rooms", target: "entity" } });
      expect(
        await w({ sv: 2, ops: [{ intent: "insert", table: "links", set: { why: "y" } }] }),
      ).toMatchObject({ status: "saved", sv: 2 });
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v2"`)).toEqual([{ n: 1 }]);
      expect(
        await answer(() =>
          w({ sv: 1, ops: [{ intent: "insert", table: "links", set: { to: "room 1" } }] }),
        ),
      ).toEqual({
        code: "schema_incompatible",
        param: "ops/0/table",
        current_sv: 2,
        changed_fields: [{ field: "*", change: "change_ref" }],
      });
      const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(replayed.mismatches).toEqual([]);
      expect(replayed.mismatches_total).toBe(0);
    },
    T,
  );
});

describe("an old write to a table restructured: refused whole before its shape is read (fixed cases)", () => {
  /** budgets made a state table, after the caller wrote rooms at version 1. */
  const switched = async () => {
    await w({
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "rooms",
          set: { guest: "x" },
          valid_from: "2026-11-01T00:00:00Z",
        },
      ],
    });
    expect(await confirm(await draft(await asState()))).toMatchObject({ status: "resolved" });
  };
  const refusal = {
    code: "schema_incompatible",
    param: "ops/0/table",
    current_sv: 2,
    changed_fields: [{ field: "*", change: "change_time_type" }],
  };
  // The insert the caller wrote for version 1: by the new definition an insert on a table with an
  // entity key (`insert_with_entity_key`) naming a field gone (`date`).
  const old = {
    intent: "insert",
    table: "budgets",
    set: { date: "2026-11-01", category: "food", amount: 5 },
  };

  it(
    "with sv given",
    async () => {
      await switched();
      expect(await answer(() => w({ sv: 1, ops: [old] }))).toEqual(refusal);
    },
    T,
  );

  it(
    "with sv by fallback (the caller's latest write on the slot was at version 1)",
    async () => {
      await switched();
      expect(await answer(() => w({ ops: [old] }))).toEqual(refusal);
    },
    T,
  );

  it(
    "an op before it with a problem of its own is reported first (document order)",
    async () => {
      await switched();
      expect(
        await answer(() => w({ sv: 1, ops: [{ intent: "insert", table: "rooms" }, old] })),
      ).toMatchObject({ code: "invalid_argument", param: "ops/0/set" });
    },
    T,
  );
});

describe("a table written", () => {
  it(
    "once, the write revoked: not in this version (table_written), nothing logged",
    async () => {
      const r = await insertBudget();
      await w({ sv: 1, ops: [{ intent: "revoke", table: "budgets", row: r.ops[0].target.row }] });
      const before = await tail();
      expect(await draft(await asState())).toMatchObject({
        code: "not_in_this_version",
        reason: "table_written",
        param: "tables/0/time",
      });
      expect(await tail()).toBe(before);
    },
    T,
  );

  it(
    "while the draft waits: the confirmation is refused (draft_outdated, table_written), the item stays open",
    async () => {
      const d = await draft(await asState());
      await insertBudget();
      const before = await tail();
      expect(await confirm(d)).toMatchObject({ code: "draft_outdated", reason: "table_written" });
      expect(await tail()).toBe(before);
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 1 }]);
    },
    T,
  );
});

it(
  "a change of the first version not compiled yet is not in this version, not an internal error (fixed case)",
  async () => {
    const id = await tableId("budgets");
    const before = await tail();
    // The time field of an event table changed: compiled by a later part of this version.
    expect(
      await draft({
        slot: "plan",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...BUDGETS,
            id,
            fields: [
              ...BUDGETS.fields.map((f, i) => ({ ...f, id: `f${i + 1}` })),
              { name: "paid_on", type: "date", required: true, description: "paid" },
            ],
            time: { type: "event", field: "paid_on" },
          },
        ],
      }),
    ).toMatchObject({ code: "not_in_this_version", reason: "not_implemented" });
    expect(await tail()).toBe(before);
  },
  T,
);

describe("an old write by external key to a table restructured: schema_incompatible, not a key error (fixed cases)", () => {
  beforeAll(() => acceptExternalKeyForTests(true));
  afterAll(() => acceptExternalKeyForTests(false));
  /** items made an event table, after the caller wrote rooms at version 1. */
  const switched = async () => {
    await w({
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "rooms",
          set: { guest: "x" },
          valid_from: "2026-11-01T00:00:00Z",
        },
      ],
    });
    const d = await draft({
      slot: "plan",
      base_version: 1,
      timezone: "Asia/Shanghai",
      tables: [
        {
          ...ITEMS,
          id: await tableId("items"),
          time: { type: "event", field: "on" },
          fields: [
            { ...ITEMS.fields[0], id: "f1" },
            { ...ITEMS.fields[1], id: "f2" },
            {
              name: "on",
              type: "date",
              required: true,
              description: "the day",
              backfill: { const: "2026-11-01" },
            },
          ],
        },
      ],
    });
    expect(d.changes.map((c: Any) => c.change)).toEqual(["change_time_type", "add_required_field"]);
    expect(await confirm(d)).toMatchObject({ status: "resolved" });
  };
  const refusal = {
    code: "schema_incompatible",
    param: "ops/0/table",
    current_sv: 2,
    changed_fields: [{ field: "*", change: "change_time_type" }],
  };
  // By key: read and normalized, it would reach the write path (which does not write by key yet).
  const byKey = {
    intent: "update",
    table: "items",
    external_key: { code: "a" },
    set: { label: "x" },
  };
  // An insert with a key: on a table changed whole since the request's version it too is refused
  // first with schema_incompatible; only on a table not changed so is it insert_with_external_key.
  const insertKeyed = {
    intent: "insert",
    table: "items",
    external_key: { code: "a" },
    set: { code: "a", label: "x" },
  };

  it.each([
    ["by key, sv given", { sv: 1, ops: [byKey] }],
    ["by key, sv by fallback", { ops: [byKey] }],
    ["an insert with a key, sv given", { sv: 1, ops: [insertKeyed] }],
    ["an insert with a key, sv by fallback", { ops: [insertKeyed] }],
  ])(
    "%s",
    async (_, params) => {
      await switched();
      expect(await answer(() => w(params))).toEqual(refusal);
    },
    T,
  );
});

describe("the external key", () => {
  beforeAll(() => acceptExternalKeyForTests(true));
  afterAll(() => acceptExternalKeyForTests(false));

  it(
    "dropped on a table written: the catalog only, confirmed; by key at the old version no_external_key, by row accepted, no row added",
    async () => {
      const id = await tableId("tags");
      const first = await w({
        sv: 1,
        ops: [{ intent: "insert", table: "tags", set: { label: "a" } }],
      });
      const row = first.ops[0].target.row;
      const d = await draft({
        slot: "plan",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...withoutKey,
            id,
            fields: [
              { ...TAGS.fields[0], id: "f1" },
              { ...TAGS.fields[1], id: "f2" },
            ],
          },
        ],
      });
      expect(d).toMatchObject({
        outcome: "pending",
        changes: [
          {
            target: { table: "tags" },
            change: "drop_external_key",
            class: "metadata",
            compatible_with_old_writes: true,
            destructive: false,
            auto: false,
          },
        ],
      });
      expect(await confirm(d)).toMatchObject({ status: "resolved" });
      // The catalog only: the physical table is the first version's, with its row.
      const c = (await catalog(s.store, ctx("schema"), { level: "schema", slot: "plan" })) as Any;
      expect(c.document.tables.find((t: Any) => t.name === "tags")).not.toHaveProperty(
        "external_key",
      );
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v1"`)).toEqual([{ n: 1 }]);
      // By key at the old version: judged by the current definition, which has no key (R446).
      const before = await tail();
      expect(
        await answer(() =>
          w({
            sv: 1,
            ops: [
              { intent: "update", table: "tags", external_key: { code: "x" }, set: { label: "b" } },
            ],
          }),
        ),
      ).toMatchObject({ code: "invalid_argument", reason: "no_external_key" });
      expect(await tail()).toBe(before);
      // By row at the old version: accepted (the change is compatible), and no row added.
      expect(
        await w({ sv: 1, ops: [{ intent: "update", table: "tags", row, set: { label: "c" } }] }),
      ).toMatchObject({ status: "saved" });
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v1"`)).toEqual([{ n: 1 }]);
      expect(
        (await query(s.store, ctx("r"), { table: "tags" })).rows.map((x: Any) => x.values),
      ).toEqual([{ code: null, label: "c" }]);
      const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(replayed.mismatches).toEqual([]);
      expect(replayed.mismatches_total).toBe(0);
    },
    T,
  );

  it(
    "changed on a table never written: switched into a new empty table, the key index of the new key",
    async () => {
      const id = await tableId("tags");
      const d = await draft({
        slot: "plan",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...TAGS,
            id,
            external_key: ["label"],
            fields: [
              { ...TAGS.fields[0], id: "f1" },
              { ...TAGS.fields[1], id: "f2" },
            ],
          },
        ],
      });
      expect(d.changes.map((c: Any) => c.change)).toEqual(["change_external_key"]);
      expect(await confirm(d)).toMatchObject({ status: "resolved" });
      const c = (await catalog(s.store, ctx("schema"), { level: "schema", slot: "plan" })) as Any;
      expect(c.document.tables.find((t: Any) => t.name === "tags").external_key).toEqual(["label"]);
      expect(await rows(`SELECT count(*)::int AS n FROM "t_${id}_v2"`)).toEqual([{ n: 0 }]);
      // An old write to it is refused whole.
      expect(
        await answer(() =>
          w({ sv: 1, ops: [{ intent: "insert", table: "tags", set: { label: "a" } }] }),
        ),
      ).toMatchObject({
        code: "schema_incompatible",
        changed_fields: [{ field: "*", change: "change_external_key" }],
      });
      const replayed = await reconcileLog({ live: s.store, scratch: scratch.store });
      expect(replayed.mismatches_total).toBe(0);
    },
    T,
  );
});
