// apply of write.base on PGlite against judge and the reference evaluator (02-architecture §11
// «测试矩阵», «写入路径与参考一致»; 09-event-format §5.7). The comparison's judged scenarios are
// encoded into events by the record mapping and applied operation by operation into a slot created
// through apply. After every step the row or entity in the version table's open cells must give
// what judge's view and the reference evaluator give (the values, the items giving them, the gaps,
// existence); the business table's field values must be the cells' (an event or timeless table's
// row also when revoked); the source table's "reverted" registrations must be judge's, item by
// item; and `ver` must move exactly when the version table changed. At the end the version table
// read as of every earlier operation gives that step's state, and replaying the whole log into an
// empty storage gives the same tables (K12).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  KERNEL_TABLES,
  type NewEvent,
  type ReadTx,
  readEvents,
  readTail,
  view,
} from "@fluxvita/saveslot-kernel";
import {
  asInThisPhase,
  COMPILED_V1,
  createSlotEvents,
  type Decision,
  eventsOfSteps,
  judged,
  SLOT,
  scenario,
  shape,
} from "@fluxvita/saveslot-kernel/testing";
import { evaluateLog, type TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PgliteBackend, type PgliteTenantStore } from "./backend.ts";

// Each sample builds a store and compares several tables after every step; 60 samples a table
// take several minutes, more when `pnpm check` runs the other test files beside it.
vi.setConfig({ testTimeout: 1_200_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 1_150_000, markInterruptAsFailure: true });

const RUNS = propRuns(60);
/**
 * `PROP_SEED` fixes the seed: a large run goes in several processes of a size one process holds
 * (each sample opens and closes PGlite stores), each with its own seed.
 */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);

/**
 * More decisions than the comparison's scenarios insert, weighted towards the rare ones, so that
 * each kind of resolution reaches storage in a share of the samples.
 */
const extra = fc.array(
  fc.record({
    after: fc.nat(),
    pick: fc.nat(),
    kind: fc.constantFrom(
      "keep",
      "keep",
      "reject",
      "reject",
      "previous",
      "take",
      "confirm",
      "undo",
    ) as fc.Arbitrary<Decision["kind"]>,
    flag: fc.nat({ max: 7 }),
    focus: fc.boolean(),
  }),
  { maxLength: 6 },
);
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;
const DECOY = { state: `e_${"5".repeat(26)}`, event: `r_${"5".repeat(26)}` };

/** The scenarios' tables: f2 required, f3 optional, both text; a timeless and a state table. */
const fields = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
];
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "rows",
      kind: "base",
      description: "rows",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields,
    },
    {
      id: "t2",
      name: "entities",
      kind: "base",
      description: "entities over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t2_v1" },
      fields,
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  { target: { table: "t1" }, change: "add_table" },
  { target: { table: "t2" }, change: "add_table" },
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);
/** Removes the storage opened last (each sample removes its own when it is done). */
const drop = () => {
  const r = roots.pop();
  if (r !== undefined) rmSync(r, { recursive: true, force: true });
};
const open = async () => {
  const root = mkdtempSync(join(tmpdir(), "saveslot-apply-write-"));
  roots.push(root);
  return new PgliteBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
};

let minute = 0;
const nextNow = () => {
  minute++;
  return `2026-11-10T${String(5 + (Math.floor(minute / 60) % 18)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z` as never;
};

const run = (s: PgliteTenantStore, events: NewEvent[]) =>
  s.write(async (tx) => {
    const op = await appendOperation(tx, { actor: USER as never, now: nextNow(), events });
    await applyEvents(tx, eventsOf(op));
    return op;
  });

/** Another row or entity of the same table, written first: apply must keep to its own row. */
function decoy(isState: boolean): NewEvent[] {
  const target = isState ? { table: "t2", entity: DECOY.state } : { table: "t1", row: DECOY.event };
  const valid = { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } };
  return [
    {
      type: "write.head",
      slot: SLOT,
      blocks: {
        ctx: CTX,
        request: { sv: 1, sv_basis: "explicit", op_count: 1 },
        "ops/0/target": { ...target, intent: "insert", created: true },
        "ops/0/set/f2": "z",
        ...(isState ? { "ops/0/valid": valid } : {}),
      },
    },
    {
      type: "write.base",
      slot: SLOT,
      blocks: {
        target: {
          ...target,
          intent: "insert",
          sv: 1,
          created: true,
          cause: "request",
          op_index: 0,
        },
        "fields/f2/0": { status: "applied", value: "z" },
        "sources/f2/0": [{ kind: "value", source: 7 }],
        ...(isState ? { "span/f2/0": { valid: { from: "2026-10-01" } } } : {}),
      },
    },
  ] as NewEvent[];
}

const CTX = {
  now: "2026-11-10T05:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};

/** A write of nothing on another entity: moves the log on to the seq a step needs. */
const filler: NewEvent = {
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: {
      now: "2026-11-10T05:00:00.000Z",
      today: "2026-11-10",
      ruleset_version: 1,
      policy_version: 1,
      literal_checker: "literal@1",
    },
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t2", entity: FILLER, intent: "update" },
  },
};

type Stretch = {
  valid: { from: string | null; to: string | null }[];
  value: unknown;
  by?: { event: number; target: string; k: number };
};
type View = { exists: boolean; gaps: unknown; fields: Record<string, Stretch[]> };

const WHOLE = { from: null, to: null };

/** The complement of sorted, disjoint intervals. */
function gapsOf(has: { from: string | null; to: string | null }[]) {
  const out: { from: string | null; to: string | null }[] = [];
  let at: string | null = null;
  let started = false;
  for (const x of has) {
    if (!started) {
      if (x.from !== null) out.push({ from: null, to: x.from });
    } else if (at !== x.from) out.push({ from: at, to: x.from });
    started = true;
    at = x.to;
    if (at === null) return out;
  }
  if (!started) return [WHOLE];
  out.push({ from: at, to: null });
  return out;
}

/**
 * Runs touching stretches of the same value and item together, as judge's view does (a null
 * cell's item is not compared: two empty cells from different no-value items read as one).
 */
function merged(xs: readonly Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    const a = last?.valid[0];
    const b = x.valid[0];
    if (
      last !== undefined &&
      a !== undefined &&
      b !== undefined &&
      a.to !== null &&
      a.to === b.from &&
      JSON.stringify([last.value, last.by]) === JSON.stringify([x.value, x.by])
    ) {
      out[out.length - 1] = { ...last, valid: [{ from: a.from, to: b.to }] };
    } else out.push(x);
  }
  return out;
}

/** Joins touching intervals (business rows split where any field changes). */
function joined(xs: { from: string | null; to: string | null }[]) {
  const out: { from: string | null; to: string | null }[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last !== undefined && last.to === x.from) last.to = x.to;
    else out.push({ ...x });
  }
  return out;
}

/** The row or entity as the version table holds it as of operation `at` (open cells if none). */
async function fromCells(tx: ReadTx, isState: boolean, ids: readonly string[], at?: number) {
  const table = isState ? "t_t2_v1__ver" : "t_t1_v1__ver";
  const id = isState ? ENTITY : ROW;
  const when =
    at === undefined
      ? "rec_to IS NULL"
      : `rec_from <= ${at} AND (rec_to IS NULL OR rec_to > ${at})`;
  const r = await tx.query<{
    field_id: string;
    vf: string | null;
    vt: string | null;
    src_event: unknown;
    src_field: string | null;
    src_k: number | null;
    f_f2: string | null;
    f_f3: string | null;
    revoked: boolean | null;
  }>(
    `SELECT field_id, ${isState ? "valid_from::text" : "NULL"} AS vf, ${isState ? "valid_to::text" : "NULL"} AS vt,
       src_event, src_field, src_k, f_f2, f_f3, revoked
     FROM ${table} WHERE row_id = $1 AND ${when} ORDER BY field_id, vf`,
    [id],
  );
  const cells = r.rows;
  // A null cell names the no-value item emptying it; judge's view gives an empty stretch no item.
  const stretch = (c: (typeof cells)[number]): Stretch => {
    const value = c.field_id === "f2" ? c.f_f2 : c.f_f3;
    return {
      valid: [isState ? { from: c.vf, to: c.vt } : WHOLE],
      value,
      ...(c.src_event !== null && value !== null
        ? {
            by: { event: Number(c.src_event), target: c.src_field as string, k: c.src_k as number },
          }
        : {}),
    };
  };
  const fieldCells = cells.filter((c) => c.field_id !== "existence");
  if (isState) {
    // The entity has a value where the required f2 has one; elsewhere cells only say why not.
    const valued = fieldCells.filter((c) => c.field_id !== "f2" || c.f_f2 !== null);
    const has = joined(
      valued.filter((c) => c.field_id === "f2").map((c) => ({ from: c.vf, to: c.vt })),
    );
    const byField = (f: string) => merged(valued.filter((c) => c.field_id === f).map(stretch));
    return {
      exists: has.length > 0,
      gaps: gapsOf(has),
      fields: Object.fromEntries(ids.map((f) => [f, byField(f)])),
    };
  }
  const revoked = cells.some((c) => c.field_id === "existence" && c.revoked === true);
  const exists = fieldCells.length > 0 && !revoked;
  const byField = (f: string) => fieldCells.filter((c) => c.field_id === f).map(stretch);
  return {
    exists,
    gaps: [],
    fields: exists ? Object.fromEntries(ids.map((f) => [f, byField(f)])) : {},
  };
}

/** The business table's rows of the row or entity: where it has a value, or whether it exists. */
async function businessRows(tx: ReadTx, isState: boolean) {
  if (isState) {
    const r = await tx.query<{
      vf: string;
      vt: string | null;
      f_f2: string | null;
      f_f3: string | null;
    }>(
      "SELECT valid_from::text AS vf, valid_to::text AS vt, f_f2, f_f3 FROM t_t2_v1 WHERE entity_id = $1 ORDER BY valid_from",
      [ENTITY],
    );
    return r.rows;
  }
  return (await tx.query("SELECT revoked, f_f2, f_f3 FROM t_t1_v1 WHERE row_id = $1", [ROW])).rows;
}

/** The open cells of the row or entity, as stored. */
async function openCells(tx: ReadTx, isState: boolean) {
  const r = await tx.query<{
    field_id: string;
    vf: string | null;
    vt: string | null;
    f_f2: string | null;
    f_f3: string | null;
    revoked: boolean | null;
  }>(
    `SELECT field_id, ${isState ? "valid_from::text" : "NULL"} AS vf, ${isState ? "valid_to::text" : "NULL"} AS vt,
       f_f2, f_f3, revoked FROM ${isState ? "t_t2_v1__ver" : "t_t1_v1__ver"}
     WHERE row_id = $1 AND rec_to IS NULL ORDER BY field_id, vf`,
    [isState ? ENTITY : ROW],
  );
  return r.rows;
}

/**
 * The business table's field values are the open cells' (a state table's rows segment by
 * segment; an event or timeless table's row also when revoked, with the revoked mark the
 * existence cell's).
 */
function agrees(
  isState: boolean,
  rows: readonly Record<string, unknown>[],
  cells: Awaited<ReturnType<typeof openCells>>,
): void {
  const cellValue = (c: (typeof cells)[number]) => (c.field_id === "f2" ? c.f_f2 : c.f_f3);
  if (isState) {
    for (const row of rows) {
      for (const f of ["f2", "f3"]) {
        // A business row may span several cells of the same value (from different items).
        const over = cells.filter(
          (x) =>
            x.field_id === f &&
            (x.vf === null || row["vt"] === null || x.vf < (row["vt"] as string)) &&
            (x.vt === null || x.vt > (row["vf"] as string)),
        );
        expect({ row, f, values: [...new Set(over.map(cellValue))] }).toEqual({
          row,
          f,
          values: [row[`f_${f}`]],
        });
      }
    }
    return;
  }
  const fieldCells = cells.filter((c) => c.field_id !== "existence");
  const row = rows[0];
  expect(rows.length).toBeLessThanOrEqual(1);
  if (row === undefined) {
    expect(fieldCells).toEqual([]);
    return;
  }
  const existence = cells.find((c) => c.field_id === "existence");
  expect({
    revoked: row["revoked"],
    f2: row["f_f2"],
    f3: row["f_f3"],
  }).toEqual({
    revoked: existence?.revoked === true,
    f2: fieldCells.find((c) => c.field_id === "f2")?.f_f2,
    f3: fieldCells.find((c) => c.field_id === "f3")?.f_f3,
  });
}

/** The registrations in the source table, by item: `event/target/k` → [{op, valid}]. */
async function storedRegs(tx: ReadTx, id: string) {
  const r = await tx.query<{ event_seq: unknown; field_id: string; k: number; reverted: string }>(
    "SELECT event_seq, field_id, k, reverted FROM base_sources WHERE row_id = $1 AND n = 0 AND reverted <> '[]'",
    [id],
  );
  return Object.fromEntries(
    r.rows
      .map((x) => [`${Number(x.event_seq)}/${x.field_id}/${x.k}`, JSON.parse(x.reverted)] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * The row's version table around operation `op`: whether it has cells from before the operation
 * or open ones after, whether the operation opened or closed a cell (outside `schema_switch`),
 * and `ver`, the latest version outside `schema_switch` (01-objects «版本标记»).
 */
async function versionTable(tx: ReadTx, isState: boolean, id: string, op: number) {
  const r = await tx.query<{ before: boolean; after: boolean; changed: boolean; v: unknown }>(
    `SELECT bool_or(rec_from < $2) AS before, bool_or(rec_to IS NULL) AS after,
       bool_or(intent <> 'schema_switch' AND (rec_from = $2 OR rec_to = $2)) AS changed,
       max(rec_from) FILTER (WHERE intent <> 'schema_switch') AS v
     FROM ${isState ? "t_t2_v1__ver" : "t_t1_v1__ver"} WHERE row_id = $1`,
    [id, op],
  );
  const x = r.rows[0];
  return {
    before: x?.before === true,
    after: x?.after === true,
    changed: x?.changed === true,
    ver: x?.v === null || x?.v === undefined ? null : Number(x.v),
  };
}

const plain = (v: { exists: boolean; gaps: unknown; fields: object }) =>
  JSON.parse(JSON.stringify({ exists: v.exists, gaps: v.gaps, fields: v.fields })) as View;

/** Every row of every materialized table and of the physical tables. */
async function everything(tx: ReadTx): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const big = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
  const all = (r: { rows: readonly unknown[] }) => r.rows.map((x) => JSON.stringify(x, big)).sort();
  for (const t of KERNEL_TABLES.filter((t) => t.class === "materialized")) {
    out[t.name] = all(await tx.query(`SELECT * FROM ${t.name}`));
  }
  for (const t of ["t_t1_v1", "t_t1_v1__ver", "t_t2_v1", "t_t2_v1__ver"]) {
    out[t] = all(await tx.query(`SELECT * FROM "${t}"`));
  }
  return out;
}

async function replayed(store: PgliteTenantStore) {
  const replica = await open();
  try {
    const events = await store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
    const content = await store.read((tx) => tx.query("SELECT * FROM content ORDER BY seq, path"));
    await replica.write(async (tx) => {
      for (const [table, rs] of [
        ["events", events.rows],
        ["content", content.rows],
      ] as const) {
        for (const r of rs) {
          const cols = Object.keys(r as object);
          await tx.query(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
            Object.values(r as object) as never,
          );
        }
      }
      const last = (await readTail(tx))?.seq ?? 0;
      await applyEvents(tx, await readEvents(tx, 1, last));
    });
    return await replica.read(everything);
  } finally {
    await replica.close();
    drop();
  }
}

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

/** Samples reaching each kind of operation, over both tables (the last test checks them). */
const totals: Record<string, number> = {};

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  it("apply on storage gives judge's view and the reference evaluator, step by step and as of each operation", async () => {
    const seen = { samples: 0, skipped: 0, steps: 0, replayed: 0 };
    const hits: Record<string, number> = {};
    await fc.assert(
      fc.asyncProperty(scenario(isState), extra, async ({ ops, decisions: some }, more) => {
        const decisions = [...some, ...more];
        const { steps } = judged(schema, ops.map(asInThisPhase), decisions);
        const ctx = {
          table: (isState ? "t2" : "t1") as never,
          target: isState ? { entity: ENTITY as never } : { row: ROW as never },
          shape: shape(schema),
          granularity: "date" as const,
        };
        // Pending item events follow their write.base (or head event) in the operation.
        const perStep = eventsOfSteps(ctx, steps, (after, n) => after + 1 + n);
        // An operation inserted right after one with several events would take a seq it needs.
        const collides = perStep.some((evs, k) => {
          const next = perStep[k + 1]?.[0]?.seq;
          return next !== undefined && (evs.at(-1)?.seq ?? 0) >= next;
        });
        if (collides) {
          seen.skipped++;
          return;
        }
        const store = await open();
        try {
          await createTenant(
            store,
            createOpsContext({
              tenant: TENANT,
              actor: USER,
              trigger: null,
              task: null,
              visibility: { kind: "all" },
              request_key: null,
              idempotency_window: 86_400_000,
              now: "2026-11-10T04:00:00.000Z",
              confirmation: null,
            }),
          );
          await run(
            store,
            createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
          );
          await run(store, decoy(isState));
          seen.samples++;
          const sample = new Set<string>();
          for (const [k, evs] of perStep.entries()) {
            const head = evs[0]?.seq as number;
            for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++) {
              await run(store, [filler]);
            }
            const op = await run(
              store,
              evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
            );
            expect(op.events.map((e) => e.seq)).toEqual(evs.map((e) => e.seq));
            const state = (steps[k] as (typeof steps)[number]).state;
            const v = plain(view(state));
            const ids = Object.keys(v.fields).sort();
            const got = await store.read((tx) => fromCells(tx, isState, ids));
            expect(plain(got)).toEqual(v);
            const ref = evaluateLog(
              schema,
              steps.slice(0, k + 1).map((x) => x.op),
            ).final;
            expect(plain(got)).toEqual(
              plain({
                exists: ref.exists,
                gaps: ref.gaps,
                fields:
                  ref.exists || isState
                    ? Object.fromEntries(
                        ids.map((f) => [f, (ref.fields as Record<string, unknown>)[f] ?? []]),
                      )
                    : {},
              }),
            );
            // The business table agrees with the cells: rows where the entity has a value, the
            // row existing (or revoked), and the field values.
            const rows = await store.read((tx) => businessRows(tx, isState));
            agrees(isState, rows, await store.read((tx) => openCells(tx, isState)));
            if (isState) {
              const spans = (rows as { vf: string; vt: string | null }[]).map((r) => ({
                from: r.vf,
                to: r.vt,
              }));
              expect(joined(spans)).toEqual(
                joined(got.fields["f2"]?.map((s) => s.valid[0] as never) ?? []),
              );
            } else {
              expect(rows.filter((r) => r["revoked"] === false).length).toBe(got.exists ? 1 : 0);
            }
            // The registrations are judge's, item by item.
            const id = isState ? ENTITY : ROW;
            const judgeRegs = Object.fromEntries(
              [...state.regs]
                .filter(([, rs]) => rs.length > 0)
                .map(([key, rs]) => [key, rs.map((x) => ({ op: x.op, valid: x.valid }))] as const)
                .sort(([a], [b]) => (a < b ? -1 : 1)),
            );
            expect(await store.read((tx) => storedRegs(tx, id))).toEqual(
              JSON.parse(JSON.stringify(judgeRegs)),
            );
            // `ver` (04-contract §3; 09 §5.7): it becomes this operation's number exactly when
            // the operation changed the row's version table (opened or closed a cell, outside
            // `schema_switch`). An item put into effect that leaves what is in effect as it was
            // (a repeated undo; a write-back a later item still covers) changes neither. Checked
            // where the row has cells before or after: judged scenarios also write to a row never
            // created (a non-required field only, or a revoke with no field item under it),
            // which a real write cannot reach (`not_found`), and such a row has no cells at all.
            const recordOp = (steps[k] as (typeof steps)[number]).judgement.record.op;
            const vt = await store.read((tx) => versionTable(tx, isState, id, recordOp));
            if (vt.before || vt.after) {
              expect({ step: k, changed: vt.changed, ver: vt.ver === recordOp }).toEqual({
                step: k,
                changed: vt.changed,
                ver: vt.changed,
              });
              // Cross-check with judge: a field (or, through it, existence) whose state this
              // operation changed means a changed version table.
              if (["f2", "f3"].some((f) => state.changedBy(recordOp, f as never).length > 0)) {
                expect({ step: k, changed: vt.changed }).toEqual({ step: k, changed: true });
              }
            }
            // The table's row count follows its business rows (revoked rows not counted).
            const counted = await store.read(async (tx) => {
              const c = await tx.query<{ row_count: unknown }>(
                `SELECT row_count FROM counts WHERE table_id = '${isState ? "t2" : "t1"}'`,
              );
              const n = await tx.query<{ n: unknown }>(
                isState
                  ? "SELECT count(*) AS n FROM t_t2_v1"
                  : "SELECT count(*) AS n FROM t_t1_v1 WHERE NOT revoked",
              );
              return [Number(c.rows[0]?.row_count), Number(n.rows[0]?.n)];
            });
            expect(counted[0]).toBe(counted[1]);
            // The first creation: the latest write given as creating it.
            const created = steps
              .slice(0, k + 1)
              .filter((x) => x.judgement.created)
              .at(-1)?.judgement.record.event;
            const origin = await store.read((tx) =>
              tx.query<{ origin_seq: unknown }>(
                "SELECT origin_seq FROM row_origins WHERE row_id = $1",
                [isState ? ENTITY : ROW],
              ),
            );
            expect(origin.rows.map((x) => Number(x.origin_seq))).toEqual(
              created === undefined ? [] : [created],
            );
            const step = steps[k] as (typeof steps)[number];
            const r = step.judgement.record;
            sample.add(r.kind === "undo" ? `undo ${r.status}` : r.kind);
            if (r.kind === "confirm" && r.revert !== undefined) sample.add("confirm undo");
            if (step.judgement.conflicts.length > 0) sample.add("conflict");
            if (state.regs.size > 0) sample.add("registered");
            seen.steps++;
          }
          for (const h of sample) hits[h] = (hits[h] ?? 0) + 1;
          // The version table as of every earlier operation.
          for (const s of steps) {
            const v = plain(view(s.state));
            const ids = Object.keys(v.fields).sort();
            const asOf = await store.read((tx) =>
              fromCells(tx, isState, ids, s.judgement.record.op),
            );
            expect({ op: s.judgement.record.op, view: plain(asOf) }).toEqual({
              op: s.judgement.record.op,
              view: v,
            });
          }
          // K12: replaying the whole log into an empty storage gives the same tables (every fourth
          // sample: the replay costs as much as the sample, and checks the same apply each time).
          if (seen.samples % 4 === 1) {
            expect(await replayed(store)).toEqual(await store.read(everything));
            seen.replayed++;
          }
        } finally {
          await store.close();
          drop();
        }
      }),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    if (process.env["JUDGE_STATS"]) console.log(schema.kind, JSON.stringify({ ...seen, hits }));
    for (const [h, n] of Object.entries(hits)) totals[h] = (totals[h] ?? 0) + n;
    // Each table reaches storage with the situations that tell apply apart, in a share of the
    // samples (about a third of what 60 samples a table reach): revokes, reverts (an undo, a
    // revert back to the merge base, a confirmed undo) and the resolutions of conflict items.
    const share = (...kinds: string[]) =>
      kinds.reduce((n, k) => n + (hits[k] ?? 0), 0) / seen.samples;
    expect(seen.samples).toBeGreaterThan(RUNS / 2);
    expect({ revoke: share("revoke") > 0.15 }).toEqual({ revoke: true });
    expect({ revert: share("undo applied", "take_previous", "confirm undo") > 0.12 }).toEqual({
      revert: true,
    });
    expect({ resolved: share("keep_effective", "take_candidate", "take_previous") > 0.15 }).toEqual(
      {
        resolved: true,
      },
    );
    expect({ registered: share("registered") > 0.1 }).toEqual({ registered: true });
  });
});

it("over both tables, each kind of decision reaches storage", () => {
  // Rarer kinds, counted over both tables (about a third of what 60 samples a table reach).
  const at = (k: string) => (totals[k] ?? 0) / (RUNS / 60);
  expect({
    keep: at("keep_effective") >= 4,
    take: at("take_candidate") >= 6,
    previous: at("take_previous") >= 4,
    awaitingUndo: at("undo awaiting") >= 6,
    confirm: at("confirm") >= 2,
    confirmOrReject: at("confirm") + at("reject") >= 4,
  }).toEqual({
    keep: true,
    take: true,
    previous: true,
    awaitingUndo: true,
    confirm: true,
    confirmOrReject: true,
  });
});
