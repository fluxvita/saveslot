// The `schema_updated` notices the kernel computes for the service (04-contract §13; 04-contract-types
// §7): the version the caller last read of a slot behind the current one, and what the versions
// since changed, by the names now (or before a drop). By actor and task, as the `sv` fallback reads
// "last read" (04-contract §2). Fictional IDs and names.

import {
  catalog,
  createOpsContext,
  createTenant,
  resolve,
  schemaDraft,
  schemaUpdatedNotices,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"9".repeat(26)}`;
const USER = `u_${"2".repeat(26)}`;
const OTHER = `ci_${"6".repeat(26)}`;

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
const ctxOf = (actor: string, task: string | null = null) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T04:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  } as never);
// biome-ignore lint/suspicious/noExplicitAny: results as the kernel gives them
type Any = any;
let slotId: string;

/** Submits a change to `ledger` at `base` and confirms it when it waits: the next version. */
async function change(document: Record<string, unknown>): Promise<void> {
  const d = (await schemaDraft(s.store, ctxOf(USER, "schema"), {
    document: { slot: "ledger", timezone: "Asia/Shanghai", ...document },
  } as never)) as Any;
  if (d.outcome === "applied") return;
  expect(d).toMatchObject({ outcome: "pending" });
  await resolve(s.store, ctxOf(USER, "schema"), {
    id: d.item.id,
    decision: "confirm",
    item_ver: d.item.item_ver,
  } as never);
}
/** `pairs` at `base` with its fields as given (by ID). */
const pairs = (base: number, a: Record<string, unknown>, b: Record<string, unknown>) => ({
  base_version: base,
  tables: [
    {
      ...PAIRS,
      id: "t1",
      fields: [
        { ...PAIRS.fields[0], id: "f1", ...a },
        { ...PAIRS.fields[1], id: "f2", ...b },
      ],
    },
  ],
});
const read = (actor = USER, task: string | null = null) =>
  catalog(s.store, ctxOf(actor, task), { level: "schema", slot: "ledger" } as never);
const notices = (actor = USER, task: string | null = null, visibility: Any = { kind: "all" }) =>
  schemaUpdatedNotices(s.store, visibility, { actor: actor as never, task }, { slots: ["ledger"] });

beforeAll(async () => {
  s = await openReusable("saveslot-notices-schema-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctxOf(USER));
  slotId = (
    (await schemaDraft(s.store, ctxOf(USER, "schema"), {
      document: {
        slot: "ledger",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [PAIRS, SETTINGS],
      },
    } as never)) as Any
  ).slot_id;
}, T);

describe("schemaUpdatedNotices", () => {
  it(
    "behind: from the version read to the current one, every change since by the names now; read again, none",
    async () => {
      await read();
      expect(await notices()).toEqual([]);
      // A description (automatic), then a rename (confirmed), then a table dropped (confirmed).
      await change(pairs(1, { description: "the first" }, {}));
      expect(await notices()).toEqual([
        { code: "schema_updated", slot: "ledger", from: 1, to: 2, changed: ["pairs.a"] },
      ]);
      await change(pairs(2, { description: "the first" }, { name: "beta" }));
      await change({ base_version: 3, drop_tables: ["settings"], tables: [] });
      expect(await notices()).toEqual([
        {
          code: "schema_updated",
          slot: "ledger",
          from: 1,
          to: 4,
          // The renamed field by its name now; the dropped table by its name before.
          changed: ["pairs.a", "pairs.beta", "settings"],
        },
      ]);
      await read();
      expect(await notices()).toEqual([]);
    },
    T,
  );

  it(
    "a change to the slot itself is the slot, by its name now",
    async () => {
      await read();
      await change({ ...pairs(1, { description: "the first" }, {}), rename_to: "books" });
      expect(
        await schemaUpdatedNotices(
          s.store,
          { kind: "all" },
          { actor: USER as never, task: null },
          { slots: ["books"] },
        ),
      ).toEqual([
        { code: "schema_updated", slot: "books", from: 1, to: 2, changed: ["books", "pairs.a"] },
      ]);
    },
    T,
  );

  it(
    "by actor and task as last read is kept; never read, or out of range: none",
    async () => {
      await read();
      await read(OTHER, "t");
      await change(pairs(1, { description: "the first" }, {}));
      // Never read under this task, nor by this actor at all.
      expect(await notices(OTHER, null)).toEqual([]);
      expect(await notices(`u_${"3".repeat(26)}`)).toEqual([]);
      expect(await notices(OTHER, "t")).toMatchObject([{ from: 1, to: 2 }]);
      // A range without the slot: nothing, though the references name it.
      expect(
        await notices(USER, null, { kind: "scoped", slots: [{ slot: `sl_${"7".repeat(26)}` }] }),
      ).toEqual([]);
      expect(
        await notices(USER, null, { kind: "scoped", slots: [{ slot: slotId }] }),
      ).toMatchObject([{ slot: "ledger", from: 1, to: 2 }]);
      // A range of the slot's other table only: nothing it sees changed, no notice (not `changed: []`).
      expect(
        await notices(USER, null, {
          kind: "scoped",
          slots: [{ slot: slotId, tables: [{ table: "t2" }] }],
        }),
      ).toEqual([]);
      expect(
        await notices(USER, null, {
          kind: "scoped",
          slots: [{ slot: slotId, tables: [{ table: "t1" }] }],
        }),
      ).toMatchObject([{ changed: ["pairs.a"] }]);
    },
    T,
  );
});
