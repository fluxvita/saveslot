// The `deletion_preview` and `delete` operations, the kernel's part (04-contract-types §4.7, §5.4;
// 03-deletion «预览与回执要写明的内容»; 02-architecture §8 the anchor store), on logs the write path
// makes. Fixed cases: the lunch of 09 §4.4 previewed, confirmed and read back; the order of the
// checks at confirmation (replayed, handle_expired, preview_outdated) and what outdates a preview;
// the registry entry as intent before the event and pending after; the shapes this version refuses.
// Each case that confirms ends with the log replayed into an empty storage. Fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  confirmDeletion,
  createOpsContext,
  createTenant,
  type DeletionBinding,
  previewDeletion,
  query,
  type ReadTx,
  readTail,
  reconcileLog,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const BUDGET = {
  name: "budget",
  kind: "base",
  description: "the monthly budget over time",
  time: { type: "state", granularity: "date" },
  fields: [{ name: "amount", type: "text", required: true, description: "how much" }],
};
const KEYED = {
  name: "imported",
  kind: "base",
  description: "rows from another system",
  time: { type: "none" },
  fields: [
    { name: "origin", type: "text", description: "the source system" },
    { name: "external_id", type: "text", description: "its ID there" },
    { name: "amount", type: "text", description: "what it cost" },
  ],
  external_key: ["origin", "external_id"],
};

const MEALS = {
  name: "meals",
  kind: "base",
  description: "a meal",
  time: { type: "none" },
  fields: [{ name: "name", type: "text", required: true, description: "what" }],
};
const DISHES = {
  name: "dishes",
  kind: "base",
  description: "a dish",
  time: { type: "none" },
  fields: [
    { name: "dish", type: "text", required: true, description: "what" },
    { name: "meal", type: "ref", description: "its meal", ref: { table: "meals", target: "row" } },
  ],
};

let s: ReusableStore;
let scratch: ReusableStore;
let dir: string;
let anchor: AnchorStore;
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
/** The external ID of the `source.recorded` whose text is `text`. */
const sourceId = (text: string) =>
  s.store.read(async (tx: ReadTx) => {
    const r = await tx.query<{ source_id: string }>(
      `SELECT s.source_id FROM sources s JOIN content c ON c.seq = s.seq
       WHERE c.path = 'text' AND c.body LIKE $1`,
      [`%${text}%`],
    );
    return r.rows[0]?.source_id as string;
  });
const sourceSeq = (text: string) =>
  s.store.read(async (tx: ReadTx) => {
    const r = await tx.query<{ seq: unknown }>(
      `SELECT c.seq FROM content c JOIN events e ON e.seq = c.seq
       WHERE e.type = 'source.recorded' AND c.path = 'text' AND c.body LIKE $1`,
      [`%${text}%`],
    );
    return Number(r.rows[0]?.seq);
  });
const replaysTheSame = async () => {
  await scratch.reset();
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
};
/** What a call threw, as the caller sees it. */
const thrown = async (f: () => Promise<unknown>): Promise<Any> => {
  try {
    await f();
  } catch (e) {
    return e;
  }
  return undefined;
};
const confirm = (binding: DeletionBinding, handle = "dc_test") =>
  confirmDeletion(s.store, anchor, ctx(), { binding, handle });

/** The lunch of 09 §4.4: 45, then corrected to 35. */
async function lunch() {
  const r1 = await w(
    [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
    "lunch was 45",
  );
  const row = r1.ops[0].target.row as string;
  const r2 = await w(
    [{ intent: "correct", table: "lunches", row, set: { amount: "35" } }],
    "no, lunch was 35",
  );
  return { row, first: r1, second: r2 };
}

beforeAll(async () => {
  s = await openReusable("saveslot-delete-op-");
  scratch = await openReusable("saveslot-delete-op-scratch-");
}, T);
afterAll(async () => {
  await s?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-delete-op-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: {
      slot: "home",
      base_version: null,
      timezone: "UTC",
      tables: [LUNCH, BUDGET, KEYED, MEALS, DISHES],
    },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a deletion previewed and confirmed", () => {
  it(
    "the lunch of 09 §4.4: the correction's words deleted, the amount back to 45; read back as the preview said",
    async () => {
      const { row } = await lunch();
      // The first write's base event: what the amount still rests on.
      const said = await s.store.read(async (tx) => {
        const r = await tx.query<{ seq: unknown }>(
          "SELECT seq FROM events WHERE type = 'write.base' AND target_row = $1 ORDER BY seq LIMIT 1",
          [row],
        );
        return Number(r.rows[0]?.seq);
      });
      const { preview, binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      expect(preview.totals).toEqual({ sources: 1, rows: 1, derived: 0 });
      expect(preview.rows).toEqual([
        {
          target: { table: "lunches", row },
          result: "fields_reverted",
          after: { values: { amount: "45" } },
          basis: { amount: [said] },
        },
      ]);
      expect(binding.seq).toBe(await tail());
      const receipt = await confirm(binding);
      expect(receipt.seq).toBe(binding.seq + 1);
      expect(receipt.rows).toEqual([{ ...preview.rows[0], ver: `v${receipt.seq}.0` }]);
      expect(receipt.deletion.cancel_with).toEqual({
        op: "resolve",
        id: receipt.deletion.id,
        decision: "cancel",
      });
      // Due 24 hours after the confirmation.
      const at = await s.store.read(async (tx) => {
        const r = await tx.query<{ at: string }>("SELECT at FROM events WHERE seq = $1", [
          receipt.seq,
        ]);
        return r.rows[0]?.at as string;
      });
      expect(Date.parse(receipt.deletion.expires_at) - Date.parse(at)).toBe(24 * 60 * 60 * 1000);
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows.map((x: Any) => [x.row, x.values.amount, x.ver])).toEqual([
        [row, "45", `v${receipt.seq}.0`],
      ]);
      // The registry entry: pending, at the event's seq, with its sources and positions.
      const a = await anchor.read(TENANT as never);
      expect(a.deletions.map((d) => [d.deletion, d.state, d.confirmedSeq, d.sources])).toEqual([
        [receipt.deletion.id, "pending", receipt.seq, [await sourceSeq("no, lunch was 35")]],
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a state entity: the preview gives the spans after",
    async () => {
      const r1 = await w(
        [
          {
            intent: "insert",
            table: "budget",
            valid_from: "2026-10-01",
            set: { amount: "5000" },
          },
        ],
        "budget is 5000 from october",
      );
      const entity = r1.ops[0].target.entity as string;
      await w(
        [
          {
            intent: "update",
            table: "budget",
            entity,
            valid_from: "2026-11-10",
            valid_to: "2026-11-20",
            set: { amount: "4000" },
          },
        ],
        "4000 for ten days",
      );
      const { preview, binding } = await previewDeletion(s.store, {
        sources: [await sourceId("4000 for ten days")],
      });
      expect(preview.rows.map((r) => [r.result, r.after])).toEqual([
        // 5000 cut by the 4000 and whole again: re-segmented, one stretch from October.
        ["resegmented", { spans: [{ from: "2026-10-01", values: { amount: "5000" } }] }],
      ]);
      const receipt = await confirm(binding);
      const read = await query(s.store, ctx(), { table: "budget" });
      expect(read.rows.map((x: Any) => x.ver)).toEqual([`v${receipt.seq}.0`]);
      await replaysTheSame();
    },
    T,
  );
});

describe("at confirmation: replayed, then handle_expired, then preview_outdated", () => {
  it(
    "the same handle again: known by the deletion ID it binds, the receipt again, replayed, nothing appended",
    async () => {
      await lunch();
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const first = await confirm(binding, "dc_one");
      const at = await tail();
      const again = await confirm(binding, "dc_one");
      expect(await tail()).toBe(at);
      // The same receipt, rebuilt from the event: the rows' targets, outcomes and new `ver`; their
      // details omitted.
      const { replayed, omitted, rows, ...rest } = again;
      const { rows: firstRows, ...firstRest } = first;
      expect([replayed, omitted]).toEqual([true, ["rows"]]);
      expect(rest).toEqual(firstRest);
      expect(rows).toEqual(
        firstRows.map((r) => ({ target: r.target, result: r.result, ver: r.ver })),
      );
      // Past the handle's expiry: still answered as a replay.
      const late = await confirmDeletion(s.store, anchor, ctx(), {
        binding,
        handle: "dc_one",
        expired: true,
      });
      expect(late.replayed).toBe(true);
      expect(late.deletion.id).toBe(first.deletion.id);
    },
    T,
  );

  it(
    "restored since the preview: handle_expired (restored), before the state is looked at",
    async () => {
      await lunch();
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      // Also outdated: the restore count is checked first.
      await w([{ intent: "insert", table: "lunches", set: { amount: "9" } }], "another lunch");
      const e = await thrown(() => confirm({ ...binding, restoreCount: 1 }));
      expect([e?.code, e?.detail?.reason]).toEqual(["handle_expired", "restored"]);
      expect((await anchor.read(TENANT as never)).deletions).toEqual([]);
    },
    T,
  );

  it(
    "expired and never confirmed: handle_expired (expired)",
    async () => {
      await lunch();
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const e = await thrown(() =>
        confirmDeletion(s.store, anchor, ctx(), { binding, handle: "dc_x", expired: true }),
      );
      expect([e?.code, e?.detail?.reason]).toEqual(["handle_expired", "expired"]);
    },
    T,
  );

  it(
    "a source the preview lists made pending deletion by another deletion: preview_outdated, with the refusal",
    async () => {
      await lunch();
      const id = await sourceId("no, lunch was 35");
      const first = await previewDeletion(s.store, { sources: [id] });
      const second = await previewDeletion(s.store, { sources: [id] });
      await confirm(second.binding);
      const e = await thrown(() => confirm(first.binding));
      expect(e?.code).toBe("preview_outdated");
      expect(e?.detail?.preview_refused).toMatchObject({
        code: "invalid_argument",
        reason: "pending_deletion_source",
      });
    },
    T,
  );

  it(
    "a write to the listed row outdates the preview; the new preview comes with the error",
    async () => {
      const { row } = await lunch();
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const at = await tail();
      await w(
        [{ intent: "correct", table: "lunches", row, set: { amount: "30" } }],
        "it was 30 after all",
      );
      const e = await thrown(() => confirm(binding));
      expect(e?.code).toBe("preview_outdated");
      expect(e?.detail?.binding?.hash).not.toBe(binding.hash);
      expect(e?.detail?.binding?.seq).toBeGreaterThan(at);
      expect((await anchor.read(TENANT as never)).deletions).toEqual([]);
      // The new binding confirms.
      const receipt = await confirm(e.detail.binding as DeletionBinding);
      expect(receipt.seq).toBe((e.detail.binding as DeletionBinding).seq + 1);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a write elsewhere does not outdate it",
    async () => {
      await lunch();
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      await w([{ intent: "insert", table: "lunches", set: { amount: "9" } }], "another lunch");
      const receipt = await confirm(binding);
      expect(receipt.seq).toBeGreaterThan(binding.seq + 1);
      await replaysTheSame();
    },
    T,
  );
});

describe("the registry entry", () => {
  it(
    "is written as intent before the event: when it cannot be, nothing is appended; then pending",
    async () => {
      await lunch();
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const states: [string, number][] = [];
      const failing = (failOn: string): AnchorStore => ({
        read: (t) => anchor.read(t),
        removeDeletion: (t, d) => anchor.removeDeletion(t, d),
        advanceHighWater: (t, q) => anchor.advanceHighWater(t, q),
        beginRestore: (t, r) => anchor.beginRestore(t, r),
        endRestore: (t, r, h) => anchor.endRestore(t, r, h),
        beginImport: (...a) => anchor.beginImport(...a),
        endImport: (...a) => anchor.endImport(...a),
        abortImport: (...a) => anchor.abortImport(...a),
        putDeletion: async (t, entry) => {
          states.push([entry.state, entry.confirmedSeq]);
          if (entry.state === failOn) throw new Error("the anchor store is down");
          return anchor.putDeletion(t, entry);
        },
      });
      const at = await tail();
      const e = await thrown(() =>
        confirmDeletion(s.store, failing("intent"), ctx(), { binding, handle: "dc_a" }),
      );
      expect(e?.message).toBe("the anchor store is down");
      expect(await tail()).toBe(at);
      // Pending failing after the commit: the deletion stands; the entry stays intent for
      // reconciliation to settle.
      const receipt = await confirmDeletion(s.store, failing("pending"), ctx(), {
        binding,
        handle: "dc_b",
      });
      expect(states).toEqual([
        ["intent", at + 1],
        ["intent", receipt.seq],
        ["pending", receipt.seq],
      ]);
      expect((await anchor.read(TENANT as never)).deletions.map((d) => d.state)).toEqual([
        "intent",
      ]);
    },
    T,
  );
});

describe("the shapes this version refuses, before anything is appended", () => {
  const refusedAs = async (sources: string[], kind: string) => {
    const at = await tail();
    const e = await thrown(() => previewDeletion(s.store, { sources }));
    expect([e?.code, e?.detail?.reason, e?.detail?.kind]).toEqual([
      "internal",
      "not_implemented",
      kind,
    ]);
    expect(await tail()).toBe(at);
  };

  it(
    "a row an earlier deletion touched: prior_deletion_on_row",
    async () => {
      await lunch();
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      await confirm(binding);
      await refusedAs([await sourceId("lunch was 45")], "prior_deletion_on_row");
    },
    T,
  );

  it(
    "a deletion that changes a pending item: pending_items_touched",
    async () => {
      // #1 45; #2 35 having seen #1; #3 30 having seen #1 too: a candidate against #2. Deleting
      // #2's words takes the conflict's cause away.
      const { row, first } = await lunch();
      await w(
        [
          {
            intent: "correct",
            table: "lunches",
            row,
            ver: first.ops[0].ver,
            set: { amount: "30" },
          },
        ],
        "it was 30",
      );
      const open = await s.store.read((tx) =>
        tx.query<{ id: string }>("SELECT id FROM pending_items WHERE state = 'open'"),
      );
      expect(open.rows).toHaveLength(1);
      await refusedAs([await sourceId("no, lunch was 35")], "pending_items_touched");
    },
    T,
  );

  it(
    "an open item's entry the deletion lists, its members unchanged: pending_items_touched",
    async () => {
      // #1 45; #2 35 having seen #1; #3 30 having seen #1: a candidate against #2, the item's value
      // at the merge base #1's 45. Deleting #1's words: #2 still gives 35 and #3 is still a
      // candidate against it (no item's members change), but the item's entry of the merge base
      // rests on #1's contribution and is listed.
      const { row, first } = await lunch();
      await w(
        [
          {
            intent: "correct",
            table: "lunches",
            row,
            ver: first.ops[0].ver,
            set: { amount: "30" },
          },
        ],
        "it was 30",
      );
      await refusedAs([await sourceId("lunch was 45")], "pending_items_touched");
    },
    T,
  );

  it(
    "a row a premise declaration names: premise",
    async () => {
      const { row, second } = await lunch();
      const other = await w(
        [{ intent: "insert", table: "lunches", set: { amount: "12" } }],
        "a second lunch",
      );
      await w(
        [
          {
            intent: "update",
            table: "lunches",
            row: other.ops[0].target.row,
            ver: other.ops[0].ver,
            set: { amount: "13" },
            premises: [{ table: "lunches", row, ver: second.ops[0].ver }],
          },
        ],
        "13, as the first lunch still stands",
      );
      await refusedAs([await sourceId("no, lunch was 35")], "premise");
    },
    T,
  );

  it(
    "a table a derived table depends on: derived",
    async () => {
      await schemaDraft(s.store, ctx(), {
        document: {
          slot: "ledger",
          base_version: null,
          timezone: "UTC",
          tables: [
            {
              name: "spends",
              kind: "base",
              description: "one row per spend",
              time: { type: "none" },
              fields: [{ name: "amount", type: "text", required: true, description: "how much" }],
            },
            {
              name: "spend_count",
              kind: "derived",
              description: "how many spends",
              rule: { sql: "SELECT count(amount) AS n FROM spends", time_dependency: "none" },
              fields: [{ name: "n", description: "spends" }],
            },
          ],
        },
      });
      await write(s.store, ctx(), {
        sv: 1,
        evidence: [{ kind: "user_message", text: "spent 8" }],
        ops: [{ intent: "insert", table: "ledger.spends", set: { amount: "8" } }],
      });
      await refusedAs([await sourceId("spent 8")], "derived");
    },
    T,
  );

  it(
    "a row referring to a row whose revoke awaits for its referrers (high impact ②): referenced_revoke_awaiting",
    async () => {
      const m = await w(
        [{ intent: "insert", table: "meals", set: { name: "lunch" } }],
        "had lunch",
      );
      const meal = m.ops[0].target.row as string;
      await w(
        [{ intent: "insert", table: "dishes", set: { dish: "soup", meal } }],
        "soup with lunch",
      );
      await w(
        [{ intent: "revoke", table: "meals", row: meal, ver: m.ops[0].ver }],
        "forget that lunch",
      );
      const open = await s.store.read((tx) =>
        tx.query<{ type: string; target_row: string }>(
          "SELECT type, target_row FROM pending_items WHERE state = 'open'",
        ),
      );
      expect(open.rows).toEqual([{ type: "awaiting_confirmation", target_row: meal }]);
      // Deleting the dish's words: the dish, the only referrer, goes; the revoke's item is on the
      // meal, another row.
      await refusedAs([await sourceId("soup with lunch")], "referenced_revoke_awaiting");
    },
    T,
  );

  it(
    "a revoke a candidate when written, its conflict cleared, on a table that may be referred to: revoke_conflict_cleared",
    async () => {
      // #1 lunch; #2 renamed, having seen #1; #3 revokes having seen #1: a candidate against #2.
      // Deleting #2's words clears the conflict; whether the revoke would then await for referrers
      // is other rows'.
      const m = await w(
        [{ intent: "insert", table: "meals", set: { name: "lunch" } }],
        "had lunch",
      );
      const meal = m.ops[0].target.row as string;
      await w(
        [{ intent: "correct", table: "meals", row: meal, set: { name: "brunch" } }],
        "it was brunch",
      );
      await w(
        [{ intent: "revoke", table: "meals", row: meal, ver: m.ops[0].ver }],
        "forget that lunch",
      );
      await refusedAs([await sourceId("it was brunch")], "revoke_conflict_cleared");
    },
    T,
  );

  it(
    "a table with an external key: external_key",
    async () => {
      await w(
        [
          {
            intent: "update",
            table: "imported",
            external_key: { origin: "band_app", external_id: "m-1" },
            set: { amount: "12" },
          },
        ],
        "an imported row",
      );
      await refusedAs([await sourceId("an imported row")], "external_key");
    },
    T,
  );

  it(
    "an unknown source, no source, sources of two slots, a source pending deletion",
    async () => {
      await lunch();
      const e1 = await thrown(() => previewDeletion(s.store, { sources: ["s_0000000000000000"] }));
      expect([e1?.code, e1?.detail?.reason]).toEqual(["not_found", "source"]);
      const e2 = await thrown(() => previewDeletion(s.store, { sources: [] }));
      expect([e2?.code, e2?.detail?.reason]).toEqual(["invalid_argument", "missing"]);
      // A source of another slot beside one of this slot.
      await schemaDraft(s.store, ctx(), {
        document: {
          slot: "other",
          base_version: null,
          timezone: "UTC",
          tables: [{ ...LUNCH, name: "snacks" }],
        },
      });
      await write(s.store, ctx(), {
        sv: 1,
        evidence: [{ kind: "user_message", text: "a snack" }],
        ops: [{ intent: "insert", table: "other.snacks", set: { amount: "2" } }],
      });
      const both = [await sourceId("no, lunch was 35"), await sourceId("a snack")];
      const e4 = await thrown(() => previewDeletion(s.store, { sources: both }));
      expect([e4?.code, e4?.detail?.reason]).toEqual(["invalid_argument", "cross_slot"]);
      const id = await sourceId("no, lunch was 35");
      await confirm((await previewDeletion(s.store, { sources: [id] })).binding);
      const e3 = await thrown(() => previewDeletion(s.store, { sources: [id] }));
      expect([e3?.code, e3?.detail?.reason]).toEqual([
        "invalid_argument",
        "pending_deletion_source",
      ]);
    },
    T,
  );
});
