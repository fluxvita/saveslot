// Derived writes through the write pipeline, the log and apply, on PGlite (06-derived.md «刷新范围与写入
// 准入», 01-objects «行身份»; 09-event-format.md §4.2 step 6, §5.7 `write.derived`). A slot with derived tables
// over `runs` is created by its schema events; then, step by step, a write request inserts, updates,
// revokes or restores a row of runs, and the pipeline appends the derived writes to the same
// operation. After each step:
//
// - each derived table, as apply wrote it, equals its rule recomputed over the rows not revoked;
// - a group keeps its partition for good, emptied or not, and is registered once;
// - with nothing changed since, there is no derived write.
//
// Each sample runs in one transaction rolled back at its end. The cases where apply refuses a
// tampered derived write change base rows in their table directly and append by hand.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApplyError,
  appendOperation,
  applyEvents,
  continueOperation,
  createOpsContext,
  createTenant,
  type DerivedWrite,
  derivedLayout,
  derivedWrites,
  evaluateRule,
  eventsOf,
  loadRsql,
  type NewEvent,
  type Query,
  readBufferOf,
  readEvents,
  readTail,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, fc, propRuns, rule, TABLES } from "@fluxvita/saveslot-kernel/rsql-testing";
import { createSlotEvents, SLOT, writeInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

vi.setConfig({ testTimeout: 300_000 });

type Schema = ReturnType<typeof derivedSchema>;
type Derived = Extract<Schema["tables"][number], { kind: "derived" }>;
type Cell = string | boolean | null;

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const RUNS = TABLES.find((t) => t.id === "t1") as (typeof TABLES)[number];

/** Three rules over runs: grouped by week, grouped by an enum (NULL keys), a whole aggregate. */
const RULES = [
  [
    "t9",
    "SELECT date_trunc('week', date::timestamp)::date AS w, sum(distance) AS total, count(*) AS n FROM runs GROUP BY 1",
    ["w", "total", "n"],
    "bucketed",
  ],
  [
    "t10",
    "SELECT route AS r, max(pace) AS p, count(feeling) AS f FROM runs GROUP BY 1",
    ["r", "p", "f"],
    "none",
  ],
  [
    "t11",
    "SELECT sum(distance) AS total, avg(laps) AS laps FROM runs WHERE race",
    ["total", "laps"],
    "none",
  ],
  // Beyond 9999-12-31 only for dates this test writes on purpose (the last case).
  ["t12", "SELECT max(date + 2900000) AS far FROM runs", ["far"], "none"],
  // A sum of integers that overflows 64 bits on purpose (the last cases).
  ["t13", "SELECT sum(laps) AS total_laps FROM runs", ["total_laps"], "none"],
] as const;
type TableId = (typeof RULES)[number][0];

let schema: Schema;
let store: PgliteTenantStore;
let root: string;
let minute = 0;
const nextNow = () => `2026-11-10T06:${String(minute++ % 60).padStart(2, "0")}:00.000Z` as never;

beforeAll(async () => {
  await loadRsql();
  const derived = RULES.map(([id, sql, fields, td], i): Derived => {
    const t = derivedSchema(rule(sql, fields, td)).tables.find((x) => x.id === "t9") as Derived;
    return {
      ...t,
      id,
      name: `derived_${id}`,
      physical: { table: `d_${id}_v1` },
      rule: { ...t.rule, id: `r${i + 1}` as Derived["rule"]["id"] },
    } as Derived;
  });
  const base = derivedSchema(rule(RULES[0][1], RULES[0][2], RULES[0][3]));
  schema = {
    ...base,
    slot: SLOT,
    tables: [...base.tables.filter((t) => t.kind === "base"), ...derived],
  } as Schema;
  root = mkdtempSync(join(tmpdir(), "saveslot-derive-"));
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  await createTenant(
    store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 86_400_000,
      now: "2026-11-10T04:00:00.000Z",
      confirmation: null,
    }),
  );
  const change = (target: Record<string, unknown>, kind: string) => ({
    target,
    change: kind,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  });
  const events = createSlotEvents({
    compiled: schema as never,
    changes: [
      change({ slot: true }, "create_slot"),
      ...schema.tables.map((t) =>
        change({ table: t.id }, t.kind === "base" ? "add_table" : "add_derived_table"),
      ),
    ] as never,
  });
  await store.write(async (tx) => {
    const op = await appendOperation(tx, { actor: USER as never, now: nextNow(), events });
    await applyEvents(tx, eventsOf(op));
  });
}, 120_000);

afterAll(async () => {
  await store?.close();
  rmSync(root, { recursive: true, force: true });
}, 120_000);

const derivedOf = (id: TableId) => schema.tables.find((t) => t.id === id) as Derived;
const queryIn =
  (tx: Tx): Query =>
  async (sql, params) =>
    tx.query<Record<string, unknown>>(sql, params as never);

/** Each derived table as apply wrote it and as the rule gives it, keyed by group key. */
async function compare(tx: Tx, id: TableId) {
  const t = derivedOf(id);
  const e = evaluateRule(schema, id);
  const want = new Map<string, unknown>();
  for (const r of (await tx.query<Record<string, unknown>>(e.all.sql)).rows) {
    const d = e.decode(r);
    if (d !== undefined) want.set(JSON.stringify(d.key), d.values);
  }
  const keyOf = new Map<string, string>();
  for (const r of (
    await tx.query<{ partition_id: string; group_key: string }>(
      "SELECT partition_id, group_key FROM partitions WHERE derived_table_id = $1",
      [id],
    )
  ).rows)
    keyOf.set(r.partition_id, r.group_key);
  const l = derivedLayout(t);
  const cols = l.fields.map(({ field, column }) =>
    field.type === "boolean"
      ? `"${column}" AS "${field.id}"`
      : `CAST("${column}" AS text) AS "${field.id}"`,
  );
  const rows = (
    await tx.query<Record<string, unknown>>(
      `SELECT partition_id, ${cols.join(", ")} FROM "${l.table}"`,
    )
  ).rows;
  // Each row by its own decoded key: two partitions of one logical key collide here.
  const got = new Map<string, unknown>();
  for (const r of rows) {
    if (!keyOf.has(String(r["partition_id"])))
      throw new Error(`row ${String(r["partition_id"])} without a partition`);
    const d = e.decode({ ...r, inputs: "1" });
    if (d === undefined) throw new Error("a stored row that decodes to none");
    got.set(JSON.stringify(d.key), d.values);
  }
  // One row per group.
  expect(rows.length).toBe(got.size);
  return { got: [...got].sort(), want: [...want].sort() };
}

// --- base changes ------------------------------------------------------------------------------

type Step =
  | { readonly k: "insert"; readonly cells: Readonly<Record<string, Cell>> }
  | { readonly k: "update"; readonly row: number; readonly cells: Readonly<Record<string, Cell>> }
  | { readonly k: "revoke"; readonly row: number }
  | { readonly k: "restore"; readonly row: number };

const DATES = ["2026-10-28", "2026-11-01", "2026-11-02", "2026-11-05", "2026-11-09", "2026-12-31"];
const cells = fc.record(
  {
    f1: fc.constantFrom(...DATES),
    f2: fc.constantFrom("1", "2.5", "7", "0.01"),
    f4: fc.option(fc.constantFrom("ok", "说"), { nil: null }),
    f5: fc.option(fc.constantFrom("park", "river"), { nil: null }),
    f6: fc.option(fc.constantFrom("0", "3", "8"), { nil: null }),
    f7: fc.option(fc.constantFrom("4.5", "5.25", "-1"), { nil: null }),
    f10: fc.option(fc.boolean(), { nil: null }),
  },
  { requiredKeys: [] },
);
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: cells.map((c) => ({
      k: "insert" as const,
      cells: { f1: "2026-11-02", f2: "1", ...c },
    })),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("update" as const), row: fc.nat(9), cells }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("revoke" as const), row: fc.nat(9) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("restore" as const), row: fc.nat(9) }) },
);

const rowId = (n: number) => `r_${String(n).padStart(26, "0")}`;

/** Applies a base step to the table; the row it touched, or undefined when it touched none. */
async function base(tx: Tx, s: Step, inserted: number): Promise<string | undefined> {
  const table = `"${RUNS.physical.table}"`;
  if (s.k === "insert") {
    const id = rowId(inserted);
    const fields = Object.keys(s.cells);
    await tx.query(
      `INSERT INTO ${table} (row_id, ${fields.map((f) => `"f_${f}"`).join(", ")}) VALUES ($1, ${fields.map((_, i) => `$${i + 2}`).join(", ")})`,
      [id, ...fields.map((f) => s.cells[f] ?? null)],
    );
    return id;
  }
  if (inserted === 0) return undefined;
  const id = rowId(s.row % inserted);
  if (s.k === "revoke" || s.k === "restore") {
    await tx.query(`UPDATE ${table} SET revoked = $1 WHERE row_id = $2`, [s.k === "revoke", id]);
    return id;
  }
  const fields = Object.keys(s.cells);
  if (fields.length === 0) return undefined;
  await tx.query(
    `UPDATE ${table} SET ${fields.map((f, i) => `"f_${f}" = $${i + 2}`).join(", ")} WHERE row_id = $1`,
    [id, ...fields.map((f) => s.cells[f] ?? null)],
  );
  return id;
}

/** The head of an operation writing one row of runs. */
const head = (row: string): NewEvent => ({
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: {
      now: "2026-11-10T06:00:00.000Z",
      today: "2026-11-10",
      ruleset_version: 1,
      policy_version: 1,
      literal_checker: "literal@1",
    },
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t1", row, intent: "insert" },
  },
});

/** The events of derived writes. */
const derivedEvents = (writes: readonly DerivedWrite[]): NewEvent[] =>
  writes.map((w) => ({
    type: "write.derived",
    slot: SLOT,
    blocks: {
      target: w.target as never,
      ...(w.key !== undefined ? { key: w.key as never } : {}),
      ...(w.checksum !== undefined ? { checksum: w.checksum as never } : {}),
    },
  }));

const ROLLBACK = new Error("rolled back");

/** A derived write as the log keeps it. */
interface Logged {
  readonly table: string;
  readonly partition: string;
  readonly emptied: boolean;
  readonly key: unknown[] | undefined;
}
/** One step through the pipeline: its derived writes, and the receipt's derived changes. */
interface Stepped {
  readonly writes: readonly Logged[];
  readonly derived: readonly { readonly table: string; readonly field: string }[];
}

/** A step's cells as a write request's values (`distance` a quantity in km). */
const values = (cells: Readonly<Record<string, Cell>>) =>
  Object.fromEntries(
    Object.entries(cells).map(([id, v]) => {
      const f = RUNS.fields.find((x) => x.id === id) as (typeof RUNS.fields)[number];
      return [f.name, f.type === "quantity" && v !== null ? { value: v, unit: "km" } : v];
    }),
  );

/**
 * Runs the steps through the write pipeline in one transaction, rolled back at the end; after each,
 * the derived tables are checked against their rules. A step the pipeline cannot take (an update
 * of a revoked row, a restore of a row not revoked) is skipped. Returns every step's derived writes.
 */
async function run(steps: readonly Step[]): Promise<Stepped[]> {
  const all: Stepped[] = [];
  readBufferOf(store).take();
  try {
    await store.write(async (tx) => {
      let ids = 0;
      let partitions = 0;
      const rows: { id: string; ver: string; revoked?: number }[] = [];
      const partitionOf = new Map<string, string>();
      const keyed = new Set<string>();
      const newId = (kind: "row" | "entity" | "source" | "item" | "partition") =>
        kind === "partition"
          ? `p_${String(++partitions).padStart(16, "0")}`
          : `${{ row: "r_", entity: "e_", source: "s_", item: "pi_" }[kind]}${String(++ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0")}`;
      for (const [i, s] of steps.entries()) {
        const where = `step ${i} ${JSON.stringify(s)}`;
        const r = s.k === "insert" ? undefined : rows[s.row % Math.max(rows.length, 1)];
        let op: unknown;
        if (s.k === "insert") op = { intent: "insert", table: "runs", set: values(s.cells) };
        else if (r === undefined) op = undefined;
        else if (s.k === "update" && r.revoked === undefined && Object.keys(s.cells).length > 0)
          op = { intent: "update", table: "runs", row: r.id, ver: r.ver, set: values(s.cells) };
        else if (s.k === "revoke" && r.revoked === undefined)
          op = { intent: "revoke", table: "runs", row: r.id, ver: r.ver };
        else if (s.k === "restore" && r.revoked !== undefined)
          op = { table: "runs", row: r.id, revert: { undo: r.revoked } };
        if (op === undefined) {
          all.push({ writes: [], derived: [] });
          continue;
        }
        const receipt = (await writeInTx(tx, {
          actor: USER as never,
          task: null,
          now: `2026-11-10T07:${String(i).padStart(2, "0")}:00.000Z` as never,
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params: { sv: 1, idempotency_key: `step-${i}`, ops: [op] },
          newId,
          reads: readBufferOf(store),
        })) as unknown as {
          seq: number;
          status: string;
          ops: { target: { row: string }; ver: string }[];
          derived: { table: string; field: string }[];
        };
        expect(receipt.status, where).toBe("saved");
        const ver = receipt.ops[0]?.ver as string;
        if (s.k === "insert") rows.push({ id: receipt.ops[0]?.target.row as string, ver });
        else if (r !== undefined) {
          r.ver = ver;
          if (s.k === "revoke") r.revoked = receipt.seq;
          else if (s.k === "restore") delete r.revoked;
        }
        const op$ = receipt.seq;
        const events = await readEvents(tx, op$, (await readTail(tx))?.seq ?? op$);
        const own = events.filter((e) => Number(e.header["op"]) === op$);
        const present = (e: (typeof own)[number], path: string) => {
          const b = e.blocks.get(path);
          return b?.state === "present" ? b.value : undefined;
        };
        const derivedEvents = own.filter((e) => e.header["type"] === "write.derived");
        const lastBase = own.filter((e) => e.header["type"] !== "write.derived").at(-1);
        const writes: Logged[] = derivedEvents.map((e) => {
          const t = present(e, "target") as { table: string; partition: string; emptied?: boolean };
          const key = present(e, "key") as { values: unknown[] } | undefined;
          return {
            table: t.table,
            partition: t.partition,
            emptied: t.emptied === true,
            key: key?.values,
          };
        });
        all.push({ writes, derived: receipt.derived });
        // Each derived row written carries the operation as its ver; each derived write has one
        // derived_reads row per base table read, at the last event before the derived writes.
        for (const w of writes) {
          const l = derivedLayout(derivedOf(w.table as TableId));
          const v = await tx.query<{ ver: unknown }>(
            `SELECT ver FROM "${l.table}" WHERE partition_id = $1`,
            [w.partition],
          );
          expect(
            v.rows.map((x) => Number(x.ver)),
            where,
          ).toEqual(w.emptied ? [] : [op$]);
        }
        const dr = await tx.query<{
          base_table_id: string;
          partition_id: string;
          read_pos: unknown;
        }>(
          `SELECT d.base_table_id, d.partition_id, d.read_pos FROM derived_reads d
           JOIN events e ON e.seq = d.derived_seq WHERE e.op = $1 ORDER BY d.derived_seq`,
          [op$],
        );
        expect(
          dr.rows.map((x) => [x.base_table_id, x.partition_id, Number(x.read_pos)]),
          where,
        ).toEqual(writes.map((w) => ["t1", w.partition, Number(lastBase?.header["seq"])]));
        for (const [id] of RULES) {
          const { got, want } = await compare(tx, id);
          expect(got, `${where} ${id}`).toEqual(want);
        }
        // A group keeps its partition for good; the key block comes with its first write only.
        const mapping = await tx.query<{
          derived_table_id: string;
          group_key: string;
          partition_id: string;
        }>("SELECT derived_table_id, group_key, partition_id FROM partitions");
        for (const m of mapping.rows) {
          const k = `${m.derived_table_id} ${m.group_key}`;
          const before = partitionOf.get(k);
          if (before !== undefined) expect(m.partition_id, where).toBe(before);
          partitionOf.set(k, m.partition_id);
        }
        expect(mapping.rows.length, where).toBe(partitionOf.size);
        for (const e of events.filter((x) => x.header["type"] === "write.derived")) {
          const t = present(e, "target") as { table: string; partition: string };
          const k = `${t.table} ${t.partition}`;
          expect(present(e, "key") !== undefined, where).toBe(!keyed.has(k));
          keyed.add(k);
        }
        // With nothing changed since, there is no derived write.
        const again = await derivedWrites({
          query: queryIn(tx),
          schema,
          changes: rows.map((x) => ({ table: "t1" as const, row: x.id as never, fields: [] })),
          newPartitionId: () => "p_ZZZZZZZZZZZZZZZZ",
          readPos: (await readTail(tx))?.seq as never,
        });
        expect(again, where).toEqual([]);
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return all;
}

describe("writes through the pipeline keep each derived table equal to its rule", () => {
  it("random inserts, updates, revokes and restores", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
        await run(steps);
      }),
      { numRuns: propRuns(40) },
    );
  });
});

const ins = (c: Record<string, Cell>): Step => ({
  k: "insert",
  cells: { f1: "2026-11-02", f2: "1", ...c },
});
const shape = (id: TableId) => (st: Stepped) =>
  st.writes
    .filter((w) => w.table === id)
    .map((w) => ({ partition: w.partition, emptied: w.emptied, key: w.key }));
/** The receipt's changed fields of a derived table, by name (`derived_<id>`). */
const changed = (id: TableId) => (st: Stepped) =>
  st.derived
    .filter((d) => d.table === `health.derived_${id}`)
    .map((d) => d.field)
    .sort();
const P = (n: number) => `p_${String(n).padStart(16, "0")}`;

describe("fixed cases", () => {
  it("a new group, a change, a result unchanged, emptied, back under the same partition", async () => {
    const ws = await run([
      ins({ f1: "2026-11-02", f2: "5" }),
      ins({ f1: "2026-11-03", f2: "2" }),
      { k: "update", row: 0, cells: { f4: "说" } },
      { k: "revoke", row: 0 },
      { k: "revoke", row: 1 },
      ins({ f1: "2026-11-04", f2: "1" }),
    ]);
    expect(ws.map(shape("t9"))).toEqual([
      [{ partition: P(1), emptied: false, key: ["2026-11-02"] }],
      [{ partition: P(1), emptied: false, key: undefined }],
      // feeling is not read by this rule's results: no write for t9.
      [],
      [{ partition: P(1), emptied: false, key: undefined }],
      [{ partition: P(1), emptied: true, key: undefined }],
      // The group comes back under its partition, without a key block.
      [{ partition: P(1), emptied: false, key: undefined }],
    ]);
    // The receipt lists the changed fields, not the group key's.
    expect(ws.map(changed("t9"))).toEqual([
      ["n", "total"],
      ["n", "total"],
      [],
      ["n", "total"],
      ["n", "total"],
      ["n", "total"],
    ]);
  });

  it("a row moved to another group: one emptied, one new", async () => {
    const ws = await run([
      ins({ f1: "2026-11-02" }),
      { k: "update", row: 0, cells: { f1: "2026-11-09" } },
    ]);
    const moved = ws.map(shape("t9"))[1];
    expect(moved?.map((x) => [x.emptied, x.key])).toEqual([
      [true, undefined],
      [false, ["2026-11-09"]],
    ]);
  });

  it("a NULL group key is a group of its own", async () => {
    const ws = await run([ins({ f5: null, f7: "4.5" }), ins({ f5: "park", f7: "5" })]);
    expect(ws.map(shape("t10")).map((x) => x.map((w) => w.key))).toEqual([[[null]], [["park"]]]);
  });

  it("a whole aggregate: no row, a row (key []), none again, and back under its partition", async () => {
    const ws = await run([
      ins({ f10: false }),
      ins({ f10: true, f6: "3" }),
      { k: "revoke", row: 1 },
      { k: "restore", row: 1 },
    ]);
    const whole = ws.map(shape("t11"));
    expect(whole.map((x) => x.map((w) => [w.emptied, w.key]))).toEqual([
      [],
      [[false, []]],
      [[true, undefined]],
      [[false, undefined]],
    ]);
    const parts = new Set(whole.flat().map((w) => w.partition));
    expect(parts.size).toBe(1);
  });
});

// --- apply refuses what disagrees with the recomputation ----------------------------------------

/** One insert, then a derived write tampered by `f`: apply's verdict, the transaction rolled back. */
async function tampered(f: (w: DerivedWrite, seq: number) => DerivedWrite): Promise<string> {
  try {
    await store.write(async (tx) => {
      const row = await base(tx, ins({ f1: "2026-11-02", f2: "5", f10: true }), 0);
      const opened = await appendOperation(tx, {
        actor: USER as never,
        now: nextNow(),
        events: [head(row as string)],
      });
      await applyEvents(tx, eventsOf(opened));
      let n = 0;
      const writes = await derivedWrites({
        query: queryIn(tx),
        schema,
        changes: [{ table: "t1", row: row as string, fields: [] }],
        newPartitionId: () => `p_${String(++n).padStart(16, "0")}` as const,
        readPos: opened.op,
      });
      const w = writes.find((x) => x.target.table === "t9") as DerivedWrite;
      const more = await continueOperation(tx, opened, derivedEvents([f(w, opened.op + 1)]));
      await applyEvents(tx, eventsOf(more));
      throw ROLLBACK;
    });
  } catch (e) {
    if (e === ROLLBACK) return "applied";
    if (e instanceof ApplyError)
      return `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
    throw e;
  }
  return "applied";
}

describe("apply checks a derived write against the partition recomputed", () => {
  it("as given: applied", async () => {
    expect(await tampered((w) => w)).toBe("applied");
  });

  it("a checksum that is not the recomputed row's", async () => {
    expect(await tampered((w) => ({ ...w, checksum: { checksum: "0".repeat(64) as never } }))).toBe(
      "inconsistent: partition p_0000000000000001: the checksum is not the recomputed row's",
    );
  });

  it("emptied while the partition has a row", async () => {
    expect(
      await tampered((w) => {
        const { key: _, checksum: __, ...rest } = w;
        return { ...rest, target: { ...w.target, emptied: true } };
      }),
    ).toBe("inconsistent: partition p_0000000000000001 is not registered");
  });

  it("a key whose partition has no row: not emptied, but nothing recomputed", async () => {
    expect(await tampered((w) => ({ ...w, key: { values: ["2030-01-07"] } }))).toBe(
      "inconsistent: partition p_0000000000000001 gives 0 rows, not one",
    );
  });

  it("read_pos at the event itself, or before the operation", async () => {
    expect(await tampered((w, seq) => ({ ...w, target: { ...w.target, read_pos: seq } }))).toMatch(
      /^inconsistent: read_pos \d+ is not within operation \d+ before \d+$/,
    );
    expect(await tampered((w) => ({ ...w, target: { ...w.target, read_pos: 1 } }))).toMatch(
      /^inconsistent: read_pos 1 is not within operation \d+ before \d+$/,
    );
  });
});

describe("apply when the recomputation meets data it cannot represent", () => {
  it("is inconsistent: the base data is not what the write was computed on", async () => {
    const verdict = await (async () => {
      try {
        await store.write(async (tx) => {
          // 9999-01-01 + 2900000 days is past 9999-12-31.
          const row = await base(tx, ins({ f1: "9999-01-01" }), 0);
          const opened = await appendOperation(tx, {
            actor: USER as never,
            now: nextNow(),
            events: [head(row as string)],
          });
          await applyEvents(tx, eventsOf(opened));
          const more = await continueOperation(tx, opened, [
            {
              type: "write.derived",
              slot: SLOT,
              blocks: {
                target: {
                  table: "t12",
                  rule: "r4",
                  rule_version: 1,
                  partition: P(1),
                  read_pos: opened.op,
                  reads: [{ table: "t1" }],
                  emptied: false,
                },
                key: { values: [] },
                checksum: { checksum: "0".repeat(64) },
              },
            },
          ]);
          await applyEvents(tx, eventsOf(more));
          throw ROLLBACK;
        });
      } catch (e) {
        if (e === ROLLBACK) return "applied";
        if (e instanceof ApplyError)
          return `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
        throw e;
      }
      return "applied";
    })();
    expect(verdict).toMatch(
      new RegExp(`^inconsistent: recomputing partition ${P(1)}: f1: .* is not a date of 0001`),
    );
  });
});

// --- what apply refuses, by tampering with honest derived writes --------------------------------

/**
 * Honest writes for one insert (after a first honest operation when `registered`), tampered by
 * `f` over all of them, appended and applied: apply's verdict; the transaction rolled back.
 */
async function tamperedAll(
  f: (writes: DerivedWrite[]) => DerivedWrite[],
  o: { readonly registered?: boolean } = {},
): Promise<string> {
  try {
    await store.write(async (tx) => {
      let n = 0;
      const step = async (k: number, honest: boolean) => {
        const row = await base(tx, ins({ f1: "2026-11-02", f2: "5", f10: true }), k);
        const opened = await appendOperation(tx, {
          actor: USER as never,
          now: nextNow(),
          events: [head(row as string)],
        });
        await applyEvents(tx, eventsOf(opened));
        const writes = await derivedWrites({
          query: queryIn(tx),
          schema,
          changes: [{ table: "t1", row: row as string, fields: [] }],
          newPartitionId: () => `p_${String(++n).padStart(16, "0")}` as const,
          readPos: opened.op,
        });
        const more = await continueOperation(
          tx,
          opened,
          derivedEvents(honest ? writes : f(writes)),
        );
        await applyEvents(tx, eventsOf(more));
      };
      if (o.registered === true) await step(0, true);
      await step(o.registered === true ? 1 : 0, false);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e === ROLLBACK) return "applied";
    if (e instanceof ApplyError)
      return `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
    throw e;
  }
  return "applied";
}
const onT9 = (f: (w: DerivedWrite) => DerivedWrite) => (ws: DerivedWrite[]) =>
  ws.map((w) => (w.target.table === "t9" ? f(w) : w));
const P77 = `p_${"7".repeat(16)}` as never;

describe("apply refuses a key or partition that is not the group's", () => {
  it("a key not written canonically: refused before any lookup", async () => {
    for (const values of [
      ["2026-11-2"],
      ["20261102"],
      ["Nov 2 2026"],
      [{ unit: "anything", value: "20261102" }],
    ]) {
      expect(await tamperedAll(onT9((w) => ({ ...w, key: { values: values as never } })))).toMatch(
        /^inconsistent: recomputing partition p_\d+: key value 0 is not a canonical date$/,
      );
    }
    // The group registered already, under another partition with the key written otherwise.
    expect(
      await tamperedAll(
        onT9((w) => ({
          ...w,
          target: { ...w.target, partition: P77 },
          key: { values: ["2026-11-2"] },
        })),
        { registered: true },
      ),
    ).toMatch(/is not a canonical date$/);
  });

  it("the group's key registered for another partition", async () => {
    expect(
      await tamperedAll(
        onT9((w) => ({
          ...w,
          target: { ...w.target, partition: P77 },
          key: { values: ["2026-11-02"] },
        })),
        { registered: true },
      ),
    ).toBe("inconsistent: its key is registered for partition p_0000000000000001");
  });

  it("a partition ID registered for another derived table", async () => {
    expect(
      await tamperedAll((ws) => {
        const p = ws.find((w) => w.target.table === "t9")?.target.partition as never;
        return ws.map((w) =>
          w.target.table === "t10" ? { ...w, target: { ...w.target, partition: p } } : w,
        );
      }),
    ).toMatch(/^inconsistent: partition p_\d+ is registered for table t9$/);
  });

  it("emptied on a registered partition that has a row", async () => {
    expect(
      await tamperedAll(
        onT9((w) => {
          const { checksum: _, ...rest } = w;
          return { ...rest, target: { ...w.target, emptied: true } };
        }),
        { registered: true },
      ),
    ).toBe("inconsistent: partition p_0000000000000001 is not empty");
  });

  it("a recomputation that fails in the database (a 64-bit overflow): inconsistent", async () => {
    let verdict = "applied";
    try {
      await store.write(async (tx) => {
        const big = "9223372036854775807";
        await base(tx, ins({ f6: big }), 0);
        const row = await base(tx, ins({ f6: big }), 1);
        const opened = await appendOperation(tx, {
          actor: USER as never,
          now: nextNow(),
          events: [head(row as string)],
        });
        await applyEvents(tx, eventsOf(opened));
        const more = await continueOperation(tx, opened, [
          {
            type: "write.derived",
            slot: SLOT,
            blocks: {
              target: {
                table: "t13",
                rule: "r5",
                rule_version: 1,
                partition: P77,
                read_pos: opened.op,
                reads: [{ table: "t1" }],
                emptied: false,
              },
              key: { values: [] },
              checksum: { checksum: "0".repeat(64) },
            },
          },
        ]);
        await applyEvents(tx, eventsOf(more));
      });
    } catch (e) {
      if (!(e instanceof ApplyError)) throw e;
      verdict = `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
    }
    expect(verdict).toMatch(/^inconsistent: recomputing partition p_7+: database: /);
  });
});
