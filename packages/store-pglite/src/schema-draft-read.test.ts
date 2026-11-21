// Reading a slot's drafts (04-contract §10 `catalog` `draft`, `pending`; 04-contract-types §4.2
// `CatalogSchema`, §4.8 `SchemaChangeDetail`): a `schema_change` item's detail and the list, a
// draft's whole document on the slot's current version, and the visible range: a slot's drafts and
// their items are seen only with every table of the slot in range, else they are as not there.
// Fictional names.

import {
  catalog,
  createOpsContext,
  createTenant,
  pending,
  pendingItemsNotices,
  schemaDraft,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NO_ITEM = `pi_${"7".repeat(16)}`;
const NO_DRAFT = `d_${"7".repeat(16)}`;

const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "note", type: "text", description: "what for" },
      ],
    },
    {
      name: "settings",
      kind: "base",
      description: "one row per setting",
      time: { type: "none" },
      fields: [{ name: "key", type: "text", required: true, description: "the setting" }],
    },
  ],
};

/** A draft on version `base` of the ledger, listing the expenses table with `note` renamed. */
const rename = (name: string, base = 1) => {
  const t = structuredClone(DOCUMENT.tables[0]) as (typeof DOCUMENT.tables)[number];
  Object.assign(t.fields[1] as object, { id: "f2", name });
  return { slot: "ledger", base_version: base, timezone: "Asia/Shanghai", tables: [t] };
};
/** A draft on version `base` changing only the description of `settings`: automatic. */
const describeSettings = (description: string, base = 1) => {
  const t = structuredClone(DOCUMENT.tables[1]) as (typeof DOCUMENT.tables)[number];
  Object.assign(t, { id: "t2", description });
  return { slot: "ledger", base_version: base, timezone: "Asia/Shanghai", tables: [t] };
};

let s: ReusableStore;
let slotId: string;
let minute = 0;
const ctx = (o: { visibility?: unknown } = {}) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: (o.visibility ?? { kind: "all" }) as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
const draft = (document: unknown): Promise<Any> => schemaDraft(s.store, ctx(), { document });
const read = (params: unknown, o: Parameters<typeof ctx>[0] = {}): Promise<Any> =>
  catalog(s.store, ctx(o), { level: "schema", slot: "ledger", ...(params as object) });
const items = (params: unknown, o: Parameters<typeof ctx>[0] = {}): Promise<Any> =>
  pending(s.store, ctx(o), params);
/** The refusal of `f`, as a caller gets it: code, message, details. */
async function refusal(f: () => Promise<unknown>) {
  try {
    await f();
  } catch (e) {
    const x = e as { code?: string; message: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, message: x.message, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}
/** A credential seeing only the slot's table `expenses` (table IDs t1, t2 in order). */
const partOfSlot = () => ({ kind: "scoped", slots: [{ slot: slotId, tables: [{ table: "t1" }] }] });
/** A credential seeing the whole slot by naming each of its tables. */
const everyTable = () => ({
  kind: "scoped",
  slots: [{ slot: slotId, tables: [{ table: "t1" }, { table: "t2" }] }],
});

beforeAll(async () => {
  s = await openReusable("saveslot-schema-draft-read-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
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
  slotId = (await draft(structuredClone(DOCUMENT))).slot_id;
}, T);

describe("a schema_change item's detail", () => {
  it(
    "gives the draft, its version, the changes by names and the impact; reading it reads its version",
    async () => {
      const r = await draft(rename("memo"));
      const d = await items({ id: r.item.id });
      expect(d).toEqual({
        id: r.item.id,
        item_ver: r.item.item_ver,
        status: "open",
        slot: "ledger",
        reason: "schema_change",
        opened_at: expect.any(String),
        opened_by: expect.objectContaining({ kind: "user", id: USER }),
        // `resolve` takes no decision on it in this version.
        decisions: [],
        type: "schema_change",
        draft: r.draft,
        target_sv: 2,
        changes: r.changes,
        // No `consumers`: usage is not computed (as the receipt).
        impact: { rows_affected: 0, derived_changed: [] },
      });
      expect(d.changes).toEqual([
        expect.objectContaining({
          target: { table: "expenses", field: "memo" },
          change: "rename_field",
        }),
      ]);
    },
    T,
  );

  it(
    "once superseded: closed, saying by what",
    async () => {
      const first = await draft(rename("memo"));
      await draft(rename("remark"));
      const d = await items({ id: first.item.id });
      expect(d).toMatchObject({
        status: "superseded",
        decisions: [],
        superseded: { reason: "draft_replaced" },
        draft: first.draft,
        target_sv: 2,
      });
    },
    T,
  );

  it(
    "is listed with its slot and no target",
    async () => {
      const r = await draft(rename("memo"));
      const list = await items({});
      expect(list).toMatchObject({ total: 1 });
      expect(list.items).toEqual([
        {
          id: r.item.id,
          type: "schema_change",
          status: "open",
          slot: "ledger",
          reason: "schema_change",
          opened_at: expect.any(String),
          opened_by: expect.objectContaining({ id: USER }),
        },
      ]);
    },
    T,
  );
});

describe("a draft's document (catalog, schema, draft)", () => {
  it(
    "is the whole slot once switched to the draft, on the current version; the version it compiles to",
    async () => {
      const r = await draft(rename("memo"));
      const c = await read({ draft: r.draft });
      expect(c).toMatchObject({ level: "schema", slot: "ledger", sv: 2, draft: r.draft });
      // Both tables, though the draft lists one; on the version the slot is at.
      expect(c.document).toMatchObject({ slot: "ledger", base_version: 1 });
      const tables = c.document.tables as { name: string; fields: { name: string }[] }[];
      expect(tables.map((t) => t.name)).toEqual(["expenses", "settings"]);
      expect(tables[0]?.fields.map((f) => f.name)).toEqual(["date", "memo"]);
      // The receipt's document is still the draft as submitted, filled in: its one table.
      expect((r.document.tables as unknown[]).length).toBe(1);
      // Without `draft`: the current version, unchanged.
      const now = await read({});
      expect(now).toMatchObject({ sv: 1 });
      expect(now).not.toHaveProperty("draft");
      expect(now.document.tables[0].fields.map((f: { name: string }) => f.name)).toEqual([
        "date",
        "note",
      ]);
    },
    T,
  );

  it(
    "changed and submitted, replaces the pending draft",
    async () => {
      const r = await draft(rename("memo"));
      const doc = (await read({ draft: r.draft })).document;
      doc.tables[0].fields[1].name = "remark";
      const again = await draft(doc);
      expect(again).toMatchObject({ outcome: "pending", superseded_draft: r.draft, target_sv: 3 });
      expect(again.changes).toEqual([
        expect.objectContaining({ target: { table: "expenses", field: "remark" } }),
      ]);
    },
    T,
  );

  it(
    "is read whatever state the draft is in, on the version it holds on; given back, judged by it",
    async () => {
      // Pending: on the current version (the item's own test above). Superseded and never in
      // effect: on the version it was written on.
      const first = await draft(rename("memo"));
      await draft(rename("remark"));
      const old = await read({ draft: first.draft });
      expect(old).toMatchObject({ sv: 2, document: { base_version: 1 } });
      expect(old.document.tables[0].fields[1].name).toBe("memo");

      // In effect: on its own version. While current, given back it changes nothing.
      const auto = await draft(describeSettings("the settings, one per row"));
      expect(auto).toMatchObject({ outcome: "applied", sv: 4 });
      const current = await read({ draft: auto.draft });
      expect(current).toMatchObject({ sv: 4, document: { base_version: 4 } });
      expect(await refusal(() => draft(current.document))).toMatchObject({
        code: "invalid_argument",
        reason: "no_change",
      });
      // The superseded draft, given back now that the slot switched: outdated, not a silent
      // revert of what came since.
      expect(await refusal(() => draft(old.document))).toMatchObject({
        code: "draft_outdated",
        current_sv: 4,
      });

      // Retired: still on its own version; given back, outdated.
      await draft(describeSettings("settings", 4));
      const retired = await read({ draft: auto.draft });
      expect(retired).toMatchObject({ sv: 4, document: { base_version: 4 } });
      expect(retired.document.tables[1].description).toBe("the settings, one per row");
      expect(await refusal(() => draft(retired.document))).toMatchObject({
        code: "draft_outdated",
        current_sv: 5,
      });
    },
    T,
  );

  it(
    "not there: an unknown draft, or one of another slot, is not_found (draft); a malformed one, invalid",
    async () => {
      const other = await schemaDraft(s.store, ctx(), {
        document: { ...structuredClone(DOCUMENT), slot: "garden" },
      });
      const unknown = await refusal(() => read({ draft: NO_DRAFT }));
      expect(unknown).toMatchObject({ code: "not_found", reason: "draft", param: "draft" });
      expect(await refusal(() => read({ draft: (other as Any).draft }))).toEqual(unknown);
      expect(await refusal(() => read({ draft: "d_x" }))).toMatchObject({
        code: "invalid_argument",
        reason: "malformed",
        param: "draft",
      });
    },
    T,
  );
});

describe("the visible range: a slot's schema is seen only with every table of it", () => {
  /** The answer of `f`, its result or its refusal (code, message, details), whole. */
  const answer = async (f: () => Promise<unknown>) => {
    try {
      return await f();
    } catch (e) {
      const x = e as { code?: string; message: string; detail?: Record<string, unknown> };
      if (x.code === undefined) throw e;
      return { code: x.code, message: x.message, ...(x.detail ?? {}) };
    }
  };
  /** What a caller with `o` gets of the slot's pending items and schema, as whole answers. */
  const seen = async (o: { visibility: unknown }, item: string, draftId: string) => ({
    detail: await answer(() => items({ id: item }, o)),
    list: await answer(() => items({}, o)),
    listOne: await answer(() => items({ limit: 1 }, o)),
    listAll: await answer(() => items({ type: "schema_change", status: "all" }, o)),
    listSlot: await answer(() => items({ slot: "ledger", status: "all" }, o)),
    schema: await answer(() => read({}, o)),
    draftRead: await answer(() => read({ draft: draftId }, o)),
    notices: await pendingItemsNotices(s.store, o.visibility as never, {
      slots: ["ledger"],
      tables: ["expenses"],
      items: [item],
    }),
  });

  it(
    "with part of the slot: byte for byte as if the draft and its item were not there",
    async () => {
      const o = { visibility: partOfSlot() };
      const before = await seen(o, NO_ITEM, NO_DRAFT);
      const r = await draft(rename("memo"));
      const after = await seen(o, r.item.id, r.draft);
      expect(after).toEqual(before);
      // What that is: the item not found, none listed, the slot's schema not found as a slot.
      expect(after.detail).toMatchObject({ code: "not_found", reason: "item" });
      expect(after.list).toEqual({ total: 0, items: [] });
      expect(after.schema).toEqual(await refusal(() => read({ slot: "nowhere" }, o)));
      expect(after.schema).toMatchObject({ code: "not_found", reason: "slot", param: "slot" });
      expect(after.draftRead).toEqual(after.schema);
      expect(after.notices).toEqual([]);
      // The tables it sees stay readable at the other levels.
      expect(
        await catalog(s.store, ctx(o), { level: "table", tables: ["expenses"] }),
      ).toMatchObject({ level: "table" });
    },
    T,
  );

  it(
    "without the slot at all: the same as with part of it",
    async () => {
      await schemaDraft(s.store, ctx(), {
        document: { ...structuredClone(DOCUMENT), slot: "garden" },
      });
      const gardenId = (
        (await catalog(s.store, ctx(), { slot: "garden" })) as unknown as {
          slots: { slot_id: string }[];
        }
      ).slots[0]?.slot_id;
      const o = { visibility: { kind: "scoped", slots: [{ slot: gardenId }] } };
      const before = await seen(o, NO_ITEM, NO_DRAFT);
      const r = await draft(rename("memo"));
      const after = await seen(o, r.item.id, r.draft);
      expect(after).toEqual(before);
      expect(after.detail).toMatchObject({ code: "not_found", reason: "item" });
      expect(after.schema).toMatchObject({ code: "not_found", reason: "slot" });
      expect(after.notices).toEqual([]);
    },
    T,
  );

  it(
    "with every table of the slot named, all of it is seen",
    async () => {
      const r = await draft(rename("memo"));
      const o = { visibility: everyTable() };
      expect(await items({ id: r.item.id }, o)).toMatchObject({ draft: r.draft });
      expect(await items({}, o)).toMatchObject({ total: 1 });
      expect(await read({ draft: r.draft }, o)).toMatchObject({ sv: 2 });
      expect(await read({}, o)).toMatchObject({ sv: 1 });
      expect(
        await pendingItemsNotices(s.store, o.visibility as never, { slots: ["ledger"] }),
      ).toEqual([expect.objectContaining({ code: "pending_items", slot: "ledger", count: 1 })]);
    },
    T,
  );
});
