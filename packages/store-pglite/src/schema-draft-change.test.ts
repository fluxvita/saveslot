// `schema_draft` changing an existing slot through the ops entry (04-contract §10 `schema_draft`;
// 09-event-format §4.5, §5.5, §5.8): the draft left pending as a `schema_change` item, a newer
// draft superseding it, version numbers never used twice, the refusals, idempotent replays, and
// the log replayed into an empty storage giving the same state. Fictional names.

import {
  applyEvents,
  catalog,
  createOpsContext,
  createTenant,
  KERNEL_TABLES,
  query,
  readEvents,
  readTail,
  schemaDraft,
  write,
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
      expect(r).toEqual({
        draft: expect.stringMatching(/^d_/),
        slot: "ledger",
        slot_id: expect.stringMatching(/^sl_/),
        target_sv: 2,
        // On the version the slot is at, as submitted, IDs filled in.
        document: {
          slot: "ledger",
          base_version: 1,
          timezone: "Asia/Shanghai",
          tables: [
            {
              id: "t1",
              name: "expenses",
              kind: "base",
              description: "one row per expense",
              time: { type: "event", field: "date" },
              fields: [
                { id: "f1", name: "date", type: "date", required: true, description: "the day" },
                { id: "f2", name: "memo", type: "text", description: "what for" },
              ],
            },
          ],
        },
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
        impact: { rows_affected: 0, derived_changed: [] },
        outcome: "pending",
        item: { id: expect.stringMatching(/^pi_/), item_ver: expect.stringMatching(/^iv_/) },
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
      const expense = (sv: number, date: string) =>
        write(s.store, ctx(), {
          sv,
          ops: [{ intent: "insert", table: "expenses", set: { date } }],
        });
      await expense(1, "2026-11-01");
      await draft({ document: rename("memo") });
      await draft({ document: rename("remark") });
      const switched = change((t) => (t.description = "every expense"));
      switched.tables.push({
        name: "budgets",
        kind: "base",
        description: "a budget",
        time: { type: "none" },
        fields: [{ name: "label", type: "text", description: "what for" }],
      } as never);
      await draft({ document: switched });
      // Writes in the version switched to, and in the earlier one.
      await expense(4, "2026-11-02");
      await expense(1, "2026-11-03");
      await write(s.store, ctx(), {
        sv: 4,
        ops: [{ intent: "insert", table: "budgets", set: { label: "food" } }],
      });
      await replayed(async (replica) => {
        const kept = new Set(
          KERNEL_TABLES.filter((t) => t.class !== "materialized").map((t) => t.name),
        );
        const state = async (store: typeof s.store) => {
          const all = await store.read(snapshot);
          return Object.fromEntries(Object.entries(all).filter(([name]) => !kept.has(name)));
        };
        expect(await state(replica.store)).toEqual(await state(s.store));
        // And as it should be, not only as the live storage has it.
        const at = async (sql: string) =>
          (await replica.store.read((tx) => tx.query(sql))).rows as Record<string, unknown>[];
        expect(await at("SELECT sv, state FROM schema_versions ORDER BY sv")).toEqual([
          { sv: 1, state: "retired" },
          { sv: 2, state: "superseded" },
          { sv: 3, state: "superseded" },
          { sv: 4, state: "current" },
        ]);
        const cat = await at("SELECT table_id, sv, structure FROM catalog ORDER BY sv, table_id");
        expect(cat.map((x) => [x["table_id"], x["sv"]])).toEqual([
          ["t1", 1],
          ["t1", 4],
          ["t2", 4],
        ]);
        expect(JSON.parse(cat[1]?.["structure"] as string)).toMatchObject({
          id: "t1",
          description: "every expense",
          fields: [{ name: "date" }, { name: "note" }],
        });
        expect(JSON.parse(cat[2]?.["structure"] as string)).toMatchObject({
          id: "t2",
          name: "budgets",
        });
        expect(await at("SELECT table_id, row_count FROM counts ORDER BY table_id")).toEqual([
          { table_id: "t1", row_count: 3 },
          { table_id: "t2", row_count: 1 },
        ]);
        expect(await at("SELECT current_sv FROM slots")).toEqual([{ current_sv: 4 }]);
      });
    },
    T,
  );

  it(
    "a switch to a version given up stops the replay: the log edited",
    async () => {
      const pending = await draft({ document: rename("memo") });
      await draft({ document: change((t) => (t.description = "every expense")) });
      // The switch names the superseded draft and its number, whose compiled definition is in
      // the log: everything but the version row's state agrees.
      const error = await replayed(
        async () => undefined,
        (events, content) => {
          // The last switch: the first is the slot's creation.
          const sw = events.findLast((e) => e["type"] === "schema.switched") as Record<
            string,
            unknown
          >;
          const target = content.find(
            (c) => c["seq"] === sw["seq"] && c["path"] === "target",
          ) as Record<string, unknown>;
          target["body"] = JSON.stringify({
            ...JSON.parse(target["body"] as string),
            draft_id: pending.draft,
            to_version: 2,
          });
        },
      );
      expect(error).toMatchObject({ reason: "inconsistent" });
      expect(String((error as Error).message)).toContain(
        `version 2 of ${pending.slot_id} is not the pending draft ${pending.draft}`,
      );
    },
    T,
  );
});

/**
 * The log copied into an empty storage, edited by `edit` first, and applied; `check` then reads
 * the replica. Gives what stopped the apply, if anything.
 */
async function replayed(
  check: (replica: ReusableStore) => Promise<void>,
  edit?: (events: Record<string, unknown>[], content: Record<string, unknown>[]) => void,
): Promise<unknown> {
  const replica = await openReusable("saveslot-schema-draft-change-replica-");
  try {
    const last = (await tail()) as number;
    const events = await rows("SELECT * FROM events ORDER BY seq");
    const content = await rows("SELECT * FROM content ORDER BY seq, path");
    edit?.(events, content);
    let stopped: unknown;
    try {
      await replica.store.write(async (tx) => {
        const insert = async (table: string, all: readonly Record<string, unknown>[]) => {
          for (const e of all) {
            const cols = Object.keys(e);
            const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
            await tx.query(
              `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${marks})`,
              Object.values(e) as never,
            );
          }
        };
        await insert("events", events);
        await insert("content", content);
        await applyEvents(tx, await readEvents(tx, 1, last));
      });
    } catch (e) {
      stopped = e;
    }
    if (stopped === undefined) await check(replica);
    else if (edit === undefined) throw stopped;
    return stopped;
  } finally {
    await replica.close();
  }
}

describe("a draft whose every change is automatic", () => {
  it(
    "switches at once: confirmed, switched, the earlier version retired, reads use the new one",
    async () => {
      const r = await draft({ document: change((t) => (t.description = "every expense")) });
      expect(r).toEqual({
        draft: expect.stringMatching(/^d_/),
        slot: "ledger",
        slot_id: expect.stringMatching(/^sl_/),
        target_sv: 2,
        document: {
          slot: "ledger",
          base_version: 1,
          timezone: "Asia/Shanghai",
          tables: [
            {
              id: "t1",
              name: "expenses",
              kind: "base",
              description: "every expense",
              time: { type: "event", field: "date" },
              fields: [
                { id: "f1", name: "date", type: "date", required: true, description: "the day" },
                { id: "f2", name: "note", type: "text", description: "what for" },
              ],
            },
          ],
        },
        changes: [
          {
            target: { table: "expenses" },
            change: "change_description",
            class: "metadata",
            compatible_with_old_writes: true,
            destructive: false,
            auto: true,
          },
        ],
        impact: { rows_affected: 0, derived_changed: [] },
        outcome: "applied",
        sv: 2,
      });
      const op = await rows(
        "SELECT type FROM events WHERE op = (SELECT max(op) FROM events) ORDER BY seq",
      );
      expect(op.map((x) => x["type"])).toEqual([
        "schema.draft_submitted",
        "schema.compiled",
        "schema.confirmed",
        "schema.switched",
      ]);
      expect(await versions()).toEqual([
        [1, "retired", expect.any(String)],
        [2, "current", r.draft],
      ]);
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 2 }]);
      const cat = await rows("SELECT table_id, sv, structure FROM catalog ORDER BY sv, table_id");
      expect(cat.map((x) => [x["table_id"], x["sv"]])).toEqual([
        ["t1", 1],
        ["t1", 2],
      ]);
      // What the switch wrote is the new version's definition: version 1's with the new
      // description, without the physical tables.
      const [v1, v2] = cat.map((x) => JSON.parse(x["structure"] as string));
      expect(v1).toMatchObject({ id: "t1", name: "expenses", description: "one row per expense" });
      expect(v1).not.toHaveProperty("physical");
      expect(v2).toEqual({ ...v1, description: "every expense" });
      // The physical table is the one version 1 built; writes and reads go on in it.
      const w = await write(s.store, ctx(), {
        sv: 2,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "tea" } }],
      });
      expect(w).toMatchObject({ status: "saved", sv: 2 });
      const q = await query(s.store, ctx(), { table: "expenses" });
      expect(q).toMatchObject({ sv: 2 });
      expect(q.rows.map((x) => x.values)).toEqual([{ date: "2026-11-02", note: "tea" }]);
      const c = (await catalog(s.store, ctx(), {})) as unknown as {
        slots: { slot: string; sv: number }[];
      };
      expect(c.slots.map((x) => [x.slot, x.sv])).toEqual([["ledger", 2]]);
    },
    T,
  );

  it(
    "adds a table: built in the switch, written and read at once",
    async () => {
      const d = change(() => {});
      d.tables.push({
        name: "budgets",
        kind: "base",
        description: "a budget",
        time: { type: "none" },
        fields: [{ name: "label", type: "text", description: "what for" }],
      } as never);
      const r = await draft({ document: d });
      expect(r).toMatchObject({ outcome: "applied", sv: 2 });
      expect(r.changes.map((c: { change: string }) => c.change)).toEqual(["add_table"]);
      await write(s.store, ctx(), {
        sv: 2,
        ops: [{ intent: "insert", table: "budgets", set: { label: "food" } }],
      });
      const q = await query(s.store, ctx(), { table: "budgets" });
      expect(q.rows.map((x) => x.values)).toEqual([{ label: "food" }]);
      // Version 1 has no such table: named in it, the name is not there (07 «旧版写入»).
      await expect(
        write(s.store, ctx(), {
          sv: 1,
          ops: [{ intent: "insert", table: "budgets", set: { label: "rent" } }],
        }),
      ).rejects.toMatchObject({
        code: "unknown_table",
        detail: { param: "ops/0/table", name: "budgets" },
      });
      // Its other table, in version 1 as well, takes the write.
      expect(
        await write(s.store, ctx(), {
          sv: 1,
          ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-03" } }],
        }),
      ).toMatchObject({ status: "saved" });
    },
    T,
  );

  it(
    "supersedes a draft awaiting confirmation, and takes the next number",
    async () => {
      const pending = await draft({ document: rename("memo") });
      const r = await draft({ document: change((t) => (t.description = "every expense")) });
      expect(r).toMatchObject({ outcome: "applied", sv: 3, superseded_draft: pending.draft });
      expect(await versions()).toEqual([
        [1, "retired", expect.any(String)],
        [2, "superseded", pending.draft],
        [3, "current", r.draft],
      ]);
      expect(await rows("SELECT state FROM pending_items")).toEqual([{ state: "superseded" }]);
      // A write may carry 1 (retired) or 3 (current), not 2: a number no version had in effect.
      const writeAt = (sv: number) =>
        write(s.store, ctx(), {
          sv,
          ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02" } }],
        });
      await expect(writeAt(2)).rejects.toMatchObject({
        code: "invalid_argument",
        detail: { reason: "malformed", param: "sv" },
      });
      expect(await writeAt(1)).toMatchObject({ status: "saved" });
      // A draft on the version switched from is outdated now (another task: not a replay).
      expect(await refused({ document: rename("memo") }, { task: "later" })).toEqual({
        code: "draft_outdated",
        reason: "base_version",
        current_sv: 3,
      });
    },
    T,
  );

  it(
    "replays: the same request gives the first receipt",
    async () => {
      const d = {
        document: change((t) => (t.description = "every expense")),
        idempotency_key: "k",
      };
      const r = await draft(d);
      expect(await draft(d)).toEqual({ ...r, replayed: true });
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
    "a type changed, a migrate: not_in_this_version at the key, named in the message",
    async () => {
      expect(
        await refused({
          document: change((t) => ((t.fields[1] as { type: string }).type = "integer")),
        }),
      ).toEqual({
        code: "not_in_this_version",
        reason: "parameter",
        param: "tables/0/fields/1/type",
      });
      expect(
        await refused({
          document: change((t) =>
            Object.assign(t.fields[1] as object, { migrate: { sql: "note" } }),
          ),
        }),
      ).toEqual({
        code: "not_in_this_version",
        reason: "parameter",
        param: "tables/0/fields/1/migrate",
      });
      await expect(
        draft({ document: change((t) => ((t.fields[1] as { type: string }).type = "integer")) }),
      ).rejects.toThrow("change_type is not in this version");
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
});
