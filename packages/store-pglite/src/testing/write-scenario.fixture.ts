// A judged scenario written into a stored log, and the row or entity read back as judge's view
// and the reference evaluator give it (02-architecture §11 «测试矩阵», «写入路径与参考一致»).
// The same building and reading as apply-write.prop.test.ts, for the tests that compare another
// path to the reference: one row (event or timeless table t1) or one entity (state table t2),
// written after a decoy on another row and filler writes that move the log on to the `seq`s a
// step needs.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type NewEvent,
  type ReadTx,
  readTail,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import {
  asWritten,
  COMPILED_V1,
  createSlotEvents,
  type Decision,
  eventsOfSteps,
  judged,
  SLOT,
  shape,
  withConfirmations,
} from "@fluxvita/saveslot-kernel/testing";
import type { Op, TableSchema } from "@fluxvita/saveslot-reference";

export const TENANT = `tn_${"8".repeat(26)}`;
export const USER = `u_${"1".repeat(26)}`;
export const ROW = `r_${"6".repeat(26)}`;
export const ENTITY = `e_${"7".repeat(26)}`;
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

const CTX = {
  now: "2026-11-10T05:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};

let minute = 0;
const nextNow = () => {
  minute++;
  return `2026-11-10T${String(5 + (Math.floor(minute / 60) % 18)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z` as never;
};

const run = (s: TenantStore, events: NewEvent[]) =>
  s.write(async (tx) => {
    // A decision confirms the item's entries as they are (09 §5.8): the hash the pipeline gives.
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: nextNow(),
      events: await withConfirmations(tx, events),
    });
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

/** A write of nothing on another entity: moves the log on to the seq a step needs. */
const filler: NewEvent = {
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: CTX,
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t2", entity: FILLER, intent: "update" },
  },
};

/** Writes the tenant's genesis into an empty store. */
export const genesisInto = (store: TenantStore) =>
  createTenant(
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

/**
 * Writes the judged scenario into the empty `store`: genesis, the slot with both tables, the decoy,
 * then each step's events at the `seq`s judge gave them. Undefined when the scenario cannot be
 * written (an operation would take a `seq` the one before needs); else judge's steps.
 */
export async function writeScenario(
  store: TenantStore,
  schema: TableSchema,
  isState: boolean,
  ops: readonly Op[],
  decisions: readonly Decision[],
) {
  const { steps } = judged(schema, ops.map(asWritten), decisions);
  const ctx = {
    table: (isState ? "t2" : "t1") as never,
    target: isState ? { entity: ENTITY as never } : { row: ROW as never },
    shape: shape(schema),
    granularity: "date" as const,
  };
  // Pending item events follow their write.base (or head event) in the operation.
  const perStep = eventsOfSteps(ctx, steps, (after, n) => after + 1 + n);
  const collides = perStep.some((evs, k) => {
    const next = perStep[k + 1]?.[0]?.seq;
    return next !== undefined && (evs.at(-1)?.seq ?? 0) >= next;
  });
  if (collides) return undefined;
  await genesisInto(store);
  await run(store, createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }));
  await run(store, decoy(isState));
  for (const evs of perStep) {
    const head = evs[0]?.seq as number;
    for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++) {
      await run(store, [filler]);
    }
    const op = await run(
      store,
      evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
    );
    if (op.events.map((e) => e.seq).join() !== evs.map((e) => e.seq).join()) {
      throw new Error("a step's events did not get the seqs judge gave them");
    }
  }
  return steps;
}

type Interval = { from: string | null; to: string | null };
type Stretch = { valid: Interval[]; value: unknown; by?: unknown };
export type View = { exists: boolean; gaps: unknown; fields: Record<string, Stretch[]> };

const WHOLE = { from: null, to: null };

/** The complement of sorted, disjoint intervals. */
function gapsOf(has: Interval[]) {
  const out: Interval[] = [];
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

/** Runs touching stretches of the same value and item together, as judge's view does. */
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

/** Joins touching intervals. */
function joined(xs: Interval[]) {
  const out: Interval[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last !== undefined && last.to === x.from) last.to = x.to;
    else out.push({ ...x });
  }
  return out;
}

/** The row or entity as its version table's open cells hold it, without the items giving them. */
export async function openView(
  tx: ReadTx,
  isState: boolean,
  ids: readonly string[],
): Promise<View> {
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
  const cells = r.rows;
  const stretch = (c: (typeof cells)[number]): Stretch => ({
    valid: [isState ? { from: c.vf, to: c.vt } : WHOLE],
    value: c.field_id === "f2" ? c.f_f2 : c.f_f3,
  });
  const fieldCells = cells.filter((c) => c.field_id !== "existence");
  if (isState) {
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

/**
 * The reference evaluator's final state in the same form, without the items giving the values:
 * touching stretches of one value run together (as cells of different items with one value read).
 */
export function referenceView(
  final: { exists: boolean; gaps: unknown; fields: object },
  isState: boolean,
): View {
  const plain = JSON.parse(JSON.stringify(final)) as View;
  const ids = Object.keys(plain.fields).sort();
  const fields = Object.fromEntries(
    ids.map((f) => [
      f,
      merged((plain.fields[f] ?? []).map((s) => ({ valid: s.valid, value: s.value }))),
    ]),
  );
  return {
    exists: plain.exists,
    gaps: plain.gaps,
    fields: plain.exists || isState ? fields : {},
  };
}
