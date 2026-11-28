// `history` `changes` on a state table when an end of a changed stretch came from content a
// deletion still pending removed (the decision on interval ends of deleted content, §3;
// 04-contract-types `ChangeInterval`): the end is left out and the entry marked; stretches cut
// only inside removed content run together; `as_of` and `changes` give the same days of one
// history. On real deletions; fictional names.

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
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

async function deleteSource(words: string): Promise<Any> {
  const { binding } = await previewDeletion(s.store, { sources: [(await sourceOf(words)).id] });
  return confirmDeletion(s.store, anchor, ctx(), { binding, handle: `dc_${++n}` });
}

const asOf = (entity: string, op: number, more: Record<string, unknown> = {}): Promise<Any> =>
  history(s.store, ctx(), {
    table: "budget",
    entity,
    mode: "as_of",
    as_of: op,
    ...more,
  }) as Promise<Any>;

beforeAll(async () => {
  s = await openReusable("saveslot-interval-ends-changes-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-interval-ends-changes-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [BUDGET] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const changesSince = (since: number): Promise<Any> =>
  history(s.store, ctx(), { table: "budget", mode: "changes", since }) as Promise<Any>;
/** Every start and end a result gives (`valid_from`, `valid_to`, at any depth), as a set. */
const daysOf = (x: unknown): string[] =>
  [
    ...new Set(
      [...text(x).matchAll(/"valid_(?:from|to)":"([0-9-]+)"/g)].map((m) => m[1] as string),
    ),
  ].sort();
/** Each changed stretch of an entry: its op, start, end ("—" when left out) and mark. */
const stretches = (r: Any) =>
  (r.changes as Any[]).flatMap((e) =>
    ((e.fields.amount ?? []) as Any[]).map((p) => [
      e.seq,
      "valid_from" in p.valid ? p.valid.valid_from : "—",
      "valid_to" in p.valid ? p.valid.valid_to : "—",
      e.partially_deleted === true,
    ]),
  );

async function deleteSources(...words: string[]): Promise<Any> {
  const ids = [];
  for (const x of words) ids.push((await sourceOf(x)).id);
  const { binding } = await previewDeletion(s.store, { sources: ids });
  return confirmDeletion(s.store, anchor, ctx(), { binding, handle: `dc_${++n}` });
}

async function base() {
  const a = await w("5000 from october", {
    intent: "insert",
    valid_from: "2026-10-01",
    set: { amount: "5000" },
  });
  return { a, entity: a.ops[0].target.entity as string, ver: a.ops[0].ver as string };
}

describe("changes: an end from deleted content is left out, the entry marked", () => {
  it(
    "a default end stopping at a removed write's change point; the same days as as_of",
    async () => {
      const { a, entity, ver } = await base();
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
      const r = await changesSince(0);
      expect(text(r)).not.toContain("SECRET");
      expect(daysOf(r.changes)).not.toContain("2026-11-20");
      // The 3000's own change: its start stated, its end the removed write's change point.
      expect(stretches(r)).toContainEqual([c.seq, "2026-11-10", "—", true]);
      // The removed write's own change: neither end given.
      expect(stretches(r)).toContainEqual([b.seq, "—", "—", true]);
      // The first write, untouched: as ever.
      expect(stretches(r)).toContainEqual([a.seq, "2026-10-01", null, false]);
      // The days the two reads give of this history are the same.
      expect(daysOf(r.changes)).toEqual(daysOf((await asOf(entity, c.seq)).rows));
    },
    T,
  );

  it(
    "a removed write's stated dates: neither end of its change given",
    async () => {
      const { entity, ver } = await base();
      const b = await w("DELETED 4000 for ten days", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-10",
        valid_to: "2026-11-20",
        set: { amount: "SECRET-4000" },
      });
      await deleteSource("DELETED 4000 for ten days");
      const r = await changesSince(0);
      expect(stretches(r).filter((x) => x[0] === b.seq)).toEqual([[b.seq, "—", "—", true]]);
      expect(daysOf(r.changes)).not.toContain("2026-11-10");
      expect(daysOf(r.changes)).not.toContain("2026-11-20");
    },
    T,
  );

  it(
    "two removed writes side by side, one deletion: the cut between them is not given, the stretches one",
    async () => {
      const { entity, ver } = await base();
      const b1 = await w("DELETED first half", {
        intent: "update",
        entity,
        ver,
        valid_from: "2026-11-01",
        valid_to: "2026-11-10",
        set: { amount: "SECRET-1" },
      });
      await w("DELETED second half", {
        intent: "update",
        entity,
        ver: b1.ops[0].ver,
        valid_from: "2026-11-10",
        valid_to: "2026-11-20",
        set: { amount: "SECRET-2" },
      });
      const d = await deleteSources("DELETED first half", "DELETED second half");
      const r = await changesSince(0);
      // The deletion's own change, from both removed values back to 5000: one stretch, no cut.
      const mine = stretches(r).filter((x) => x[0] === d.seq);
      expect(mine).toEqual([[d.seq, "—", "—", true]]);
      expect(daysOf(r.changes)).not.toContain("2026-11-10");
      // From one removed value to the other is still a change (each its own).
      expect(stretches(r).length).toBeGreaterThan(2);
    },
    T,
  );
});
