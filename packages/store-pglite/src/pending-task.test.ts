// An operation's `task` is a data block (09 §5.1), listed by a deletion with the operation's other
// blocks (§5.9): while it is pending, the fallbacks that go by the task of the caller's own writes
// count that operation as of no known task — neither the caller's nor another — and never quote it.
// The `sv` and `ver` fallbacks are reached through a real deletion. An item opened by a write whose
// source is deleted is superseded by that deletion, so the item fallbacks are reached with the
// task block registered as pending by hand (as a deletion's apply registers its positions).
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
  resolve,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"3".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const HIDDEN = "TASK-OF-THE-DELETED-WRITE";
/** The `deletion.confirmed` the hand-registered blocks are listed by: never an event here. */
const DELETION = 1_000_000;

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
const ctx = (task: string | null) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-10T08:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
let n = 0;
/** A write under `task`, with its own words as its source and its own idempotency key. */
const w = (task: string, words: string, body: Record<string, unknown>): Promise<Any> =>
  write(s.store, ctx(task), {
    evidence: [{ kind: "user_message", text: words }],
    idempotency_key: `k-${++n}`,
    ...body,
  });
/** What a call threw: its code and detail. */
const refusal = async (f: () => Promise<unknown>): Promise<Any> => {
  try {
    return { returned: await f() };
  } catch (e) {
    return { code: (e as Any).code, detail: (e as Any).detail };
  }
};

/** Deletes the source whose text is `words`, by a confirmed deletion under task "del". */
async function deleteSource(words: string): Promise<void> {
  const id = (
    await s.store.read((tx) =>
      tx.query<{ source_id: string }>(
        `SELECT so.source_id FROM sources so JOIN content c ON c.seq = so.seq
         WHERE c.path = 'text' AND c.body LIKE $1`,
        [`%${words}%`],
      ),
    )
  ).rows[0]?.source_id as string;
  const { binding } = await previewDeletion(s.store, { sources: [id] });
  await confirmDeletion(s.store, anchor, ctx("del"), { binding, handle: `dc_${++n}` });
}

/** Whether the `task` block of operation `op` is pending. */
const taskPending = async (op: number) =>
  (
    await s.store.read((tx) =>
      tx.query("SELECT 1 FROM pending_blocks WHERE seq = $1 AND path = 'task'", [op]),
    )
  ).rows.length === 1;

/** Registers the `task` block of operation `op` as pending, as a deletion's apply does. */
const pendTask = (op: number) =>
  s.store.write((tx) =>
    tx.query("INSERT INTO pending_blocks (seq, path, deletion_seq) VALUES ($1, 'task', $2)", [
      op,
      DELETION,
    ]),
  );

/** 9 then 9.5 in effect; a write of 10 under `task` seeing the first: a conflict item it opened. */
async function disputed(task: string) {
  const a = await w("w", "nine", {
    sv: 1,
    ops: [{ intent: "insert", table: "lunches", set: { amount: "9" } }],
  });
  const row = a.ops[0].target.row as string;
  const ver = a.ops[0].ver as string;
  const b = await w(task, "nine and a half", {
    sv: 1,
    ops: [{ intent: "update", table: "lunches", row, ver, set: { amount: "9.5" } }],
  });
  const c = await w(task, "ten", {
    sv: 1,
    ops: [{ intent: "update", table: "lunches", row, ver, set: { amount: "10" } }],
  });
  return { row, b, c, item: c.pending[0]?.id as string };
}

beforeAll(async () => {
  s = await openReusable("saveslot-pending-task-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  dir = mkdtempSync(join(tmpdir(), "saveslot-pending-task-anchor-"));
  anchor = openFileAnchorStore(join(dir, "anchor.json"));
  await createTenant(s.store, ctx("w"));
  await schemaDraft(s.store, ctx("w"), {
    document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH] },
  });
}, T);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a task a deletion lists is of no known task to the fallbacks, and never quoted", () => {
  it(
    "sv left out, under another task: read_first names the visible write's task, not the deleted one's",
    async () => {
      await w("w", "a lunch", {
        sv: 1,
        ops: [{ intent: "insert", table: "lunches", set: { amount: "45" } }],
      });
      const d = await w(HIDDEN, "the deleted words", {
        sv: 1,
        ops: [{ intent: "insert", table: "lunches", set: { amount: "35" } }],
      });
      const before = await refusal(() =>
        w("other", "x", { ops: [{ intent: "insert", table: "lunches", set: { amount: "2" } }] }),
      );
      expect(before.detail).toMatchObject({ reason: "task_mismatch", read_task: HIDDEN });
      await deleteSource("the deleted words");
      expect(await taskPending(d.seq)).toBe(true);
      const after = await refusal(() =>
        w("other", "y", { ops: [{ intent: "insert", table: "lunches", set: { amount: "3" } }] }),
      );
      expect(after).toEqual({
        code: "read_first",
        detail: expect.objectContaining({ reason: "task_mismatch", read_task: "w", task: "other" }),
      });
      expect(JSON.stringify(after)).not.toContain(HIDDEN);
    },
    T,
  );

  it(
    "ver left out, under the deleted write's task: that write is not taken as the caller's own",
    async () => {
      const a = await w("w", "a lunch", {
        sv: 1,
        ops: [{ intent: "insert", table: "lunches", set: { amount: "8" } }],
      });
      const row = a.ops[0].target.row as string;
      const d = await w(HIDDEN, "the deleted words", {
        sv: 1,
        ops: [
          { intent: "correct", table: "lunches", row, ver: a.ops[0].ver, set: { amount: "7" } },
        ],
      });
      await deleteSource("the deleted words");
      expect(await taskPending(d.seq)).toBe(true);
      // Its version is still in the version table; under its task it would be the caller's own.
      const r = await refusal(() =>
        w(HIDDEN, "z", {
          sv: 1,
          ops: [{ intent: "update", table: "lunches", row, set: { amount: "4" } }],
        }),
      );
      expect(r.code).toBe("read_first");
      expect(r.detail).toMatchObject({ reason: "task_mismatch", task: HIDDEN });
      expect(r.detail.read_task).not.toBe(HIDDEN);
    },
    T,
  );

  it(
    "item_ver left out: the receipt of a write whose task is pending neither binds nor names it",
    async () => {
      const { c, item } = await disputed(HIDDEN);
      const under = (task: string) =>
        refusal(() => resolve(s.store, ctx(task), { id: item, decision: "keep_effective" }));
      expect((await under("other")).detail).toMatchObject({
        reason: "task_mismatch",
        read_task: HIDDEN,
      });
      await pendTask(c.seq);
      const other = await under("other");
      expect(other).toEqual({
        code: "read_first",
        detail: expect.objectContaining({ reason: "no_read", target: "item" }),
      });
      expect(JSON.stringify(other)).not.toContain(HIDDEN);
      // Under the pending task itself, the receipt is not the caller's own either.
      expect(await under(HIDDEN)).toEqual({
        code: "read_first",
        detail: expect.objectContaining({ reason: "no_read", target: "item" }),
      });
    },
    T,
  );

  it(
    "the writer's own receipt counts as having read its item only while its task is known",
    async () => {
      const opened = await disputed(HIDDEN);
      const items = async (op: number, type: string) =>
        Number(
          (
            await s.store.read((tx) =>
              tx.query<{ n: unknown }>(
                "SELECT count(*) AS n FROM events WHERE op = $1 AND type = $2",
                [op, type],
              ),
            )
          ).rows[0]?.n,
        );
      // Known: the write that overwrites the item takes it as read, and supersedes it.
      const known = await w(HIDDEN, "twelve", {
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "lunches",
            row: opened.row,
            ver: `v${opened.b.seq}.0`,
            set: { amount: "12" },
          },
        ],
      });
      expect(await items(known.seq, "item.superseded")).toBe(1);

      await s.reset();
      minute = 0;
      await createTenant(s.store, ctx("w"));
      await schemaDraft(s.store, ctx("w"), {
        document: { slot: "home", base_version: null, timezone: "UTC", tables: [LUNCH] },
      });
      const again = await disputed(HIDDEN);
      await pendTask(again.c.seq);
      // Pending: not read by that receipt; the write refreshes the item instead.
      const unknown = await w(HIDDEN, "twelve", {
        sv: 1,
        ops: [
          {
            intent: "update",
            table: "lunches",
            row: again.row,
            ver: `v${again.b.seq}.0`,
            set: { amount: "12" },
          },
        ],
      });
      expect(await items(unknown.seq, "item.superseded")).toBe(0);
      expect(await items(unknown.seq, "item.refreshed")).toBe(1);
    },
    T,
  );
});
