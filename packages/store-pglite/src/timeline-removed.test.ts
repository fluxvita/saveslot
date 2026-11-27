// `history`'s timeline on an item whose content a deletion removed (04-contract-types
// `TimelineResultCode` `removed`, `TimelineField.removed`): its result is `removed`, never an empty
// code, and the entry carries `removed: true` with it, the two always together. A contribution in
// effect that was taken away, a candidate whose evidence was deleted, and one on a state table.
// After a cancellation the item's own result is back. Fictional names.

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

/** Every field part of a timeline, with the entry's operation. */
const parts = (t: Any): { seq: number; field: string; part: Any }[] =>
  t.entries.flatMap((e: Any) =>
    Object.entries(e.fields as Record<string, Any>).flatMap(([field, v]) =>
      (Array.isArray(v) ? v : [v]).map((part) => ({ seq: e.seq as number, field, part })),
    ),
  );

/** `removed` as the result and `removed: true` on the part: both or neither, on every part. */
function together(t: Any) {
  for (const { part } of parts(t)) {
    expect(part.result).not.toBe("");
    expect(part.result === "removed").toBe(part.removed === true);
  }
}

const timeline = (table: string, target: Record<string, string>): Promise<Any> =>
  history(s.store, ctx(), { table, ...target }) as Promise<Any>;

beforeAll(async () => {
  s = await openReusable("saveslot-timeline-removed-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-timeline-removed-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH, BUDGET] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("timeline: an item a deletion removed is `removed`, with `removed: true`", () => {
  it(
    "a contribution in effect, taken away; after a cancellation, applied again",
    async () => {
      const a = await w("lunch was 45 at home", [
        { intent: "insert", table: "lunches", set: { amount: "45", place: "home" } },
      ]);
      const row = a.ops[0].target.row as string;
      const b = await w("DELETED-WORDS: 35 at the cafe", [
        { intent: "correct", table: "lunches", row, set: { amount: "35", place: "CAFE-SECRET" } },
      ]);
      const before = await timeline("lunches", { row });
      together(before);
      expect(parts(before).every((x) => x.part.result === "applied")).toBe(true);

      const del = await deleteSource("DELETED-WORDS");
      const t = await timeline("lunches", { row });
      together(t);
      const mine = parts(t).filter((x) => x.seq === b.seq);
      expect(mine.map((x) => x.field).sort()).toEqual(["amount", "place"]);
      for (const { part } of mine) {
        expect(part).toMatchObject({ result: "removed", removed: true });
        expect(part).not.toHaveProperty("after");
      }
      expect(JSON.stringify(t)).not.toContain("CAFE-SECRET");
      // The first write, untouched: as ever.
      for (const { part } of parts(t).filter((x) => x.seq === a.seq)) {
        expect(part.result).toBe("applied");
      }

      const compiled = await compiledOf("lunches");
      await cancelDeletion(s.store, {
        slot: compiled.slot,
        table: compiled.table,
        row,
        sources: [(await sourceOf("DELETED-WORDS")).seq],
        id: del.deletion.id,
        actor: USER,
        now: ctx().now,
      });
      const back = await timeline("lunches", { row });
      together(back);
      for (const { part } of parts(back).filter((x) => x.seq === b.seq)) {
        expect(part.result).toBe("applied");
        expect(part).not.toHaveProperty("removed");
      }
    },
    T,
  );

  it(
    "a candidate whose evidence was deleted: not in the source table, still `removed`",
    async () => {
      const a = await w("lunch was 45 at home", [
        { intent: "insert", table: "lunches", set: { amount: "45", place: "home" } },
      ]);
      const row = a.ops[0].target.row as string;
      await w("it was 40", [
        { intent: "update", table: "lunches", row, ver: a.ops[0].ver, set: { amount: "40" } },
      ]);
      // Written against the first version, after another write: a candidate.
      const c = await w("DELETED-WORDS: it was SECRET-38", [
        {
          intent: "update",
          table: "lunches",
          row,
          ver: a.ops[0].ver,
          set: { amount: "SECRET-38" },
        },
      ]);
      expect(c.ops[0].fields.amount.result).toBe("candidate");
      const before = parts(await timeline("lunches", { row })).filter((x) => x.seq === c.seq);
      expect(before.map((x) => x.part.result)).toEqual(["candidate"]);

      await deleteSource("DELETED-WORDS");
      const t = await timeline("lunches", { row });
      together(t);
      const mine = parts(t).filter((x) => x.seq === c.seq);
      expect(mine.map((x) => x.part)).toMatchObject([{ result: "removed", removed: true }]);
      expect(JSON.stringify(t)).not.toContain("SECRET-38");
    },
    T,
  );

  it(
    "a state table: the write taken away is `removed`; one whose end it gave, applied",
    async () => {
      const a = await w("budget is 5000 from october", [
        { intent: "insert", table: "budget", valid_from: "2026-10-01", set: { amount: "5000" } },
      ]);
      const entity = a.ops[0].target.entity as string;
      const b = await w("DELETED-WORDS: 4000 from 11-20", [
        {
          intent: "update",
          table: "budget",
          entity,
          ver: a.ops[0].ver,
          valid_from: "2026-11-20",
          set: { amount: "4000" },
        },
      ]);
      const c = await w("3000 from 11-10", [
        {
          intent: "update",
          table: "budget",
          entity,
          ver: b.ops[0].ver,
          valid_from: "2026-11-10",
          set: { amount: "3000" },
        },
      ]);
      await deleteSource("DELETED-WORDS");
      const t = await timeline("budget", { entity });
      together(t);
      expect(parts(t).find((x) => x.seq === b.seq)?.part).toMatchObject({
        result: "removed",
        removed: true,
      });
      expect(parts(t).find((x) => x.seq === c.seq)?.part.result).toBe("applied");
    },
    T,
  );
});
