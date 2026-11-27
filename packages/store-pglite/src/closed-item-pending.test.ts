// A closed item's details (04-contract-types `ConflictDetail.effective`, `AwaitingDetail.current`,
// `FlaggedDetail`) when a deletion still pending removed a value they read (03-data-model/
// 03-deletion «版本表»): a closed item is read at its own version, which a later deletion does not
// refresh, so the value is left out and that side marked `partially_deleted`; after a
// cancellation, as before. Fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  confirmDeletion,
  createOpsContext,
  createTenant,
  pending,
  previewDeletion,
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
  description: "a budget over time",
  time: { type: "state", granularity: "date" },
  fields: [{ name: "amount", type: "text", required: true, description: "how much" }],
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
const detail = (id: string): Promise<Any> => pending(s.store, ctx(), { id }) as Promise<Any>;
const decide = async (id: string, decision: string) => {
  const d = await detail(id);
  return resolve(s.store, ctx(), { id, decision, item_ver: d.item_ver } as never);
};
/** Deletes the source `words`: the deletion's receipt. */
async function deleteSource(words: string): Promise<Any> {
  const { binding } = await previewDeletion(s.store, { sources: [(await sourceOf(words)).id] });
  return confirmDeletion(s.store, anchor, ctx(), { binding, handle: `dc_${++n}` });
}
async function cancel(del: Any, table: string, row: string, words: string) {
  const compiled = await compiledOf(table);
  await cancelDeletion(s.store, {
    slot: compiled.slot,
    table: compiled.table,
    row,
    sources: [(await sourceOf(words)).seq],
    id: del.deletion.id,
    actor: USER,
    now: ctx().now,
  });
}

beforeAll(async () => {
  s = await openReusable("saveslot-closed-item-pending-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-closed-item-pending-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: {
      slot: "home",
      base_version: null,
      timezone: "UTC",
      tables: [LUNCH, BUDGET, DUPS],
    },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a closed item's details, a value they read removed by a pending deletion", () => {
  it(
    "conflict, resolved keep_effective: effective leaves it out, marked; as before after a cancellation",
    async () => {
      const a = await w("lunch was 45", [
        { intent: "insert", table: "lunches", set: { amount: "45" } },
      ]);
      const row = a.ops[0].target.row as string;
      await w("DELETED-WORDS it was SECRET-40", [
        {
          intent: "update",
          table: "lunches",
          row,
          ver: a.ops[0].ver,
          set: { amount: "SECRET-40" },
        },
      ]);
      const c = await w("it was 38", [
        { intent: "update", table: "lunches", row, ver: a.ops[0].ver, set: { amount: "38" } },
      ]);
      const id = c.ops[0].fields.amount.item as string;
      await decide(id, "keep_effective");
      const before = await detail(id);
      expect(before.effective.values).toEqual({ amount: "SECRET-40" });
      expect(before.effective).not.toHaveProperty("partially_deleted");

      const del = await deleteSource("DELETED-WORDS");
      const after = await detail(id);
      expect(after.status).toBe("resolved");
      expect(after.effective).toMatchObject({ values: {}, exists: true, partially_deleted: true });
      expect(text(after)).not.toContain("SECRET-40");

      await cancel(del, "lunches", row, "DELETED-WORDS");
      expect((await detail(id)).effective).toEqual(before.effective);
    },
    T,
  );

  it(
    "awaiting, rejected: current leaves it out, marked",
    async () => {
      const a = await w("budget x from 11-01", [
        { intent: "insert", table: "budget", valid_from: "2026-11-01", set: { amount: "x" } },
      ]);
      const entity = a.ops[0].target.entity as string;
      const b = await w("DELETED-WORDS SECRET-Y from 11-10", [
        {
          intent: "update",
          table: "budget",
          entity,
          ver: a.ops[0].ver,
          valid_from: "2026-11-10",
          set: { amount: "SECRET-Y" },
        },
      ]);
      // Over the change point at 11-10: high impact, awaiting.
      const c = await w("z from 11-05 to 11-15", [
        {
          intent: "update",
          table: "budget",
          entity,
          ver: b.ops[0].ver,
          valid_from: "2026-11-05",
          valid_to: "2026-11-15",
          set: { amount: "z" },
        },
      ]);
      const id = c.pending?.[0]?.id as string;
      expect(c.pending?.[0]?.type).toBe("awaiting_confirmation");
      await decide(id, "reject");
      const before = await detail(id);
      expect(text(before.current)).toContain("SECRET-Y");
      expect(before.current).not.toHaveProperty("partially_deleted");

      await deleteSource("DELETED-WORDS");
      const after = await detail(id);
      expect(after.status).toBe("resolved");
      expect(after.current.partially_deleted).toBe(true);
      expect(text(after)).not.toContain("SECRET-Y");
    },
    T,
  );

  it(
    "flagged, kept: matched_values leaves it out, marked",
    async () => {
      await w("first is NAME-SECRET", [
        { intent: "insert", table: "dups", set: { name: "NAME-SECRET" } },
      ]);
      const b = await w("DELETED-WORDS second is NAME-SECRET", [
        { intent: "insert", table: "dups", set: { name: "NAME-SECRET" } },
      ]);
      const id = b.pending?.[0]?.id as string;
      expect(b.pending?.[0]?.type).toBe("flagged");
      await decide(id, "keep");
      const before = await detail(id);
      expect(before.matched_values).toEqual({ name: "NAME-SECRET" });
      expect(before).not.toHaveProperty("partially_deleted");

      await deleteSource("DELETED-WORDS");
      const after = await detail(id);
      expect(after.status).toBe("resolved");
      expect(after.partially_deleted).toBe(true);
      expect(after.matched_values ?? {}).toEqual({});
    },
    T,
  );
});
