// `log.reconcile` on either backend (04-contract-types §8.4; 02-architecture §7 replay comparison,
// §8 the "Replay comparison" column, §11 K12): the log replayed from an empty storage into a
// scratch one equals the live tables, a restored tenant's and a derived table's too; a table
// changed without `apply` is found, named by IDs only; batches, a write between batches and a write
// during the comparison change nothing of that. Fictional IDs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  loadRsql,
  OpsError,
  RECONCILE_MISMATCHES_SHOWN,
  type ReconcileResult,
  readBufferOf,
  readTail,
  reconcileLog,
  restoreTenant,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, SLOT, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

let live: ReusableStore;
let scratch: ReusableStore;
let minute = 0;
let ids = 0;
/** The first expense the setup writes, early in the log. */
let lunch: { readonly target: { row: string }; ver: string };
const now = () => {
  minute++;
  return `2026-11-05T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

type Receipt = { readonly ops: readonly { readonly target: { row?: string }; ver?: string }[] };

/** One write request through the pipeline; a refusal thrown with its detail. */
async function write(
  store: TenantStore,
  ops: readonly Record<string, unknown>[],
): Promise<Receipt> {
  try {
    return await write1(store, ops);
  } catch (e) {
    const x = e as { code?: string; detail?: unknown };
    if (x.code === undefined) throw e;
    throw new Error(`write refused: ${JSON.stringify({ code: x.code, detail: x.detail })}`);
  }
}

async function write1(
  store: TenantStore,
  ops: readonly Record<string, unknown>[],
): Promise<Receipt> {
  return store.write(
    (tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params: { sv: 1, ops } as never,
        newId,
        reads: readBufferOf(store),
      }) as Promise<Receipt>,
  );
}

const expense = (note: string) => ({
  intent: "insert",
  table: "expenses",
  set: { date: "2026-11-01", category: "food", amount: { value: "12.50", unit: "CNY" }, note },
});

const reconcile = (o: { batch?: number; scratch?: TenantStore } = {}) =>
  reconcileLog({ live: live.store, scratch: o.scratch ?? scratch.store, ...o });

/** Runs SQL on the live storage, past `apply`: what K12 says reconciling must find. */
const tamper = (sql: string, params: readonly unknown[] = []) =>
  live.store.write((tx) => tx.query(sql, params as never));

/** Adds past apply a copy of the row of `table` whose `column` is `from`, with `to` there instead. */
const copyRow = (table: string, column: string, from: string, to: string) =>
  live.store.write(async (tx) => {
    await tx.query(`CREATE TEMP TABLE copied AS SELECT * FROM "${table}" WITH NO DATA`);
    await tx.query(`INSERT INTO copied SELECT * FROM "${table}" WHERE "${column}" = $1`, [from]);
    await tx.query(`UPDATE copied SET "${column}" = $1`, [to]);
    await tx.query(`INSERT INTO "${table}" SELECT * FROM copied`);
    await tx.query("DROP TABLE copied");
  });

const one = async (sql: string): Promise<string> => {
  const r = await live.store.read((tx) => tx.query<{ v: string }>(sql));
  return String(r.rows[0]?.v);
};

beforeAll(async () => {
  live = await openReusable("saveslot-reconcile-live-");
  scratch = await openReusable("saveslot-reconcile-scratch-");
}, T);
afterAll(async () => {
  await live?.close();
  await scratch?.close();
}, T);
beforeEach(async () => {
  await live.reset();
  await scratch.reset();
  readBufferOf(live.store).take();
  ids = 0;
  await createTenant(
    live.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: "2026-11-05T00:00:00.000Z",
      confirmation: null,
    }),
  );
}, T);

/** Creates the slot `events` make, applied. */
const createSlot = (events: ReturnType<typeof createSlotEvents>) =>
  live.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });

const without = (r: ReconcileResult) => JSON.stringify(r);

const tail = async () => (await live.store.read((tx) => readTail(tx)))?.seq ?? 0;

/**
 * Changes the setup's first expense's note until the log is past seq 100: the note's cells then have
 * `rec_from` of one, two and three digits, and so do the sources' `seq`.
 */
async function pastSeq100(): Promise<string> {
  const row = lunch.target.row;
  let ver = lunch.ver;
  for (let i = 0; (await tail()) <= 100; i++) {
    const r = await write(live.store, [
      { intent: "update", table: "expenses", row, ver, set: { note: `note ${i}` } },
    ]);
    ver = r.ops[0]?.ver as string;
  }
  return row;
}

/**
 * Whether text order puts `k` among `keys` before a smaller number: then a merge by number misaligns
 * on it, where a key whose neighbours agree either way would pass even sorted as text.
 */
const misplaced = (k: number, keys: readonly number[]): boolean => {
  const text = [...new Set([...keys, k])].map(String).sort();
  const next = text[text.indexOf(String(k)) + 1];
  return next !== undefined && Number(next) < k;
};

const ints = async (sql: string, params: readonly unknown[] = []): Promise<number[]> => {
  const r = await live.store.read((tx) => tx.query<{ v: unknown }>(sql, params as never));
  return r.rows.map((x) => Number(x.v));
};

describe("reconcileLog", () => {
  beforeEach(async () => {
    await createSlot(createSlotEvents());
    lunch = (await write(live.store, [expense("lunch"), expense("dinner"), expense("coffee")]))
      .ops[0] as typeof lunch;
    await write(live.store, [{ intent: "insert", table: "rooms", set: { guest: "ann" } }]);
    await write(live.store, [{ intent: "insert", table: "rooms", set: { guest: "bob" } }]);
  }, T);

  it(
    "finds no mismatch in a log replayed from an empty storage, and lists every compared table",
    async () => {
      const r = await reconcile();
      expect(r.mismatches).toEqual([]);
      expect(r.mismatches_total).toBe(0);
      expect(r.compared_to).toBe((await live.store.read((tx) => readTail(tx)))?.seq);
      const names = r.tables.map((t) => t.name);
      for (const t of [
        "principals",
        "slots",
        "catalog",
        "t_t1_v1",
        "t_t1_v1__ver",
        "t_t3_v1",
        "t_t3_v1__ver",
      ]) {
        expect(names).toContain(t);
      }
      expect(names).not.toContain("events");
      expect(names).not.toContain("read_log");
      expect(r.tables.find((t) => t.name === "t_t1_v1")).toEqual({
        name: "t_t1_v1",
        rows: 3,
        mismatched: 0,
      });
    },
    T,
  );

  it(
    "finds a business table's field changed past apply, by row and field, without its value",
    async () => {
      const row = await one("SELECT row_id AS v FROM t_t1_v1 ORDER BY row_id LIMIT 1");
      await tamper(`UPDATE t_t1_v1 SET "f_f4" = 'TAMPERED-1' WHERE row_id = $1`, [row]);
      const r = await reconcile();
      expect(r.mismatches).toEqual([{ table: "t_t1_v1", row, field: "f4", kind: "different" }]);
      expect(r.mismatches_total).toBe(1);
      expect(without(r)).not.toContain("TAMPERED");
    },
    T,
  );

  it(
    "finds a business row removed past apply as missing, and one added as extra",
    async () => {
      const row = await one("SELECT row_id AS v FROM t_t1_v1 ORDER BY row_id LIMIT 1");
      await tamper("DELETE FROM t_t1_v1 WHERE row_id = $1", [row]);
      const added = `r_${"9".repeat(26)}`;
      await tamper(
        `INSERT INTO t_t1_v1 (row_id, "f_f1", "f_f3", "f_f4") VALUES ($1, '2026-11-02', 1, 'ADDED-1')`,
        [added],
      );
      const r = await reconcile();
      expect(r.mismatches).toEqual(
        expect.arrayContaining([
          { table: "t_t1_v1", row, kind: "missing" },
          { table: "t_t1_v1", row: added, kind: "extra" },
        ]),
      );
      expect(r.mismatches_total).toBe(2);
      expect(without(r)).not.toContain("ADDED");
    },
    T,
  );

  it(
    "finds a version table's cell changed past apply, by row and the cell's field",
    async () => {
      const row = await one("SELECT row_id AS v FROM t_t1_v1 ORDER BY row_id LIMIT 1");
      await tamper(
        `UPDATE t_t1_v1__ver SET "f_f4" = 'TAMPERED-2' WHERE row_id = $1 AND field_id = 'f4'`,
        [row],
      );
      const r = await reconcile();
      expect(r.mismatches).toEqual([
        { table: "t_t1_v1__ver", row, field: "f4", kind: "different" },
      ]);
      expect(without(r)).not.toContain("TAMPERED");
    },
    T,
  );

  it(
    "names a state table's row by its entity, not the stretch's start",
    async () => {
      const entity = await one("SELECT entity_id AS v FROM t_t3_v1 ORDER BY entity_id LIMIT 1");
      await tamper(`UPDATE t_t3_v1 SET "f_f1" = 'TAMPERED-6' WHERE entity_id = $1`, [entity]);
      const r = await reconcile();
      expect(r.mismatches).toEqual([
        { table: "t_t3_v1", row: entity, field: "f1", kind: "different" },
      ]);
      expect(without(r)).not.toContain("TAMPERED");
    },
    T,
  );

  it(
    "finds a state table's entity removed past apply as missing, and one added as extra",
    async () => {
      const entity = await one("SELECT entity_id AS v FROM t_t3_v1 ORDER BY entity_id LIMIT 1");
      const added = `e_${"9".repeat(26)}`;
      await copyRow("t_t3_v1", "entity_id", entity, added);
      await tamper("DELETE FROM t_t3_v1 WHERE entity_id = $1", [entity]);
      const r = await reconcile();
      expect(r.mismatches).toEqual(
        expect.arrayContaining([
          { table: "t_t3_v1", row: entity, kind: "missing" },
          { table: "t_t3_v1", row: added, kind: "extra" },
        ]),
      );
      expect(r.mismatches_total).toBe(2);
      expect(without(r)).not.toContain("2026-");
    },
    T,
  );

  it(
    "finds no mismatch in a tenant restored once and written after",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "saveslot-reconcile-anchor-"));
      try {
        const restored = await restoreTenant({
          store: live.store,
          anchor: openFileAnchorStore(join(dir, "anchor.json")),
          tenant: TENANT as never,
          now: now() as never,
        });
        await write(live.store, [expense("after the restore")]);
        expect(await one("SELECT count(*) AS v FROM events WHERE type = 'tenant.restored'")).toBe(
          "1",
        );
        const r = await reconcile();
        expect(r.mismatches).toEqual([]);
        expect(r.compared_to).toBeGreaterThan(restored.restoredSeq);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  it(
    "finds a kernel table changed past apply; not the catalog's profile",
    async () => {
      await tamper("UPDATE principals SET name = 'TAMPERED-3' WHERE id = $1", [USER]);
      await tamper(`UPDATE catalog SET profile = '{"rows":12345}'`);
      const r = await reconcile();
      expect(r.mismatches).toEqual([
        { table: "principals", row: USER, field: "name", kind: "different" },
      ]);
      expect(without(r)).not.toContain("TAMPERED");
    },
    T,
  );

  it(
    "leaves a key that is content out of the row: a request key changed is a table's mismatch",
    async () => {
      const key = await one("SELECT key AS v FROM request_keys ORDER BY key LIMIT 1");
      await tamper("UPDATE request_keys SET key = 'TAMPERED-4' WHERE key = $1", [key]);
      const r = await reconcile();
      expect(r.mismatches).toEqual(
        expect.arrayContaining([
          { table: "request_keys", kind: "missing" },
          { table: "request_keys", kind: "extra" },
        ]),
      );
      expect(without(r)).not.toContain("TAMPERED");
      expect(without(r)).not.toContain(key);
    },
    T,
  );

  // 04-contract-types §8.4: each mismatch is one place (table, row, field, kind), listed once;
  // `mismatches_total` counts places, `tables[].mismatched` rows.
  it(
    "lists two cells of one row and field removed past apply as one place, one row",
    async () => {
      const row = lunch.target.row;
      await write(live.store, [
        { intent: "update", table: "expenses", row, ver: lunch.ver, set: { note: "brunch" } },
      ]);
      const cells = await ints(
        `SELECT rec_from AS v FROM t_t1_v1__ver WHERE row_id = $1 AND field_id = 'f4'`,
        [row],
      );
      expect(cells.length).toBe(2);
      await tamper(`DELETE FROM t_t1_v1__ver WHERE row_id = $1 AND field_id = 'f4'`, [row]);
      const r = await reconcile();
      expect(r.mismatches).toEqual([{ table: "t_t1_v1__ver", row, field: "f4", kind: "missing" }]);
      expect(r.mismatches_total).toBe(1);
      expect(r.tables.find((t) => t.name === "t_t1_v1__ver")?.mismatched).toBe(1);
    },
    T,
  );

  it(
    "counts three fields of one row changed past apply as three places and one row",
    async () => {
      const row = lunch.target.row;
      await tamper(
        `UPDATE t_t1_v1 SET "f_f1" = '2026-10-01', "f_f4" = 'TAMPERED-7', "f_f5" = 99
           WHERE row_id = $1`,
        [row],
      );
      const r = await reconcile();
      expect(r.mismatches).toEqual(
        ["f1", "f4", "f5"].map((field) => ({ table: "t_t1_v1", row, field, kind: "different" })),
      );
      expect(r.mismatches_total).toBe(3);
      expect(r.tables.find((t) => t.name === "t_t1_v1")?.mismatched).toBe(1);
    },
    T,
  );

  it(
    "names no row of a table whose key is content: request keys changed are two places, counted by rows",
    async () => {
      const n = Number(await one("SELECT count(*) AS v FROM request_keys"));
      expect(n).toBeGreaterThan(1);
      await tamper("UPDATE request_keys SET key = 'TAMPERED-8-' || key");
      const r = await reconcile();
      expect(r.mismatches).toEqual([
        { table: "request_keys", kind: "missing" },
        { table: "request_keys", kind: "extra" },
      ]);
      expect(r.mismatches_total).toBe(2);
      expect(r.tables.find((t) => t.name === "request_keys")?.mismatched).toBe(2 * n);
      expect(without(r)).not.toContain("TAMPERED");
    },
    T,
  );

  it(
    "names no row of external keys, whose key holds the key values",
    async () => {
      await tamper(
        `INSERT INTO external_keys (table_id, key_values, holder_row, state)
           VALUES ('t1', '["SECRET-EK-1"]', $1, 'present')`,
        [lunch.target.row],
      );
      const r = await reconcile();
      expect(r.mismatches).toEqual([{ table: "external_keys", kind: "extra" }]);
      expect(without(r)).not.toContain("SECRET");
    },
    T,
  );

  it(
    "names a row of counts by its table ID",
    async () => {
      expect(await one("SELECT count(*) AS v FROM counts WHERE table_id = 't1'")).not.toBe("0");
      await tamper("UPDATE counts SET row_count = row_count + 7 WHERE table_id = 't1'");
      const r = await reconcile();
      expect(r.mismatches).toEqual([
        { table: "counts", row: "t1", field: "row_count", kind: "different" },
      ]);
      expect(r.mismatches_total).toBe(1);
    },
    T,
  );

  it(
    "names a table on one side only, and a table whose columns differ",
    async () => {
      await tamper(`CREATE TABLE t_t9_v1 (row_id TEXT COLLATE "C" PRIMARY KEY)`);
      await tamper(`ALTER TABLE t_t1_v1 ADD COLUMN "f_f99" TEXT`);
      const r = await reconcile();
      expect(r.mismatches).toEqual(
        expect.arrayContaining([
          { table: "t_t9_v1", kind: "extra" },
          { table: "t_t1_v1", kind: "different" },
        ]),
      );
      expect(r.mismatches_total).toBe(2);
    },
    T,
  );

  // A row's ID comes from its primary key: without one, the other columns would make it, and they
  // hold content (here a stretch's start, business time).
  const SECRET = "SECRET-PK-1";
  const hideAndDelete = async () => {
    await tamper(
      `UPDATE base_sources SET valid_from = $1
         WHERE event_seq = (SELECT min(event_seq) FROM base_sources)`,
      [SECRET],
    );
    await tamper(
      `DELETE FROM base_sources WHERE event_seq = (SELECT max(event_seq) FROM base_sources)`,
    );
  };
  // `reset` empties the kernel's tables but does not make them again: a primary key changed is put
  // back after the case, on both storages.
  let keyChanged = false;
  const changeKey = async (sql: string) => {
    keyChanged = true;
    await tamper(sql);
  };
  afterEach(async () => {
    if (!keyChanged) return;
    keyChanged = false;
    for (const s of [live, scratch]) {
      await s.reset();
      await s.store.write(async (tx) => {
        await tx.query("ALTER TABLE base_sources DROP CONSTRAINT IF EXISTS base_sources_pkey");
        await tx.query(
          "ALTER TABLE base_sources ADD PRIMARY KEY (event_seq, row_id, field_id, k, n)",
        );
      });
    }
  }, T);
  const noValue = (r: ReconcileResult) => {
    expect(without(r)).not.toContain(SECRET);
    expect(without(r)).not.toContain("2026-");
    expect(without(r)).not.toContain("applied");
  };

  it(
    "finds a primary key dropped past apply as a table's mismatch, with no row and no value",
    async () => {
      await hideAndDelete();
      await changeKey("ALTER TABLE base_sources DROP CONSTRAINT base_sources_pkey");
      const r = await reconcile();
      expect(r.mismatches).toEqual([{ table: "base_sources", kind: "different" }]);
      expect(r.mismatches_total).toBe(1);
      noValue(r);
    },
    T,
  );

  it(
    "finds a primary key of the same columns in another order as a table's mismatch",
    async () => {
      await changeKey("ALTER TABLE base_sources DROP CONSTRAINT base_sources_pkey");
      await changeKey(
        "ALTER TABLE base_sources ADD PRIMARY KEY (row_id, event_seq, field_id, k, n)",
      );
      const r = await reconcile();
      expect(r.mismatches).toEqual([{ table: "base_sources", kind: "different" }]);
    },
    T,
  );

  it(
    "names no row of a table with no primary key on either side: a table's mismatch",
    async () => {
      await hideAndDelete();
      await changeKey("ALTER TABLE base_sources DROP CONSTRAINT base_sources_pkey");
      let comparing = false;
      const keyless = new Proxy(scratch.store, {
        get(target, k) {
          if (k === "read") {
            return async (fn: never) => {
              if (comparing) {
                await target.write((tx) =>
                  tx.query("ALTER TABLE base_sources DROP CONSTRAINT base_sources_pkey"),
                );
              }
              return target.read(fn);
            };
          }
          const v = Reflect.get(target, k);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const r = await reconcileLog({
        live: live.store,
        scratch: keyless,
        onPhase: (phase) => {
          comparing = phase === "compare";
        },
      });
      expect(comparing).toBe(true);
      expect(r.mismatches).toEqual([{ table: "base_sources", kind: "different" }]);
      noValue(r);
    },
    T,
  );

  it(
    `lists ${RECONCILE_MISMATCHES_SHOWN} mismatches and counts them all`,
    async () => {
      for (let i = 0; i < 10; i++) {
        await write(
          live.store,
          [1, 2, 3, 4, 5].map((k) => expense(`n${i}-${k}`)),
        );
      }
      const cells = Number(await one("SELECT count(*) AS v FROM t_t1_v1__ver"));
      expect(cells).toBeGreaterThan(RECONCILE_MISMATCHES_SHOWN);
      await tamper("UPDATE t_t1_v1__ver SET rec_to = 999999");
      const r = await reconcile();
      expect(r.mismatches).toHaveLength(RECONCILE_MISMATCHES_SHOWN);
      expect(r.mismatches_total).toBe(cells);
    },
    T,
  );

  // The keys are integers: sorted as text (10 before 9, 100 before 11) and merged as numbers, one row
  // on one side only would misalign every row after it.
  it.each([10, 100])(
    "finds one source added past apply as one extra row, its seq from %i and misplaced as text",
    async (from) => {
      await pastSeq100();
      const seqs = await ints("SELECT seq AS v FROM sources ORDER BY seq");
      expect(seqs.some((x) => x < 10) && seqs.some((x) => x >= 10 && x < 100)).toBe(true);
      expect(seqs.some((x) => x >= 100)).toBe(true);
      let seq = from;
      while (seqs.includes(seq) || !misplaced(seq, seqs)) seq++;
      expect(seq).toBeLessThan(from * 10);
      await tamper(
        `INSERT INTO sources (seq, source_id, kind, level, slot_id, deletion_state)
           SELECT $1, $2, kind, level, slot_id, deletion_state FROM sources ORDER BY seq LIMIT 1`,
        [seq, `s_${"9".repeat(16)}`],
      );
      const r = await reconcile();
      expect(r.mismatches).toEqual([{ table: "sources", row: String(seq), kind: "extra" }]);
      expect(r.mismatches_total).toBe(1);
    },
    T,
  );

  it.each([10, 100])(
    "finds one version cell removed past apply as one missing cell, its rec_from from %i and misplaced as text",
    async (from) => {
      const row = await pastSeq100();
      const cells = await ints(
        `SELECT rec_from AS v FROM t_t1_v1__ver WHERE row_id = $1 AND field_id = 'f4' ORDER BY rec_from`,
        [row],
      );
      expect(cells.some((x) => x < 10) && cells.some((x) => x >= 100)).toBe(true);
      const gone = cells.find((x) => x >= from && misplaced(x, cells)) as number;
      expect(gone).toBeLessThan(from * 10);
      await tamper(
        `DELETE FROM t_t1_v1__ver WHERE row_id = $1 AND field_id = 'f4' AND rec_from = $2`,
        [row, gone],
      );
      const r = await reconcile();
      expect(r.mismatches).toEqual([{ table: "t_t1_v1__ver", row, field: "f4", kind: "missing" }]);
      expect(r.mismatches_total).toBe(1);
    },
    T,
  );

  it(
    "gives the same in batches of one, two, three and all",
    async () => {
      const row = await one("SELECT row_id AS v FROM t_t1_v1 ORDER BY row_id LIMIT 1");
      await tamper(`UPDATE t_t1_v1 SET "f_f4" = 'TAMPERED-5' WHERE row_id = $1`, [row]);
      const results: ReconcileResult[] = [];
      for (const batch of [1, 2, 3, 100_000]) {
        await scratch.reset();
        results.push(await reconcile({ batch }));
      }
      for (const r of results.slice(1)) expect(r).toEqual(results[0]);
      expect(results[0]?.mismatches_total).toBe(1);
    },
    T,
  );

  it(
    "takes up a write made between two batches, and compares to the log's end after it",
    async () => {
      let first = true;
      const intercepting = new Proxy(scratch.store, {
        get(target, k) {
          if (k === "write") {
            return async (fn: never) => {
              if (first) {
                first = false;
                await write(live.store, [expense("between")]);
              }
              return target.write(fn);
            };
          }
          const v = Reflect.get(target, k);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const r = await reconcile({ batch: 1, scratch: intercepting });
      expect(first).toBe(false);
      expect(r.mismatches).toEqual([]);
      expect(r.compared_to).toBe((await live.store.read((tx) => readTail(tx)))?.seq);
      expect(r.tables.find((t) => t.name === "t_t1_v1")?.rows).toBe(4);
    },
    T,
  );

  it(
    "brings the scratch storage up to the log's end it compares to, a write landing just before the comparison",
    async () => {
      // The live storage's reads, with one batch taking the whole log: its end, the batch, its end
      // again (caught up), then the comparison's. The write comes just before the fourth.
      let reads = 0;
      const live4 = new Proxy(live.store, {
        get(target, k) {
          if (k === "read") {
            return async (fn: never) => {
              if (++reads === 4) await write(live.store, [expense("before the comparison")]);
              return target.read(fn);
            };
          }
          const v = Reflect.get(target, k);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const r = await reconcileLog({ live: live4, scratch: scratch.store, batch: 100_000 });
      expect(reads).toBe(4);
      expect(r.mismatches).toEqual([]);
      expect(r.compared_to).toBe((await live.store.read((tx) => readTail(tx)))?.seq);
      expect(r.tables.find((t) => t.name === "t_t1_v1")?.rows).toBe(4);
    },
    T,
  );

  it(
    "is not misled by a write made while it compares: it compares to the log's end it read",
    async () => {
      const before = (await live.store.read((tx) => readTail(tx)))?.seq;
      let during: Promise<Receipt> | undefined;
      const r = await reconcileLog({
        live: live.store,
        scratch: scratch.store,
        // Inside the live read, as the comparison begins.
        onPhase: (phase) => {
          if (phase === "compare") during = write(live.store, [expense("during")]);
        },
      });
      expect(during).toBeDefined();
      await during;
      expect(r.mismatches).toEqual([]);
      expect(r.compared_to).toBe(before);
      expect((await live.store.read((tx) => readTail(tx)))?.seq).toBeGreaterThan(before ?? 0);
    },
    T,
  );

  it(
    "refuses a scratch storage that is not empty",
    async () => {
      await createTenant(
        scratch.store,
        createOpsContext({
          tenant: TENANT,
          actor: USER,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 0,
          idempotency_window: 0,
          now: "2026-11-05T00:00:00.000Z",
          confirmation: null,
        }),
      );
      await expect(reconcile()).rejects.toBeInstanceOf(OpsError);
    },
    T,
  );

  it(
    "refuses a scratch storage with no event but a row of a materialized table",
    async () => {
      await scratch.store.write((tx) =>
        tx.query(
          "INSERT INTO principals (id, kind, state, registered_seq) VALUES ($1, 'user', 'active', 1)",
          [USER],
        ),
      );
      await expect(reconcile()).rejects.toBeInstanceOf(OpsError);
    },
    T,
  );
});

describe("reconcileLog, a slot with a derived table", () => {
  beforeAll(async () => {
    await loadRsql();
  }, T);
  beforeEach(async () => {
    const schema = {
      ...derivedSchema(
        rule("SELECT route AS route, count(*) AS runs FROM runs GROUP BY 1", ["route", "runs"]),
      ),
      slot: SLOT,
    };
    const change = (target: Record<string, unknown>, kind: string) => ({
      target,
      change: kind,
      class: "create",
      compatible_with_old_writes: true,
      destructive: false,
      auto: true,
    });
    await createSlot(
      createSlotEvents({
        compiled: schema as never,
        changes: [
          change({ slot: true }, "create_slot"),
          ...schema.tables.map((t) =>
            change({ table: t.id }, t.kind === "base" ? "add_table" : "add_derived_table"),
          ),
        ] as never,
      }),
    );
    for (const route of ["park", "river", "park"]) {
      await write(live.store, [
        {
          intent: "insert",
          table: "runs",
          set: { date: "2026-11-02", distance: { value: "5.0", unit: "km" }, route },
        },
      ]);
    }
  }, T);

  it(
    "finds no mismatch, the derived table compared",
    async () => {
      const r = await reconcile();
      expect(r.mismatches).toEqual([]);
      const d = r.tables.find((t) => t.name === "d_t9_v1");
      expect(d?.rows).toBeGreaterThan(1);
      expect(d?.mismatched).toBe(0);
    },
    T,
  );

  it(
    "finds a derived row removed past apply as missing, and one added as extra",
    async () => {
      const partition = await one(
        "SELECT partition_id AS v FROM d_t9_v1 ORDER BY partition_id LIMIT 1",
      );
      const added = `p_${"9".repeat(16)}`;
      await copyRow("d_t9_v1", "partition_id", partition, added);
      await tamper("DELETE FROM d_t9_v1 WHERE partition_id = $1", [partition]);
      const r = await reconcile();
      expect(r.mismatches).toEqual(
        expect.arrayContaining([
          { table: "d_t9_v1", row: partition, kind: "missing" },
          { table: "d_t9_v1", row: added, kind: "extra" },
        ]),
      );
      expect(r.mismatches_total).toBe(2);
      expect(without(r)).not.toContain("river");
    },
    T,
  );
});
