// Reads by record time of a row a deletion took something from (03-data-model/03-deletion.md
// «删除后的样子是一个新版本», «版本表»): the version table keeps the earlier versions, but what a
// removed contribution gave there is not readable while the deletion is pending, nor once it is
// carried out; that place is marked `partially_deleted`. `history`'s `as_of` and `changes`, and a
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
  fields: [{ name: "amount", type: "text", required: true, description: "how much" }],
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

/** Deletes the source `words`, by a confirmed deletion; its receipt. */
async function deleteSource(words: string): Promise<Any> {
  const { binding } = await previewDeletion(s.store, { sources: [(await sourceOf(words)).id] });
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
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH, BUDGET] },
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

  it(
    "carried out: still not given",
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
        ["2026-10-01", "2026-11-10", { amount: "5000" }, undefined],
        ["2026-11-10", "2026-11-20", {}, true],
        ["2026-11-20", null, { amount: "5000" }, undefined],
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

describe("a query's later page, read as of its first page's operation", () => {
  it(
    "after a deletion between the pages: the removed value not given, the row marked",
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
      const second: Any = await query(s.store, ctx(), { table: "lunches", limit: 1, position });
      expect(text(second)).not.toContain("CAFE-SECRET");
      const hit = second.rows.find((x: Any) => x.values.amount !== "10");
      expect(hit, text(second)).toBeDefined();
      expect(hit.marks).toMatchObject({ partially_deleted: true });
    },
    T,
  );
});
