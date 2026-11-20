// A read kept to what its caller can give (kernel/ops/read.ts `Fit`): computed once more with the
// limit the caller keeps, in the same read transaction; only that read is recorded, with exactly
// the rows kept, and the next page starts at the first entry not kept (`sql` by its `max_rows`).
// Keeping nothing records nothing; an amount the read does not have is the caller's fault.

import {
  catalog,
  createOpsContext,
  createTenant,
  type Fit,
  history,
  loadRsql,
  NothingKept,
  pending,
  query,
  readsList,
  schemaDraft,
  sql,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"9".repeat(26)}`;
const USER = `u_${"2".repeat(26)}`;

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
    now: `2026-11-05T04:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });

/** The query reads recorded so far, newest first. */
async function queryReads() {
  const r = await readsList(s.store, ctx(), { limit: 200 });
  return r.reads.filter((x) => x.operation === "query");
}

beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-read-fit-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await schemaDraft(s.store, ctx(), {
    document: {
      slot: "ledger",
      base_version: null,
      timezone: "Asia/Shanghai",
      tables: [
        {
          name: "expenses",
          kind: "base",
          description: "one row per expense",
          time: { type: "event", field: "date" },
          fields: [
            { name: "date", type: "date", required: true, description: "the day" },
            { name: "note", type: "text", description: "what for" },
          ],
        },
      ],
    },
  });
  await write(s.store, ctx(), {
    sv: 1,
    ops: Array.from({ length: 10 }, (_, i) => ({
      intent: "insert",
      table: "expenses",
      set: { date: `2026-11-${String(i + 1).padStart(2, "0")}`, note: `n${i}` },
    })),
  });
}, T);

describe("a read kept to k entries", () => {
  it(
    "records one read of exactly the k rows kept; the next page starts at entry k + 1; fit is asked once",
    async () => {
      const all = await query(s.store, ctx(), { table: "expenses", limit: 10 });
      const before = (await queryReads()).length;
      const seen: number[] = [];
      const fit: Fit = (r) => {
        seen.push((r as { rows: unknown[] }).rows.length);
        return 4;
      };
      const kept = await query(s.store, ctx(), { table: "expenses", limit: 10 }, fit);
      expect(seen).toEqual([10]);
      expect(kept.rows.map((r) => r.row)).toEqual(all.rows.slice(0, 4).map((r) => r.row));
      const reads = await queryReads();
      expect(reads.length).toBe(before + 1);
      expect(reads[0]?.rows?.map((r) => r.target.row)).toEqual(kept.rows.map((r) => r.row));
      const next = await query(s.store, ctx(), {
        table: "expenses",
        limit: 10,
        position: kept.next_position,
      });
      expect(next.rows.map((r) => r.row)).toEqual(all.rows.slice(4).map((r) => r.row));
    },
    T,
  );

  it(
    "sql: computed once more with the k rows kept as max_rows; one read recorded; keeping none records none",
    async () => {
      const statement = { sql: "SELECT note FROM expenses ORDER BY note", max_rows: 10 };
      const all = await sql(s.store, ctx(), statement);
      const sqlReads = async () =>
        (await readsList(s.store, ctx(), { limit: 200 })).reads.filter((x) => x.operation === "sql")
          .length;
      const before = await sqlReads();
      const seen: number[] = [];
      const kept = await sql(s.store, ctx(), statement, {
        fit: (r) => {
          seen.push((r as { rows: unknown[] }).rows.length);
          return 4;
        },
      });
      expect(seen).toEqual([10]);
      expect(kept.rows).toEqual(all.rows.slice(0, 4));
      expect(kept.next_position).toBeDefined();
      expect(await sqlReads()).toBe(before + 1);
      await expect(sql(s.store, ctx(), statement, { fit: () => 0 })).rejects.toBeInstanceOf(
        NothingKept,
      );
      expect(await sqlReads()).toBe(before + 1);
    },
    T,
  );

  it(
    "a timeline kept to k entries",
    async () => {
      const row = (await query(s.store, ctx(), { table: "expenses", limit: 1 })).rows[0]?.row;
      await write(s.store, ctx(), {
        sv: 1,
        ops: [{ intent: "update", table: "expenses", row, set: { note: "again" } }],
      });
      const t = (await history(s.store, ctx(), { table: "expenses", row }, () => 1)) as unknown as {
        entries: unknown[];
      };
      expect(t.entries).toHaveLength(1);
    },
    T,
  );
});

describe("keeping nothing, or what the read does not have", () => {
  it(
    "keeping nothing records nothing and says so",
    async () => {
      const before = (await queryReads()).length;
      await expect(query(s.store, ctx(), { table: "expenses" }, () => 0)).rejects.toBeInstanceOf(
        NothingKept,
      );
      expect((await queryReads()).length).toBe(before);
    },
    T,
  );

  it.each([
    ["all of it, as if cut", 10],
    ["more than there is", 11],
    ["a fraction", 2.5],
    ["less than none", -1],
  ])("%s: the caller's fault, nothing recorded", async (_, k) => {
    const before = (await queryReads()).length;
    await expect(query(s.store, ctx(), { table: "expenses", limit: 10 }, () => k)).rejects.toThrow(
      /does not have/,
    );
    expect((await queryReads()).length).toBe(before);
  });

  it(
    "what fit throws goes up as it is, nothing recorded",
    async () => {
      const before = (await queryReads()).length;
      const mine = new Error("mine");
      await expect(
        query(s.store, ctx(), { table: "expenses" }, () => {
          throw mine;
        }),
      ).rejects.toBe(mine);
      expect((await queryReads()).length).toBe(before);
    },
    T,
  );

  it(
    "the pending list kept whole, or not at all",
    async () => {
      await expect(pending(s.store, ctx(), {}, () => undefined)).resolves.toBeDefined();
      await expect(pending(s.store, ctx(), {}, () => 0)).rejects.toBeInstanceOf(NothingKept);
    },
    T,
  );

  it(
    "a result that is no page (the catalog's tables) kept in part: the caller's fault",
    async () => {
      await expect(
        catalog(s.store, ctx(), { level: "table", tables: ["expenses"] }, () => 1),
      ).rejects.toThrow(/does not have/);
      await expect(
        catalog(s.store, ctx(), { level: "table", tables: ["expenses"] }, () => 0),
      ).rejects.toBeInstanceOf(NothingKept);
    },
    T,
  );
});
