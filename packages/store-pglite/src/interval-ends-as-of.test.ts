// `history` `as_of` on a state entity when an end of a stretch came from content a deletion still
// pending removed (the decision on interval ends of deleted content; 03-data-model/03-deletion
// «版本表»; 04-contract `history`): the end is left out and the stretch marked; a stretch with
// nothing left is not listed; a business time condition only a withheld end could decide does not
// hit; the stretches whose start is withheld come after the others and page by an ordinal; the
// result says something was left out. On real deletions; fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  confirmDeletion,
  createOpsContext,
  createTenant,
  history,
  pending,
  previewDeletion,
  query,
  readBufferOf,
  resolve,
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

const BUDGET = {
  name: "budget",
  kind: "base",
  description: "a budget over time",
  time: { type: "state", granularity: "date" },
  fields: [
    { name: "amount", type: "text", required: true, description: "how much" },
    { name: "note", type: "text", description: "a note" },
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
/** A write of one op with the words given as its evidence (several: one source each). */
const w = (words: string | string[], op: Record<string, unknown>): Promise<Any> =>
  write(s.store, ctx(), {
    sv: 1,
    evidence: (Array.isArray(words) ? words : [words]).map((text) => ({
      kind: "user_message",
      text,
    })),
    idempotency_key: `k-${++n}`,
    ops: [{ table: "budget", ...op }],
  });
const text = (x: unknown) => JSON.stringify(x);

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

async function deleteSource(words: string): Promise<Any> {
  const { binding } = await previewDeletion(s.store, { sources: [(await sourceOf(words)).id] });
  return confirmDeletion(s.store, anchor, ctx(), { binding, handle: `dc_${++n}` });
}
async function cancel(del: Any, entity: string, words: string) {
  const compiled = await compiledOf("budget");
  await cancelDeletion(s.store, {
    slot: compiled.slot,
    table: compiled.table,
    row: entity,
    sources: [(await sourceOf(words)).seq],
    id: del.deletion.id,
    actor: USER,
    now: ctx().now,
  });
}

/** The write's pending item confirmed, when it has one; else the write. */
async function confirmFirst(wr: Any): Promise<Any> {
  const item = wr.pending?.[0]?.id as string | undefined;
  if (item === undefined) return wr;
  const d: Any = await pending(s.store, ctx(), { id: item });
  return resolve(s.store, ctx(), { id: item, decision: "confirm", item_ver: d.item_ver } as never);
}

const asOf = (entity: string, op: number, more: Record<string, unknown> = {}): Promise<Any> =>
  history(s.store, ctx(), {
    table: "budget",
    entity,
    mode: "as_of",
    as_of: op,
    ...more,
  }) as Promise<Any>;
/** Each row's start, end, amount and mark; an end left out is "—", not null. */
const shape = (r: Any) =>
  (r.rows as Any[]).map((x) => [
    "valid_from" in x ? x.valid_from : "—",
    "valid_to" in x ? x.valid_to : "—",
    x.values.amount ?? "·",
    x.marks?.partially_deleted === true,
  ]);
const daysIn = (r: Any) => text(r.rows);

beforeAll(async () => {
  s = await openReusable("saveslot-interval-ends-as-of-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  s.buffered(false);
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-interval-ends-as-of-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [BUDGET] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** #1 5000 from 10-01; then `then`, its words deleted later. */
async function base() {
  const a = await w("5000 from october", {
    intent: "insert",
    valid_from: "2026-10-01",
    set: { amount: "5000" },
  });
  return { a, entity: a.ops[0].target.entity as string, ver: a.ops[0].ver as string };
}

describe("an end from deleted content, read by record time", () => {
  it(
    "a default end stopping at a removed write's change point: two stretches, the second's end left out; back after a cancellation",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-20", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      const c = await w("3000 from 11-10", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-11-10",
        set: { amount: "3000" },
      });
      const before = await asOf(entity, c.seq);
      expect(shape(before)).toEqual([
        ["2026-10-01", "2026-11-10", "5000", false],
        ["2026-11-10", "2026-11-20", "3000", false],
        ["2026-11-20", null, "SECRET-4000", false],
      ]);
      expect(before).not.toHaveProperty("partially_deleted");
      const del = await deleteSource("DELETED 4000 from 11-20");
      const r = await asOf(entity, c.seq);
      // 11-20 was the removed write's: not the 3000's end, nor a third stretch's start.
      expect(shape(r)).toEqual([
        ["2026-10-01", "2026-11-10", "5000", false],
        ["2026-11-10", "—", "3000", true],
      ]);
      expect(r.rows[1]).not.toHaveProperty("valid_to_inclusive");
      expect(daysIn(r)).not.toContain("2026-11-20");
      expect(daysIn(r)).not.toContain("SECRET");
      expect(r.partially_deleted).toBe(true);
      await cancel(del, entity, "DELETED 4000 from 11-20");
      expect(shape(await asOf(entity, c.seq))).toEqual(shape(before));
    },
    T,
  );

  it(
    "a removed write's stated end, open: left out, not null, and no valid_to_inclusive",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-01 on", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-01",
        valid_to: "open",
        set: { amount: "SECRET-4000" },
      });
      // Over the removed write's change point at 11-01: high impact, confirmed.
      const c = await w("3000 for october's second half", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-10-15",
        valid_to: "2026-11-10",
        set: { amount: "3000" },
      });
      const item = c.pending?.[0]?.id as string;
      const d: Any = await pending(s.store, ctx(), { id: item });
      const ok: Any = await resolve(s.store, ctx(), {
        id: item,
        decision: "confirm",
        item_ver: d.item_ver,
      } as never);
      await deleteSource("DELETED 4000 from 11-01 on");
      const r = await asOf(entity, ok.write?.seq ?? ok.seq);
      // Its value is left out, but its start is the 3000's stated end: listed, with no end.
      expect(shape(r)).toEqual([
        ["2026-10-01", "2026-10-15", "5000", false],
        ["2026-10-15", "2026-11-10", "3000", false],
        ["2026-11-10", "—", "·", true],
      ]);
      expect(r.rows[2]).not.toHaveProperty("valid_to_inclusive");
      expect(daysIn(r)).not.toContain("2026-11-01");
    },
    T,
  );

  it(
    "an end both neighbours state, one of them removed: given",
    async () => {
      const a = await w("5000 for october to 11-20", {
        intent: "insert",
        valid_from: "2026-10-01",
        valid_to: "2026-11-20",
        set: { amount: "5000" },
      });
      const entity = a.ops[0].target.entity as string;
      const b = await w("DELETED 4000 from 11-20", {
        intent: "update",
        entity,
        ver: a.ops[0].ver,
        valid_from: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      await deleteSource("DELETED 4000 from 11-20");
      const r = await asOf(entity, b.seq);
      // 11-20 is #1's own stated end too.
      expect(shape(r)[0]).toEqual(["2026-10-01", "2026-11-20", "5000", false]);
      // The removed write's own stretch: its start is #1's end... and its own words: left out whole.
      expect(r.rows).toHaveLength(1);
    },
    T,
  );

  it(
    "a row of two fields: an end only one field's removed write gave is given when the other field changes there too",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-01", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-01",
        set: { amount: "SECRET-4000" },
      });
      const c = await w("a note from 11-01", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-11-01",
        set: { note: "kept" },
      });
      await deleteSource("DELETED 4000 from 11-01");
      const r = await asOf(entity, c.seq);
      expect(shape(r)).toEqual([
        ["2026-10-01", "2026-11-01", "5000", false],
        ["2026-11-01", null, "·", true],
      ]);
    },
    T,
  );

  it(
    "a corrected span's start, resolved at a removed write's change point: left out with the end before it",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-05", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-05",
        set: { amount: "SECRET-4000" },
      });
      // A correct with no interval: the stretch holding now (11-10), from 11-05.
      const c = await w("it is 4500", {
        intent: "correct",
        entity,
        ver: b.ops[0].ver,
        set: { amount: "4500" },
      });
      await deleteSource("DELETED 4000 from 11-05");
      const r = await asOf(entity, c.seq);
      // Its end too: open as resolved, the block holding both ends listed (a resolved end is
      // judged by its block: withheld more, as the decision says, §1).
      expect(shape(r)).toEqual([
        ["2026-10-01", "—", "5000", true],
        ["—", "—", "4500", true],
      ]);
      expect(daysIn(r)).not.toContain("2026-11-05");
    },
    T,
  );

  it(
    "a revoke given a start only, its end resolved at a removed write's change point: left out",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-20", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      const c = await w("none from 11-10", {
        intent: "revoke",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-11-10",
      });
      await deleteSource("DELETED 4000 from 11-20");
      const r = await asOf(entity, c.seq);
      // The gap's start is the revoke's own; its end (and the next stretch's start) were 11-20.
      expect(shape(r)[0]).toEqual(["2026-10-01", "2026-11-10", "5000", false]);
      expect(daysIn(r)).not.toContain("2026-11-20");
    },
    T,
  );

  it(
    "two deletions: an end the first restated is given after it, and not once the second removes what it stops at",
    async () => {
      const { entity, ver } = await base();
      const b = await w("ONE 4000 from 11-20", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-20",
        set: { amount: "4000" },
      });
      const c = await w("TWO 2000 from 12-01", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-12-01",
        set: { amount: "2000" },
      });
      const d = await w("3000 from 11-10", {
        intent: "update",
        entity,
        ver: c.ops[0].ver,
        valid_from: "2026-11-10",
        set: { amount: "3000" },
      });
      // The first deletion restates #4's end: it stops at #3's 12-01 now.
      const d1 = await deleteSource("ONE 4000 from 11-20");
      const after1 = await asOf(entity, d1.seq);
      expect(shape(after1)).toContainEqual(["2026-11-10", "2026-12-01", "3000", false]);
      await deleteSource("TWO 2000 from 12-01");
      const after2 = await asOf(entity, d1.seq);
      // The cell the first deletion recorded is given by its restatement, which the second lists:
      // its value is withheld as well (03-deletion «版本表»), and its end with it.
      expect(shape(after2)).toContainEqual(["2026-11-10", "—", "·", true]);
      expect(daysIn(after2)).not.toContain("2026-12-01");
      expect(d.seq).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "only the value's evidence deleted, the sentence stating the dates kept: the dates are not given either",
    async () => {
      const { entity, ver } = await base();
      const b = await write(s.store, ctx(), {
        sv: 1,
        evidence: [
          { kind: "user_message", text: "DELETED the amount is 4000" },
          { kind: "user_message", text: "for 11-10 to 11-20" },
        ],
        idempotency_key: `k-${++n}`,
        ops: [
          {
            table: "budget",
            intent: "update",
            entity,
            ver,
            valid_from: "2026-11-10",
            valid_to: "2026-11-20",
            set: { amount: "SECRET-4000" },
            evidence_by_field: { amount: [0], valid: [1] },
          },
        ],
      } as never);
      await deleteSource("DELETED the amount is 4000");
      const r = await asOf(entity, (b as Any).seq);
      expect(daysIn(r)).not.toContain("2026-11-10");
      expect(daysIn(r)).not.toContain("2026-11-20");
    },
    T,
  );
  it(
    "a write with no interval: its start `now` is stated and given, its end resolved at a removed write's change point is left out",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-20", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      // Now is 11-10: the head says from `now`, to `next_change` (11-20, the removed write's).
      const c = await w("3000 now", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        set: { amount: "3000" },
      });
      await deleteSource("DELETED 4000 from 11-20");
      const r = await asOf(entity, c.seq);
      expect(shape(r)).toEqual([
        ["2026-10-01", "2026-11-10", "5000", false],
        ["2026-11-10", "—", "3000", true],
      ]);
      expect(daysIn(r)).not.toContain("2026-11-20");
    },
    T,
  );

  it(
    "an undo whose write-back stops at a removed write's start: neither the date nor the value",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-20", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      // Over the removed write's change point at 11-20: high impact, confirmed.
      const c0 = await w("3000 for 11-01 to 12-01", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-11-01",
        valid_to: "2026-12-01",
        set: { amount: "3000" },
      });
      const c = await confirmFirst(c0);
      const cSeq = c.write?.seq ?? c.seq;
      const cur: Any = await query(s.store, ctx(), { table: "budget" } as never);
      const d0: Any = await write(s.store, ctx(), {
        sv: 1,
        evidence: [{ kind: "user_message", text: "undo that" }],
        idempotency_key: `k-${++n}`,
        ops: [
          {
            table: "budget",
            intent: "update",
            entity,
            ver: cur.rows[0].ver,
            revert: { undo: cSeq },
          },
        ],
      } as never);
      const d = await confirmFirst(d0);
      const dSeq = d.write?.seq ?? d.seq;
      // The write-back gives 5000 back to 11-20 and the removed write's value from there.
      expect(shape(await asOf(entity, dSeq))).toEqual([
        ["2026-10-01", "2026-11-20", "5000", false],
        ["2026-11-20", null, "SECRET-4000", false],
      ]);
      await deleteSource("DELETED 4000 from 11-20");
      const r = await asOf(entity, dSeq);
      expect(shape(r)).toEqual([["2026-10-01", "—", "5000", true]]);
      expect(daysIn(r)).not.toContain("2026-11-20");
      expect(daysIn(r)).not.toContain("SECRET");
    },
    T,
  );
});

describe("a business time condition, the order and the pages", () => {
  it(
    "valid_at in a stretch whose end is left out: no hit, and the result says so, empty or not",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-20", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      const c = await w("3000 from 11-10", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-11-10",
        set: { amount: "3000" },
      });
      await deleteSource("DELETED 4000 from 11-20");
      // 11-15 is before 11-20, but only the withheld end could say so.
      const r = await asOf(entity, c.seq, { valid_at: "2026-11-15" });
      expect(r.rows).toEqual([]);
      expect(r.partially_deleted).toBe(true);
      // A day the given ends decide: hit, as ever.
      const k = await asOf(entity, c.seq, { valid_at: "2026-10-15" });
      expect(shape(k)).toEqual([["2026-10-01", "2026-11-10", "5000", false]]);
      // Asked day after day, no answer tells where the withheld end is.
      const days = ["2026-11-12", "2026-11-19", "2026-11-20", "2026-11-25", "2026-12-31"];
      const answers = await Promise.all(days.map((d) => asOf(entity, c.seq, { valid_at: d })));
      expect(answers.map((x) => x.rows.length)).toEqual([0, 0, 0, 0, 0]);
    },
    T,
  );

  it(
    "a carried valid_during: a stretch whose given start is in the window hits though its end is left out; one only the withheld end could place does not",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 from 11-20", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      const c = await w("3000 from 11-10", {
        intent: "update",
        entity,
        ver: b.ops[0].ver,
        valid_from: "2026-11-10",
        set: { amount: "3000" },
      });
      s.buffered(true);
      const readOf = async (during: [string, string]) => {
        await query(s.store, ctx(), { table: "budget", valid_during: during } as never);
        return readBufferOf(s.store).entries().at(-1)?.read as string;
      };
      // Starts 11-10, inside the window: its end is after 10-05 whatever it is.
      const wide = await readOf(["2026-10-05", "2026-11-12"]);
      // Starts 11-10, before the window: only its end could say it reaches 11-15.
      const late = await readOf(["2026-11-15", "2026-11-18"]);
      await deleteSource("DELETED 4000 from 11-20");
      const r = await asOf(entity, c.seq, { as_of: { read: wide } });
      expect(shape(r)).toEqual([
        ["2026-10-01", "2026-11-10", "5000", false],
        ["2026-11-10", "—", "3000", true],
      ]);
      const k = await asOf(entity, c.seq, { as_of: { read: late } });
      expect(k.rows).toEqual([]);
      expect(k.partially_deleted).toBe(true);
      expect(daysIn(r) + daysIn(k)).not.toContain("2026-11-20");
    },
    T,
  );

  it(
    "three stretches whose start is left out: after the others, paged one by one without a loss or a repeat, and no withheld day in a position",
    async () => {
      const { entity, ver } = await base();
      // Three notes, each stated by removed words over its own days: the amount runs on.
      let v = ver;
      let last: Any;
      for (const [tag, from, to] of [
        ["A", "2026-11-01", "2026-11-03"],
        ["B", "2026-11-05", "2026-11-07"],
        ["C", "2026-11-09", "2026-11-11"],
      ] as const) {
        last = await w(`DELETED note ${tag}`, {
          intent: "update",
          entity,
          ver: v,
          valid_from: from,
          valid_to: to,
          set: { note: `SECRET-${tag}` },
        });
        v = last.ops[0].ver;
      }
      // A kept change after them: its stretch's start is given, and comes before theirs.
      last = await w("kept 4500 from 11-20", {
        intent: "update",
        entity,
        ver: v,
        valid_from: "2026-11-20",
        set: { amount: "4500" },
      });
      for (const tag of ["A", "B", "C"]) await deleteSource(`DELETED note ${tag}`);
      const whole = await asOf(entity, last.seq);
      const rows: Any[] = [];
      const positions: string[] = [];
      let position: string | undefined;
      for (let i = 0; i < 10; i++) {
        const p = await asOf(entity, last.seq, {
          limit: 1,
          ...(position !== undefined ? { position } : {}),
        });
        rows.push(...p.rows);
        position = p.next_position;
        if (position === undefined) break;
        positions.push(position);
      }
      expect(text(rows)).toBe(text(whole.rows));
      // Those whose start is left out come after the others.
      const starts = (whole.rows as Any[]).map((x) => "valid_from" in x);
      expect(starts.indexOf(false)).toBeGreaterThan(-1);
      expect(starts.slice(starts.indexOf(false)).every((x) => !x)).toBe(true);
      expect(
        (whole.rows as Any[]).filter((x) => "valid_from" in x).map((x) => x.valid_from),
      ).toEqual(["2026-10-01", "2026-11-20"]);
      // No position holds a day the rows leave out.
      const decoded = positions.map((p) => Buffer.from(p, "base64url").toString("utf8")).join("\n");
      for (const day of ["01", "03", "05", "07", "09", "11"])
        expect(decoded).not.toContain(`2026-11-${day}`);
      expect(daysIn(whole)).not.toContain("2026-11-0");
    },
    T,
  );

  it(
    "a position of the format before: handle_expired, format_changed",
    async () => {
      const { entity, ver } = await base();
      const b = await w("4000 from 11-01", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-01",
        set: { amount: "4000" },
      });
      const first = await asOf(entity, b.seq, { limit: 1 });
      const p = JSON.parse(Buffer.from(first.next_position, "base64url").toString("utf8"));
      const old = Buffer.from(JSON.stringify({ ...p, v: 1, k: [p.k[0]] }), "utf8").toString(
        "base64url",
      );
      const e = await asOf(entity, b.seq, { limit: 1, position: old }).catch((x: Any) => x);
      expect(
        { code: e.code, reason: e.detail?.reason },
        JSON.stringify({ ...e, message: e.message }),
      ).toEqual({
        code: "handle_expired",
        reason: "format_changed",
      });
    },
    T,
  );
});
