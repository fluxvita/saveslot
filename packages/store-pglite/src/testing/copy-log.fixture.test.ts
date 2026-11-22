// `copyLog` (copy-log.fixture.ts): the log copied into an empty store is the log it was copied
// from, row for row, whatever number of rows each INSERT takes, and no INSERT binds more than its
// limit of parameters. On a log apply wrote (replayed, it gives the tables of the store copied) and
// on rows written by hand (every nullable column empty and not, text needing quotes, seqs past
// 2^31, more rows than one INSERT takes). On either backend (02-architecture §11 «测试矩阵»).

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type QueryResult,
  type ReadTx,
  readEvents,
  readTail,
  type SqlValue,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import { createSlotEvents } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyLog, insertRows, MAX_PARAMS } from "./copy-log.fixture.ts";
import { openReusable, type ReusableStore, snapshot } from "./reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

let from: ReusableStore;
let into: ReusableStore;
beforeAll(async () => {
  from = await openReusable("saveslot-copy-log-");
  into = await openReusable("saveslot-copy-log-into-");
}, T);
afterAll(async () => {
  await from?.close();
  await into?.close();
}, T);

/** `events` and `content`, every row in `seq` order as JSON text. */
async function log(tx: ReadTx) {
  const big = (_: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
  const rows = async (sql: string) => (await tx.query(sql)).rows.map((r) => JSON.stringify(r, big));
  return {
    events: await rows("SELECT * FROM events ORDER BY seq"),
    content: await rows("SELECT * FROM content ORDER BY seq, path"),
  };
}

/** Inserts `rows` one statement a row, not by the copy's own INSERT. */
async function insertEach(tx: Tx, table: string, rows: readonly Record<string, unknown>[]) {
  for (const r of rows) {
    const cols = Object.keys(r);
    await tx.query(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(r) as SqlValue[],
    );
  }
}

/** `tx` with each statement's number of parameters noted in `bound`. */
function counting(tx: Tx, bound: number[]): Tx {
  return {
    exec: (sql) => tx.exec(sql),
    query: <R>(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<R>> => {
      bound.push(params?.length ?? 0);
      return tx.query<R>(sql, params);
    },
  };
}

describe("copyLog", () => {
  it(
    "a log apply wrote, copied and replayed, gives the tables of the store copied",
    async () => {
      await from.reset();
      await into.reset();
      await createTenant(
        from.store,
        createOpsContext({
          tenant: TENANT,
          actor: USER,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_window: 600_000,
          idempotency_key_window: 86_400_000,
          now: "2026-11-05T03:00:00.000Z",
          confirmation: null,
        }),
      );
      await from.store.write(async (tx) => {
        const op = await appendOperation(tx, {
          actor: USER as never,
          now: "2026-11-05T03:00:30.000Z" as never,
          events: createSlotEvents(),
        });
        await applyEvents(tx, eventsOf(op));
      });
      const copied = await into.store.write(async (tx) => {
        const n = await copyLog(from.store, tx);
        await applyEvents(tx, await readEvents(tx, 1, (await readTail(tx))?.seq ?? 0));
        return n;
      });
      const want = await from.store.read(log);
      expect(copied).toBe(want.events.length);
      expect(copied).toBeGreaterThan(1);
      expect(await into.store.read(log)).toEqual(want);
      expect(await into.store.read(snapshot)).toEqual(await from.store.read(snapshot));
    },
    T,
  );

  // 41 events of 11 columns, 82 content rows of 7: one INSERT for all, one a row, and limits
  // between, giving a last INSERT with fewer rows than the others.
  it.each([MAX_PARAMS, 11, 50, 77, 300])(
    "rows written by hand come out the same, at most %i parameters to an INSERT",
    async (limit) => {
      await from.reset();
      await into.reset();
      const seqs = Array.from({ length: 41 }, (_, i) => (i === 40 ? 2 ** 31 + 7 : i + 1));
      await from.store.write(async (tx) => {
        await insertEach(
          tx,
          "events",
          seqs.map((seq, i) => ({
            seq,
            header: `{"seq":${seq},"note":"it's \\"quoted\\" — ${"é".repeat(i % 3)}"}`,
            header_hash: "a".repeat(64),
            type: "write.base",
            actor: USER,
            at: "2026-11-05T03:00:00.000Z",
            op: seq,
            slot: i % 2 === 0 ? null : "default",
            target_table: i % 3 === 0 ? null : "t1",
            target_row: i % 3 === 0 ? null : `r_${String(i).padStart(26, "0")}`,
            target_event: i % 5 === 0 ? 2 ** 31 + i : null,
          })),
        );
        await insertEach(
          tx,
          "content",
          seqs.flatMap((seq, i) => [
            {
              seq,
              path: "fields/f1",
              body: i % 4 === 0 ? null : `"value ${i}"`,
              checksum: i % 4 === 0 ? null : "b".repeat(64),
              removed_by: i % 4 === 0 ? 2 ** 31 + 8 : null,
              key_id: null,
              placeholder_of: null,
            },
            {
              seq,
              path: "meta/target",
              body: null,
              checksum: null,
              removed_by: null,
              key_id: null,
              placeholder_of: i % 2 === 0 ? seq : null,
            },
          ]),
        );
      });
      const bound: number[] = [];
      const copied = await into.store.write((tx) =>
        copyLog(from.store, counting(tx, bound), limit),
      );
      expect(copied).toBe(41);
      expect(await into.store.read(log)).toEqual(await from.store.read(log));
      expect(Math.max(...bound)).toBeLessThanOrEqual(limit);
      // Every INSERT as full as the limit lets it be, but the last of each table.
      const per = (cols: number, rows: number) => {
        const n = Math.floor(limit / cols);
        return Array.from(
          { length: Math.ceil(rows / n) },
          (_, i) => cols * Math.min(n, rows - i * n),
        );
      };
      expect(bound).toEqual([...per(11, 41), ...per(7, 82)]);
    },
    T,
  );

  it(
    "an empty log copies nothing; a row with more columns than the limit is refused",
    async () => {
      await from.reset();
      await into.reset();
      const bound: number[] = [];
      expect(await into.store.write((tx) => copyLog(from.store, counting(tx, bound)))).toBe(0);
      expect(bound).toEqual([]);
      await expect(
        into.store.write((tx) => insertRows(tx, "events", [{ seq: 1, op: 1 }], 1)),
      ).rejects.toThrow("binds more than 1 parameters");
    },
    T,
  );
});
