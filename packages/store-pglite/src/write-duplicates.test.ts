// Duplicate keys when writing (03-data-model/04-write-and-read.md «疑似重复»; 09-event-format.md
// §5.7 `duplicate`, §5.8 `item.created` of a flagged item): a row created and in effect is compared
// once with the table's rows in effect, the request's earlier ops included; a match is recorded on
// its `write.base` and opens a flagged item; the write is saved all the same. Every case ends with
// the log replayed into an empty storage. Fictional names.

import {
  createOpsContext,
  createTenant,
  query,
  readTail,
  reconcileLog,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"6".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

/** Meals: the same day and the same energy is likely written twice; so is the same note. */
const MEALS = {
  name: "meals",
  kind: "base",
  description: "one row per meal",
  time: { type: "event", field: "day" },
  fields: [
    { name: "day", type: "date", required: true, description: "the day" },
    { name: "energy", type: "quantity", unit: "kcal", description: "energy" },
    { name: "note", type: "text", description: "what it was" },
  ],
  duplicate_keys: [["day", "energy"], ["note"]],
};
/** Synced from a band by its ID there, and written by hand: the same meal may come in twice. */
const SYNCED = {
  name: "synced",
  kind: "base",
  description: "meals, some synced",
  time: { type: "none" },
  external_key: ["external_id"],
  fields: [
    { name: "external_id", type: "text", description: "the band's ID" },
    { name: "day", type: "date", description: "the day" },
    { name: "note", type: "text", description: "what it was" },
  ],
  duplicate_keys: [["day", "note"]],
};
/** No duplicate keys: never compared. */
const PLAIN = {
  name: "plain",
  kind: "base",
  description: "no keys",
  time: { type: "none" },
  fields: [{ name: "a", type: "text", description: "a" }],
};

let s: ReusableStore;
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
    now: `2026-11-05T05:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
const rows = async (q: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(q, params as never))).rows as Record<string, unknown>[];
const tail = async () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);
const w = (ops: unknown[]): Promise<Any> => write(s.store, ctx("w"), { sv: 1, ops });
const meal = (set: Record<string, unknown>) => ({ intent: "insert", table: "meals", set });
/** The `duplicate` blocks and flagged items logged since `after`. */
async function logged(after: number) {
  const dup = await rows(
    `SELECT e.seq, e.target_row, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'duplicate'
     WHERE e.type = 'write.base' AND e.seq > $1 ORDER BY e.seq`,
    [after],
  );
  const items = await rows(
    `SELECT e.seq, t.body AS target FROM events e JOIN content t ON t.seq = e.seq AND t.path = 'target'
     WHERE e.type = 'item.created' AND e.seq > $1 ORDER BY e.seq`,
    [after],
  );
  const matched = await rows(
    `SELECT e.seq, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path LIKE 'matched/%'
     WHERE e.type = 'item.created' AND e.seq > $1 ORDER BY e.seq, c.path`,
    [after],
  );
  return {
    duplicate: dup.map((x) => ({ row: x["target_row"], ...JSON.parse(x["body"] as string) })),
    items: items.map((x) => JSON.parse(x["target"] as string)),
    matched: matched.map((x) => JSON.parse(x["body"] as string).row),
  };
}
const replaysTheSame = async () => {
  const r = await reconcileLog({ live: s.store, scratch: scratch.store });
  expect(r.mismatches).toEqual([]);
  expect(r.mismatches_total).toBe(0);
};

beforeAll(async () => {
  s = await openReusable("saveslot-write-duplicates-");
  scratch = await openReusable("saveslot-write-duplicates-scratch-");
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
  await schemaDraft(s.store, ctx("schema"), {
    document: {
      slot: "food",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [MEALS, PLAIN, SYNCED],
    },
  });
}, T);

describe("a row created, compared once", () => {
  it(
    "a match: saved, the write.base records it, a flagged item opens and the row reads flagged",
    async () => {
      const first = await w([meal({ day: "2026-11-01", energy: { value: 600, unit: "kcal" } })]);
      const a = first.ops[0].target.row;
      const before = await tail();
      const r = await w([
        meal({ day: "2026-11-01", energy: { value: 600, unit: "kcal" }, note: "x" }),
      ]);
      expect(r.status).toBe("saved");
      const b = r.ops[0].target.row;
      expect(r.pending).toEqual([
        expect.objectContaining({ type: "flagged", reason: "duplicate_keys" }),
      ]);
      const l = await logged(before);
      expect(l.duplicate).toEqual([
        { row: b, matched: [a], keys: ["f1", "f2"], deps: expect.any(Array) },
      ]);
      expect(l.duplicate[0].deps).toHaveLength(2);
      expect(l.items).toEqual([
        expect.objectContaining({ type: "flagged", reason: "duplicate_keys", row: b }),
      ]);
      expect(l.matched).toEqual([a]);
      const read = await query(s.store, ctx("r"), { table: "meals" });
      const flagged = read.rows.find((x: Any) => x.row === b) as Any;
      expect(flagged.marks?.flagged).toEqual([
        expect.objectContaining({ item: r.pending[0].id, reason: "duplicate_keys" }),
      ]);
      await replaysTheSame();
    },
    T,
  );

  it(
    "no match; a field empty on either side matches nothing; a table without keys is never compared",
    async () => {
      await w([meal({ day: "2026-11-01", energy: { value: 600, unit: "kcal" } })]);
      const before = await tail();
      await w([meal({ day: "2026-11-02", energy: { value: 600, unit: "kcal" } })]);
      await w([meal({ day: "2026-11-01" })]);
      await w([{ intent: "insert", table: "plain", set: { a: "1" } }]);
      await w([{ intent: "insert", table: "plain", set: { a: "1" } }]);
      expect(await logged(before)).toEqual({ duplicate: [], items: [], matched: [] });
      await replaysTheSame();
    },
    T,
  );

  it(
    "the second group matches; the same value in another unit counts (10 «同值判据»)",
    async () => {
      const a = (await w([meal({ day: "2026-11-01", note: "noodles" })])).ops[0].target.row;
      const before = await tail();
      await w([meal({ day: "2026-11-03", note: "noodles" })]);
      let l = await logged(before);
      expect(l.duplicate).toEqual([expect.objectContaining({ matched: [a], keys: ["f3"] })]);
      const c = (await w([meal({ day: "2026-11-04", energy: { value: 1, unit: "kcal" } })])).ops[0]
        .target.row;
      const mid = await tail();
      await w([meal({ day: "2026-11-04", energy: { value: 4.184, unit: "kJ" } })]);
      l = await logged(mid);
      expect(l.duplicate).toEqual([expect.objectContaining({ matched: [c], keys: ["f1", "f2"] })]);
      await replaysTheSame();
    },
    T,
  );
});

describe("the request's own earlier ops count", () => {
  it(
    "two equal inserts in one request: the second is flagged with the first, the first is not",
    async () => {
      const before = await tail();
      const r = await w([
        meal({ note: "rice", day: "2026-11-01" }),
        meal({ note: "rice", day: "2026-11-02" }),
      ]);
      const [a, b] = r.ops.map((x: Any) => x.target.row);
      const l = await logged(before);
      expect(l.duplicate).toEqual([
        expect.objectContaining({ row: b, matched: [a], keys: ["f3"] }),
      ]);
      expect(l.items).toHaveLength(1);
      await replaysTheSame();
    },
    T,
  );

  it(
    "a row changed to match earlier in the request matches; one revoked earlier does not",
    async () => {
      const a = (await w([meal({ note: "soup", day: "2026-11-01" })])).ops[0].target.row;
      const before = await tail();
      // a's note made "tea" by an earlier op, then a new row with "tea": a matches.
      await w([
        { intent: "update", table: "meals", row: a, set: { note: "tea" } },
        meal({ note: "tea", day: "2026-11-05" }),
      ]);
      let l = await logged(before);
      expect(l.duplicate).toEqual([expect.objectContaining({ matched: [a], keys: ["f3"] })]);
      // Revoked by an earlier op, then a new row like it: no match.
      const mid = await tail();
      await w([
        { intent: "revoke", table: "meals", row: a },
        meal({ note: "tea", day: "2026-11-06" }),
      ]);
      l = await logged(mid);
      // The row of #… before is still there and not revoked: it alone matches.
      expect(l.duplicate.every((d: Any) => !d.matched.includes(a))).toBe(true);
      await replaysTheSame();
    },
    T,
  );
});

describe("the order of rows the request touched but did not write in effect (fixed cases)", () => {
  it(
    "a no-op or a candidate on a row earlier in the request leaves its last write where it was",
    async () => {
      const ra = await w([meal({ note: "k", day: "2026-11-01" })]);
      const a = ra.ops[0].target.row;
      const seenA = ra.ops[0].ver;
      const x = (await w([meal({ note: "zz", day: "2026-11-02" })])).ops[0].target.row;
      await w([{ intent: "update", table: "meals", row: x, set: { note: "k" } }]);
      // a written after x was made like it, then x again: x is the latest written of the two.
      await w([{ intent: "update", table: "meals", row: a, set: { day: "2026-11-03" } }]);
      await w([{ intent: "update", table: "meals", row: x, set: { day: "2026-11-04" } }]);
      // A no-op on a before the new row: a is not written in effect by this request.
      let before = await tail();
      const r1 = await w([
        { intent: "update", table: "meals", row: a, set: { day: "2026-11-03" } },
        meal({ note: "k", day: "2026-11-05" }),
      ]);
      const n1 = r1.ops[1].target.row;
      expect((await logged(before)).duplicate).toEqual([
        expect.objectContaining({ row: n1, matched: [x, a] }),
      ]);
      // A stale write on a, a candidate, before the new row: the same.
      before = await tail();
      const r2 = await w([
        { intent: "update", table: "meals", row: a, ver: seenA, set: { day: "2026-11-06" } },
        meal({ note: "k", day: "2026-11-07" }),
      ]);
      expect(r2.status).toBe("pending");
      const n2 = r2.ops[1].target.row;
      expect((await logged(before)).duplicate).toEqual([
        expect.objectContaining({ row: n2, matched: [n1, x, a] }),
      ]);
      // A write in effect on a earlier in the request: a is this operation's, the first.
      before = await tail();
      const r3 = await w([
        { intent: "update", table: "meals", row: a, set: { day: "2026-11-08" } },
        meal({ note: "k", day: "2026-11-09" }),
      ]);
      const n3 = r3.ops[1].target.row;
      expect((await logged(before)).duplicate).toEqual([
        expect.objectContaining({ row: n3, matched: [a, n2, n1, x] }),
      ]);
      // a now the latest written (with n3, by the same operation); a no-op on it in the request
      // keeps it there, ahead of the older rows.
      before = await tail();
      const r4 = await w([
        { intent: "update", table: "meals", row: a, set: { day: "2026-11-08" } },
        meal({ note: "k", day: "2026-11-10" }),
      ]);
      expect((await logged(before)).duplicate).toEqual([
        expect.objectContaining({
          row: r4.ops[1].target.row,
          matched: [...[a, n3].sort(), n2, n1, x],
        }),
      ]);
      await replaysTheSame();
    },
    T,
  );
});

describe("what is not compared", () => {
  it(
    "a revoked row; an update or a correction making a row like another is not judged",
    async () => {
      const a = (await w([meal({ note: "pie", day: "2026-11-01" })])).ops[0].target.row;
      await w([{ intent: "revoke", table: "meals", row: a }]);
      const before = await tail();
      await w([meal({ note: "pie", day: "2026-11-02" })]);
      const b = (await w([meal({ note: "cake", day: "2026-11-03" })])).ops[0].target.row;
      const c = (await w([meal({ note: "tart", day: "2026-11-04" })])).ops[0].target.row;
      // b and c are not alike; c made like b by an update: not a new row, not judged.
      await w([{ intent: "update", table: "meals", row: c, set: { note: "cake" } }]);
      expect(b).not.toBe(c);
      expect(await logged(before)).toEqual({ duplicate: [], items: [], matched: [] });
      await replaysTheSame();
    },
    T,
  );
});

describe("candidates are not values in effect", () => {
  it(
    "a stale write's value, a candidate, matches nothing; the value in effect does",
    async () => {
      const first = await w([meal({ note: "a", day: "2026-11-01" })]);
      const x = first.ops[0].target.row;
      const seen = first.ops[0].ver;
      await w([{ intent: "update", table: "meals", row: x, set: { note: "c" } }]);
      // Written on the version before "c": a candidate.
      const stale = await w([
        { intent: "update", table: "meals", row: x, ver: seen, set: { note: "b" } },
      ]);
      expect(stale.status).toBe("pending");
      const before = await tail();
      await w([meal({ note: "b", day: "2026-11-02" })]);
      expect((await logged(before)).duplicate).toEqual([]);
      const mid = await tail();
      await w([meal({ note: "c", day: "2026-11-03" })]);
      expect((await logged(mid)).duplicate).toEqual([
        expect.objectContaining({ matched: [x], keys: ["f3"] }),
      ]);
      await replaysTheSame();
    },
    T,
  );
});

describe("at most 10 rows, latest written first", () => {
  it(
    "12 alike: the 10 written last are listed, latest first",
    async () => {
      const made: string[] = [];
      for (let i = 0; i < 12; i++)
        made.push(
          (await w([meal({ note: "same", day: `2026-10-${String(i + 1).padStart(2, "0")}` })]))
            .ops[0].target.row,
        );
      // The rows written so far were each flagged against the earlier ones; only the last write
      // here is looked at.
      const before = await tail();
      await w([meal({ note: "same", day: "2026-11-01" })]);
      const l = await logged(before);
      expect(l.duplicate[0].matched).toEqual(made.slice(2).reverse());
      expect(l.matched).toEqual(made.slice(2).reverse());
      await replaysTheSame();
    },
    T,
  );
});

describe("a row created by external key (04 «与已有机制的关系»: created by key, compared as any new row)", () => {
  const byKey = (id: string, set: Record<string, unknown>) => ({
    intent: "update",
    table: "synced",
    external_key: { external_id: id },
    set,
  });

  it(
    "an update by key creating a row is compared (its intent is not insert); one meeting a row again is not",
    async () => {
      const hand = (
        await w([{ intent: "insert", table: "synced", set: { day: "2026-11-01", note: "salad" } }])
      ).ops[0].target.row;
      const before = await tail();
      const created = await w([byKey("m-1", { day: "2026-11-01", note: "salad" })]);
      expect(created.ops[0]).toMatchObject({ outcome: "created", intent: "update" });
      const row = created.ops[0].target.row;
      let l = await logged(before);
      expect(l.duplicate).toEqual([
        expect.objectContaining({ row, matched: [hand], keys: ["f2", "f3"] }),
      ]);
      expect(l.items).toEqual([expect.objectContaining({ type: "flagged", row })]);
      // A key met again: the row is not created, so not compared, even made like another row.
      // (The flagged row itself is not written here: writing a row with a flagged item waits for
      // superseding and refreshing flagged items. Another key's row is.)
      const other = await w([byKey("m-2", { day: "2026-11-02", note: "soup" })]);
      expect(other.ops[0]).toMatchObject({ outcome: "created" });
      const mid = await tail();
      const again = await w([byKey("m-2", { day: "2026-11-02", note: "soup" })]);
      expect(again.ops[0]?.outcome).toBe("unchanged");
      const moved = await w([byKey("m-2", { day: "2026-11-01", note: "salad" })]);
      expect(moved.ops[0]?.outcome).toBe("updated");
      l = await logged(mid);
      expect(l).toEqual({ duplicate: [], items: [], matched: [] });
      await replaysTheSame();
    },
    T,
  );
  it(
    "one request: a key met again unchanged (left out of the log), then a key creating a row like it: one match, listed once",
    async () => {
      const m2 = (await w([byKey("m-2", { day: "2026-11-02", note: "soup" })])).ops[0].target.row;
      const before = await tail();
      const r = await w([
        byKey("m-2", { day: "2026-11-02", note: "soup" }),
        byKey("m-3", { day: "2026-11-02", note: "soup" }),
      ]);
      expect(r.ops.map((o: Any) => o.outcome)).toEqual(["unchanged", "created"]);
      const m3 = r.ops[1].target.row;
      const l = await logged(before);
      expect(l.duplicate).toEqual([expect.objectContaining({ row: m3, matched: [m2] })]);
      expect(l.items).toEqual([expect.objectContaining({ type: "flagged", row: m3 })]);
      expect(l.matched).toEqual([m2]);
      await replaysTheSame();
    },
    T,
  );
});
