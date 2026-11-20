// `sql` is no read of a table for `my_last_read` (04-contract §10): what it read depends on the
// query, and the record keeps a superset of the rows, so neither a query that read nothing nor
// one that read a row means the table was seen. A later `history changes … since: my_last_read`
// still asks the caller to read the table first, and a `query` before it keeps its own position.

import {
  createOpsContext,
  history,
  loadRsql,
  query,
  readBufferOf,
  sql as sqlOp,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, NOW, refusal, TENANT, USER } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlmylast-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

let task = 0;
const ctx = (t: string) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: t,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: NOW,
    confirmation: null,
  });
const since = (t: string) =>
  history(s.store, ctx(t), { mode: "changes", table: "spend", since: "my_last_read" });

describe("a `sql` read under `my_last_read`", () => {
  it.each([
    ["no row at all", "SELECT 1 AS x FROM spend WHERE false"],
    ["one row", "SELECT note FROM spend WHERE category = 'rent'"],
    ["every row", "SELECT note FROM spend"],
  ])("that reads %s leaves the table unread", async (_n, text) => {
    const t = `sql-${++task}`;
    expect(await refusal(since(t))).toMatchObject({ code: "read_first", reason: "no_read" });
    await sqlOp(s.store, ctx(t), { sql: text });
    expect(await refusal(since(t))).toMatchObject({ code: "read_first", reason: "no_read" });
  });

  it("does not move the position of an earlier `query` of the table", async () => {
    const t = `sql-${++task}`;
    await query(s.store, ctx(t), { table: "spend" });
    const written = await write(s.store, ctx(t), {
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "spend",
          set: { date: "2026-11-06", category: "food", note: "after the query" },
        },
      ],
    });
    await sqlOp(s.store, ctx(t), { sql: "SELECT note FROM spend" });
    const r = (await since(t)) as unknown as {
      since: number;
      until: number;
      changes: { seq: number }[];
    };
    // The window starts where the `query` was read, so the write in between is in it; had the
    // `sql` call counted, it would start after that write and miss it.
    expect(r.since).toBeLessThan(written.seq);
    expect(r.changes.map((c) => c.seq)).toContain(written.seq);
  });
});

describe("a `sql` read that is in the read log", () => {
  const insert = (t: string, note: string) =>
    write(s.store, ctx(t), {
      sv: 1,
      ops: [
        {
          intent: "insert",
          table: "spend",
          set: { date: "2026-11-06", category: "food", note },
        },
      ],
    });
  const logged = (t: string) =>
    s.store.read(async (tx) => {
      const r = await tx.query<{ operation: string; n: unknown }>(
        "SELECT operation, count(*) AS n FROM read_log WHERE task = $1 GROUP BY operation",
        [t] as never,
      );
      return Object.fromEntries(r.rows.map((x) => [x.operation, Number(x.n)]));
    });

  it.each([
    ["no row at all", "SELECT 1 AS x FROM spend WHERE false"],
    ["one row", "SELECT note FROM spend WHERE category = 'rent'"],
    ["every row", "SELECT note FROM spend"],
  ])("that read %s, once written, still leaves the table unread", async (_n, text) => {
    const t = `sql-${++task}`;
    await sqlOp(s.store, ctx(t), { sql: text });
    // A write puts the buffered reads into the log: the question is asked of the persisted path.
    await insert(t, "flushes the buffer");
    expect(readBufferOf(s.store).size).toBe(0);
    expect(await logged(t)).toEqual({ sql: 1 });
    // Not counted: `read_first`, and the task the sql call ran under is not named as the one that read.
    const e = await refusal(since(t));
    expect(e).toMatchObject({ code: "read_first" });
    expect(e["read_task"]).not.toBe(t);
  });

  it("does not move the position of a `query` that is in the log with it", async () => {
    const t = `sql-${++task}`;
    await query(s.store, ctx(t), { table: "spend" });
    const written = await insert(t, "between the two");
    await sqlOp(s.store, ctx(t), { sql: "SELECT note FROM spend" });
    await insert(t, "flushes the sql read");
    expect(readBufferOf(s.store).size).toBe(0);
    expect(await logged(t)).toMatchObject({ query: 1, sql: 1 });
    const r = (await since(t)) as unknown as { since: number; changes: { seq: number }[] };
    expect(r.since).toBeLessThan(written.seq);
    expect(r.changes.map((c) => c.seq)).toContain(written.seq);
  });
});
