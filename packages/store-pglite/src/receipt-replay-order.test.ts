// A replayed receipt gives what the first one gave, in the same order (04-contract §14 «重放返回什么»):
// both are rebuilt from the log (kernel write/receipt.ts `readReceipt`), and a receipt's objects
// take their key order from the order its operation's blocks are read in, so that read is ordered
// by sequence number and path (write/reads.ts `BLOCKS_OF_EVENTS_SQL`), as the log's own read is.
//
// The database gives rows without an ORDER BY in whatever order it scans them. Here the blocks are
// put out of their path order on purpose between the first receipt and the replay: one block
// rewritten in place (same body) is stored again after the others, so that a read without an
// order meets it last. Without the order, `resolved`'s keys come out in another order than the
// first receipt's.

import { createOpsContext, createTenant, schemaDraft, write } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

let s: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-15T03:${String(minute++ % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: receipts read as JSON
type Any = any;

beforeAll(async () => {
  s = await openReusable("saveslot-receipt-replay-order-");
  await createTenant(s.store, ctx());
  const d = (await schemaDraft(s.store, ctx(), {
    document: {
      slot: "ledger",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [
        {
          name: "plans",
          kind: "base",
          description: "by the day",
          time: { type: "state", granularity: "date" },
          fields: [
            { name: "b", type: "text", description: "first" },
            { name: "c", type: "text", description: "second" },
            { name: "d", type: "text", description: "third" },
          ],
        },
      ],
    },
  })) as Any;
  expect(d.outcome).toBe("applied");
}, T);
afterAll(async () => {
  await s?.close();
}, T);

const rows = async (q: string, params: unknown[] = []) =>
  (await s.store.read((tx) => tx.query(q, params as never))).rows as Record<string, unknown>[];

describe("a replayed receipt", () => {
  it(
    "gives `resolved` in the first receipt's order, whatever order the blocks are stored in",
    async () => {
      const entity = (
        (await write(s.store, ctx(), {
          sv: 1,
          idempotency_key: "k-insert",
          ops: [
            {
              intent: "insert",
              table: "plans",
              set: { b: "1", c: "1", d: "1" },
              valid_from: "2026-11-01",
            },
          ],
        })) as Any
      ).ops[0].target.entity as string;
      const params = {
        sv: 1,
        idempotency_key: "k-update",
        ops: [
          {
            intent: "update",
            table: "plans",
            entity,
            set: { b: "2", c: "2", d: "2" },
            valid_from: "2026-11-05",
          },
        ],
      };
      const first = (await write(s.store, ctx(), params)) as Any;
      expect(Object.keys(first.ops[0].resolved ?? {}).length).toBeGreaterThanOrEqual(2);

      // The span blocks of the update, by path; the first of them stored again after the others.
      const spans = await rows(
        `SELECT c.seq, c.path FROM content c JOIN events e ON e.seq = c.seq
       WHERE e.op = $1 AND c.path LIKE 'span/%' ORDER BY c.path COLLATE "C"`,
        [first.seq],
      );
      expect(spans.length).toBeGreaterThanOrEqual(2);
      const moved = spans[0] as { seq: unknown; path: string };
      // Taken out and put back as it was: stored after the other blocks, with an index entry of its
      // own (an update in place keeps the old entry, and a read through the index the old place).
      await s.store.write(async (tx) => {
        const r = await tx.query<Record<string, unknown>>(
          "DELETE FROM content WHERE seq = $1 AND path = $2 RETURNING *",
          [moved.seq, moved.path] as never,
        );
        const row = r.rows[0] as Record<string, unknown>;
        const cols = Object.keys(row);
        await tx.query(
          `INSERT INTO content (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          cols.map((c) => row[c]) as never,
        );
      });

      const again = (await write(s.store, ctx(), params)) as Any;
      expect(again.replayed).toBe(true);
      expect(JSON.stringify(again.ops)).toBe(JSON.stringify(first.ops));
    },
    T,
  );
});
