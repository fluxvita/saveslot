// `resolve` of a `schema_change` item (04-contract §10 `resolve`; 09-event-format §4.5, §5.5,
// §5.8, §5.10): a draft confirmed switches the slot, one rejected gives its number up; repeats,
// closed items, a version read before, the visible range; a slot renamed, its old name not
// resolved; a table dropped, the declarations on it changed; the log replayed into an empty
// storage giving the same state. Fictional names.

import {
  applyEvents,
  catalog,
  createOpsContext,
  createTenant,
  history,
  KERNEL_TABLES,
  pending,
  query,
  readEvents,
  readTail,
  removeSlot,
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NO_ITEM = `pi_${"7".repeat(16)}`;

const EXPENSES = {
  name: "expenses",
  kind: "base",
  description: "one row per expense",
  time: { type: "event", field: "date" },
  fields: [
    { name: "date", type: "date", required: true, description: "the day" },
    { name: "note", type: "text", description: "what for" },
  ],
};
const SETTINGS = {
  name: "settings",
  kind: "base",
  description: "one row per setting",
  time: { type: "none" },
  fields: [{ name: "key", type: "text", required: true, description: "the setting" }],
};
const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [EXPENSES, SETTINGS],
};

/** A draft on version `base` listing the expenses table with `note` renamed: it waits. */
const rename = (name: string, base = 1) => ({
  slot: "ledger",
  base_version: base,
  timezone: "Asia/Shanghai",
  tables: [
    {
      ...EXPENSES,
      id: "t1",
      fields: [
        { ...EXPENSES.fields[0], id: "f1" },
        { ...EXPENSES.fields[1], id: "f2", name },
      ],
    },
  ],
});

let s: ReusableStore;
let slotId: string;
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
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
const draft = (document: unknown, o: Parameters<typeof ctx>[0] = {}): Promise<Any> =>
  schemaDraft(s.store, ctx(o), { document });
const decide = (params: unknown, o: Parameters<typeof ctx>[0] = {}): Promise<Any> =>
  resolve(s.store, ctx(o), params);
/** The answer of `f`: its result, or its refusal (code, message, details), whole. */
async function answer(f: () => Promise<unknown>): Promise<Any> {
  try {
    return await f();
  } catch (e) {
    const x = e as { code?: string; message: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, message: x.message, ...(x.detail ?? {}) };
  }
}
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);
const rows = async (sql: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(sql, params as never))).rows as Record<string, unknown>[];
const versions = async () =>
  (
    await rows("SELECT sv, state FROM schema_versions WHERE slot_id = $1 ORDER BY sv", [slotId])
  ).map((r) => [Number(r["sv"]), r["state"]]);
const lastOp = async () =>
  (await rows("SELECT type FROM events WHERE op = (SELECT max(op) FROM events) ORDER BY seq")).map(
    (x) => x["type"],
  );

beforeAll(async () => {
  s = await openReusable("saveslot-schema-resolve-");
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

describe("confirm", () => {
  it(
    "switches the slot to the draft's version: the receipt, the events, the versions, reads and writes",
    async () => {
      const d = await draft(rename("memo"));
      const r = await decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver });
      expect(r).toEqual({
        id: d.item.id,
        type: "schema_change",
        decision: "confirm",
        item_ver: expect.stringMatching(/^iv_/),
        status: "resolved",
        schema: { switched: true, sv: 2 },
      });
      expect(await lastOp()).toEqual(["item.resolved", "schema.confirmed", "schema.switched"]);
      expect(await versions()).toEqual([
        [1, "retired"],
        [2, "current"],
      ]);
      expect(
        await rows("SELECT state, decision FROM pending_items WHERE id = $1", [d.item.id]),
      ).toEqual([{ state: "resolved", decision: "confirm" }]);
      // The new name is read and written in version 2.
      await write(s.store, ctx(), {
        sv: 2,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", memo: "tea" } }],
      });
      const q = await query(s.store, ctx(), { table: "expenses" });
      expect(q).toMatchObject({ sv: 2 });
      expect(q.rows.map((x) => x.values)).toEqual([{ date: "2026-11-02", memo: "tea" }]);
      // The item's detail: resolved, no decision left.
      expect(await pending(s.store, ctx(), { id: d.item.id })).toMatchObject({
        status: "resolved",
        decisions: [],
        resolution: { decision: "confirm" },
      });
    },
    T,
  );

  it(
    "with a note: the request is an api_call source, the decision's op_sources",
    async () => {
      const d = await draft(rename("memo"));
      await decide({
        id: d.item.id,
        decision: "confirm",
        item_ver: d.item.item_ver,
        note: "the user agreed",
      });
      expect(await lastOp()).toEqual([
        "item.resolved",
        "source.recorded",
        "schema.confirmed",
        "schema.switched",
      ]);
      const [head] = await rows(
        `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'op_sources'
         WHERE e.type = 'item.resolved'`,
      );
      const source = await rows("SELECT seq FROM events WHERE type = 'source.recorded'");
      expect(JSON.parse(head?.["body"] as string)).toEqual([Number(source[0]?.["seq"])]);
    },
    T,
  );
});

describe("reject", () => {
  it(
    "gives the draft's number up: the slot stays, the next draft skips it",
    async () => {
      const d = await draft(rename("memo"));
      const r = await decide({ id: d.item.id, decision: "reject", item_ver: d.item.item_ver });
      expect(r).toEqual({
        id: d.item.id,
        type: "schema_change",
        decision: "reject",
        item_ver: expect.stringMatching(/^iv_/),
        status: "resolved",
        schema: { switched: false },
      });
      expect(await lastOp()).toEqual(["item.resolved", "schema.rejected"]);
      expect(await versions()).toEqual([
        [1, "current"],
        [2, "rejected"],
      ]);
      const next = await draft(rename("remark"));
      expect(next).toMatchObject({ target_sv: 3 });
    },
    T,
  );
});

describe("the item and the request", () => {
  it(
    "a repeat gives the first result; another decision after it is item_closed, nothing logged",
    async () => {
      const d = await draft(rename("memo"));
      const p = { id: d.item.id, decision: "confirm", item_ver: d.item.item_ver };
      const first = await decide(p);
      const at = await tail();
      expect(await decide(p)).toEqual({ ...first, replayed: true });
      expect(
        await answer(() => decide({ ...p, decision: "reject", task: "another" })),
      ).toMatchObject({ code: "item_closed", reason: "resolved" });
      expect(await tail()).toBe(at);
    },
    T,
  );

  it(
    "a draft superseded by an automatic one: its item is closed, confirming it is item_closed",
    async () => {
      const d = await draft(rename("memo"));
      const auto = {
        ...rename("note"),
        tables: [{ ...rename("note").tables[0], description: "every expense" }],
      };
      expect(await draft(auto)).toMatchObject({ outcome: "applied", sv: 3 });
      const at = await tail();
      expect(
        await answer(() =>
          decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver }),
        ),
      ).toMatchObject({
        code: "item_closed",
        reason: "superseded",
        superseded: { reason: "draft_replaced" },
      });
      expect(await tail()).toBe(at);
    },
    T,
  );

  it(
    "a version not the item's: confirmation_mismatch with the item's detail now",
    async () => {
      const d = await draft(rename("memo"));
      const stale = `${d.item.item_ver.split(".")[0]}.1.0`;
      const e = await answer(() => decide({ id: d.item.id, decision: "confirm", item_ver: stale }));
      expect(e).toMatchObject({
        code: "confirmation_mismatch",
        reason: "changed",
        current: { id: d.item.id, type: "schema_change", draft: d.draft, target_sv: 2 },
      });
    },
    T,
  );

  it(
    "a decision the item does not take is refused, nothing logged",
    async () => {
      const d = await draft(rename("memo"));
      const at = await tail();
      expect(
        await answer(() =>
          decide({ id: d.item.id, decision: "keep_effective", item_ver: d.item.item_ver }),
        ),
      ).toMatchObject({ code: "invalid_argument", reason: "malformed", param: "decision" });
      expect(await tail()).toBe(at);
    },
    T,
  );

  it(
    "evidence: each segment a source, then the note's api_call, all the decision's op_sources",
    async () => {
      const d = await draft(rename("memo"));
      await decide({
        id: d.item.id,
        decision: "reject",
        item_ver: d.item.item_ver,
        evidence: [{ kind: "user_message", text: "keep the old name" }],
        note: "the user said no",
      });
      expect(await lastOp()).toEqual([
        "item.resolved",
        "source.recorded",
        "source.recorded",
        "schema.rejected",
      ]);
      const sources = await rows(
        `SELECT e.seq, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
         WHERE e.type = 'source.recorded' ORDER BY e.seq`,
      );
      expect(sources.map((x) => JSON.parse(x["body"] as string).kind)).toEqual([
        "user_message",
        "api_call",
      ]);
      const [head] = await rows(
        `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'op_sources'
         WHERE e.type = 'item.resolved'`,
      );
      expect(JSON.parse(head?.["body"] as string)).toEqual(sources.map((x) => Number(x["seq"])));
    },
    T,
  );

  it(
    "with part of the slot in range: not_found, byte for byte as an item not there",
    async () => {
      const d = await draft(rename("memo"));
      const o = {
        visibility: { kind: "scoped", slots: [{ slot: slotId, tables: [{ table: "t1" }] }] },
      };
      const seen = await answer(() => decide({ id: d.item.id, decision: "confirm" }, o));
      expect(seen).toEqual(await answer(() => decide({ id: NO_ITEM, decision: "confirm" }, o)));
      expect(seen).toMatchObject({ code: "not_found", reason: "item" });
    },
    T,
  );
});

describe("a slot renamed to a name taken while its draft waited (07 «确认时重新判断»)", () => {
  const renameTo = (from: string, to: string) => ({
    slot: from,
    base_version: 1,
    timezone: "Asia/Shanghai",
    rename_to: to,
    tables: [],
  });

  it(
    "a slot created with the name meanwhile: draft_outdated (name_taken), nothing logged, the item open",
    async () => {
      const d = await draft(renameTo("ledger", "budget"));
      expect(d).toMatchObject({ outcome: "pending" });
      // A draft waiting holds no name: another slot may take it.
      await draft({ ...structuredClone(DOCUMENT), slot: "Budget" }, { task: "new" });
      const before = await tail();
      expect(
        await answer(() =>
          decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver }),
        ),
      ).toEqual({
        code: "draft_outdated",
        message: "another slot is named budget now",
        reason: "name_taken",
        current_sv: 1,
      });
      expect(await tail()).toBe(before);
      expect(await rows("SELECT state FROM pending_items WHERE id = $1", [d.item.id])).toEqual([
        { state: "open" },
      ]);
      expect(await rows("SELECT name FROM slots ORDER BY name")).toEqual([
        { name: "Budget" },
        { name: "ledger" },
      ]);
      // Rejecting it still works.
      expect(
        await decide({ id: d.item.id, decision: "reject", item_ver: d.item.item_ver }),
      ).toMatchObject({ status: "resolved", decision: "reject" });
    },
    T,
  );

  it(
    "two slots' drafts renaming to one name: the first confirmed takes it, the second is refused",
    async () => {
      await draft({ ...structuredClone(DOCUMENT), slot: "books" }, { task: "books" });
      const a = await draft(renameTo("ledger", "shared"));
      const b = await draft(renameTo("books", "shared"), { task: "books" });
      expect([a.outcome, b.outcome]).toEqual(["pending", "pending"]);
      await decide({ id: a.item.id, decision: "confirm", item_ver: a.item.item_ver });
      expect(
        await answer(() =>
          decide({ id: b.item.id, decision: "confirm", item_ver: b.item.item_ver }),
        ),
      ).toMatchObject({ code: "draft_outdated", reason: "name_taken" });
      expect(await rows("SELECT name FROM slots ORDER BY name")).toEqual([
        { name: "books" },
        { name: "shared" },
      ]);
    },
    T,
  );
});

describe("a slot renamed", () => {
  it(
    "the receipt's slot is the name in the version switched to: a repeat after a later rename gives it again",
    async () => {
      const renameTo = (from: string, to: string, base: number) => ({
        slot: from,
        base_version: base,
        timezone: "Asia/Shanghai",
        rename_to: to,
        tables: [],
      });
      const first = await draft(renameTo("ledger", "budget", 1));
      const decision = { id: first.item.id, decision: "confirm", item_ver: first.item.item_ver };
      expect((await decide(decision)).schema).toEqual({ switched: true, sv: 2, slot: "budget" });
      const second = await draft(renameTo("budget", "cash", 2));
      expect(
        (await decide({ id: second.item.id, decision: "confirm", item_ver: second.item.item_ver }))
          .schema,
      ).toEqual({ switched: true, sv: 3, slot: "cash" });
      // The first decision sent again: its own receipt, the name it switched to.
      expect(await decide(decision)).toMatchObject({
        replayed: true,
        schema: { switched: true, sv: 2, slot: "budget" },
      });
      // A switch without a rename gives no slot.
      const described = await draft({
        slot: "cash",
        base_version: 3,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...EXPENSES,
            id: "t1",
            fields: [
              { ...EXPENSES.fields[0], id: "f1" },
              { ...EXPENSES.fields[1], id: "f2", name: "memo" },
            ],
          },
        ],
      });
      expect(
        (
          await decide({
            id: described.item.id,
            decision: "confirm",
            item_ver: described.item.item_ver,
          })
        ).schema,
      ).toEqual({ switched: true, sv: 4 });
    },
    T,
  );

  it(
    "takes the new name; the old one is not resolved, and a new slot may take it",
    async () => {
      const d = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        rename_to: "budget",
        tables: [],
      });
      expect(d.changes).toEqual([
        expect.objectContaining({ target: { slot: true, name: "budget" }, change: "rename_slot" }),
      ]);
      // The item's detail says it too.
      expect(await pending(s.store, ctx(), { id: d.item.id })).toMatchObject({
        changes: [{ target: { slot: true, name: "budget" }, change: "rename_slot" }],
      });
      const confirmed = await decide({
        id: d.item.id,
        decision: "confirm",
        item_ver: d.item.item_ver,
      });
      expect(confirmed.schema).toEqual({ switched: true, sv: 2, slot: "budget" });
      expect(await rows("SELECT name FROM slots WHERE id = $1", [slotId])).toEqual([
        { name: "budget" },
      ]);
      // The old name, qualified: as a name not there.
      expect(await answer(() => query(s.store, ctx(), { table: "ledger.expenses" }))).toMatchObject(
        {
          code: "unknown_table",
        },
      );
      expect(
        await answer(() =>
          write(s.store, ctx(), {
            sv: 2,
            ops: [{ intent: "insert", table: "ledger.expenses", set: { date: "2026-11-02" } }],
          }),
        ),
      ).toMatchObject({ code: "unknown_table" });
      expect(await answer(() => catalog(s.store, ctx(), { slot: "ledger" }))).toMatchObject({
        code: "not_found",
        reason: "slot",
      });
      expect(await query(s.store, ctx(), { table: "budget.expenses" })).toMatchObject({ sv: 2 });
      // A new slot named as the old one: its own, nothing shared.
      // Another task: the same document as the first one, not a repeat of it.
      const other = await draft({ ...structuredClone(DOCUMENT), slot: "ledger" }, { task: "new" });
      expect(other.slot_id).not.toBe(slotId);
      await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "ledger.expenses", set: { date: "2026-11-03" } }],
      });
      expect((await query(s.store, ctx(), { table: "budget.expenses" })).rows).toEqual([]);
      expect((await query(s.store, ctx(), { table: "ledger.expenses" })).rows).toHaveLength(1);
    },
    T,
  );
});

describe("a table dropped", () => {
  it(
    "the declarations still current on its rows change (schema_switched); others stay",
    async () => {
      const setting = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "settings", set: { key: "currency" } }],
      });
      const target = setting.ops[0] as Any;
      const declared = await write(s.store, ctx(), {
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "expenses",
            set: { date: "2026-11-02" },
            premises: [{ table: "settings", row: target.target.row, ver: target.ver }],
          },
        ],
      });
      const d = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        drop_tables: ["settings"],
        tables: [],
      });
      expect(d.changes).toEqual([expect.objectContaining({ change: "drop_table" })]);
      await decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver });
      expect(await lastOp()).toEqual([
        "item.resolved",
        "schema.confirmed",
        "schema.switched",
        "premise.changed",
      ]);
      const [switched] = await rows(
        "SELECT seq FROM events WHERE type = 'schema.switched' ORDER BY seq DESC LIMIT 1",
      );
      const [changed] = await rows(
        `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'targets/0'
         WHERE e.type = 'premise.changed'`,
      );
      expect(JSON.parse(changed?.["body"] as string)).toEqual({
        table: "t2",
        row: target.target.row,
        by_event: Number(switched?.["seq"]),
        changed: [{ op: declared.seq, i: 0, j: 0, reason: "schema_switched" }],
      });
      expect(
        await rows("SELECT state, reason, since FROM premise_decls WHERE op = $1", [declared.seq]),
      ).toEqual([{ state: "changed", reason: "schema_switched", since: expect.anything() }]);
      // The mark on the row resting on it (05 §4.2: "dropped in the schema switch of #n"). Seeing the
      // whole slot: told whole, the table as the version before the drop named it. A range of the
      // tables left only (all the slot has now, but not what it had): hidden, as a table out of range.
      const row = (declared.ops[0] as Any).target.row;
      const markOf = async (visibility?: unknown) =>
        (
          (await query(s.store, ctx(visibility === undefined ? {} : { visibility }), {
            table: "expenses",
          })) as Any
        ).rows.find((r: Any) => r.row === row).marks.premise_changed;
      const [switchedOp] = await rows(
        "SELECT op FROM events WHERE type = 'schema.switched' ORDER BY seq DESC LIMIT 1",
      );
      expect(await markOf()).toEqual([
        {
          premise: { table: "ledger.settings", row: target.target.row },
          seen: target.ver,
          reason: "schema_switched",
          since: Number(switchedOp?.["op"]),
          fields: ["date"],
          declared: { seq: declared.seq, actor: expect.anything() },
        },
      ]);
      expect(
        await markOf({ kind: "scoped", slots: [{ slot: slotId, tables: [{ table: "t1" }] }] }),
      ).toEqual([{ hidden: true, since: Number(switchedOp?.["op"]), fields: ["date"] }]);
      // The declaring write in the row's history: the same rule.
      const premisesOf = async (visibility?: unknown) =>
        (
          (await history(s.store, ctx(visibility === undefined ? {} : { visibility }), {
            table: "expenses",
            row,
          })) as Any
        ).entries[0].premises;
      expect(await premisesOf()).toEqual([
        {
          target: { table: "ledger.settings", row: target.target.row },
          ver: target.ver,
          state: "changed",
          reason: "schema_switched",
          since: Number(switchedOp?.["op"]),
        },
      ]);
      expect(
        await premisesOf({ kind: "scoped", slots: [{ slot: slotId, tables: [{ table: "t1" }] }] }),
      ).toEqual([{ hidden: true, state: "changed", since: Number(switchedOp?.["op"]) }]);
      // A range naming the dropped table by its ID took it in: told whole.
      expect(
        await markOf({
          kind: "scoped",
          slots: [{ slot: slotId, tables: [{ table: "t1" }, { table: "t2" }] }],
        }),
      ).toEqual([
        expect.objectContaining({ premise: { table: "ledger.settings", row: target.target.row } }),
      ]);
    },
    T,
  );

  it(
    "a draft renaming it, rejected, then the drop: the mark names the table as it was in effect, not as the draft would have",
    async () => {
      const setting = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "settings", set: { key: "currency" } }],
      });
      const target = setting.ops[0] as Any;
      const declared = await write(s.store, ctx(), {
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "expenses",
            set: { date: "2026-11-02" },
            premises: [{ table: "settings", row: target.target.row, ver: target.ver }],
          },
        ],
      });
      // Renamed to prefs by a draft never in effect: compiled as version 2, rejected.
      const renamed = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        tables: [{ ...SETTINGS, id: "t2", name: "prefs" }],
      });
      expect(renamed).toMatchObject({ outcome: "pending" });
      await decide({ id: renamed.item.id, decision: "reject", item_ver: renamed.item.item_ver });
      const drop = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        drop_tables: ["settings"],
        tables: [],
      });
      await decide({ id: drop.item.id, decision: "confirm", item_ver: drop.item.item_ver });
      const row = (declared.ops[0] as Any).target.row;
      const marked = ((await query(s.store, ctx(), { table: "expenses" })) as Any).rows.find(
        (r: Any) => r.row === row,
      ).marks.premise_changed;
      expect(marked).toEqual([
        expect.objectContaining({
          premise: { table: "ledger.settings", row: target.target.row },
          reason: "schema_switched",
        }),
      ]);
      const entry = ((await history(s.store, ctx(), { table: "expenses", row })) as Any).entries[0]
        .premises;
      expect(entry).toEqual([
        expect.objectContaining({ target: { table: "ledger.settings", row: target.target.row } }),
      ]);
    },
    T,
  );

  it(
    "its open items are superseded (schema_switched) by the switch; those on other tables stay",
    async () => {
      const made = await write(s.store, ctx(), {
        sv: 1,
        ops: [
          { intent: "insert", table: "settings", set: { key: "currency" } },
          { intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "a" } },
        ],
      });
      const [setting, expense] = made.ops as Any[];
      // A stale write on each table: a conflict on each.
      const conflictOn = async (table: string, o: Any, set: Record<string, string>) => {
        await write(s.store, ctx(), {
          sv: 1,
          ops: [{ intent: "update", table, row: o.target.row, ver: o.ver, set }],
        });
        const stale = await write(s.store, ctx({ task: `other-${table}` }), {
          sv: 1,
          ops: [{ intent: "update", table, row: o.target.row, ver: o.ver, set }],
        });
        expect(stale.pending).toHaveLength(1);
        return (stale.pending as Any[])[0];
      };
      const onSettings = await conflictOn("settings", setting, { key: "cur-b" });
      const onExpenses = await conflictOn("expenses", expense, { note: "b" });
      const d = await draft({
        slot: "ledger",
        base_version: 1,
        timezone: "Asia/Shanghai",
        drop_tables: ["settings"],
        tables: [],
      });
      await decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver });
      // schema.switched, then the items it supersedes (09 §4.5).
      expect(await lastOp()).toEqual([
        "item.resolved",
        "schema.confirmed",
        "schema.switched",
        "item.superseded",
      ]);
      const [switched] = await rows(
        "SELECT seq FROM events WHERE type = 'schema.switched' ORDER BY seq DESC LIMIT 1",
      );
      const [superseded] = await rows(
        `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
         WHERE e.type = 'item.superseded' ORDER BY e.seq DESC LIMIT 1`,
      );
      expect(JSON.parse(superseded?.["body"] as string)).toEqual({
        item: onSettings.id,
        reason: "schema_switched",
        by_event: Number(switched?.["seq"]),
      });
      expect(
        await rows("SELECT id, state FROM pending_items WHERE type = 'conflict' ORDER BY id", []),
      ).toEqual(
        [
          { id: onSettings.id, state: "superseded" },
          { id: onExpenses.id, state: "open" },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
      // Deciding it after: item_closed, not an internal failure.
      expect(
        await answer(() =>
          decide({ id: onSettings.id, decision: "take_candidate", item_ver: onSettings.item_ver }),
        ),
      ).toMatchObject({ code: "item_closed", reason: "superseded" });
    },
    T,
  );
});

describe("a field a derived rule reads, renamed, then eleven more versions", () => {
  it(
    "the catalog's document given back is still no_change; the rule's text keeps the old name and still evaluates",
    async () => {
      const meals = {
        name: "meals",
        kind: "base",
        description: "one row per meal",
        time: { type: "event", field: "date" },
        fields: [
          { name: "date", type: "date", required: true, description: "the day" },
          { name: "energy", type: "quantity", unit: "kcal", description: "energy" },
        ],
      };
      await draft(
        {
          slot: "diet",
          base_version: null,
          timezone: "Asia/Shanghai",
          tables: [
            meals,
            {
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
            },
          ],
        },
        { task: "diet" },
      );
      const listed = (sv: number, description: string, energy = "kcal") => ({
        slot: "diet",
        base_version: sv,
        timezone: "Asia/Shanghai",
        tables: [
          {
            ...meals,
            id: "t3",
            description,
            fields: [
              { ...meals.fields[0], id: "f1" },
              { ...meals.fields[1], id: "f2", name: energy },
            ],
          },
        ],
      });
      // The rename waits; confirmed, it is version 2.
      const renamed = await draft(listed(1, "one row per meal"), { task: "diet" });
      expect(renamed).toMatchObject({ outcome: "pending" });
      await decide({ id: renamed.item.id, decision: "confirm", item_ver: renamed.item.item_ver });
      // Eleven automatic changes after it: versions 3 to 13.
      for (let sv = 2; sv < 13; sv++) {
        const r = await draft(listed(sv, `meals, version ${sv + 1}`), { task: "diet" });
        expect(r).toMatchObject({ outcome: "applied", sv: sv + 1 });
      }
      const c = (await catalog(s.store, ctx(), { level: "schema", slot: "diet" })) as Any;
      expect(c).toMatchObject({ sv: 13, document: { base_version: 13 } });
      const rule = c.document.tables.find((t: { name: string }) => t.name === "daily_energy").rule;
      expect(rule.sql).toBe("SELECT date, sum(energy) AS total FROM meals GROUP BY date");
      expect(
        await answer(() => schemaDraft(s.store, ctx({ task: "diet" }), { document: c.document })),
      ).toMatchObject({ code: "invalid_argument", reason: "no_change" });
      // The rule evaluates by IDs: a meal written now counts in the day's total.
      await write(s.store, ctx(), {
        sv: 13,
        ops: [
          {
            intent: "insert",
            table: "meals",
            set: { date: "2026-11-02", kcal: { value: "500", unit: "kcal" } },
          },
        ],
      });
      // At version 1, twelve versions back, the field is still `energy` (07 «旧名字还认多久»: names
      // by the request's sv, any version); `kcal` was not its name then.
      await write(s.store, ctx(), {
        sv: 1,
        ops: [
          {
            intent: "insert",
            table: "diet.meals",
            set: { date: "2026-11-02", energy: { value: "300", unit: "kcal" } },
          },
        ],
      });
      expect(
        await answer(() =>
          write(s.store, ctx(), {
            sv: 1,
            ops: [
              {
                intent: "insert",
                table: "diet.meals",
                set: { date: "2026-11-02", kcal: { value: "1", unit: "kcal" } },
              },
            ],
          }),
        ),
      ).toMatchObject({ code: "unknown_field", name: "kcal" });
      const q = await query(s.store, ctx(), { table: "daily_energy" });
      expect(q.rows.map((x) => x.values)).toEqual([
        { date: "2026-11-02", total: { value: "800", unit: "kcal" } },
      ]);
    },
    T,
  );
});

describe("removing the slot (07-scope-v1: a schema change still open keeps it)", () => {
  it(
    "slot_not_empty while the item is open, naming it; removable once it is rejected",
    async () => {
      const d = await draft(rename("memo"));
      const remove = () => removeSlot(s.store, ctx(), { slot_id: slotId } as never);
      expect(await answer(remove)).toMatchObject({
        code: "invalid_argument",
        reason: "slot_not_empty",
        cause: "open_schema_change",
        item: d.item.id,
      });
      await decide({ id: d.item.id, decision: "reject", item_ver: d.item.item_ver });
      expect(await remove()).toMatchObject({ slot_id: slotId, name: "ledger" });
    },
    T,
  );
});

describe("as_of reads the version switched to by then (08 «状态机»: a version takes effect at its switch)", () => {
  it(
    "a confirmed draft: the earlier version up to its confirmation, the draft's from the confirmation on",
    async () => {
      const w = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "tea" } }],
      });
      const row = (w.ops[0] as Any).target.row;
      const d = await draft(rename("memo"));
      // The draft's operation, and a write after it, before the confirmation.
      const [own] = await rows(
        "SELECT op FROM events WHERE type = 'schema.compiled' ORDER BY seq DESC LIMIT 1",
      );
      const draftOp = Number(own?.["op"]);
      const later = (
        await write(s.store, ctx(), {
          sv: 1,
          ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-03" } }],
        })
      ).seq as number;
      const asOf = (seq: number) =>
        history(s.store, ctx(), { table: "expenses", row, mode: "as_of", as_of: seq });
      await decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver });
      const [confirm] = await rows(
        "SELECT op FROM events WHERE type = 'schema.switched' ORDER BY seq DESC LIMIT 1",
      );
      // Compiled at the draft, switched at the confirmation: in between, version 1 was in effect.
      // Named as version 1 has them, though version 2 is current.
      expect(await asOf(draftOp)).toMatchObject({
        sv: 1,
        rows: [{ table: "ledger.expenses", values: { date: "2026-11-02", note: "tea" } }],
      });
      expect(await asOf(later)).toMatchObject({ sv: 1 });
      expect(Object.keys(((await asOf(later)) as Any).rows[0].values).sort()).toEqual([
        "date",
        "note",
      ]);
      // At the confirmation itself, one operation: the rows, their sv and the slot's schema agree.
      const at = (await asOf(Number(confirm?.["op"]))) as Any;
      expect(at).toMatchObject({ sv: 2 });
      expect(Object.keys(at.rows[0].values).sort()).toEqual(["date", "memo"]);
      expect(await catalog(s.store, ctx(), { level: "schema", slot: "ledger" })).toMatchObject({
        sv: 2,
      });
    },
    T,
  );

  it(
    "renamed twice: a point between the two reads the middle version's names, table and field",
    async () => {
      const w = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "tea" } }],
      });
      const row = (w.ops[0] as Any).target.row;
      const second = await draft(rename("memo"));
      await decide({ id: second.item.id, decision: "confirm", item_ver: second.item.item_ver });
      const middle = await tail();
      const third = rename("purpose", 2);
      (third.tables[0] as Any).name = "spending";
      const d = await draft(third);
      if (d.outcome === "pending")
        await decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver });
      expect(await catalog(s.store, ctx(), { level: "schema", slot: "ledger" })).toMatchObject({
        sv: 3,
      });
      const asOf = async (seq: number) =>
        (await history(s.store, ctx(), {
          table: "spending",
          row,
          mode: "as_of",
          as_of: seq,
        })) as Any;
      const at = (seq: number) =>
        asOf(seq).then((r) => ({ sv: r.sv, table: r.rows[0].table, values: r.rows[0].values }));
      expect(await at(w.seq as number)).toEqual({
        sv: 1,
        table: "ledger.expenses",
        values: { date: "2026-11-02", note: "tea" },
      });
      expect(await at(middle)).toEqual({
        sv: 2,
        table: "ledger.expenses",
        values: { date: "2026-11-02", memo: "tea" },
      });
      expect(await at(await tail())).toEqual({
        sv: 3,
        table: "ledger.spending",
        values: { date: "2026-11-02", purpose: "tea" },
      });
    },
    T,
  );

  it(
    "before the slot's first version took effect: the first version's sv and names, no rows",
    async () => {
      const [created] = await rows(
        "SELECT min(e.op) AS op FROM events e WHERE e.type = 'schema.switched'",
      );
      const w = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02", note: "tea" } }],
      });
      const row = (w.ops[0] as Any).target.row;
      const d = await draft(rename("memo"));
      await decide({ id: d.item.id, decision: "confirm", item_ver: d.item.item_ver });
      // The slot is at version 2 now; a point before it was created is of version 1, as named then.
      const before = (await history(s.store, ctx(), {
        table: "expenses",
        row,
        mode: "as_of",
        as_of: Number(created?.["op"]) - 1,
      })) as Any;
      expect(before).toMatchObject({ sv: 1, rows: [] });
    },
    T,
  );

  it(
    "an automatic draft: compiled and switched in one operation, that operation reads the new version",
    async () => {
      const w = await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "insert", table: "expenses", set: { date: "2026-11-02" } }],
      });
      const row = (w.ops[0] as Any).target.row;
      const auto = rename("note");
      (auto.tables[0] as Any).description = "every expense";
      expect(await draft(auto)).toMatchObject({ outcome: "applied", sv: 2 });
      const [switched] = await rows(
        "SELECT op FROM events WHERE type = 'schema.switched' ORDER BY seq DESC LIMIT 1",
      );
      const op = Number(switched?.["op"]);
      const asOf = (seq: number) =>
        history(s.store, ctx(), { table: "expenses", row, mode: "as_of", as_of: seq });
      // The write before it, and the switch's own operation.
      expect(await asOf(w.seq as number)).toMatchObject({ sv: 1 });
      expect(await asOf(op)).toMatchObject({ sv: 2 });
    },
    T,
  );
});

describe("replayed", () => {
  it(
    "the log into an empty storage gives the same state: confirmations, rejections, a superseded draft, evidence, a dropped table with an item and a premise on it",
    async () => {
      const a = await draft(rename("memo"));
      await decide({ id: a.item.id, decision: "reject", item_ver: a.item.item_ver });
      const b = await draft(rename("remark"));
      await decide({ id: b.item.id, decision: "confirm", item_ver: b.item.item_ver, note: "yes" });
      const c = await draft({
        slot: "ledger",
        base_version: 3,
        timezone: "Asia/Shanghai",
        rename_to: "budget",
        tables: [],
      });
      await decide({ id: c.item.id, decision: "confirm", item_ver: c.item.item_ver });
      // On settings: a row, a conflict on it, a premise declared on it.
      const made = await write(s.store, ctx(), {
        sv: 4,
        ops: [{ intent: "insert", table: "settings", set: { key: "currency" } }],
      });
      const setting = made.ops[0] as Any;
      const update = (task?: string) =>
        write(s.store, ctx(task === undefined ? {} : { task }), {
          sv: 4,
          ops: [
            {
              intent: "update",
              table: "settings",
              row: setting.target.row,
              ver: setting.ver,
              set: { key: task ?? "cur-b" },
            },
          ],
        });
      const fresh = await update();
      expect((await update("stale")).pending).toHaveLength(1);
      await write(s.store, ctx(), {
        sv: 4,
        ops: [
          {
            intent: "insert",
            table: "expenses",
            set: { date: "2026-11-02" },
            premises: [
              { table: "settings", row: setting.target.row, ver: (fresh.ops[0] as Any).ver },
            ],
          },
        ],
      });
      // A draft superseded by the next one, which drops settings; confirmed with evidence.
      await draft({ ...rename("purpose", 4), slot: "budget" });
      const drop = await draft({
        slot: "budget",
        base_version: 4,
        timezone: "Asia/Shanghai",
        drop_tables: ["settings"],
        tables: [],
      });
      expect(drop.superseded_draft).toBeDefined();
      await decide({
        id: drop.item.id,
        decision: "confirm",
        item_ver: drop.item.item_ver,
        evidence: [{ kind: "user_message", text: "settings can go" }],
      });
      expect(await lastOp()).toEqual([
        "item.resolved",
        "source.recorded",
        "schema.confirmed",
        "schema.switched",
        "item.superseded",
        "premise.changed",
      ]);
      const replica = await openReusable("saveslot-schema-resolve-replica-");
      try {
        const last = (await tail()) as number;
        const events = await rows("SELECT * FROM events ORDER BY seq");
        const content = await rows("SELECT * FROM content ORDER BY seq, path");
        await replica.store.write(async (tx) => {
          for (const [table, all] of [
            ["events", events],
            ["content", content],
          ] as const) {
            for (const e of all) {
              const cols = Object.keys(e);
              const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
              await tx.query(
                `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${marks})`,
                Object.values(e) as never,
              );
            }
          }
          await applyEvents(tx, await readEvents(tx, 1, last));
        });
        const kept = new Set(
          KERNEL_TABLES.filter((t) => t.class !== "materialized").map((t) => t.name),
        );
        const state = async (store: typeof s.store) =>
          Object.fromEntries(
            Object.entries(await store.read(snapshot)).filter(([name]) => !kept.has(name)),
          );
        expect(await state(replica.store)).toEqual(await state(s.store));
        const at = async (sql: string) =>
          (await replica.store.read((tx) => tx.query(sql))).rows as Record<string, unknown>[];
        expect(await at("SELECT sv, state FROM schema_versions ORDER BY sv")).toEqual([
          { sv: 1, state: "retired" },
          { sv: 2, state: "rejected" },
          { sv: 3, state: "retired" },
          { sv: 4, state: "retired" },
          { sv: 5, state: "superseded" },
          { sv: 6, state: "current" },
        ]);
        expect(await at("SELECT name, current_sv FROM slots")).toEqual([
          { name: "budget", current_sv: 6 },
        ]);
        expect(
          await at(
            "SELECT type, state, decision FROM pending_items ORDER BY type, state, decision",
          ),
        ).toEqual([
          { type: "conflict", state: "superseded", decision: null },
          { type: "schema_change", state: "resolved", decision: "confirm" },
          { type: "schema_change", state: "resolved", decision: "confirm" },
          { type: "schema_change", state: "resolved", decision: "confirm" },
          { type: "schema_change", state: "resolved", decision: "reject" },
          { type: "schema_change", state: "superseded", decision: null },
        ]);
        expect(await at("SELECT state, reason FROM premise_decls")).toEqual([
          { state: "changed", reason: "schema_switched" },
        ]);
      } finally {
        await replica.close();
      }
    },
    T,
  );
});
