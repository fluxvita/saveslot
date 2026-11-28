// The indices only cancelled deletions gave, as the position index reads them from storage
// (`readPositionIndex`, `PositionIndex.onlyCancelled`; 09 §5.7, §3.5 rule 1), on a log the write
// path and `DeletionSession` make. With no cancelled deletion in the slot the restatements are not
// read at all. After one, an index given at write time, one a pending deletion gave an interval
// and one a cancellation restated are none of the class. In this version a deletion that numbers
// an index anew is refused, so no log here holds one of the class (the kernel's fixed cases in
// `delete/cancelled-index.test.ts` cover it). Fictional names.

import {
  createOpsContext,
  createTenant,
  type ReadTx,
  readCitations,
  readPositionIndex,
  schemaDraft,
  takenAway,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeletionSession } from "./testing/deletion.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"5".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const BUDGET = {
  name: "budget",
  kind: "base",
  description: "the monthly budget over time",
  time: { type: "state", granularity: "date" },
  fields: [{ name: "amount", type: "text", required: true, description: "how much" }],
};
const A = `pi_${"2".repeat(16)}`;
const B = `pi_${"4".repeat(16)}`;

// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
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
const w = (ops: unknown[], evidence: string): Promise<Any> =>
  write(s.store, ctx(), { sv: 1, evidence: [{ kind: "user_message", text: evidence }], ops });
const one = async <R>(sql: string, params: unknown[] = []) =>
  s.store.read(async (tx: ReadTx) => (await tx.query<R>(sql, params as never)).rows);
const sourceOf = async (text: string) => {
  const rows = await one<{ seq: unknown }>(
    `SELECT c.seq FROM content c JOIN events e ON e.seq = c.seq
     WHERE e.type = 'source.recorded' AND c.path = 'text' AND c.body LIKE $1`,
    [`%${text}%`],
  );
  return Number(rows[0]?.seq);
};

/** The position index for a deletion of `sources`, and whether it read any `restated/%` block. */
const indexFor = (slot: string, sources: number[]) =>
  s.store.read(async (tx) => {
    let readRestated = false;
    const counting = new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string, params?: unknown[]) => {
          if (sql.includes("'restated/%'")) readRestated = true;
          return target.query(sql, params as never);
        };
      },
    });
    const bases = await readCitations(tx, slot, sources);
    const deleted = takenAway(bases, new Set(sources));
    const index = await readPositionIndex(counting, {
      slot,
      sources,
      bases,
      deleted,
      restated: [],
    });
    return { onlyCancelled: index.onlyCancelled, readRestated };
  });

beforeAll(async () => {
  s = await openReusable("saveslot-only-cancelled-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);

describe("indices only cancelled deletions gave, read from storage", () => {
  it(
    "no cancelled deletion: not read; after one, none of the class",
    async () => {
      await s.reset();
      await createTenant(s.store, ctx());
      await schemaDraft(s.store, ctx(), {
        document: { slot: "home", base_version: null, timezone: "UTC", tables: [BUDGET] },
      });
      // Three writes (as in apply-deletion-sessions.test.ts): deleting the second's words gives
      // the first write's item an interval anew.
      const r1 = await w(
        [{ intent: "insert", table: "budget", set: { amount: "100" }, valid_from: "2026-01-01" }],
        "s1 100",
      );
      const row = r1.ops[0].target.entity as string;
      const update = (amount: string, from: string, to?: string) => ({
        intent: "update",
        table: "budget",
        entity: row,
        set: { amount },
        valid_from: from,
        ...(to !== undefined ? { valid_to: to } : {}),
      });
      await w([update("200", "2026-03-01")], "s2 200");
      await w([update("300", "2026-02-01", "2026-05-01")], "s3 300");
      const slot = (
        await one<{ slot_id: string }>("SELECT slot_id FROM schema_versions LIMIT 1")
      )[0]?.slot_id as string;
      const table = (
        JSON.parse(
          (
            await one<{ body: string }>(
              `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
               WHERE v.state = 'current'`,
            )
          )[0]?.body as string,
        ).tables as Any[]
      ).find((t) => t.name === "budget");
      const s1 = await sourceOf("s1 100");
      const s2 = await sourceOf("s2 200");
      const session = new DeletionSession(s.store, { slot, table, row, actor: USER });

      // A pending deletion restates the first write's item (its interval given anew).
      await session.confirm(A, [s2], now());
      expect(await indexFor(slot, [s1])).toEqual({ onlyCancelled: undefined, readRestated: false });

      // Cancelled: its restatements are a cancelled deletion's, the cancellation restates the item
      // back; a second deletion, pending, restates it again.
      await session.cancel(A, now());
      await session.confirm(B, [s2], now());
      const restatedBy = await one<{ type: string; state: string | null; status: string }>(
        `SELECT e.type, d.state, c.body::json->>'status' AS status
         FROM events e JOIN content c ON c.seq = e.seq
         LEFT JOIN deletions d ON d.confirmed_seq = e.seq
         WHERE e.slot = $1 AND c.path LIKE 'restated/%' AND c.body IS NOT NULL
         ORDER BY e.seq, c.path`,
        [slot],
      );
      const kinds = new Set(restatedBy.map((x) => `${x.type} ${x.state ?? "-"}`));
      expect(kinds).toEqual(
        new Set([
          "deletion.confirmed cancelled",
          "deletion.cancelled -",
          "deletion.confirmed pending",
        ]),
      );
      expect(restatedBy.every((x) => x.status !== "dropped")).toBe(true);
      expect(await indexFor(slot, [s1])).toEqual({ onlyCancelled: undefined, readRestated: true });
    },
    T,
  );
});
