// A write at an earlier schema version, refused field by field (03-data-model/07-schema-evolution.md
// «原则» 4; 04-contract §2; 04-contract-types `schema_incompatible`): what refuses it is read off the
// changes the versions since recorded. Changes compatible with old writes refuse nothing, whether the
// version is given or taken by fallback. (The changes that refuse a field — a field dropped, a type
// changed — switch only once a version can be built; their judgement is the pure
// kernel/src/schema/changed-since.test.ts.) Fictional names.

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
/** Writes under task `w`: the decisions are under none, so they move no fallback of the writer. */
const w = (params: unknown, task = "w"): Promise<Any> => write(s.store, ctx(task), params);
const draft = (document: unknown): Promise<Any> =>
  schemaDraft(s.store, ctx("schema"), { document });
/** Submits `document` and confirms it: the slot's next version. */
async function change(document: unknown): Promise<void> {
  const d = await draft(document);
  if (d.outcome === "applied") return;
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

beforeAll(async () => {
  s = await openReusable("saveslot-schema-old-sv-fields-");
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

/** `pairs` at version 1 as created, with `f` applied to its first field. */
async function pairsWith(base: number, f: (a: Any) => void): Promise<Any> {
  const d: Any = await pairsAs("ledger", base, "a", "b");
  f(d.tables[0].fields[0]);
  return d;
}

describe("changes compatible with old writes: a write at the version before is taken", () => {
  it.each([
    [
      "a field's description changed",
      (a: Any): void => {
        a.description = "the first one";
      },
    ],
    [
      "a field's aliases changed",
      (a: Any): void => {
        a.aliases = ["alpha"];
      },
    ],
    [
      "a field renamed (the old name resolves by the old version)",
      (a: Any): void => {
        a.name = "first";
      },
    ],
  ] as const)(
    "%s",
    async (_, f) => {
      await change(await pairsWith(1, f));
      const r = await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] });
      expect(r).toMatchObject({ sv: 1, ops: [{ fields: { a: { after: "A" } } }] });
    },
    T,
  );

  it(
    "a table added beside it",
    async () => {
      const d = await pairsWith(1, () => {});
      d.tables.push({
        name: "notes",
        kind: "base",
        description: "free notes",
        time: { type: "none" },
        fields: [{ name: "text", type: "text", description: "the note" }],
      });
      await change(d);
      expect(
        await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { b: "B" } }] }),
      ).toMatchObject({ sv: 1 });
    },
    T,
  );

  it(
    "the same with the version taken by fallback; a table dropped since is refused the same way",
    async () => {
      await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { a: "first" } }] });
      await change(await pairsWith(1, (a) => (a.description = "the first one")));
      expect(
        await w({ ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] }),
      ).toMatchObject({
        sv: 1,
        warnings: [expect.objectContaining({ code: "sv_fallback", sv: 1 })],
      });
      await change({
        slot: "ledger",
        base_version: 2,
        timezone: "Asia/Shanghai",
        drop_tables: ["settings"],
        tables: [],
      });
      expect(
        await answer(() =>
          w({ ops: [{ intent: "insert", table: "settings", set: { key: "k" } }] }),
        ),
      ).toEqual({
        code: "schema_incompatible",
        param: "ops/0/table",
        current_sv: 3,
        changed_fields: [{ field: "*", change: "drop_table" }],
      });
    },
    T,
  );
});
