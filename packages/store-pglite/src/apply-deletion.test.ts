// apply of `deletion.confirmed` on logs the write path makes (09-event-format §4.4, §5.9 `apply`),
// fixed cases: the lunch of §4.4 (the correction's words deleted, the amount back to 45); a state
// entity re-segmented; a result made to disagree with the row stops apply with nothing written.
// Each case that applies ends with the log replayed into an empty storage. Fictional names.

import {
  ApplyError,
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  query,
  type ReadTx,
  readEvents,
  readTail,
  reconcileLog,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cancelDeletion, confirmDeletion, DeletionSession } from "./testing/deletion.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const LUNCH = {
  name: "lunches",
  kind: "base",
  description: "one row per lunch",
  time: { type: "none" },
  fields: [{ name: "amount", type: "text", required: true, description: "what it cost" }],
};
const MEALS = {
  name: "meals",
  kind: "base",
  description: "one row per meal",
  time: { type: "none" },
  fields: [
    { name: "amount", type: "text", required: true, description: "what it cost" },
    { name: "note", type: "text", description: "what it was" },
  ],
};
const BUDGET = {
  name: "budget",
  kind: "base",
  description: "the monthly budget over time",
  time: { type: "state", granularity: "date" },
  fields: [{ name: "amount", type: "text", required: true, description: "how much" }],
};

let s: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
const now = () => `2026-11-10T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "w",
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: now(),
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
const w = (ops: unknown[], evidence?: string): Promise<Any> =>
  write(s.store, ctx(), {
    sv: 1,
    ...(evidence !== undefined ? { evidence: [{ kind: "user_message", text: evidence }] } : {}),
    ops,
  });
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);
/** The `source.recorded` whose text is `text`. */
const sourceOf = (text: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ seq: unknown }>(
      `SELECT c.seq FROM content c JOIN events e ON e.seq = c.seq
       WHERE e.type = 'source.recorded' AND c.path = 'text' AND c.body LIKE $1`,
      [`%${text}%`],
    );
    return Number(r.rows[0]?.seq);
  });
/** A table's compiled definition, by name. */
const compiled = (name: string) =>
  s.store.read(async (tx: ReadTx) => {
    const r = await tx.query<{ body: string }>(
      `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
       WHERE v.state = 'current'`,
    );
    const tables = JSON.parse(r.rows[0]?.body as string).tables as Any[];
    return tables.find((t) => t.name === name);
  });
/** The slot's ID. */
const slotId = () =>
  s.store.read(async (tx: ReadTx) => {
    const r = await tx.query<{ slot_id: string }>("SELECT slot_id FROM schema_versions LIMIT 1");
    return r.rows[0]?.slot_id as string;
  });
const replaysTheSame = async () => {
  await scratch.reset();
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
};

beforeAll(async () => {
  s = await openReusable("saveslot-apply-deletion-fixed-");
  scratch = await openReusable("saveslot-apply-deletion-fixed-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH, BUDGET, MEALS] },
  });
}, T);

describe("a deletion confirmed: the rows as its results say, the blocks it lists pending", () => {
  it(
    "the lunch of 09 §4.4: the correction's words deleted, the amount back to 45",
    async () => {
      const r1 = await w(
        [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
        "lunch was 45",
      );
      const row = r1.ops[0].target.row as string;
      await w(
        [{ intent: "correct", table: "lunches", row, set: { amount: "35" } }],
        "no, lunch was 35",
      );
      const correction = await sourceOf("no, lunch was 35");
      const made = await confirmDeletion(s.store, {
        slot: await slotId(),
        table: await compiled("lunches"),
        row,
        sources: [correction],
        actor: USER,
        now: now(),
      });
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows.map((x: Any) => [x.row, x.values.amount, x.ver])).toEqual([
        [row, "45", `v${made.self}.0`],
      ]);
      // The correction's words and its contribution are pending: read no more through the log.
      await s.store.read(async (tx) => {
        const evs = await readEvents(tx, correction, correction);
        expect(evs[0]?.blocks.get("text")).toEqual({ state: "pending", by: made.self });
      });
      await replaysTheSame();
    },
    T,
  );

  it(
    "after the confirmation, a write referring to the deleted source is refused: pending_deletion_source",
    async () => {
      const r1 = await w(
        [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
        "lunch was 45",
      );
      const row = r1.ops[0].target.row as string;
      await w(
        [{ intent: "correct", table: "lunches", row, set: { amount: "35" } }],
        "no, lunch was 35",
      );
      const correction = await sourceOf("no, lunch was 35");
      await confirmDeletion(s.store, {
        slot: await slotId(),
        table: await compiled("lunches"),
        row,
        sources: [correction],
        actor: USER,
        now: now(),
      });
      const id = (
        await s.store.read((tx) =>
          tx.query<{ source_id: string }>("SELECT source_id FROM sources WHERE seq = $1", [
            correction,
          ]),
        )
      ).rows[0]?.source_id as string;
      let refused: unknown;
      try {
        await write(s.store, ctx(), {
          sv: 1,
          evidence: [{ kind: "source_ref", id }],
          ops: [{ intent: "insert", table: "lunches", set: { amount: "35" } }],
        });
      } catch (e) {
        refused = e;
      }
      expect(JSON.stringify(refused ?? null)).toContain("pending_deletion_source");
    },
    T,
  );

  it(
    "a write after the deletion settles its row from the content the deletion's restatement gave",
    async () => {
      // A deletion restating the meal's amount item with 50 (made by hand: what it says is what
      // matters here), then a write of the note alone: the amount the row settles to stays 50.
      const r1 = await w(
        [{ intent: "insert", table: "meals", set: { amount: "45", note: "soup" } }],
        "lunch was 45",
      );
      const row = r1.ops[0].target.row as string;
      const meals = await compiled("meals");
      const amount = meals.fields.find((f: Any) => f.name === "amount").id as string;
      const note = meals.fields.find((f: Any) => f.name === "note").id as string;
      const said = await sourceOf("lunch was 45");
      const base = await s.store.read(async (tx) => {
        const r = await tx.query<{ seq: unknown }>(
          "SELECT seq FROM events WHERE type = 'write.base' AND target_row = $1",
          [row],
        );
        return Number(r.rows[0]?.seq);
      });
      const self = (await tail()) + 1;
      const carried = { event: base, field: amount, k: 0 };
      const deletion = {
        ctx: { now: now(), today: "2026-11-10", ruleset_version: 1, policy_version: 1 },
        target: {
          deletion: `pi_${"7".repeat(16)}`,
          kind: "privacy",
          due_at: "2026-12-31T00:00:00.000Z",
          sources: [said],
          origin: "request",
        },
        positions: [{ seq: self, path: "summary" }],
        summary: { hash: "c".repeat(64) },
        "results/0/target": { table: meals.id, row, outcome: "fields_reverted" },
        [`results/0/fields/${amount}/0`]: {
          value: "50",
          sources: [{ kind: "value", carried }],
        },
        "restated/0": {
          ...carried,
          status: "applied",
          value: "50",
          sources: [{ kind: "value", carried }],
          deps: [carried],
        },
      };
      const append = (events: unknown[]) =>
        s.store.write(async (tx) => {
          const op = await appendOperation(tx, {
            actor: USER as never,
            now: now() as never,
            events: events as never,
          });
          await applyEvents(tx, eventsOf(op));
        });
      const slot = await slotId();
      await append([{ type: "deletion.confirmed", slot, blocks: deletion }]);
      const ctxBlock = {
        now: now(),
        today: "2026-11-10",
        ruleset_version: 1,
        policy_version: 1,
        literal_checker: "literal@1",
      };
      await append([
        {
          type: "write.head",
          slot,
          blocks: {
            ctx: ctxBlock,
            request: { sv: 1, sv_basis: "explicit", op_count: 1 },
            "ops/0/target": { table: meals.id, row, intent: "update" },
            [`ops/0/set/${note}`]: "stew",
          },
        },
        {
          type: "write.base",
          slot,
          blocks: {
            target: {
              table: meals.id,
              row,
              intent: "update",
              sv: 1,
              cause: "request",
              op_index: 0,
            },
            [`fields/${note}/0`]: { status: "applied", value: "stew" },
            [`sources/${note}/0`]: [{ kind: "value", source: said }],
          },
        },
      ]);
      const read = await query(s.store, ctx(), { table: "meals" });
      expect(read.rows.map((x: Any) => [x.values.amount, x.values.note])).toEqual([["50", "stew"]]);
      // Another deletion listing the row (taking nothing of it): its amount is the 50 the first
      // gave, read from that deletion's block in the log.
      const self2 = (await tail()) + 1;
      await append([
        {
          type: "deletion.confirmed",
          slot,
          blocks: {
            ctx: deletion.ctx,
            target: { ...deletion.target, deletion: `pi_${"8".repeat(16)}` },
            positions: [{ seq: self2, path: "summary" }],
            summary: { hash: "d".repeat(64) },
            "results/0/target": { table: meals.id, row, outcome: "sources_changed" },
            [`results/0/fields/${amount}/0`]: {
              value: "50",
              sources: [{ kind: "value", carried }],
            },
          },
        },
      ]);
      const again = await query(s.store, ctx(), { table: "meals" });
      expect(again.rows.map((x: Any) => x.values.amount)).toEqual(["50"]);
    },
    T,
  );

  it(
    "the lunch's deletion cancelled: 35 again, the correction's words readable, the deletion cancelled",
    async () => {
      const r1 = await w(
        [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
        "lunch was 45",
      );
      const row = r1.ops[0].target.row as string;
      await w(
        [{ intent: "correct", table: "lunches", row, set: { amount: "35" } }],
        "no, lunch was 35",
      );
      const correction = await sourceOf("no, lunch was 35");
      const input = {
        slot: await slotId(),
        table: await compiled("lunches"),
        row,
        sources: [correction],
        actor: USER,
        now: now(),
      };
      await confirmDeletion(s.store, input);
      const back = await cancelDeletion(s.store, { ...input, now: now() });
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows.map((x: Any) => [x.row, x.values.amount, x.ver])).toEqual([
        [row, "35", `v${back.self}.0`],
      ]);
      await s.store.read(async (tx) => {
        const evs = await readEvents(tx, correction, correction);
        expect(evs[0]?.blocks.get("text")).toMatchObject({ state: "present" });
        const d = await tx.query("SELECT state FROM deletions");
        expect(d.rows).toEqual([{ state: "cancelled" }]);
        // The correction's words can be referred to as evidence again.
        const src = await tx.query("SELECT deletion_state FROM sources WHERE seq = $1", [
          correction,
        ]);
        expect(src.rows).toEqual([{ deletion_state: "present" }]);
      });
      await replaysTheSame();
    },
    T,
  );

  it(
    "two deletions pending of the same words, one cancelled: the words stay pending, the amount stays 45",
    async () => {
      const r1 = await w(
        [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
        "lunch was 45",
      );
      const row = r1.ops[0].target.row as string;
      await w(
        [{ intent: "correct", table: "lunches", row, set: { amount: "35" } }],
        "no, lunch was 35",
      );
      const correction = await sourceOf("no, lunch was 35");
      const session = new DeletionSession(s.store, {
        slot: await slotId(),
        table: await compiled("lunches"),
        row,
        actor: USER,
      });
      const first = `pi_${"A".repeat(16)}`;
      const second = `pi_${"B".repeat(16)}`;
      await session.confirm(first, [correction], now());
      const other = await session.confirm(second, [correction], now());
      await session.cancel(first, now());
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows.map((x: Any) => [x.row, x.values.amount])).toEqual([[row, "45"]]);
      await s.store.read(async (tx) => {
        // The other deletion still deletes the words: unreadable, and not evidence to refer to.
        const evs = await readEvents(tx, correction, correction);
        expect(evs[0]?.blocks.get("text")).toEqual({ state: "pending", by: other.self });
        const src = await tx.query("SELECT deletion_state FROM sources WHERE seq = $1", [
          correction,
        ]);
        expect(src.rows).toEqual([{ deletion_state: "pending_deletion" }]);
        const d = await tx.query("SELECT id, state FROM deletions ORDER BY id");
        expect(d.rows).toEqual([
          { id: first, state: "cancelled" },
          { id: second, state: "pending" },
        ]);
      });
      await replaysTheSame();
    },
    T,
  );

  /**
   * 45, then 50, then 35, then the 35 undone: the undo writes 50 back, carried from the second
   * write. The second write's words deleted: the undo's item now carries 45 (a restatement giving
   * it new content). Returns the row and the second write's source.
   */
  const undone = async () => {
    const r1 = await w([{ intent: "insert", table: "lunches", set: { amount: "45" } }], "first 45");
    const row = r1.ops[0].target.row as string;
    await w([{ intent: "correct", table: "lunches", row, set: { amount: "50" } }], "then 50");
    const third = await w(
      [{ intent: "correct", table: "lunches", row, set: { amount: "35" } }],
      "then 35",
    );
    await w([{ table: "lunches", row, revert: { undo: third.seq } }], "not 35 after all");
    const amount = async () =>
      (await query(s.store, ctx(), { table: "lunches" })).rows.map((x: Any) => x.values.amount);
    expect(await amount()).toEqual(["50"]);
    const input = {
      slot: await slotId(),
      table: await compiled("lunches"),
      row,
      sources: [await sourceOf("then 50")],
      actor: USER,
    };
    return { input, amount };
  };

  it(
    "an undo carrying a deleted write: the deletion gives it new content, its cancellation takes it back",
    async () => {
      const { input, amount } = await undone();
      const made = await confirmDeletion(s.store, { ...input, now: now() });
      expect(made.replay.replay.restated.length).toBeGreaterThan(0);
      expect(await amount()).toEqual(["45"]);
      await cancelDeletion(s.store, { ...input, now: now() });
      expect(await amount()).toEqual(["50"]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "the same deleted and cancelled twice: the first cancelled deletion's new content gives nothing",
    async () => {
      const { input, amount } = await undone();
      await confirmDeletion(s.store, { ...input, now: now() });
      await cancelDeletion(s.store, { ...input, now: now() });
      const again = { ...input, id: `pi_${"C".repeat(16)}` };
      await confirmDeletion(s.store, { ...again, now: now() });
      expect(await amount()).toEqual(["45"]);
      await cancelDeletion(s.store, { ...again, now: now() });
      expect(await amount()).toEqual(["50"]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a conflict item superseded by the deletion of its candidate's words, put back by the cancellation: open again, its flag back",
    async () => {
      const a = await w([{ intent: "insert", table: "lunches", set: { amount: "9" } }], "nine");
      const row = a.ops[0].target.row as string;
      const ver = a.ops[0].ver as string;
      await w([{ intent: "update", table: "lunches", row, ver, set: { amount: "9.5" } }], "9.5");
      const c = await w(
        [{ intent: "update", table: "lunches", row, ver, set: { amount: "10" } }],
        "ten, not 9.5",
      );
      const item = c.pending[0]?.id as string;
      const itemState = () =>
        s.store.read(async (tx) => ({
          item: (await tx.query("SELECT state FROM pending_items WHERE id = $1", [item])).rows,
          flags: (await tx.query("SELECT flag FROM flags WHERE item_id = $1", [item])).rows,
        }));
      const open = await itemState();
      expect(open.item).toEqual([{ state: "open" }]);
      expect(open.flags.length).toBeGreaterThan(0);
      const input = {
        slot: await slotId(),
        table: await compiled("lunches"),
        row,
        sources: [await sourceOf("ten, not 9.5")],
        actor: USER,
        now: now(),
      };
      await confirmDeletion(s.store, { ...input, superseded: [item] });
      expect(await itemState()).toEqual({ item: [{ state: "superseded" }], flags: [] });
      await cancelDeletion(s.store, { ...input, restoredItems: [item], now: now() });
      expect(await itemState()).toEqual(open);
      await replaysTheSame();
    },
    T,
  );

  it(
    "an item put back that the deletion did not supersede stops the cancellation as inconsistent",
    async () => {
      const a = await w([{ intent: "insert", table: "lunches", set: { amount: "9" } }], "nine");
      const row = a.ops[0].target.row as string;
      const ver = a.ops[0].ver as string;
      await w([{ intent: "update", table: "lunches", row, ver, set: { amount: "9.5" } }], "9.5");
      const c = await w(
        [{ intent: "update", table: "lunches", row, ver, set: { amount: "10" } }],
        "ten, not 9.5",
      );
      const item = c.pending[0]?.id as string;
      const input = {
        slot: await slotId(),
        table: await compiled("lunches"),
        row,
        sources: [await sourceOf("9.5")],
        actor: USER,
        now: now(),
      };
      await confirmDeletion(s.store, input);
      const e = await cancelDeletion(s.store, {
        ...input,
        restoredItems: [item],
        now: now(),
      }).catch((x: unknown) => x);
      expect(String((e as Error).message)).toContain(`item ${item} to put back is open`);
    },
    T,
  );

  it(
    "a state entity: the middle write's words deleted, the stretches and gaps as the results say",
    async () => {
      const first = await w(
        [
          {
            intent: "insert",
            table: "budget",
            set: { amount: "5000" },
            valid_from: "2026-10-01",
          },
        ],
        "5000 from October",
      );
      const e = first.ops[0].target.entity as string;
      await w(
        [
          {
            intent: "update",
            table: "budget",
            entity: e,
            set: { amount: "3000" },
            valid_from: "2026-11-02",
            valid_to: "2026-11-20",
          },
        ],
        "3000 for most of November",
      );
      const middle = await sourceOf("3000 for most");
      const made = await confirmDeletion(s.store, {
        slot: await slotId(),
        table: await compiled("budget"),
        row: e,
        sources: [middle],
        actor: USER,
        now: now(),
      });
      expect(made.blocks["results/0/target"]).toMatchObject({ entity: e });
      const read = await query(s.store, ctx(), { table: "budget" });
      // Back to one stretch of 5000 from October: the business rows of the entity.
      expect(
        read.rows.map((x: Any) => [x.values.amount, x.valid_from, x.valid_to ?? null]),
      ).toEqual([["5000", "2026-10-01", null]]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a result made to disagree with the row: apply stops as inconsistent, nothing written",
    async () => {
      const r1 = await w(
        [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
        "lunch was 45",
      );
      const row = r1.ops[0].target.row as string;
      await w([{ intent: "correct", table: "lunches", row, set: { amount: "35" } }], "no, 35");
      const correction = await sourceOf("no, 35");
      const before = await tail();
      let thrown: unknown;
      try {
        await confirmDeletion(s.store, {
          slot: await slotId(),
          table: await compiled("lunches"),
          row,
          sources: [correction],
          actor: USER,
          now: now(),
          tamper: (b) => {
            (b["results/0/fields/f1/0"] as { value: string }).value = "35";
          },
        });
      } catch (e) {
        thrown = e;
      }
      const a = thrown instanceof ApplyError ? thrown : (thrown as { cause?: unknown })?.cause;
      expect(a).toBeInstanceOf(ApplyError);
      expect((a as ApplyError).reason).toBe("inconsistent");
      expect(await tail()).toBe(before);
    },
    T,
  );
});
