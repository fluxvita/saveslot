// Reads by record time of a row a deletion took something from (03-data-model/03-deletion.md
// «删除后的样子是一个新版本», «版本表»): the version table keeps the earlier versions, but what a
// removed contribution gave there is not readable while the deletion is pending (and, for a
// value the write's own block gave, once it is carried out); that place is marked
// `partially_deleted`. `history`'s `as_of` and `changes`, and a
// query's later page read as of its first page's operation. A cancellation makes it readable
// again. Fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  confirmDeletion,
  createOpsContext,
  createTenant,
  history,
  previewDeletion,
  query,
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
  fields: [
    { name: "amount", type: "text", required: true, description: "what it cost" },
    { name: "place", type: "text", description: "where" },
  ],
};
const BUDGET = {
  name: "budget",
  kind: "base",
  description: "the monthly budget over time",
  time: { type: "state", granularity: "date" },
  fields: [
    { name: "amount", type: "text", required: true, description: "how much" },
    { name: "note", type: "text", description: "a note" },
  ],
};
const PEOPLE = {
  name: "people",
  kind: "base",
  description: "a person",
  time: { type: "none" },
  fields: [
    { name: "name", type: "text", required: true, description: "who" },
    { name: "tag", type: "text", description: "a tag" },
  ],
};
const MEALS = {
  name: "meals",
  kind: "base",
  description: "a meal",
  time: { type: "event", field: "day" },
  fields: [
    { name: "day", type: "date", required: true, description: "when" },
    { name: "person", type: "ref", description: "who", ref: { table: "people", target: "row" } },
  ],
};

let s: ReusableStore;
let dir: string;
let anchor: AnchorStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "w",
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-10T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
let n = 0;
const w = (words: string, ops: unknown[]): Promise<Any> =>
  write(s.store, ctx(), {
    sv: 1,
    evidence: [{ kind: "user_message", text: words }],
    idempotency_key: `k-${++n}`,
    ops,
  });
const text = (x: unknown) => JSON.stringify(x);

/** The source whose text is `words`: its ID and its event. */
const sourceOf = (words: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ source_id: string; seq: unknown }>(
      `SELECT so.source_id, so.seq FROM sources so JOIN content c ON c.seq = so.seq
       WHERE c.path = 'text' AND c.body LIKE $1`,
      [`%${words}%`],
    );
    return { id: r.rows[0]?.source_id as string, seq: Number(r.rows[0]?.seq) };
  });
const compiledOf = (name: string) =>
  s.store.read(async (tx) => {
    const r = await tx.query<{ body: string; slot_id: string }>(
      `SELECT c.body, v.slot_id FROM schema_versions v
       JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled' WHERE v.state = 'current'`,
    );
    const tables = JSON.parse(r.rows[0]?.body as string).tables as Any[];
    return { table: tables.find((t) => t.name === name), slot: r.rows[0]?.slot_id as string };
  });

/** Deletes the sources `words` (one deletion), by a confirmed deletion; its receipt. */
async function deleteSource(...words: string[]): Promise<Any> {
  const ids = [];
  for (const x of words) ids.push((await sourceOf(x)).id);
  const { binding } = await previewDeletion(s.store, { sources: ids });
  return confirmDeletion(s.store, anchor, ctx(), { binding, handle: `dc_${++n}` });
}

/**
 * The blocks pending deletions list, cleared as carrying a deletion out clears them (their bodies
 * gone, recorded as removed, no longer pending): the store as after a tombstone, at storage level.
 */
const carriedOut = () =>
  s.store.write(async (tx) => {
    await tx.query(
      `UPDATE content c SET body = NULL, checksum = NULL, removed_by = p.deletion_seq
       FROM pending_blocks p WHERE c.seq = p.seq AND c.path = p.path`,
    );
    await tx.query("DELETE FROM pending_blocks");
  });

const asOf = (table: string, target: Record<string, string>, op: number, more = {}) =>
  history(s.store, ctx(), { table, ...target, mode: "as_of", as_of: op, ...more }) as Promise<Any>;
const changesSince = (table: string, since: number) =>
  history(s.store, ctx(), { table, mode: "changes", since }) as Promise<Any>;

beforeAll(async () => {
  s = await openReusable("saveslot-history-pending-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-history-pending-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: {
      slot: "home",
      base_version: null,
      timezone: "UTC",
      tables: [LUNCH, BUDGET, PEOPLE, MEALS],
    },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A lunch of 45 at home, corrected to 35 at the cafe by words then deleted. */
async function lunchCorrected() {
  const a = await w("lunch was 45 at home", [
    { intent: "insert", table: "lunches", set: { amount: "45", place: "home" } },
  ]);
  const row = a.ops[0].target.row as string;
  const b = await w("DELETED-WORDS: 35 at the cafe", [
    { intent: "correct", table: "lunches", row, set: { amount: "35", place: "CAFE-SECRET" } },
  ]);
  return { row, a: a.seq as number, b: b.seq as number };
}

describe("history as_of: what a removed contribution gave is not given, the row marked", () => {
  it(
    "timeless table: pending, carried out, and cancelled",
    async () => {
      const { row, a, b } = await lunchCorrected();
      expect((await asOf("lunches", { row }, b)).rows[0].values).toEqual({
        amount: "35",
        place: "CAFE-SECRET",
      });
      const del = await deleteSource("DELETED-WORDS");
      const pending = await asOf("lunches", { row }, b);
      expect(text(pending)).not.toContain("CAFE-SECRET");
      expect(text(pending)).not.toContain('"35"');
      expect(pending.rows[0].values).toEqual({});
      expect(pending.rows[0].marks).toMatchObject({ partially_deleted: true });
      // Before the correction, and after the deletion: nothing removed there.
      const before = await asOf("lunches", { row }, a);
      expect(before.rows[0].values).toEqual({ amount: "45", place: "home" });
      expect(before.rows[0].marks?.partially_deleted).toBeUndefined();
      const after = await asOf("lunches", { row }, del.seq);
      expect(after.rows[0].values).toEqual({ amount: "45", place: "home" });
      expect(after.rows[0].marks?.partially_deleted).toBeUndefined();
      // `detailed`: the fields' sources are not given either.
      expect(text(await asOf("lunches", { row }, b, { detail: "detailed" }))).not.toContain(
        "CAFE-SECRET",
      );
      // Cancelled: readable again.
      const { table, slot } = await compiledOf("lunches");
      await cancelDeletion(s.store, {
        slot,
        table,
        row,
        sources: [(await sourceOf("DELETED-WORDS")).seq],
        id: del.deletion.id,
        actor: USER,
        now: ctx().now,
      });
      const back = await asOf("lunches", { row }, b);
      expect(back.rows[0].values).toEqual({ amount: "35", place: "CAFE-SECRET" });
      expect(back.rows[0].marks?.partially_deleted).toBeUndefined();
    },
    T,
  );

  // Carried out, the giver being the write's own block: it is still found once cleared (by the
  // cell's own src_event, src_field, src_k), so the value stays withheld. Not so for a giver that
  // is a restatement, found by what its cleared body named: after execution is open
  // (08-open-questions), and this version does not reach that state.
  it(
    "carried out, the giver the write's own block: still not given",
    async () => {
      const { row, b } = await lunchCorrected();
      await deleteSource("DELETED-WORDS");
      await carriedOut();
      const r = await asOf("lunches", { row }, b);
      expect(text(r)).not.toContain("CAFE-SECRET");
      expect(r.rows[0].marks).toMatchObject({ partially_deleted: true });
    },
    T,
  );

  it(
    "state table: the stretch the removed write gave is still there, its value not given",
    async () => {
      const a = await w("budget is 5000 from october", [
        { intent: "insert", table: "budget", valid_from: "2026-10-01", set: { amount: "5000" } },
      ]);
      const entity = a.ops[0].target.entity as string;
      const b = await w("DELETED-WORDS: 4000 for ten days", [
        {
          intent: "update",
          table: "budget",
          entity,
          ver: a.ops[0].ver,
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
          set: { amount: "SECRET-4000" },
        },
      ]);
      await deleteSource("DELETED-WORDS");
      const r = await asOf("budget", { entity }, b.seq);
      expect(text(r)).not.toContain("SECRET-4000");
      expect(
        r.rows.map((x: Any) => [x.valid_from, x.valid_to, x.values, x.marks?.partially_deleted]),
      ).toEqual([
        ["2026-10-01", "2026-11-10", { amount: "5000", note: null }, undefined],
        ["2026-11-10", "2026-11-20", { note: null }, true],
        ["2026-11-20", null, { amount: "5000", note: null }, undefined],
      ]);
    },
    T,
  );
});

describe("history changes: the side a removed contribution gave is not given, the entry marked", () => {
  it(
    "the correction and the deletion, each with the removed side left out",
    async () => {
      const { a } = await lunchCorrected();
      await deleteSource("DELETED-WORDS");
      const r = await changesSince("lunches", a);
      expect(text(r)).not.toContain("CAFE-SECRET");
      expect(text(r)).not.toContain('"35"');
      const entries = r.changes ?? r.rows ?? r.entries;
      expect(entries.length).toBeGreaterThanOrEqual(2);
      for (const e of entries) expect(e.marks ?? e).toMatchObject({ partially_deleted: true });
    },
    T,
  );
});

/** How a read ends: refused with [code, reason], or "given". */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "given",
    (e: { code?: string; detail?: { reason?: string } }) => {
      if (e.code === undefined) throw e;
      return [e.code, e.detail?.reason];
    },
  );

describe("a query's later page, read as of its first page's operation", () => {
  it(
    "after a deletion between the pages: the position expired, read again from the first page",
    async () => {
      // Newest first: the corrected lunch is on the second page.
      await lunchCorrected();
      await w("another lunch", [
        { intent: "insert", table: "lunches", set: { amount: "10", place: "aaa" } },
      ]);
      const first: Any = await query(s.store, ctx(), { table: "lunches", limit: 1 });
      expect(first.rows.map((x: Any) => x.values.amount)).toEqual(["10"]);
      const position = first.next_position ?? first.position ?? first.next;
      expect(position, text(first)).toBeDefined();
      await deleteSource("DELETED-WORDS");
      // What is not given changed between the pages: the position expired (04-contract §15).
      expect(
        await outcome(query(s.store, ctx(), { table: "lunches", limit: 1, position })),
      ).toEqual(["handle_expired", "deletion_changed"]);
      // Read again from the first page: the removed value is not there.
      const again: Any = await query(s.store, ctx(), { table: "lunches" });
      expect(text(again)).not.toContain("CAFE-SECRET");
    },
    T,
  );
});

describe("what the deletion itself gave, and the other reads by record time", () => {
  it(
    "a value the deletion restated is given, unmarked; a later page agrees with the first page",
    async () => {
      // 4000; a source later deleted corrects it; 6000; an undo of the 6000 writes back the
      // deleted source's value; the deletion restates that write-back as 4000, keeping its k.
      const w0 = await w("person at 4000", [
        { intent: "insert", table: "people", set: { name: "v4000", tag: "x" } },
      ]);
      const row = w0.ops[0].target.row as string;
      const a = await w("DELETED-WORDS: NAME-SECRET", [
        { intent: "correct", table: "people", row, set: { name: "NAME-SECRET" } },
      ]);
      const b = await w("six", [
        { intent: "correct", table: "people", row, set: { name: "v6000" } },
      ]);
      const u = await w("undo six", [
        { table: "people", row, ver: b.ops[0].ver, revert: { undo: b.seq } },
      ]);
      // Another person after, so that this one is on the second page of a query.
      await w("another", [{ intent: "insert", table: "people", set: { name: "other", tag: "y" } }]);
      const first: Any = await query(s.store, ctx(), { table: "people", limit: 1 });
      const del = await deleteSource("DELETED-WORDS");
      // One more after the deletion: this person (versioned by the deletion) on page two again.
      await w("a third", [{ intent: "insert", table: "people", set: { name: "third", tag: "z" } }]);
      const now: Any = await query(s.store, ctx(), { table: "people" });
      expect(now.rows.find((x: Any) => x.row === row).values).toEqual({ name: "v4000", tag: "x" });
      const atDeletion = await asOf("people", { row }, del.seq);
      expect(atDeletion.rows[0].values).toEqual({ name: "v4000", tag: "x" });
      expect(atDeletion.rows[0].marks?.partially_deleted).toBeUndefined();
      for (const op of [a.seq, u.seq]) {
        const r = await asOf("people", { row }, op);
        expect(text(r)).not.toContain("NAME-SECRET");
        expect(r.rows[0].marks).toMatchObject({ partially_deleted: true });
      }
      // A page read as of an operation after the deletion: as a first page in that state.
      const again: Any = await query(s.store, ctx(), { table: "people", limit: 1 });
      const later: Any = await query(s.store, ctx(), {
        table: "people",
        limit: 1,
        position: again.next_position,
      });
      expect(later.rows[0].values).toEqual({ name: "v4000", tag: "x" });
      expect(later.rows[0].marks?.partially_deleted).toBeUndefined();
      // And the later page of a first page from before the deletion: its position expired
      // (04-contract §15); read by record time, the value is withheld (as `atDeletion` shows).
      expect(
        await outcome(
          query(s.store, ctx(), { table: "people", limit: 1, position: first.next_position }),
        ),
      ).toEqual(["handle_expired", "deletion_changed"]);
    },
    T,
  );

  it(
    "a state table over an interval: the later page expired, the stretch withheld by record time",
    async () => {
      const a = await w("budget is 5000 from october", [
        { intent: "insert", table: "budget", valid_from: "2026-10-01", set: { amount: "5000" } },
      ]);
      const entity = a.ops[0].target.entity as string;
      const b = await w("DELETED-WORDS: 4000 for ten days", [
        {
          intent: "update",
          table: "budget",
          entity,
          ver: a.ops[0].ver,
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
          set: { amount: "SECRET-4000" },
        },
      ]);
      const during = { table: "budget", valid_during: ["2026-10-01", null], limit: 1 };
      const first: Any = await query(s.store, ctx(), during);
      expect(first.rows[0].valid_from).toBe("2026-10-01");
      await deleteSource("DELETED-WORDS");
      expect(
        await outcome(query(s.store, ctx(), { ...during, position: first.next_position })),
      ).toEqual(["handle_expired", "deletion_changed"]);
      // Read by record time as of the removed write: its stretch, the value withheld and marked.
      const r = await asOf("budget", { entity }, b.seq);
      expect(text(r)).not.toContain("SECRET-4000");
      const stretch = r.rows.find((x: Any) => x.valid_from === "2026-11-10");
      expect(stretch, text(r)).toBeDefined();
      expect(stretch.marks).toMatchObject({ partially_deleted: true });
    },
    T,
  );

  it(
    "timeline: an operation's value before, when a removed contribution gave it, is not given",
    async () => {
      const { row } = await lunchCorrected();
      await w("now the bistro", [
        { intent: "correct", table: "lunches", row, set: { place: "bistro" } },
      ]);
      expect(text(await history(s.store, ctx(), { table: "lunches", row }))).toContain(
        "CAFE-SECRET",
      );
      await deleteSource("DELETED-WORDS");
      const t = await history(s.store, ctx(), { table: "lunches", row });
      expect(text(t)).not.toContain("CAFE-SECRET");
    },
    T,
  );

  it(
    "a referenced row's summary (detailed): the removed value left out, the referring row marked",
    async () => {
      const p = await w("DELETED-WORDS: his name is NAME-SECRET", [
        { intent: "insert", table: "people", set: { name: "NAME-SECRET", tag: "t1" } },
      ]);
      const person = p.ops[0].target.row as string;
      // The tag from a source that stays.
      await w("his tag is t2", [
        { intent: "correct", table: "people", row: person, set: { tag: "t2" } },
      ]);
      const m = await w("a meal with him", [
        { intent: "insert", table: "meals", set: { day: "2026-11-01", person } },
      ]);
      const meal = m.ops[0].target.row as string;
      const before = await asOf("meals", { row: meal }, m.seq, { detail: "detailed" });
      expect(text(before)).toContain("NAME-SECRET");
      await deleteSource("DELETED-WORDS");
      const r = await asOf("meals", { row: meal }, m.seq, { detail: "detailed" });
      expect(text(r)).not.toContain("NAME-SECRET");
      expect(r.rows[0].detail.fields.person.ref.values).toEqual({ tag: "t2" });
      expect(r.rows[0].marks).toMatchObject({ partially_deleted: true });
    },
    T,
  );

  it(
    "a withheld stretch never runs together with neighbours that would read the same",
    async () => {
      // The removed write gives only `note`; withheld, the stretch reads as its neighbours do.
      const a = await w("budget is 5000 from october", [
        { intent: "insert", table: "budget", valid_from: "2026-10-01", set: { amount: "5000" } },
      ]);
      const entity = a.ops[0].target.entity as string;
      const b = await w("DELETED-WORDS: a note for ten days", [
        {
          intent: "update",
          table: "budget",
          entity,
          ver: a.ops[0].ver,
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
          set: { note: "NOTE-SECRET" },
        },
      ]);
      // A query's first page before the deletion: its next page expired after it (04-contract
      // §15). Read by record time, the withheld stretch stays apart from its neighbours.
      const during = { table: "budget", valid_during: ["2026-10-01", null], limit: 1 };
      const first: Any = await query(s.store, ctx(), during);
      await deleteSource("DELETED-WORDS");
      expect(
        await outcome(query(s.store, ctx(), { ...during, position: first.next_position })),
      ).toEqual(["handle_expired", "deletion_changed"]);
      const r = await asOf("budget", { entity }, b.seq);
      expect(text(r)).not.toContain("NOTE-SECRET");
      expect(r.rows.map((x: Any) => [x.valid_from, x.marks?.partially_deleted])).toEqual([
        ["2026-10-01", undefined],
        ["2026-11-10", true],
        ["2026-11-20", undefined],
      ]);
    },
    T,
  );

  it(
    "changes: from one removed value to another is still a change, its entry marked",
    async () => {
      const a = await w("lunch was 45", [
        { intent: "insert", table: "lunches", set: { amount: "45", place: "home" } },
      ]);
      const row = a.ops[0].target.row as string;
      await w("DELETED-ONE", [
        { intent: "correct", table: "lunches", row, set: { place: "SECRET-A" } },
      ]);
      const two = await w("DELETED-TWO", [
        { intent: "correct", table: "lunches", row, set: { place: "SECRET-B" } },
      ]);
      await deleteSource("DELETED-ONE", "DELETED-TWO");
      const r = await changesSince("lunches", a.seq);
      expect(text(r)).not.toContain("SECRET-");
      const entry = r.changes.find((e: Any) => e.seq === two.seq);
      expect(entry, text(r)).toBeDefined();
      expect(entry.partially_deleted).toBe(true);
    },
    T,
  );
});

describe("the block that gave a cell its value, and the deletions confirmed after it was recorded", () => {
  /** 4000 by X; S1 corrects it; 6000; an undo of the 6000 writes back S1's value. */
  async function restatedLater() {
    const w0 = await w("X-WORDS person at 4000", [
      { intent: "insert", table: "people", set: { name: "X-4000", tag: "x" } },
    ]);
    const row = w0.ops[0].target.row as string;
    const a = await w("S1-WORDS", [
      { intent: "correct", table: "people", row, set: { name: "S1-VALUE" } },
    ]);
    const b = await w("six", [{ intent: "correct", table: "people", row, set: { name: "v6000" } }]);
    const u = await w("undo six", [
      { table: "people", row, ver: b.ops[0].ver, revert: { undo: b.seq } },
    ]);
    return { row, w0: w0.seq as number, a: a.seq as number, u: u.seq as number };
  }
  const nameAt = async (row: string, op: number) => {
    const r = await asOf("people", { row }, op);
    return { values: r.rows[0]?.values, partial: r.rows[0]?.marks?.partially_deleted === true };
  };

  it(
    "D1 restates the write-back with X's value; D2 then deletes X: the restated cell is withheld too",
    async () => {
      const { row, u } = await restatedLater();
      const d1 = await deleteSource("S1-WORDS");
      // D1 alone: its own restatement gives X's value, not withheld.
      expect(await nameAt(row, d1.seq)).toEqual({
        values: { name: "X-4000", tag: "x" },
        partial: false,
      });
      expect((await nameAt(row, u)).values).toEqual({ tag: "x" });
      await deleteSource("X-WORDS");
      // D2 lists D1's restatement: the cell recorded at D1 is now of deleted content as well.
      const at19 = await asOf("people", { row }, d1.seq);
      expect(text(at19)).not.toContain("X-4000");
      expect(at19.rows[0].marks).toMatchObject({ partially_deleted: true });
    },
    T,
  );

  it(
    "D1 confirmed then cancelled: nothing is withheld for it any more, before or after",
    async () => {
      const { row, a, u } = await restatedLater();
      const d1 = await deleteSource("S1-WORDS");
      expect((await nameAt(row, a)).partial).toBe(true);
      const { table, slot } = await compiledOf("people");
      await cancelDeletion(s.store, {
        slot,
        table,
        row,
        sources: [(await sourceOf("S1-WORDS")).seq],
        id: d1.deletion.id,
        actor: USER,
        now: ctx().now,
      });
      expect(await nameAt(row, a)).toEqual({
        values: { name: "S1-VALUE", tag: "x" },
        partial: false,
      });
      expect(await nameAt(row, u)).toEqual({
        values: { name: "S1-VALUE", tag: "x" },
        partial: false,
      });
      expect(await nameAt(row, d1.seq)).toEqual({
        values: { name: "X-4000", tag: "x" },
        partial: false,
      });
      // After the cancellation, as now.
      const now: Any = await query(s.store, ctx(), { table: "people" });
      const latest = await nameAt(row, Number(String(now.rows[0].ver).slice(1).split(".")[0]));
      expect(latest).toEqual({ values: now.rows[0].values, partial: false });
    },
    T,
  );

  it(
    "D1 restates, its cancellation restates again, D2 lists only D1's: the cancellation's cell is given",
    async () => {
      const { row } = await restatedLater();
      const d1 = await deleteSource("S1-WORDS");
      const { table, slot } = await compiledOf("people");
      await cancelDeletion(s.store, {
        slot,
        table,
        row,
        sources: [(await sourceOf("S1-WORDS")).seq],
        id: d1.deletion.id,
        actor: USER,
        now: ctx().now,
      });
      const cancelled = await s.store.read(async (tx) => {
        const r = await tx.query<{ seq: unknown }>(
          "SELECT max(seq) AS seq FROM events WHERE type = 'deletion.cancelled'",
        );
        return Number(r.rows[0]?.seq);
      });
      // The cancellation restates the write-back with S1's value again: the cell it records.
      expect(await nameAt(row, cancelled)).toEqual({
        values: { name: "S1-VALUE", tag: "x" },
        partial: false,
      });
      // D2 deletes X: it lists D1's restatement (which carried X's value), not the
      // cancellation's. The name cell the cancellation recorded is given by the cancellation's;
      // the tag X's own insert gave is withheld, as D2 deletes X.
      await deleteSource("X-WORDS");
      expect(await nameAt(row, cancelled)).toEqual({
        values: { name: "S1-VALUE" },
        partial: true,
      });
      // The cell D1 recorded, given by D1's restatement, is withheld now.
      const atD1 = await asOf("people", { row }, d1.seq);
      expect(text(atD1)).not.toContain("X-4000");
    },
    T,
  );
});
