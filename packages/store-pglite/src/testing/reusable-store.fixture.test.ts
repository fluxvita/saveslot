// `reset` of a reusable store (reusable-store.fixture.ts) against a store just opened: after a
// sample has used it, a reset store is the store just opened, and the same scenario then gives the
// same store on both. Compared: the database's structure (schemas, relations, columns, indexes,
// views, functions, types), every table's rows, every sequence's position, and the store's read
// buffer. Each kind of state a reset could leave is shown, on a store of its own, to be seen by
// that comparison and to be gone after a reset. On either backend (02-architecture §11 «测试矩阵»).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  query,
  type ReadEntry,
  readBufferOf,
  readEvents,
  readTail,
  type TenantStore,
  write,
} from "@fluxvita/saveslot-kernel";
import { createSlotEvents } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore, reusable } from "./reusable-store.fixture.ts";
import { testBackend } from "./test-backend.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const NOW = "2026-11-05T03:00:00.000Z";
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: NOW,
    confirmation: null,
  });

/** A schema of the database that is not the server's own, by the column holding its name. */
const OWN = (col: string) => `${col} NOT LIKE 'pg\\_%' AND ${col} <> 'information_schema'`;

/** What the database holds of its structure, apart from the rows: one line per thing. */
const STRUCTURE: Record<string, string> = {
  schemas: `SELECT nspname FROM pg_namespace WHERE ${OWN("nspname")}`,
  relations: `SELECT n.nspname || '.' || c.relname || ' ' || c.relkind::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE ${OWN("n.nspname")} AND c.relkind NOT IN ('t', 'i')`,
  columns: `SELECT n.nspname || '.' || c.relname || ' ' || a.attnum || ' ' || a.attname || ' '
      || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || a.attidentity::text
      || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${OWN("n.nspname")} AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
      AND a.attnum > 0 AND NOT a.attisdropped`,
  indexes: `SELECT indexdef FROM pg_indexes WHERE ${OWN("schemaname")}`,
  views: `SELECT schemaname || '.' || viewname || ' ' || definition FROM pg_views
    WHERE ${OWN("schemaname")}`,
  functions: `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid)
      || ') ' || p.prokind::text || ' ' || pg_get_function_result(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${OWN("n.nspname")}`,
  types: `SELECT n.nspname || '.' || t.typname || ' ' || t.typtype::text
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE ${OWN("n.nspname")}`,
};

const big = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);

/**
 * What a reset must give back: the database's structure (schemas, relations, columns, indexes,
 * views, functions, types), every table's rows, every sequence's position, and the read buffer.
 */
async function state(store: TenantStore) {
  const db = await store.read(async (tx) => {
    const structure: Record<string, string[]> = {};
    for (const [what, sql] of Object.entries(STRUCTURE)) {
      const rows = await tx.query<Record<string, string>>(`SELECT * FROM (${sql}) x(line)`);
      structure[what] = rows.rows.map((r) => r["line"] as string).sort();
    }
    const names = await tx.query<{ nspname: string; relname: string; relkind: string }>(
      `SELECT n.nspname, c.relname, c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ${OWN("n.nspname")} AND c.relkind IN ('r', 'p', 'S')
         ORDER BY n.nspname, c.relname`,
    );
    const tables: Record<string, string[]> = {};
    const sequences: Record<string, string> = {};
    for (const { nspname, relname, relkind } of names.rows) {
      const name = `"${nspname}"."${relname}"`;
      if (relkind === "S") {
        const r = await tx.query(`SELECT last_value, is_called FROM ${name}`);
        sequences[name] = JSON.stringify(r.rows[0], big);
      } else {
        const rows = await tx.query(`SELECT * FROM ${name}`);
        tables[name] = rows.rows.map((x) => JSON.stringify(x, big)).sort();
      }
    }
    return { structure, tables, sequences };
  });
  // A read's ID is random: the rest of each entry is compared.
  const reads = readBufferOf(store)
    .entries()
    .map(({ read: _, ...rest }) => rest);
  return { ...db, reads };
}

/** A sample's use of a store: a tenant, a slot, a write, a read left in the buffer, a schema. */
async function use(store: TenantStore) {
  await createTenant(store, ctx());
  await store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents(),
    });
    await applyEvents(tx, eventsOf(op));
  });
  await write(store, ctx(), {
    sv: 1,
    ops: [
      {
        intent: "insert",
        table: "expenses",
        set: { date: "2026-11-01", amount: { value: "12", unit: "CNY" } },
      },
    ],
  });
  await query(store, ctx(), { table: "expenses", limit: 10 });
  await store.write((tx) => tx.exec("CREATE SCHEMA scratch; CREATE TABLE scratch.t (x integer)"));
}

interface Log {
  readonly events: object[];
  readonly content: object[];
}

/** The scenario run on both stores: a log replayed (its IDs are fixed), then a read. */
async function scenario(store: TenantStore, log: Log) {
  await store.write(async (tx) => {
    for (const [table, rows] of [
      ["events", log.events],
      ["content", log.content],
    ] as const) {
      for (const r of rows) {
        const cols = Object.keys(r);
        await tx.query(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(r) as never,
        );
      }
    }
    const last = (await readTail(tx))?.seq ?? 0;
    await applyEvents(tx, await readEvents(tx, 1, last));
  });
  await query(store, ctx(), { table: "expenses", limit: 10 });
}

let reused: ReusableStore;
let opened: ReusableStore;
let fresh: Awaited<ReturnType<typeof state>>;
beforeAll(async () => {
  reused = await openReusable("saveslot-reset-", { buffered: true });
  opened = await openReusable("saveslot-reset-fresh-", { buffered: true });
  fresh = await state(opened.store);
}, T);
afterAll(async () => {
  await reused?.close();
  await opened?.close();
}, T);

describe("reset", () => {
  it(
    "gives the store just opened, and the same scenario then gives the same store",
    async () => {
      await use(reused.store);
      expect(readBufferOf(reused.store).size).toBe(1);
      const log = await reused.store.read(async (tx) => ({
        events: (await tx.query("SELECT * FROM events ORDER BY seq")).rows as object[],
        content: (await tx.query("SELECT * FROM content ORDER BY seq, path")).rows as object[],
      }));
      await reused.reset();
      expect(await state(reused.store)).toEqual(fresh);

      await scenario(reused.store, log);
      await scenario(opened.store, log);
      const after = await state(reused.store);
      expect(after.reads).toHaveLength(1);
      expect(Object.keys(after.tables)).toContain('"public"."t_t1_v1"');
      expect(after).toEqual(await state(opened.store));
    },
    T,
  );

  const READ = {
    read: `rd_${"5".repeat(16)}`,
    actor: USER,
    task: null,
    at: NOW,
    pos: 1,
    operation: "query",
    rows: [],
    coarse: [],
    lastRead: [],
  } as unknown as ReadEntry;

  /** Each kind of state a reset could leave, made on a store just opened. */
  const LEFT: readonly [string, (s: TenantStore) => Promise<unknown>][] = [
    ["a table", (s) => s.write((tx) => tx.exec("CREATE TABLE t_left (x integer)"))],
    ["a schema", (s) => s.write((tx) => tx.exec("CREATE SCHEMA left_over"))],
    [
      "a row",
      (s) => s.write((tx) => tx.exec("INSERT INTO meta (key, value) VALUES ('left', '1')")),
    ],
    // Not the ownership epoch: the open store checks it when it writes, and without it gives up.
    [
      "a row missing from meta",
      (s) => s.write((tx) => tx.exec("DELETE FROM meta WHERE key = 'storage_format'")),
    ],
    [
      "an identity not restarted",
      (s) => s.write((tx) => tx.query("SELECT nextval(pg_get_serial_sequence('read_log', 'n'))")),
    ],
    ["a read in the buffer", async (s) => readBufferOf(s).record(READ)],
    ["a sequence", (s) => s.write((tx) => tx.exec("CREATE SEQUENCE s_left"))],
    ["a view", (s) => s.write((tx) => tx.exec("CREATE VIEW v_left AS SELECT key FROM meta"))],
    [
      "a function",
      (s) =>
        s.write((tx) =>
          tx.exec("CREATE FUNCTION f_left(x integer) RETURNS integer LANGUAGE sql AS 'SELECT x'"),
        ),
    ],
    ["a type", (s) => s.write((tx) => tx.exec("CREATE TYPE e_left AS ENUM ('a', 'b')"))],
  ];
  // The session's state (`SET`, temporary tables, prepared statements, session advisory locks) is
  // outside `reset`, and so outside this comparison: a test using a reusable store leaves it alone.

  // A store of its own for each: what one case leaves, or a reset fails to empty, does not fail
  // the cases after it, so a case that fails names the state it is about.
  it.each(LEFT)(
    "leaving %s would be seen, and resets away",
    async (_, leave) => {
      const s = await openReusable("saveslot-reset-left-");
      try {
        expect(await state(s.store)).toEqual(fresh);
        await leave(s.store);
        expect(await state(s.store)).not.toEqual(fresh);
        await s.reset();
        expect(await state(s.store)).toEqual(fresh);
      } finally {
        await s.close();
      }
    },
    T,
  );

  /**
   * Changes to a kernel table itself: outside `reset`, but seen by the comparison. Each is seen
   * only by the part comparing columns or indexes: no row and no other relation changes.
   */
  const CHANGED: readonly [string, string][] = [
    ["a column's default", "ALTER TABLE meta ALTER COLUMN value SET DEFAULT 'x'"],
    ["an index", "CREATE INDEX i_left ON meta (value)"],
  ];

  // A test that timed out goes on running: its writes must not land after the next reset unseen.
  const STALE: readonly [string, (s: TenantStore, gate: Promise<void>) => Promise<unknown>][] = [
    [
      "a write",
      (s, gate) =>
        s.write(async (tx) => {
          await gate;
          await tx.exec("INSERT INTO meta (key, value) VALUES ('stale', '1')");
        }),
    ],
    [
      "a read",
      (s, gate) =>
        s.read(async (tx) => {
          await gate;
          await tx.query("SELECT 1");
        }),
    ],
  ];

  it.each(STALE)(
    "%s still running is waited for, then reset, and the reset fails saying so",
    async (_, stale) => {
      const s = await openReusable("saveslot-reset-stale-");
      try {
        let open = () => {};
        const left = stale(
          s.store,
          new Promise<void>((r) => {
            open = r;
          }),
        );
        setTimeout(() => open(), 200);
        await expect(s.reset()).rejects.toThrow("were still running");
        await left;
        expect(await state(s.store)).toEqual(fresh);
        await s.reset();
        expect(await state(s.store)).toEqual(fresh);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "a write still running past the wait fails the reset, and the store is not reset",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "saveslot-reset-hung-"));
      const store = await testBackend().open(
        { kind: "pglite", dir: join(root, "tenant") },
        { create: true },
      );
      try {
        const r = await reusable(store, 100);
        await store.write((tx) => tx.exec("INSERT INTO meta (key, value) VALUES ('left', '1')"));
        let open = () => {};
        const gate = new Promise<void>((g) => {
          open = g;
        });
        const left = store.write(async () => {
          await gate;
        });
        await expect(r.reset()).rejects.toThrow("still running after 100 ms");
        open();
        await left;
        expect(await state(store)).not.toEqual(fresh);
        await r.reset();
        expect(await state(store)).toEqual(fresh);
      } finally {
        await store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    T,
  );

  it.each(CHANGED)(
    "%s changed on a kernel table would be seen",
    async (_, ddl) => {
      const s = await openReusable("saveslot-reset-changed-");
      try {
        await s.store.write((tx) => tx.exec(ddl));
        expect(await state(s.store)).not.toEqual(fresh);
      } finally {
        await s.close();
      }
    },
    T,
  );
});
