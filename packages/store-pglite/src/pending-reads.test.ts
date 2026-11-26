// A block a deletion in its grace period lists is read no more (09 §5.9; 03-data-model/03-deletion
// «删除后的样子是一个新版本»): the read paths that take content from the log directly show none
// of it. Each case reads a value first, then registers its blocks as pending (as a deletion's apply
// registers its positions in `pending_blocks`) and reads again: the value is gone, and comes back
// when the blocks are no longer pending (as on a cancellation). Fictional names.

import {
  createOpsContext,
  createTenant,
  history,
  pending,
  resolve,
  schemaDraft,
  sources,
  write,
} from "@fluxvita/saveslot-kernel";
import { judgeStateFromLog, tableShape } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
/** The `deletion.confirmed` the registered blocks are listed by: never an event here. */
const DELETION = 1_000_000;

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
const w = (ops: unknown[], evidence?: string, more: Record<string, unknown> = {}): Promise<Any> =>
  write(s.store, ctx(), {
    sv: 1,
    ...(evidence !== undefined ? { evidence: [{ kind: "user_message", text: evidence }] } : {}),
    ops,
    ...more,
  });
const text = (x: unknown) => JSON.stringify(x);

/** The seqs of the events of operation `op` of type `type`. */
const eventsOf = async (op: number, type: string) =>
  (
    await s.store.read((tx) =>
      tx.query<{ seq: unknown }>("SELECT seq FROM events WHERE op = $1 AND type = $2", [op, type]),
    )
  ).rows.map((r) => Number(r.seq));
/** The `source.recorded` whose text holds `t`. */
const sourceOf = async (t: string) =>
  (
    await s.store.read((tx) =>
      tx.query<{ seq: unknown; source_id: string }>(
        `SELECT so.seq, so.source_id FROM sources so JOIN content c ON c.seq = so.seq
         WHERE c.path = 'text' AND c.body LIKE $1`,
        [`%${t}%`],
      ),
    )
  ).rows.map((r) => ({ seq: Number(r.seq), id: r.source_id }))[0] as { seq: number; id: string };
/**
 * Registers the blocks of `seq` as pending (all but `target`, or those `paths` names), as a
 * deletion's apply does.
 */
const pend = (seq: number, paths?: readonly string[]) =>
  s.store.write((tx) =>
    tx.query(
      `INSERT INTO pending_blocks (seq, path, deletion_seq)
       SELECT seq, path, $2 FROM content
       WHERE seq = $1 AND body IS NOT NULL AND ($3::text[] IS NULL OR path = ANY($3)) AND path <> 'target'`,
      [seq, DELETION, paths === undefined ? null : [...paths]] as never,
    ),
  );
/** As a cancellation: no block pending any more. */
const unpend = () => s.store.write((tx) => tx.query("DELETE FROM pending_blocks"));

/** A lunch of 45, corrected to 35 by `words`; the correction's op and its source. */
async function corrected(words: string) {
  const r1 = await w(
    [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
    "lunch was 45",
  );
  const row = r1.ops[0].target.row as string;
  const r2 = await w([{ intent: "correct", table: "lunches", row, set: { amount: "35" } }], words);
  return { row, op: r2.seq as number, source: await sourceOf(words) };
}

beforeAll(async () => {
  s = await openReusable("saveslot-pending-reads-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH] },
  });
}, T);

describe("in a grace period, the log's pending content is not read", () => {
  it(
    "sources (get, list): a pending source's text is not given",
    async () => {
      const { source } = await corrected("WORDS-OF-35");
      const get = () => sources(s.store, ctx(), { mode: "get", id: source.id });
      const list = () => sources(s.store, ctx(), { mode: "list" });
      expect(text(await get())).toContain("WORDS-OF-35");
      expect(text(await list())).toContain("WORDS-OF-35");
      await pend(source.seq);
      expect(text(await get())).not.toContain("WORDS-OF-35");
      expect(text(await list())).not.toContain("WORDS-OF-35");
      await unpend();
      expect(text(await get())).toContain("WORDS-OF-35");
    },
    T,
  );

  it(
    "history: a pending contribution's value is marked removed, with no value; a pending source's text is not quoted",
    async () => {
      const { row, op, source } = await corrected("WORDS-OF-35");
      const read = async () =>
        text(await history(s.store, ctx(), { table: "lunches", row, expand_sources: true }));
      expect(await read()).toContain('"35"');
      expect(await read()).toContain("WORDS-OF-35");
      for (const seq of await eventsOf(op, "write.base")) await pend(seq);
      const hidden = await read();
      expect(hidden).not.toContain('"35"');
      expect(hidden).toContain('"removed":true');
      expect(hidden).toContain("WORDS-OF-35"); // the source itself is not pending yet
      await pend(source.seq);
      expect(await read()).not.toContain("WORDS-OF-35");
      await unpend();
      expect(await read()).toContain('"35"');
    },
    T,
  );

  it(
    "a receipt rebuilt for a repeated request quotes no pending value",
    async () => {
      const r1 = await w([{ intent: "insert", table: "lunches", set: { amount: "45" } }], "lunch");
      const row = r1.ops[0].target.row as string;
      const again = () =>
        w([{ intent: "correct", table: "lunches", row, set: { amount: "35" } }], "WORDS-OF-35", {
          idempotency_key: "once",
        });
      const first = await again();
      expect(text(first)).toContain('"35"');
      for (const seq of await eventsOf(first.seq, "write.base")) await pend(seq);
      const replayed = await again();
      expect(replayed.replayed).toBe(true);
      expect(text(replayed)).not.toContain('"35"');
      await unpend();
      expect(text(await again())).toContain('"35"');
    },
    T,
  );

  it(
    "a pending item's detail gives no candidate value from a pending block; a decision's note from a pending source is not given",
    async () => {
      const a = await w([{ intent: "insert", table: "lunches", set: { amount: "9" } }], "nine");
      const row = a.ops[0].target.row as string;
      const ver = a.ops[0].ver as string;
      await w([{ intent: "update", table: "lunches", row, ver, set: { amount: "9.5" } }], "9.5");
      const c = await w(
        [{ intent: "update", table: "lunches", row, ver, set: { amount: "CANDIDATE-10" } }],
        "ten",
      );
      const item = c.pending[0]?.id as string;
      expect(item).toBeDefined();
      const detail = async () => text(await pending(s.store, ctx(), { id: item }));
      expect(await detail()).toContain("CANDIDATE-10");
      for (const seq of await eventsOf(c.seq, "item.created")) await pend(seq);
      expect(await detail()).not.toContain("CANDIDATE-10");
      await unpend();

      // The decision's note, in the request of its api_call source.
      const r = (await resolve(s.store, ctx(), {
        id: item,
        decision: "keep_effective",
        item_ver: c.pending[0]?.item_ver,
        note: "NOTE-TEXT",
      })) as Any;
      const op = Number(String(r.item_ver).split(".")[1]);
      expect(await detail()).toContain("NOTE-TEXT");
      for (const seq of await eventsOf(op, "source.recorded")) await pend(seq, ["request"]);
      const after = await detail();
      expect(after).not.toContain("NOTE-TEXT");
      expect(after).toContain("keep_effective");
    },
    T,
  );

  it(
    "a write citing a source whose text is pending, past the source check, stops as internal: never read past",
    async () => {
      const { source } = await corrected("WORDS-OF-35");
      // The source table not told (a deletion would mark it pending_deletion and the write would be
      // refused before): the text read finds the block pending.
      await pend(source.seq);
      const e = await write(s.store, ctx(), {
        sv: 1,
        evidence: [{ kind: "source_ref", id: source.id }],
        ops: [{ intent: "insert", table: "lunches", set: { amount: "35" } }],
      }).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: "internal" });
      expect(String((e as Error).message)).toContain("pending deletion");
    },
    T,
  );

  it(
    "the row's log as the write path reads it (rowEvents) has no pending value; a deletion's replay, asking, has it",
    async () => {
      const { row, op } = await corrected("WORDS-OF-35");
      const compiled = (
        await s.store.read((tx) =>
          tx.query<{ body: string }>(
            `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq
             AND c.path = 'compiled' WHERE v.state = 'current'`,
          ),
        )
      ).rows[0]?.body as string;
      const table = (JSON.parse(compiled).tables as Any[]).find((t) => t.name === "lunches");
      const ctx = {
        table: table.id,
        target: { row },
        shape: tableShape(table),
        granularity: "date",
      } as never;
      const asWrite = () =>
        s.store.read(async (tx) => text((await judgeStateFromLog(tx, ctx)).records));
      const asReplay = () =>
        s.store.read(async (tx) =>
          text((await judgeStateFromLog(tx, ctx, { includePendingDeletionBlocks: true })).records),
        );
      expect(await asWrite()).toContain('"35"');
      for (const seq of await eventsOf(op, "write.base")) await pend(seq);
      expect(await asWrite()).not.toContain('"35"');
      expect(await asReplay()).toContain('"35"');
    },
    T,
  );
});
