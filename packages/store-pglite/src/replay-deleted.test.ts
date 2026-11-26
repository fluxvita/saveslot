// A request sent again whose original write a pending deletion lists (03-data-model/03-deletion
// «宽限期内重发»; 04-contract §14 «重放返回什么»): not written again, and its receipt gives nothing
// of the original but its operation number, the deletion (`original_deleted`) and `omitted:
// ["deleted_content"]`, for a server-computed request key and an explicit idempotency key alike
// (the latter without comparing the content's fingerprint). Sent once more, the same receipt. A
// write whose own sources are not deleted replays as ever; after a cancellation, so does this one.
// Fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  confirmDeletion,
  createOpsContext,
  createTenant,
  previewDeletion,
  readTail,
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
    // Both windows wide enough for every step of a case.
    idempotency_window: 86_400_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-10T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
const send = (body: Record<string, unknown>): Promise<Any> => write(s.store, ctx(), body as never);
const text = (x: unknown) => JSON.stringify(x);
const tail = () => s.store.read(async (tx) => (await readTail(tx))?.seq);

const lunch = (words: string, amount: string, more: Record<string, unknown> = {}) => ({
  sv: 1,
  evidence: [{ kind: "user_message", text: words }],
  ops: [{ intent: "insert", table: "lunches", set: { amount } }],
  ...more,
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

async function deleteSource(words: string): Promise<Any> {
  const { binding } = await previewDeletion(s.store, { sources: [(await sourceOf(words)).id] });
  return confirmDeletion(s.store, anchor, ctx(), { binding, handle: `dc_${minute}` });
}

const deletedReceipt = (seq: number, deletion: string) => ({
  status: "saved",
  sv: 1,
  seq,
  ops: [],
  derived: [],
  derived_total: 0,
  pending: [],
  superseded: [],
  replayed: true,
  omitted: ["deleted_content"],
  original_deleted: { deletion },
});

beforeAll(async () => {
  s = await openReusable("saveslot-replay-deleted-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-replay-deleted-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a request sent again whose original write is pending deletion", () => {
  it(
    "by the server's request key: original_deleted, nothing written; once more, the same",
    async () => {
      const request = lunch("DELETED-WORDS lunch was SECRET-45", "SECRET-45");
      const first = await send(request);
      const del = await deleteSource("DELETED-WORDS");
      const at = await tail();
      const again = await send(request);
      expect(again).toEqual(deletedReceipt(first.seq, del.deletion.id));
      expect(text(again)).not.toContain("SECRET-45");
      expect(await tail()).toBe(at);
      expect(await send(request)).toEqual(again);
      expect(await tail()).toBe(at);
    },
    T,
  );

  it(
    "by an explicit idempotency key, the content different: original_deleted, not a reused key; once more, the same",
    async () => {
      const first = await send(
        lunch("DELETED-WORDS lunch was SECRET-45", "SECRET-45", { idempotency_key: "k-1" }),
      );
      const del = await deleteSource("DELETED-WORDS");
      const at = await tail();
      const other = lunch("something else", "12", { idempotency_key: "k-1" });
      const again = await send(other);
      expect(again).toEqual(deletedReceipt(first.seq, del.deletion.id));
      expect(await tail()).toBe(at);
      expect(await send(other)).toEqual(again);
      expect(await tail()).toBe(at);
    },
    T,
  );

  it(
    "a write whose sources are not the deleted ones replays as ever",
    async () => {
      const kept = lunch("kept words", "30");
      const first = await send(kept);
      await send(lunch("DELETED-WORDS lunch was SECRET-45", "SECRET-45"));
      await deleteSource("DELETED-WORDS");
      const again = await send(kept);
      expect(again.replayed).toBe(true);
      expect(again.original_deleted).toBeUndefined();
      expect(again.seq).toBe(first.seq);
      expect(again.ops[0].fields.amount).toEqual(first.ops[0].fields.amount);
    },
    T,
  );

  it(
    "cancelled: the original replays as ever, its content back",
    async () => {
      const request = lunch("DELETED-WORDS lunch was SECRET-45", "SECRET-45");
      const first = await send(request);
      const row = first.ops[0].target.row as string;
      const del = await deleteSource("DELETED-WORDS");
      const compiled = await s.store.read(async (tx) => {
        const r = await tx.query<{ body: string; slot_id: string }>(
          `SELECT c.body, v.slot_id FROM schema_versions v
           JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled' WHERE v.state = 'current'`,
        );
        const tables = JSON.parse(r.rows[0]?.body as string).tables as Any[];
        return {
          table: tables.find((t) => t.name === "lunches"),
          slot: r.rows[0]?.slot_id as string,
        };
      });
      await cancelDeletion(s.store, {
        slot: compiled.slot,
        table: compiled.table,
        row,
        sources: [(await sourceOf("DELETED-WORDS")).seq],
        id: del.deletion.id,
        actor: USER,
        now: ctx().now,
      });
      const again = await send(request);
      expect(again.replayed).toBe(true);
      expect(again.original_deleted).toBeUndefined();
      expect(again.ops[0].fields.amount).toEqual(first.ops[0].fields.amount);
    },
    T,
  );
});
