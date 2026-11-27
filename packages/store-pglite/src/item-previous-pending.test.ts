// A conflict item's `previous` (04-contract-types `ConflictDetail.previous`) when a deletion still
// pending removed the value at its merge base (03-data-model/03-deletion «版本表»): the merge base
// as recorded then, less that value, which is left out and `previous` marked `partially_deleted`;
// before the deletion and after a cancellation, as ever. Fictional names.

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
const listed = (): Promise<Any> => pending(s.store, ctx(), { status: "all" }) as Promise<Any>;

beforeAll(async () => {
  s = await openReusable("saveslot-item-previous-pending-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-item-previous-pending-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a conflict item's previous, its merge base's value removed by a pending deletion", () => {
  it(
    "given before; left out and marked after; as ever after a cancellation",
    async () => {
      // The merge base: a write whose words are then deleted.
      const a = await w("DELETED-WORDS lunch was SECRET-45 at home", [
        { intent: "insert", table: "lunches", set: { amount: "SECRET-45", place: "home" } },
      ]);
      const row = a.ops[0].target.row as string;
      await w("it was 40", [
        { intent: "update", table: "lunches", row, ver: a.ops[0].ver, set: { amount: "40" } },
      ]);
      // Written against the first version, after another write: a candidate, a conflict item.
      const c = await w("it was 38", [
        { intent: "update", table: "lunches", row, ver: a.ops[0].ver, set: { amount: "38" } },
      ]);
      const id = c.ops[0].fields.amount.item as string;

      const before = await detail(id);
      expect(before.previous).toEqual({
        seq: a.seq,
        exists: true,
        values: { amount: "SECRET-45" },
      });

      const { binding } = await previewDeletion(s.store, {
        sources: [(await sourceOf("DELETED-WORDS")).id],
      });
      const del = (await confirmDeletion(s.store, anchor, ctx(), {
        binding,
        handle: `dc_${++n}`,
      })) as Any;

      const after = await detail(id);
      expect(after.previous).toEqual({
        seq: a.seq,
        exists: true,
        values: {},
        partially_deleted: true,
      });
      expect(text(after)).not.toContain("SECRET-45");
      expect(text(await listed())).not.toContain("SECRET-45");
      // The side in effect and the candidate: as they were.
      expect(after.effective.values).toEqual({ amount: "40" });
      expect(after.candidates.map((x: Any) => x.values)).toEqual([{ amount: "38" }]);

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
      const back = await detail(id);
      expect(back.previous).toEqual(before.previous);
    },
    T,
  );
});
