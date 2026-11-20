// `schema_draft` changing an existing slot through the ops entry (04-contract §10 `schema_draft`;
// 09-event-format §4.5, §5.5, §5.8): the draft left pending as a `schema_change` item, a newer
// draft superseding it, version numbers never used twice, the refusals, idempotent replays, and
// the log replayed into an empty storage giving the same state. Fictional names.

import {
  applyEvents,
  createOpsContext,
  createTenant,
  KERNEL_TABLES,
  readEvents,
  readTail,
  schemaDraft,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

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
  ],
};

/** A draft on version `base` of the ledger: the expenses table, changed by `f`. */
function change(f: (t: (typeof DOCUMENT.tables)[number]) => void, base = 1) {
  const t = structuredClone(DOCUMENT.tables[0]) as (typeof DOCUMENT.tables)[number];
  f(t);
  return { slot: "ledger", base_version: base, timezone: "Asia/Shanghai", tables: [t] };
}
/** The `note` field renamed, by its ID. */
const rename = (name: string) =>
  change((t) => {
    Object.assign(t.fields[1] as object, { id: "f2", name });
  });

let s: ReusableStore;
let minute = 0;
const ctx = (o: { visibility?: unknown; task?: string } = {}) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: o.task ?? null,
    visibility: (o.visibility ?? { kind: "all" }) as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: receipts of both paths, read as JSON
const draft = (params: unknown, o: Parameters<typeof ctx>[0] = {}): Promise<any> =>
  schemaDraft(s.store, ctx(o), params);
async function refused(params: unknown, o: Parameters<typeof ctx>[0] = {}) {
  const before = await tail();
  try {
    await draft(params, o);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    // A refusal logs nothing.
    expect(await tail()).toBe(before);
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);
const rows = async (sql: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(sql, params as never))).rows as Record<string, unknown>[];
const versions = async () =>
  (await rows("SELECT sv, state, draft_id FROM schema_versions ORDER BY sv")).map((r) => [
    Number(r["sv"]),
    r["state"],
    r["draft_id"],
  ]);

beforeAll(async () => {
  s = await openReusable("saveslot-schema-draft-change-");
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
  await draft({ document: structuredClone(DOCUMENT) });
}, T);

describe("a draft that waits for confirmation", () => {
  it(
    "is a schema_change item: the receipt, the version it takes, the slot unchanged",
    async () => {
      const r = await draft({ document: rename("memo") });
      expect(r).toMatchObject({
        slot: "ledger",
        target_sv: 2,
        outcome: "pending",
        impact: { rows_affected: 0, derived_changed: [] },
        changes: [
          {
            target: { table: "expenses", field: "memo" },
            change: "rename_field",
            class: "metadata",
            compatible_with_old_writes: true,
            destructive: false,
            // Nobody-else-uses-it is not computed: a rename always waits.
            auto: false,
          },
        ],
      });
      // Usage is not computed: no `consumers` rather than an empty list.
      expect(r.impact).not.toHaveProperty("consumers");
      expect(r).not.toHaveProperty("sv");
      expect(r.item.id).toMatch(/^pi_/);
      expect(r.item.item_ver).toEqual(expect.any(String));
      // The document is on the version the slot is at: changed and submitted as it is.
      expect(r.document).toMatchObject({ base_version: 1 });

      expect(await versions()).toEqual([
        [1, "current", expect.stringMatching(/^d_/)],
        [2, "pending", r.draft],
      ]);
      expect(
        await rows("SELECT type, state, target_table FROM pending_items WHERE id = $1", [
          r.item.id,
        ]),
      ).toEqual([{ type: "schema_change", state: "open", target_table: null }]);
      // The slot is still at version 1.
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 1 }]);
      // The operation's events, in the order of 09 §4.5.
      const op = await rows(
        "SELECT type FROM events WHERE op = (SELECT max(op) FROM events) ORDER BY seq",
      );
      expect(op.map((x) => x["type"])).toEqual([
        "schema.draft_submitted",
        "schema.compiled",
        "item.created",
      ]);
    },
    T,
  );

  it(
    "is superseded by a newer draft: the item closes, its number stays taken, the next one skips",
    async () => {
      const first = await draft({ document: rename("memo") });
      const second = await draft({ document: rename("remark") });
      expect(second).toMatchObject({ target_sv: 3, superseded_draft: first.draft });
      expect(await versions()).toEqual([
        [1, "current", expect.any(String)],
        [2, "superseded", first.draft],
        [3, "pending", second.draft],
      ]);
      expect(await rows("SELECT id, state FROM pending_items ORDER BY state")).toEqual([
        { id: second.item.id, state: "open" },
        { id: first.item.id, state: "superseded" },
      ]);
      const op = await rows(
        "SELECT seq, type FROM events WHERE op = (SELECT max(op) FROM events) ORDER BY seq",
      );
      expect(op.map((x) => x["type"])).toEqual([
        "schema.draft_submitted",
        "schema.superseded",
        "item.superseded",
        "schema.compiled",
        "item.created",
      ]);
      // The item.superseded names the schema.superseded beside it.
      const by = await rows(
        `SELECT c.body FROM content c JOIN events e ON e.seq = c.seq
         WHERE e.type = 'item.superseded' AND c.path = 'target'`,
      );
      expect(JSON.parse(by[0]?.["body"] as string)).toEqual({
        item: first.item.id,
        reason: "draft_replaced",
        by_event: Number(op[1]?.["seq"]),
      });
    },
    T,
  );

  it(
    "K6: a version number's compiled definition, once logged, never changes",
    async () => {
      const first = await draft({ document: rename("memo") });
      const compiledOf = async (sv: number) =>
        (
          await rows(
            `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
             WHERE v.sv = $1`,
            [sv],
          )
        )[0]?.["body"];
      const v2 = await compiledOf(2);
      await draft({ document: rename("remark") });
      await draft({ document: rename("text") });
      expect(await compiledOf(2)).toBe(v2);
      expect(JSON.parse(v2 as string)).toMatchObject({ sv: 2 });
      expect(await versions()).toEqual([
        [1, "current", expect.any(String)],
        [2, "superseded", first.draft],
        [3, "superseded", expect.any(String)],
        [4, "pending", expect.any(String)],
      ]);
    },
    T,
  );

  it(
    "checks aliases against the names still resolvable, the current version's included",
    async () => {
      const d = change((t) => {
        Object.assign(t.fields[1] as object, { id: "f2", name: "memo", aliases: ["note"] });
      });
      expect(await refused({ document: d })).toMatchObject({
        code: "validation_failed",
        details: [{ path: "tables/0/fields/1/aliases/0", code: "alias_invalid", reason: "name" }],
      });
    },
    T,
  );

  it(
    "takes the receipt's document back, changed once more: it supersedes the draft it came from",
    async () => {
      const first = await draft({ document: rename("memo") });
      const again = structuredClone(first.document);
      again.tables[0].description = "every expense";
      const second = await draft({ document: again });
      expect(second).toMatchObject({ target_sv: 3, superseded_draft: first.draft });
      expect(second.changes.map((c: { change: string }) => c.change)).toEqual([
        "change_description",
        "rename_field",
      ]);
    },
    T,
  );

  it(
    "a draft the same as the one awaiting confirmation supersedes it with a new number",
    async () => {
      const first = await draft({ document: rename("memo"), task: "a" });
      const second = await draft({ document: rename("memo"), task: "b" });
      expect(second).toMatchObject({ target_sv: 3, superseded_draft: first.draft });
    },
    T,
  );

  it(
    "replays: the same request gives the first receipt and logs nothing",
    async () => {
      const r = await draft({ document: rename("memo"), idempotency_key: "k1" });
      const at = await tail();
      const again = await draft({ document: rename("memo"), idempotency_key: "k1" });
      expect(again).toEqual({ ...r, replayed: true });
      expect(await tail()).toBe(at);
    },
    T,
  );

  it(
    "is rebuilt as it was: the log replayed into an empty storage gives the same state",
    async () => {
      await draft({ document: rename("memo") });
      await draft({ document: rename("remark") });
      const replica = await openReusable("saveslot-schema-draft-change-replica-");
      try {
        const last = (await tail()) as number;
        const events = await rows("SELECT * FROM events ORDER BY seq");
        const content = await rows("SELECT * FROM content ORDER BY seq, path");
        await replica.store.write(async (tx) => {
          const insert = async (table: string, all: readonly Record<string, unknown>[]) => {
            for (const e of all) {
              const cols = Object.keys(e);
              await tx.query(
                `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
                Object.values(e) as never,
              );
            }
          };
          await insert("events", events);
          await insert("content", content);
          await applyEvents(tx, await readEvents(tx, 1, last));
        });
        const kept = new Set(
          KERNEL_TABLES.filter((t) => t.class !== "materialized").map((t) => t.name),
        );
        const state = async (store: typeof s.store) => {
          const all = await store.read(snapshot);
          return Object.fromEntries(Object.entries(all).filter(([name]) => !kept.has(name)));
        };
        expect(await state(replica.store)).toEqual(await state(s.store));
      } finally {
        await replica.close();
      }
    },
    T,
  );
});

describe("refused, nothing logged", () => {
  it(
    "a draft that changes nothing: invalid_argument no_change",
    async () => {
      expect(await refused({ document: change(() => {}) })).toMatchObject({
        code: "invalid_argument",
        reason: "no_change",
        param: "document",
      });
    },
    T,
  );

  it(
    "base_version not the current version: draft_outdated",
    async () => {
      expect(await refused({ document: change((t) => (t.description = "x"), 2) })).toMatchObject({
        code: "draft_outdated",
        reason: "base_version",
      });
    },
    T,
  );

  it(
    "a field neither matched nor dropped: field_unmatched with the fields",
    async () => {
      expect(await refused({ document: change((t) => t.fields.pop()) })).toMatchObject({
        code: "field_unmatched",
        fields: [{ table: "expenses", id: "f2", name: "note" }],
      });
    },
    T,
  );

  it(
    "a slot out of range or unknown: not_found; a slot only partly in range: insufficient_scope",
    async () => {
      const id = (await rows("SELECT id FROM slots"))[0]?.["id"] as string;
      expect(
        await refused({ document: rename("memo") }, { visibility: { kind: "scoped", slots: [] } }),
      ).toMatchObject({ code: "not_found", reason: "slot" });
      expect(await refused({ document: { ...rename("memo"), slot: "nope" } })).toMatchObject({
        code: "not_found",
        reason: "slot",
      });
      expect(
        await refused(
          { document: rename("memo") },
          { visibility: { kind: "scoped", slots: [{ slot: id, tables: [] }] } },
        ),
      ).toMatchObject({ code: "insufficient_scope" });
    },
    T,
  );

  it(
    "a slot that is not a name: invalid_argument at slot",
    async () => {
      expect(await refused({ document: { ...rename("memo"), slot: 3 } })).toEqual({
        code: "invalid_argument",
        reason: "malformed",
        param: "slot",
      });
    },
    T,
  );

  it(
    "a migration running: draft_outdated migrating",
    async () => {
      const id = (await rows("SELECT id FROM slots"))[0]?.["id"] as string;
      await s.store.write((tx) =>
        tx.query(
          `INSERT INTO migrations (id, slot_id, draft_id, from_sv, target_sv, state)
           VALUES ('m_1', $1, 'd_1', 1, 2, 'building')`,
          [id],
        ),
      );
      expect(await refused({ document: rename("memo") })).toEqual({
        code: "draft_outdated",
        reason: "migrating",
        current_sv: 1,
        migration: { target_sv: 2, state: "building" },
      });
      // The form of base_version comes first, then a draft written on another version.
      expect(await refused({ document: { ...rename("memo"), base_version: "abc" } })).toEqual({
        code: "invalid_argument",
        reason: "malformed",
        param: "base_version",
      });
      expect(await refused({ document: change((t) => (t.description = "x"), 2) })).toEqual({
        code: "draft_outdated",
        reason: "base_version",
        current_sv: 1,
      });
    },
    T,
  );

  it(
    "a draft whose changes all apply at once is not made in this version",
    async () => {
      expect(
        await refused({ document: change((t) => (t.description = "every expense")) }),
      ).toMatchObject({ code: "internal", reason: "not_implemented" });
    },
    T,
  );
});
