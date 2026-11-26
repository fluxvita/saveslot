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
  appendOperation,
  confirmDeletion,
  createOpsContext,
  createTenant,
  type DeletionBinding,
  type NewEvent,
  pending,
  previewDeletion,
  query,
  type ReadTx,
  readTail,
  reconcileLog,
  resolve as resolve$,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cancelDeletion } from "./testing/deletion.fixture.ts";
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
/** Rows the same by name: a second one opens a `flagged` item (04-contract §6 «flagged», `duplicate_keys`). */
const PAIRS = {
  name: "pairs",
  kind: "base",
  description: "two fields that go together",
  time: { type: "none" },
  together: [["a", "b"]],
  fields: [
    { name: "a", type: "text", required: true, description: "one" },
    { name: "b", type: "text", description: "the other" },
  ],
};
const DUPS = {
  name: "dups",
  kind: "base",
  description: "named rows",
  time: { type: "none" },
  duplicate_keys: [["name"]],
  fields: [{ name: "name", type: "text", required: true, description: "a name" }],
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
/** The open items, by ID. */
const openItems = () =>
  s.store.read(async (tx) =>
    (
      await tx.query<{ id: string }>(
        "SELECT id FROM pending_items WHERE state = 'open' ORDER BY id",
      )
    ).rows.map((x) => x.id),
  );
/** The events of operation `op` (from its head event): type, target block, `superseded_items`. */
const opEvents = (op: number) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ seq: unknown; type: string }>(
      "SELECT seq, type FROM events WHERE seq = $1 OR op = $1 ORDER BY seq",
      [op],
    );
    const out: { type: string; target: unknown; superseded?: unknown }[] = [];
    for (const e of r.rows) {
      const b = await tx.query<{ path: string; body: string }>(
        "SELECT path, body FROM content WHERE seq = $1 AND path IN ('target', 'superseded_items') AND body IS NOT NULL",
        [Number(e.seq)],
      );
      const by = Object.fromEntries(b.rows.map((x) => [x.path, JSON.parse(x.body)]));
      out.push({
        type: e.type,
        target: by["target"],
        ...(by["superseded_items"] !== undefined ? { superseded: by["superseded_items"] } : {}),
      });
    }
    return out;
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
      tables: [LUNCH, BUDGET, KEYED, MEALS, DISHES, DUPS, PAIRS],
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

/** A table's compiled definition and the slot's ID, as the cancellation fixture takes them. */
const compiledOf = (name: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ body: string; slot_id: string }>(
      `SELECT c.body, v.slot_id FROM schema_versions v
       JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled' WHERE v.state = 'current'`,
    );
    const tables = JSON.parse(r.rows[0]?.body as string).tables as Any[];
    return { table: tables.find((t) => t.name === name), slot: r.rows[0]?.slot_id as string };
  });

describe("a row earlier deletions touched", () => {
  it(
    "an awaiting item the pending deletion opened, superseded by the next when its write takes effect",
    async () => {
      // #1 5000 from 10-01; #2 4000 on [11-10, 11-20); #3 3000 on [09-01, 12-01), having seen #1:
      // a candidate against #2. A deletes #2's words: #3 awaits (it fills the stretch before
      // 10-01), in an item A opens. B, with A pending, deletes #1's words: no change point is left
      // for #3 to erase, it takes effect, and A's item is superseded.
      const r1 = await w(
        [{ intent: "insert", table: "budget", valid_from: "2026-10-01", set: { amount: "5000" } }],
        "budget is 5000 from october",
      );
      const entity = r1.ops[0].target.entity as string;
      const ver = r1.ops[0].ver;
      await w(
        [
          {
            intent: "update",
            table: "budget",
            entity,
            ver,
            valid_from: "2026-11-10",
            valid_to: "2026-11-20",
            set: { amount: "4000" },
          },
        ],
        "4000 for ten days",
      );
      await w(
        [
          {
            intent: "update",
            table: "budget",
            entity,
            ver,
            valid_from: "2026-09-01",
            valid_to: "2026-12-01",
            set: { amount: "3000" },
          },
        ],
        "3000 from september",
      );
      const a = await previewDeletion(s.store, { sources: [await sourceId("4000 for ten days")] });
      const first = await confirm(a.binding);
      const opened = first.now_awaiting[0]?.item.id as string;
      expect(await openItems()).toEqual([opened]);
      const b = await previewDeletion(s.store, {
        sources: [await sourceId("budget is 5000 from october")],
      });
      expect(b.preview.superseded.map((x) => x.item)).toEqual([opened]);
      expect(b.preview.now_effective.map((x) => [x.item, x.item_becomes])).toEqual([
        [opened, "superseded"],
      ]);
      await confirm(b.binding, "dc_b");
      expect(await openItems()).toEqual([]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "deleted, the deletion cancelled, deleted again: as if only the second",
    async () => {
      const { row } = await lunch();
      const second = await sourceId("lunch was 45");
      const only = await previewDeletion(s.store, { sources: [second] });
      const a = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const first = await confirm(a.binding);
      const { table, slot } = await compiledOf("lunches");
      await cancelDeletion(s.store, {
        slot,
        table,
        row,
        sources: [await sourceSeq("no, lunch was 35")],
        id: first.deletion.id,
        actor: USER,
        now: now(),
      });
      const b = await previewDeletion(s.store, { sources: [second] });
      expect(b.preview.rows).toEqual(only.preview.rows);
      const receipt = await confirm(b.binding, "dc_b");
      const positions = await s.store.read(async (tx) => {
        const r = await tx.query<{ body: string }>(
          "SELECT body FROM content WHERE seq = $1 AND path = 'positions'",
          [receipt.seq],
        );
        return JSON.parse(r.rows[0]?.body ?? "[]") as { seq: number }[];
      });
      // Of the earlier events, only what rests on the words deleted: the cancelled deletion's
      // result carrying #1's 45 (09 §3.5 rule 1), though its blocks count for nothing else.
      expect(
        positions
          .filter((p) => p.seq >= first.seq && p.seq < receipt.seq)
          .map((p) => [p.seq, (p as { path?: string }).path]),
      ).toEqual([[first.seq, "results/0/fields/f1/0"]]);
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows.map((x: Any) => x.values.amount)).toEqual(["35"]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a cancelled deletion's restatement as dropped does not count for the next deletion",
    async () => {
      // #1 45; #2 35; #3 45 again, having seen #2. A deletes #2's words: #3 a no-op, restated as
      // dropped; cancelled: #3 back, not restated (09 §5.9 rule 3 takes interval blocks only). B
      // deletes #1's words: #3 is as the log last gave it before A, not restated.
      const { row, second } = await lunch();
      const third = await w(
        [
          {
            intent: "correct",
            table: "lunches",
            row,
            ver: second.ops[0].ver,
            set: { amount: "45" },
          },
        ],
        "back to 45",
      );
      const a = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const first = await confirm(a.binding);
      const thirdBase = await s.store.read(async (tx) => {
        const r = await tx.query<{ seq: unknown }>(
          "SELECT seq FROM events WHERE type = 'write.base' AND op = $1",
          [third.seq],
        );
        return Number(r.rows[0]?.seq);
      });
      const restatedIn = (seq: number) =>
        s.store.read(async (tx) =>
          (
            await tx.query<{ body: string }>(
              "SELECT body FROM content WHERE seq = $1 AND path LIKE 'restated/%' AND body IS NOT NULL",
              [seq],
            )
          ).rows.map((x) => JSON.parse(x.body) as { event: number; status: string }),
        );
      expect((await restatedIn(first.seq)).filter((x) => x.event === thirdBase)).toEqual([
        expect.objectContaining({ event: thirdBase, status: "dropped" }),
      ]);
      const { table, slot } = await compiledOf("lunches");
      await cancelDeletion(s.store, {
        slot,
        table,
        row,
        sources: [await sourceSeq("no, lunch was 35")],
        id: first.deletion.id,
        actor: USER,
        now: now(),
      });
      const b = await previewDeletion(s.store, { sources: [await sourceId("lunch was 45")] });
      const receipt = await confirm(b.binding, "dc_b");
      expect((await restatedIn(receipt.seq)).filter((x) => x.event === thirdBase)).toEqual([]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "another deletion of the row cancelled since the preview: preview_outdated",
    async () => {
      const { row } = await lunch();
      const a = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const first = await confirm(a.binding);
      const b = await previewDeletion(s.store, { sources: [await sourceId("lunch was 45")] });
      const { table, slot } = await compiledOf("lunches");
      await cancelDeletion(s.store, {
        slot,
        table,
        row,
        sources: [await sourceSeq("no, lunch was 35")],
        id: first.deletion.id,
        actor: USER,
        now: now(),
      });
      const e = await thrown(() => confirm(b.binding, "dc_b"));
      expect(e?.code).toBe("preview_outdated");
    },
    T,
  );

  it(
    "deleted again while the first is pending: the event with it, the positions without it",
    async () => {
      // #1 45 (lunch was 45), #2 35 (no, lunch was 35). A deletes #2's words: 45. B, with A
      // pending, deletes #1's: nothing is left, the row deleted. B's event is worked out with A
      // pending; its list of positions is its own: not the blocks only A's words give.
      const { row } = await lunch();
      const a = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const first = await confirm(a.binding);
      const b = await previewDeletion(s.store, { sources: [await sourceId("lunch was 45")] });
      expect(b.preview.rows.map((x) => [x.target, x.result])).toEqual([
        [{ table: "lunches", row }, "deleted"],
      ]);
      const second = await confirm(b.binding, "dc_b");
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows).toEqual([]);
      const positionsOf = (seq: number) =>
        s.store.read(async (tx) => {
          const r = await tx.query<{ body: string }>(
            "SELECT body FROM content WHERE seq = $1 AND path = 'positions'",
            [seq],
          );
          return JSON.parse(r.rows[0]?.body ?? "[]") as { seq: number; path: string }[];
        });
      const aWords = await sourceSeq("no, lunch was 35");
      expect((await positionsOf(first.seq)).some((p) => p.seq === aWords)).toBe(true);
      expect((await positionsOf(second.seq)).some((p) => p.seq === aWords)).toBe(false);
      await replaysTheSame();
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

  /** The lunch, its correction's words deleted (pending): the row at 45. */
  const lunchDeletedOnce = async () => {
    const l = await lunch();
    const { binding } = await previewDeletion(s.store, {
      sources: [await sourceId("no, lunch was 35")],
    });
    const first = await confirm(binding);
    const [read] = (await query(s.store, ctx(), { table: "lunches" })).rows as Any[];
    expect(read.values.amount).toBe("45");
    return { ...l, first, ver: read.ver };
  };

  // Any operation on the row after its earliest deletion, whatever it changes: each kind of one.
  it(
    "a row corrected after an earlier deletion: ops_after_deletion",
    async () => {
      const { row } = await lunchDeletedOnce();
      await w([{ intent: "correct", table: "lunches", row, set: { amount: "40" } }], "it was 40");
      await refusedAs([await sourceId("lunch was 45")], "ops_after_deletion");
    },
    T,
  );

  it(
    "a row revoked after an earlier deletion: ops_after_deletion",
    async () => {
      const { row, ver } = await lunchDeletedOnce();
      await w([{ intent: "revoke", table: "lunches", row, ver }], "forget that lunch");
      await refusedAs([await sourceId("lunch was 45")], "ops_after_deletion");
    },
    T,
  );

  it(
    "a write after an earlier deletion that changes nothing: ops_after_deletion",
    async () => {
      const { row, ver } = await lunchDeletedOnce();
      await w(
        [{ intent: "correct", table: "lunches", row, ver, set: { amount: "45" } }],
        "yes, 45",
      );
      expect(
        (await query(s.store, ctx(), { table: "lunches" })).rows.map((x: Any) => x.values.amount),
      ).toEqual(["45"]);
      await refusedAs([await sourceId("lunch was 45")], "ops_after_deletion");
    },
    T,
  );

  it(
    "an undo on the row after an earlier deletion: ops_after_deletion",
    async () => {
      const { row, ver, second } = await lunchDeletedOnce();
      await w([{ table: "lunches", row, ver, revert: { undo: second.seq } }], "undo the 35");
      await refusedAs([await sourceId("lunch was 45")], "ops_after_deletion");
    },
    T,
  );

  it(
    "an item on the row resolved after an earlier deletion: the resolution itself refused, nothing appended",
    async () => {
      // As in «an awaiting item the pending deletion opened»: deleting #2's words leaves #3
      // awaiting, in an item that deletion opens. Its resolution would be an operation on the row
      // (refused as ops_after_deletion), but this version cannot judge a row with a deletion on it:
      // the resolution is refused itself, before anything is appended, so the next deletion
      // meets nothing written since.
      const r1 = await w(
        [{ intent: "insert", table: "budget", valid_from: "2026-10-01", set: { amount: "5000" } }],
        "budget is 5000 from october",
      );
      const entity = r1.ops[0].target.entity as string;
      const ver = r1.ops[0].ver;
      const span = (from: string, to: string, amount: string) => ({
        intent: "update",
        table: "budget",
        entity,
        ver,
        valid_from: from,
        valid_to: to,
        set: { amount },
      });
      await w([span("2026-11-10", "2026-11-20", "4000")], "4000 for ten days");
      await w([span("2026-09-01", "2026-12-01", "3000")], "3000 from september");
      const a = await previewDeletion(s.store, { sources: [await sourceId("4000 for ten days")] });
      const first = await confirm(a.binding);
      const item = first.now_awaiting[0]?.item.id as string;
      const iv = await s.store.read(async (tx) => {
        const r = await tx.query<{ v: unknown }>(
          "SELECT version_op AS v FROM pending_items WHERE id = $1",
          [item],
        );
        return `iv_${item.slice(3)}.${Number(r.rows[0]?.v)}.0`;
      });
      for (const decision of ["confirm", "reject"]) {
        const at = await tail();
        expect(
          await thrown(() => resolve$(s.store, ctx(), { id: item, item_ver: iv, decision })),
        ).toBeDefined();
        expect(await tail()).toBe(at);
      }
      expect(await openItems()).toEqual([item]);
      const b = await previewDeletion(s.store, {
        sources: [await sourceId("budget is 5000 from october")],
      });
      expect(b.preview.superseded.map((x) => x.item)).toEqual([item]);
    },
    T,
  );

  it(
    "a row a carried-out deletion touched: executed_deletion_on_row",
    async () => {
      // No operation carries a deletion out in this version, nor is `deletion.executed` applied:
      // the event is appended by hand, with the first deletion's positions (09 §5.9).
      const { first } = await lunchDeletedOnce();
      const positions = await s.store.read(async (tx) => {
        const r = await tx.query<{ body: string }>(
          "SELECT body FROM content WHERE seq = $1 AND path = 'positions'",
          [first.seq],
        );
        return JSON.parse(r.rows[0]?.body ?? "[]") as unknown[];
      });
      expect(positions.length).toBeGreaterThan(0);
      const { slot } = await compiledOf("lunches");
      await s.store.write(async (tx) => {
        await appendOperation(tx, {
          actor: "system" as never,
          now: now() as never,
          events: [
            {
              type: "deletion.executed",
              trigger: "deletion_expiry",
              slot,
              blocks: { target: { deletion: first.deletion.id, reason: "expiry" }, positions },
            } as NewEvent,
          ],
        });
      });
      await refusedAs([await sourceId("lunch was 45")], "executed_deletion_on_row");
    },
    T,
  );

  it(
    "a conflict's cause deleted: the candidate takes effect, its item superseded (deleted)",
    async () => {
      // #1 45; #2 35 having seen #1; #3 30 having seen #1 too: a candidate against #2. Deleting
      // #2's words takes the conflict's cause away: #3 takes effect, the item is superseded.
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
      const item = (await openItems())[0] as string;
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      const receipt = await confirm(binding);
      expect(receipt.superseded).toEqual([{ item, type: "conflict", reason: "deleted" }]);
      expect(receipt.now_effective.map((x) => [x.item, x.item_becomes])).toEqual([
        [item, "superseded"],
      ]);
      expect(await openItems()).toEqual([]);
      const events = await opEvents(receipt.seq);
      expect(events.map((e) => [e.type, e.target])).toEqual([
        ["deletion.confirmed", expect.objectContaining({ deletion: receipt.deletion.id })],
        ["item.superseded", { item, reason: "deleted", by_event: receipt.seq }],
      ]);
      expect(events[0]?.superseded).toEqual([item]);
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows.map((x: Any) => x.values.amount)).toEqual(["30"]);
      await replaysTheSame();
      // The same handle again: the write put in effect is counted from the log; the list is not.
      const again = await confirm(binding);
      expect([again.now_effective, again.now_effective_total, again.omitted]).toEqual([
        [],
        1,
        ["rows", "lists"],
      ]);
      expect(again.superseded).toEqual(receipt.superseded);
    },
    T,
  );

  it(
    "a conflict cleared, the write still of high impact: the item superseded, an awaiting item opened",
    async () => {
      // #1 5000 from 10-01; #2 (seen #1) 4000 on [11-10, 11-20); #3 (seen #1) 3000 from 09-01
      // to 12-01: a candidate against #2. Deleting #2's words clears the conflict, but #3 fills the
      // stretch before 10-01 that has no value (high impact): it awaits, in an item opened for it.
      const r1 = await w(
        [{ intent: "insert", table: "budget", valid_from: "2026-10-01", set: { amount: "5000" } }],
        "budget is 5000 from october",
      );
      const entity = r1.ops[0].target.entity as string;
      const ver = r1.ops[0].ver;
      await w(
        [
          {
            intent: "update",
            table: "budget",
            entity,
            ver,
            valid_from: "2026-11-10",
            valid_to: "2026-11-20",
            set: { amount: "4000" },
          },
        ],
        "4000 for ten days",
      );
      await w(
        [
          {
            intent: "update",
            table: "budget",
            entity,
            ver,
            valid_from: "2026-09-01",
            valid_to: "2026-12-01",
            set: { amount: "3000" },
          },
        ],
        "3000 from september",
      );
      const before = await openItems();
      expect(before).toHaveLength(1);
      const { preview, binding } = await previewDeletion(s.store, {
        sources: [await sourceId("4000 for ten days")],
      });
      // 04-contract-types §4.7: by field name, the interval on a state table, the item it
      // succeeds, and the impact as `AwaitingImpact`.
      expect(preview.now_awaiting.map((x) => Object.keys(x).sort())).toEqual([
        ["fields", "from_item", "impact", "seq", "target", "valid"],
      ]);
      expect(preview.now_awaiting[0]).toMatchObject({
        target: { table: "budget", entity },
        fields: { amount: "3000" },
        from_item: before[0],
      });
      const receipt = await confirm(binding);
      // §5.4: the item opened instead of the values; the impact as the item's details give it.
      expect(receipt.now_awaiting.map((x) => Object.keys(x).sort())).toEqual([
        ["impact", "item", "seq", "target"],
      ]);
      const opened = receipt.now_awaiting[0]?.item;
      const detail: Any = await pending(s.store, ctx(), { id: opened?.id });
      expect(detail.impact).toEqual(receipt.now_awaiting[0]?.impact);
      expect(preview.now_awaiting[0]?.impact).toEqual(detail.impact);
      expect(Object.keys(detail.impact).length).toBeGreaterThan(0);
      expect(opened?.item_ver).toBe(`iv_${opened?.id.slice(3)}.${receipt.seq}.0`);
      expect(receipt.superseded.map((x) => x.item)).toEqual(before);
      expect(await openItems()).toEqual([opened?.id]);
      const events = await opEvents(receipt.seq);
      expect(events.map((e) => [e.type, (e.target as Any).item])).toEqual([
        ["deletion.confirmed", undefined],
        ["item.created", opened?.id],
        ["item.superseded", before[0]],
      ]);
      expect(events[1]?.target).toMatchObject({
        type: "awaiting_confirmation",
        reason: "conflict_cleared_by_deletion",
        entity,
      });
      await replaysTheSame();
      // The same handle again: the item lists rebuilt from the deletion's operation; what the log
      // does not keep apart (the values put in effect) is listed as omitted.
      const again = await confirm(binding);
      expect(again.replayed).toBe(true);
      expect([again.superseded, again.superseded_total]).toEqual([receipt.superseded, 1]);
      expect([again.now_awaiting, again.now_awaiting_total]).toEqual([receipt.now_awaiting, 1]);
      expect(again.omitted).toEqual(["rows", "lists"]);
      expect(again.now_effective_total).toBe(receipt.now_effective_total);
    },
    T,
  );

  it(
    "an open item's entry the deletion lists, its members unchanged: refreshed (entries_deleted), still open",
    async () => {
      // As above; deleting #1's words: #2 still gives 35 and #3 is still a candidate against it,
      // but the item's entry of the merge base rests on #1's contribution and is listed.
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
      const item = (await openItems())[0] as string;
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("lunch was 45")],
      });
      const receipt = await confirm(binding);
      expect(receipt.superseded).toEqual([]);
      expect(await openItems()).toEqual([item]);
      const events = await opEvents(receipt.seq);
      expect(events.map((e) => [e.type, e.target])).toEqual([
        ["deletion.confirmed", expect.objectContaining({ deletion: receipt.deletion.id })],
        ["item.refreshed", { item, cause: "entries_deleted" }],
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "one of an item's candidates deleted, another still in conflict: refreshed with dropped_candidates, still open",
    async () => {
      // #1 45; #2 35 having seen #1; #3 30 and #4 25, each having seen #1: candidates against #2.
      // Deleting #3's words: #3 leaves the item, #4 is still a candidate in it.
      const { row, first } = await lunch();
      const stale = (amount: string, words: string) =>
        w(
          [{ intent: "correct", table: "lunches", row, ver: first.ops[0].ver, set: { amount } }],
          words,
        );
      await stale("30", "it was 30");
      await stale("25", "it was 25");
      const items = await openItems();
      expect(items).toHaveLength(1);
      const item = items[0] as string;
      const before = await s.store.read(async (tx) =>
        (
          await tx.query<{ path: string }>(
            "SELECT content_path AS path FROM pending_entries WHERE item_id = $1 AND content_path LIKE 'candidates/%'",
            [item],
          )
        ).rows
          .map((x) => Number(x.path.split("/")[1]))
          .sort((a, b) => a - b),
      );
      expect(before).toHaveLength(2);
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("it was 30")],
      });
      const receipt = await confirm(binding);
      expect(receipt.superseded).toEqual([]);
      expect(await openItems()).toEqual([item]);
      const events = await opEvents(receipt.seq);
      expect(events.map((e) => [e.type, e.target])).toEqual([
        ["deletion.confirmed", expect.objectContaining({ deletion: receipt.deletion.id })],
        // #3's candidate is the first the item was given.
        ["item.refreshed", { item, cause: "entries_deleted", dropped_candidates: [before[0]] }],
      ]);
      const read = await query(s.store, ctx(), { table: "lunches" });
      expect(read.rows.map((x: Any) => x.values.amount)).toEqual(["35"]);
      await replaysTheSame();
      // The candidate that left is no longer the item's: its entry is gone, taking it is refused.
      expect(
        await s.store.read(async (tx) =>
          (
            await tx.query<{ path: string }>(
              "SELECT content_path AS path FROM pending_entries WHERE item_id = $1 AND content_path LIKE 'candidates/%' ORDER BY 1",
              [item],
            )
          ).rows.map((x) => x.path),
        ),
      ).toEqual([`candidates/${before[1]}`]);
      const iv = await s.store.read(async (tx) => {
        const r = await tx.query<{ v: unknown }>(
          "SELECT version_op AS v FROM pending_items WHERE id = $1",
          [item],
        );
        return `iv_${item.slice(3)}.${Number(r.rows[0]?.v)}.0`;
      });
      const e = await thrown(() =>
        resolve$(s.store, ctx(), {
          id: item,
          item_ver: iv,
          decision: "take_candidate",
          candidate: before[0],
        }),
      );
      expect([e?.code, e?.detail?.reason]).toEqual(["invalid_argument", "index_out_of_range"]);
      // Named or not, the one left is the only candidate to take: 25.
      const took: Any = await resolve$(s.store, ctx(), {
        id: item,
        item_ver: iv,
        decision: "take_candidate",
        idempotency_key: "k-once",
      });
      // The same decision again, by another request key: a repeat of the resolved item's decision
      // (the one candidate left, as before), its receipt again, not item_closed.
      const again: Any = await resolve$(s.store, ctx(), {
        id: item,
        item_ver: iv,
        decision: "take_candidate",
      });
      expect(again.replayed).toBe(true);
      const { replayed: _r, ...rest } = again;
      const { replayed: _f, ...firstRest } = took;
      expect(rest).toEqual(firstRest);
      const taken = await query(s.store, ctx(), { table: "lunches" });
      expect(taken.rows.map((x: Any) => x.values.amount)).toEqual(["25"]);
    },
    T,
  );

  it(
    "part of a candidate deleted, the rest still a candidate: given again at its index",
    async () => {
      // a and b go together (one conflict unit). #1 1/1; #2 2/2 having seen #1; #3 3/3 having
      // seen #1, each field on its own words: one candidate of both fields against #2. Deleting the
      // words of b takes #3's b away; its a is still a candidate, given again as candidates/0.
      const r1 = await w([{ intent: "insert", table: "pairs", set: { a: "1", b: "1" } }], "pair 1");
      const row = r1.ops[0].target.row as string;
      const ver = r1.ops[0].ver;
      await w([{ intent: "correct", table: "pairs", row, ver, set: { a: "2", b: "2" } }], "pair 2");
      await write(s.store, ctx(), {
        sv: 1,
        evidence: [
          { kind: "user_message", text: "a is 3" },
          { kind: "user_message", text: "b is 3" },
        ],
        ops: [
          {
            intent: "correct",
            table: "pairs",
            row,
            ver,
            set: { a: "3", b: "3" },
            evidence_by_field: { a: [0], b: [1] },
          },
        ],
      } as never);
      const item = (await openItems())[0] as string;
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("b is 3")],
      });
      const receipt = await confirm(binding);
      expect(await openItems()).toEqual([item]);
      const given = await s.store.read(async (tx) =>
        (
          await tx.query<{ path: string; body: string }>(
            `SELECT c.path, c.body FROM content c JOIN events e ON e.seq = c.seq
             WHERE e.op = $1 AND e.type = 'item.refreshed' AND c.path LIKE 'candidates/%'`,
            [receipt.seq],
          )
        ).rows.map((x) => [x.path, JSON.parse(x.body)]),
      );
      // By field ID: a is the table's first field (f1), b its second.
      expect(given.map(([p, b]) => [p, b.items.map((x: Any) => [x.field, x.value])])).toEqual([
        ["candidates/0", [["f1", "3"]]],
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "an item on the listed row resolved since the preview: preview_outdated",
    async () => {
      // #1 45; #2 35 having seen #1; #3 30 having seen #1: a candidate against #2. The preview of
      // deleting #2's words supersedes the item; a person keeps #2's value before the confirmation.
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
      const item = (await openItems())[0] as string;
      const { binding } = await previewDeletion(s.store, {
        sources: [await sourceId("no, lunch was 35")],
      });
      await resolve$(s.store, ctx(), { id: item, decision: "keep_effective" });
      expect(await openItems()).toEqual([]);
      const e = await thrown(() => confirm(binding));
      expect(e?.code).toBe("preview_outdated");
      expect(e?.detail?.binding?.hash).not.toBe(binding.hash);
      expect((await anchor.read(TENANT as never)).deletions).toEqual([]);
    },
    T,
  );

  for (const words of ["a is x", "b is x"]) {
    it(
      `a flagged item whose rows the deletion changes (${words}): pending_items_touched`,
      async () => {
        // B written with A's name: a flagged item on B lists A. Its supersession or refresh is not
        // made yet: refused whole, the item left as it is.
        await w([{ intent: "insert", table: "dups", set: { name: "x" } }], "a is x");
        await w([{ intent: "insert", table: "dups", set: { name: "x" } }], "b is x");
        const flagged = await s.store.read(async (tx) =>
          (
            await tx.query<{ id: string }>(
              "SELECT id FROM pending_items WHERE state = 'open' AND type = 'flagged'",
            )
          ).rows.map((x) => x.id),
        );
        expect(flagged).toHaveLength(1);
        await refusedAs([await sourceId(words)], "pending_items_touched");
      },
      T,
    );
  }

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
