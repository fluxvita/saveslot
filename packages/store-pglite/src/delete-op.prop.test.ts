// The deletion as the `delete` operation works it out and appends it (../kernel ops/deletion-plan.ts
// `planDeletionOf`, ops/deletion.ts `appendDeletion`), against judge's deletion replay
// (03-deletion «删除结果的定义»; 09-event-format §5.9): judged scenarios are written into storage as
// in apply-deletion.prop.test.ts, then one or two of the sources their writes cite are deleted.
//
// - The plan's replay of the row is judge's replay of the same records with the same deleted set;
//   its positions are those the `delete` module gives for them.
// - The event it appends has the blocks `encodeDeletion` gives judge's replay (the same ID, due
//   time and impact summary).
// - Applied: the version table and the source table are judge's replay, the blocks listed pending,
//   the deletion registered; replaying the log into an empty storage gives the same tables.
//
// A shape this version refuses (`not_implemented`, by kind) or judge refuses skips the sample and
// is counted. The order of the checks at confirmation and the sources' IDs are the fixed cases'
// (delete-op.test.ts): here the plan is worked out from the sources' seqs.

import { appendFileSync } from "node:fs";
import {
  ApplyError,
  appendDeletion,
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  encodeDeletion,
  eventsOf,
  JudgeError,
  type NewEvent,
  planDeletionOf,
  positionsOf,
  type ReadTx,
  readCitations,
  readEvents,
  readPositionIndex,
  readTail,
  reconcileLog,
  takenAway,
  view,
  WriteError,
} from "@fluxvita/saveslot-kernel";
import {
  asWritten,
  COMPILED_V1,
  createSlotEvents,
  type Decision,
  deletionReplayForTests,
  eventsOfSteps,
  judged,
  SLOT,
  scenario,
  shape,
  withConfirmations,
} from "@fluxvita/saveslot-kernel/testing";
import type { Op, TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 550_000, markInterruptAsFailure: true });

const RUNS = propRuns(40);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);

const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;
const DECOY = { state: `e_${"5".repeat(26)}`, event: `r_${"5".repeat(26)}` };
/** The decoy row's evidence: never deleted, so nothing of the decoy may be listed. */
const DECOY_SOURCE = 7;

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

const run = (s: PgliteTenantStore, events: NewEvent[]) =>
  s.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: nextNow(),
      events: await withConfirmations(tx, events),
    });
    await applyEvents(tx, eventsOf(op));
    return op;
  });

/** Another row of the same table, written first from its own evidence: never listed. */
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
        "sources/f2/0": [{ kind: "value", source: DECOY_SOURCE }],
        ...(isState ? { "span/f2/0": { valid: { from: "2026-10-01" } } } : {}),
      },
    },
  ] as NewEvent[];
}

const filler: NewEvent = {
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: CTX,
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

/** What a read shows of a row: `plain`, less the fields empty all along with no giver. */
const readable = (v: { exists: boolean; gaps: unknown; fields: object }) => {
  const p = plain(v);
  const fields = Object.fromEntries(
    Object.entries(p.fields).filter(([, xs]) =>
      (xs as Stretch[]).some((x) => x.value !== null || x.by !== undefined),
    ),
  );
  return { ...p, fields };
};

const plain = (v: { exists: boolean; gaps: unknown; fields: object }) =>
  JSON.parse(JSON.stringify({ exists: v.exists, gaps: v.gaps, fields: v.fields })) as View;

/**
 * Event table: #30 a candidate against #20, taken (#50); #60 a candidate against that, taken too
 * (the generator's decision, op 63, carrying #60's value). Deleting #20's words makes #60 a no-op,
 * restated as dropped; the take's item stays in effect, carrying it, and its sources without an
 * interval are on the list (09 §3.5 rule 1): restated as it is. Found by the property (seed
 * -1136674429).
 */
const CARRIED_DROPPED = {
  ops: [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      fields: { f2: { value: "2", sources: ["S20"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 10,
      fields: { f2: { value: "3", sources: ["S30"] } },
    },
    {
      kind: "resolve",
      op: 50,
      event: 51,
      decision: "take_candidate",
      candidates: [31],
      take: 31,
      unit: "f2",
    },
    {
      kind: "write",
      op: 60,
      event: 61,
      seen: 20,
      fields: { f2: { value: "1", sources: ["S6"], explicit: false } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 70,
      event: 71,
      seen: 30,
      fields: { f2: { value: "9", sources: ["S5"], explicit: false } },
    },
  ],
  decisions: [{ after: 1516442422, pick: 0, kind: "take", flag: 0, focus: false }],
  pick: 6,
} as unknown as { ops: Op[]; decisions: Decision[]; pick: number };

const CTX_DELETE = {
  now: "2026-11-10T06:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
};
const DELETION = `pi_${"7".repeat(16)}`;
const DUE = "2026-11-11T06:00:00.000Z";
let newItems = 0;

/**
 * State table: #20 2 on [11-01, 11-05); #30 3 on [11-05, 11-11), having seen #20; #50 undoes #30,
 * writing back "no value" on [11-05, 11-11) (none was there before #30). Deleting #30's words (pick 41: the second source cited, alone) leaves #50's record
 * nothing to take back: its write-back is restated as dropped, and the stretch it gave "no value"
 * is given by nothing. Its giver changed, so the row is listed, though no stretch is there after
 * (09 §5.9 «列哪些»).
 */
const NO_VALUE_GONE = {
  ops: [
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 0,
      valid: {
        from: { mode: "given", value: "2026-11-01" },
        to: { mode: "given", value: "2026-11-05" },
      },
      fields: { f2: { value: "2", sources: ["S20"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 20,
      valid: {
        from: { mode: "given", value: "2026-11-05" },
        to: { mode: "given", value: "2026-11-11" },
      },
      fields: { f2: { value: "3", sources: ["S30"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "undo",
      op: 50,
      event: 51,
      target: 30,
      includeLater: false,
      seen: 31,
      acknowledge: ["overwrite"],
    },
  ],
  decisions: [],
  pick: 41,
} as unknown as { ops: Op[]; decisions: Decision[]; pick: number };
const item = (x: { event: number; target: string; k: number }) => `${x.event}/${x.target}/${x.k}`;

/** The source table's items in effect: status and interval, by item. */
async function storedItems(tx: ReadTx, id: string) {
  const r = await tx.query<{
    event_seq: unknown;
    field_id: string;
    k: number;
    status: string;
    valid_from: string | null;
    valid_to: string | null;
  }>(
    "SELECT event_seq, field_id, k, status, valid_from, valid_to FROM base_sources WHERE row_id = $1 AND n = 0",
    [id],
  );
  return r.rows
    .map(
      (x) =>
        `${Number(x.event_seq)}/${x.field_id}/${x.k} ${x.status} ${x.valid_from}..${x.valid_to}`,
    )
    .sort();
}

let main: ReusableStore;
let scratch: ReusableStore;
beforeAll(async () => {
  main = await openReusable("saveslot-delete-op-prop-");
  scratch = await openReusable("saveslot-delete-op-prop-scratch-");
}, 120_000);
afterAll(async () => {
  await main?.close();
  await scratch?.close();
}, 120_000);

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  const seen = {
    samples: 0,
    skipped: 0,
    refused: 0,
    notYet: 0,
    applyNotYet: 0,
    superseded: 0,
    opened: 0,
    refreshed: 0,
    listed: 0,
    restated: 0,
  };
  const notYet: Record<string, number> = {};

  const checkSample = async (ops: readonly Op[], decisions: readonly Decision[], pick: number) => {
    const { steps } = judged(schema, ops.map(asWritten), decisions);
    const ctx = {
      table: (isState ? "t2" : "t1") as never,
      target: isState ? { entity: ENTITY as never } : { row: ROW as never },
      shape: shape(schema),
      granularity: "date" as const,
    };
    const perStep = eventsOfSteps(ctx, steps, (after, n) => after + 1 + n);
    const collides = perStep.some((evs, k) => {
      const next = perStep[k + 1]?.[0]?.seq;
      return next !== undefined && (evs.at(-1)?.seq ?? 0) >= next;
    });
    if (collides) {
      seen.skipped++;
      return;
    }
    await main.reset();
    const store = main.store;
    expect(await store.read(snapshot)).toEqual(main.blank);
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
    await run(store, createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }));
    await run(store, decoy(isState));
    for (const evs of perStep) {
      const head = evs[0]?.seq as number;
      for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++) {
        await run(store, [filler]);
      }
      await run(
        store,
        evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
      );
    }

    // The deletion, as the `delete` operation works it out.
    const made = await store.read(async (tx) => {
      const cited = [
        ...new Set(
          (
            await tx.query<{ body: string }>(
              `SELECT c.body FROM events e JOIN content c ON c.seq = e.seq
               WHERE e.type = 'write.base' AND e.target_row = $1 AND c.path LIKE 'sources/%'`,
              [isState ? ENTITY : ROW],
            )
          ).rows.flatMap((x) =>
            (JSON.parse(x.body) as { source?: number }[]).flatMap((e) =>
              typeof e.source === "number" ? [e.source] : [],
            ),
          ),
        ),
      ].sort((a, b) => a - b);
      if (cited.length === 0) return undefined;
      const first = cited[pick % cited.length] as number;
      const second = cited[(pick >> 3) % cited.length] as number;
      const sources = [...new Set(pick % 2 === 0 ? [first] : [first, second])];
      const bases = await readCitations(tx, SLOT, sources);
      const deleted = takenAway(bases, new Set(sources));
      let replay: ReturnType<typeof deletionReplayForTests>;
      try {
        replay = deletionReplayForTests(
          shape(schema),
          steps.map((s) => s.judgement.record),
          deleted,
        );
      } catch (e) {
        if (e instanceof JudgeError) return "refused" as const;
        throw e;
      }
      let plan: Awaited<ReturnType<typeof planDeletionOf>>;
      try {
        plan = await planDeletionOf(tx, { slot: SLOT, sources });
      } catch (e) {
        if (e instanceof JudgeError) return "refused" as const;
        if (
          e instanceof WriteError &&
          (e.detail as { reason?: string }).reason === "not_implemented"
        ) {
          return { kind: String((e.detail as { kind?: unknown }).kind) };
        }
        throw e;
      }
      const restated = replay.replay.restated;
      const self = ((await readTail(tx))?.seq ?? 0) + 1;
      const index = await readPositionIndex(tx, { slot: SLOT, sources, bases, deleted, restated });
      const positions = positionsOf({ sources, deleted, restated, index, self });
      const r = replay.result;
      const blocks = encodeDeletion({
        id: DELETION,
        // The operation lists the sources in seq order.
        sources: [...sources].sort((a, b) => a - b),
        dueAt: DUE,
        origin: "request",
        positions,
        summaryHash: plan.hash,
        results: r.listed
          ? [
              {
                table: isState ? "t2" : "t1",
                id: isState ? ENTITY : ROW,
                outcome: replay.outcome as string,
                stretches: r.stretches,
                ...(r.gaps !== undefined ? { gaps: r.gaps } : {}),
              },
            ]
          : [],
        restated,
        recreated: r.recreated,
        // The items superseded, by the log's IDs (judge's item layer on the log's items).
        superseded: plan.items.flatMap((x) => x.superseded).sort(),
      });
      return { replay, plan, positions, self, listed: r.listed, blocks };
    });
    if (made === undefined) {
      seen.skipped++;
      return;
    }
    if (made === "refused") {
      seen.refused++;
      return;
    }
    if ("kind" in made) {
      notYet[made.kind] = (notYet[made.kind] ?? 0) + 1;
      seen.notYet++;
      return;
    }
    // The plan: the row's replay is judge's, its positions the `delete` module's.
    expect(made.plan.self).toBe(made.self);
    expect(made.plan.positions.map((p) => `${p.seq} ${p.path}`)).toEqual(
      made.positions.map((p) => `${p.seq} ${p.path}`),
    );
    const planned = made.plan.rows.find((x) => x.id === (isState ? ENTITY : ROW));
    expect(plain(view(planned?.result.replay.state ?? made.replay.before))).toEqual(
      plain(view(made.replay.replay.state)),
    );
    expect(made.plan.rows.every((x) => x.id === (isState ? ENTITY : ROW))).toBe(true);
    // A row not listed reads the same after (09 §5.9 «列哪些»): its values, givers and gaps. A field
    // empty all along with no giver reads as one the view does not name (the view names a field
    // only when an item gives it or it defines existence): left out on both sides.
    if (!made.listed) {
      expect(readable(view(made.replay.replay.state))).toEqual(readable(view(made.replay.before)));
    }
    // Each open item on the row before, with its members, read from the log's blocks: a conflict
    // item's candidates' (event, target), an awaiting item's proposal (its origin's items
    // awaiting before). Not from the item layer under test.
    const rowId = isState ? ENTITY : ROW;
    const membersBefore = await store.read(async (tx) => {
      const items = await tx.query<{ id: string; type: string }>(
        "SELECT id, type FROM pending_items WHERE state = 'open' AND target_row = $1",
        [rowId],
      );
      const out = new Map<string, { type: string; members: string[] }>();
      for (const it of items.rows) {
        if (it.type === "conflict") {
          const c = await tx.query<{ body: string }>(
            `SELECT c.body FROM pending_entries e
             JOIN content c ON c.seq = e.content_seq AND c.path = e.content_path
             WHERE e.item_id = $1 AND e.content_path LIKE 'candidates/%' AND c.body IS NOT NULL`,
            [it.id],
          );
          const members = c.rows.flatMap((x) => {
            const b = JSON.parse(x.body) as { event: number; items: { field?: string }[] };
            return b.items.map((y) => `${b.event}/${y.field ?? "existence"}`);
          });
          out.set(it.id, { type: it.type, members: [...new Set(members)].sort() });
        } else if (it.type === "awaiting_confirmation") {
          const t = await tx.query<{ body: string }>(
            `SELECT c.body FROM content c JOIN events e ON e.seq = c.seq
             WHERE e.type = 'item.created' AND c.path = 'target' AND c.body LIKE $1`,
            [`%"item":"${it.id}"%`],
          );
          const origin = (JSON.parse(t.rows[0]?.body ?? "{}") as { origin_event?: number })
            .origin_event;
          const members = (planned?.result.before.items ?? [])
            .filter((x) => x.event === origin && x.status === "awaiting")
            .map((x) => `${x.event}/${x.target}`);
          out.set(it.id, { type: it.type, members: [...new Set(members)].sort() });
        }
      }
      return out;
    });
    try {
      await store.write((tx) =>
        appendDeletion(tx, made.plan, {
          id: DELETION,
          dueAt: DUE,
          newId: () => `pi_ZZ${String(++newItems).padStart(14, "0")}`,
          actor: USER as never,
          now: CTX_DELETE.now as never,
        }),
      );
    } catch (e) {
      const a = e instanceof ApplyError ? e : (e as { cause?: unknown }).cause;
      if (a instanceof ApplyError && a.reason === "not_implemented") {
        seen.applyNotYet++;
        return;
      }
      throw e;
    }
    // The item layer against its members (03-deletion «推论», 09 §5.8): by the replay's statuses
    // after, a member stays when still pending of its item's kind (candidate / awaiting). An item
    // none of whose members stays is superseded; one some of whose members leave stays open and is
    // refreshed; each item a member of which turns from a candidate to awaiting is succeeded by a
    // new awaiting item.
    {
      const after = new Map<string, Set<string>>();
      for (const x of made.replay.replay.state.items) {
        const key = `${x.event}/${x.target}`;
        after.set(key, new Set([...(after.get(key) ?? []), x.status]));
      }
      const pendingAs = (key: string, status: string) => after.get(key)?.has(status) === true;
      const stored = await store.read(async (tx) => {
        const r = await tx.query<{ id: string; state: string }>(
          "SELECT id, state FROM pending_items WHERE target_row = $1",
          [rowId],
        );
        const refreshed = await tx.query<{ body: string }>(
          `SELECT c.body FROM content c JOIN events e ON e.seq = c.seq
           WHERE e.op = $1 AND e.type = 'item.refreshed' AND c.path = 'target'`,
          [made.self],
        );
        return {
          state: new Map(r.rows.map((x) => [x.id, x.state])),
          refreshed: new Set(
            refreshed.rows.map((x) => (JSON.parse(x.body) as { item: string }).item),
          ),
        };
      });
      let opens = 0;
      for (const [id, it] of membersBefore) {
        const kind = it.type === "conflict" ? "candidate" : "awaiting";
        const stays = it.members.filter((m) => pendingAs(m, kind));
        if (it.type === "conflict" && it.members.some((m) => pendingAs(m, "awaiting"))) opens++;
        expect([id, stored.state.get(id)]).toEqual([id, stays.length > 0 ? "open" : "superseded"]);
        if (stays.length > 0 && stays.length < it.members.length) {
          expect([id, stored.refreshed.has(id)]).toEqual([id, true]);
        }
        if (stays.length === 0) seen.superseded++;
        if (stored.refreshed.has(id)) seen.refreshed++;
      }
      const created = [...stored.state].filter(
        ([id, st]) => st === "open" && !membersBefore.has(id),
      );
      expect(created.length).toBe(opens);
      if (opens > 0) seen.opened++;
    }
    // The event appended: the blocks judge's replay encodes to.
    await store.read(async (tx) => {
      const [ev] = await readEvents(tx, made.self, made.self);
      // Its own blocks it lists (the summary) are pending from the start: not compared.
      const own = new Set(made.positions.filter((p) => p.seq === made.self).map((p) => p.path));
      const got = Object.fromEntries(
        [...(ev?.blocks ?? [])]
          .filter(([p, b]) => p !== "ctx" && (b as { state: string }).state === "present")
          .map(([p, b]) => [p, (b as { value?: unknown }).value]),
      );
      const want = Object.fromEntries(
        Object.entries(JSON.parse(JSON.stringify(made.blocks)) as Record<string, unknown>).filter(
          ([p]) => !own.has(p),
        ),
      );
      expect(got).toEqual(want);
    });
    seen.samples++;
    if (made.listed) seen.listed++;
    if (made.replay.replay.restated.length > 0) seen.restated++;
    const state = made.replay.replay.state;
    const id = isState ? ENTITY : ROW;

    // The version table is judge's view of the replay's state.
    const v = plain(view(state));
    const ids = Object.keys(v.fields).sort();
    expect(plain(await store.read((tx) => fromCells(tx, isState, ids)))).toEqual(v);
    // The source table: the items in effect, their intervals and registrations.
    const effective = state.items
      .filter((x) => x.status === "applied" || x.status === "corroborated")
      .map((x) => {
        const w = x.valid[0];
        const iv = isState ? `${w?.from ?? null}..${w?.to ?? null}` : "null..null";
        return `${item(x)} ${x.status} ${iv}`;
      })
      .sort();
    expect(await store.read((tx) => storedItems(tx, id))).toEqual(effective);
    const judgeRegs = Object.fromEntries(
      [...state.regs]
        .filter(([, rs]) => rs.length > 0)
        .map(([k, rs]) => [k, rs.map((x) => ({ op: x.op, valid: x.valid }))] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    expect(await store.read((tx) => storedRegs(tx, id))).toEqual(
      JSON.parse(JSON.stringify(judgeRegs)),
    );
    // The blocks listed are pending: read no more through the log; the deletion is registered.
    await store.read(async (tx) => {
      const evs = await readEvents(tx, 1, made.self);
      const pending = evs.flatMap((e) =>
        [...e.blocks].filter(([, b]) => b.state === "pending").map(([p]) => `${e.seq} ${p}`),
      );
      expect(pending.sort()).toEqual(made.positions.map((p) => `${p.seq} ${p.path}`).sort());
      const d = await tx.query("SELECT id, state, confirmed_seq FROM deletions");
      expect(d.rows).toEqual([{ id: DELETION, state: "pending", confirmed_seq: made.self }]);
    });
    // Replayed into an empty storage: the same tables.
    await scratch.reset();
    const r = await reconcileLog({ live: store, scratch: scratch.store });
    expect(r.mismatches).toEqual([]);
  };

  it("the deletion the operation works out and appends is judge's replay, applied and replayed the same", async () => {
    if (!isState) {
      const x = CARRIED_DROPPED;
      await checkSample(x.ops, x.decisions, x.pick);
    }
    await fc.assert(
      fc.asyncProperty(scenario(isState), fc.nat(), ({ ops, decisions }, pick) =>
        checkSample(ops, decisions, pick),
      ),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    if (process.env["DELETION_COUNTS"] !== undefined)
      appendFileSync(
        process.env["DELETION_COUNTS"],
        `${isState ? "state" : "event"} ${JSON.stringify({ seen, notYet })}\n`,
      );
    // The generator is not degenerate as a whole: most samples are checked.
    expect(seen.samples).toBeGreaterThan(RUNS / 4);
    // The rest of what the samples must reach is built in, each counted by its own case, not left
    // to the samples hitting it.
    const from = { mode: "given", value: "2026-10-01" } as never;
    const valid = isState ? { valid: { from, to: { mode: "open" } } } : {};
    const w = (op: number, seen: number, value: string, src: string) =>
      ({
        kind: "write",
        op,
        event: op + 1,
        seen,
        ...valid,
        fields: { f2: { value, sources: [src], explicit: false } },
      }) as unknown as Op;
    // Built in: #30, stale against #20, is the one candidate of its item. Deleting #20's source
    // (S2, the second source cited) gives the row #30's value (listed), restates #30 as in effect
    // (restated), and the item's only member leaves it (superseded).
    {
      const at = { ...seen };
      await checkSample([w(10, 0, "1", "S1"), w(20, 10, "2", "S2"), w(30, 10, "3", "S3")], [], 4);
      expect({
        listed: seen.listed - at.listed,
        restated: seen.restated - at.restated,
        superseded: seen.superseded - at.superseded,
      }).toEqual({ listed: 1, restated: 1, superseded: 1 });
    }
    // Built in: two stale candidates against #20 in one item; deleting #30's source (S3, the third
    // source cited) takes one away and the item stays open, refreshed. An awaiting item opened is
    // built in the fixed cases (delete-op.test.ts); the samples rarely reach it.
    {
      const at = seen.refreshed;
      await checkSample(
        [w(10, 0, "1", "S1"), w(20, 10, "2", "S2"), w(30, 10, "3", "S3"), w(40, 10, "4", "S4")],
        [],
        2,
      );
      expect(seen.refreshed).toBe(at + 1);
    }
    expect(seen.listed).toBeGreaterThan(0);
    expect(seen.restated).toBeGreaterThan(0);
    expect(seen.superseded).toBeGreaterThan(0);
    expect(seen.refreshed).toBeGreaterThan(0);
    if (isState) {
      const listed = seen.listed;
      await checkSample(NO_VALUE_GONE.ops, NO_VALUE_GONE.decisions, NO_VALUE_GONE.pick);
      expect(seen.listed).toBe(listed + 1);
    }
  });
});
