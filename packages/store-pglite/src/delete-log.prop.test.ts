// A deletion written into the log and read back, three ways (03-deletion «删除结果的定义»,
// «多项删除各自列全位置»; 09-event-format §3.5, §5.9): judged scenarios are written into storage
// operation by operation, then one to three of the sources their writes cite are deleted in turn,
// each by the delete operation's two steps (`planDeletionOf`, `appendDeletion`), which append and
// apply. After each deletion:
//
// - the store as applied live, the same log replayed into an empty store (`reconcileLog`), and the
//   reference evaluator given the same writes and the same deletions agree: the row as the version
//   table's open cells give it (existence, gaps, each field's values and the items giving them),
//   and the source table's items (status and interval); live and replayed agree on the open
//   pending items too;
// - the list of positions the delete operation wrote is the one the block model gives
//   (delete/blocks.fixture.ts: each deletion's list from its replay alone, 09 §3.5 rule 1, worked
//   out apart from the delete operation's code). Paths the model does not hold are left out by name
//   (`SKIPPED`); any other path fails.
//
// Each write cites one source, its operation's number, in the store and in the reference alike
// (the reference's sources are renamed `S<op>`), so deleting a source deletes one operation's
// contributions on both sides. Indices are compared: no deletion is cancelled here.
//
// Not here: cancellations (no operation appends one yet), field groups (the compiled slot has
// none). A shape this version refuses is skipped and counted by kind; the samples carried to the
// end and compared have a floor.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDeletion,
  appendOperation,
  applyEvents,
  confirmDeletion,
  createOpsContext,
  createTenant,
  eventsOf,
  JudgeError,
  type NewEvent,
  planDeletionOf,
  previewDeletion,
  type ReadTx,
  readBufferOf,
  readTail,
  reconcileLog,
  resolve as resolveOp,
  WriteError,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import {
  asWritten,
  BlockModel,
  COMPILED_V1,
  createSlotEvents,
  deletedContributions,
  eventsOfSteps,
  judged,
  SLOT,
  scenario,
  shape,
  withConfirmations,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import {
  evaluateLog,
  type LogEntry,
  type Op,
  type TableSchema,
} from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";
import { seenAsVersions } from "./testing/version.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 550_000, markInterruptAsFailure: true });

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

const RUNS = propRuns(60);
// A fixed seed by default, so that a run says the same as the last one; the soak runs
// (`PROP_COVERAGE` set) keep fast-check's fresh random seed, `PROP_SEED` replays one.
const SEED =
  process.env["PROP_SEED"] !== undefined
    ? Number(process.env["PROP_SEED"])
    : process.env["PROP_COVERAGE"] === undefined
      ? 20261127
      : undefined;
const DUE = "2026-11-11T06:00:00.000Z";
const NOW_DELETE = "2026-11-10T06:00:00.000Z";
/** The deletions' IDs, in turn. */
const DELETIONS = [7, 8, 9].map((d) => `pi_${String(d).repeat(16)}`);
let newItems = 0;

/**
 * A scenario op as the store can hold it, each source renamed to its operation's, `S<op>`: as the store records it
 * (write/log.fixture.ts `eventsOfSteps`: every field of a write cites the write's own number, and
 * so does its interval when one is given).
 */
function bySourceOfOp(o: Op): Op {
  const s = [`S${o.op}`];
  if (o.kind === "write") {
    const { validSources: _, ...rest } = o;
    const fields = Object.fromEntries(
      Object.entries(o.fields).map(([f, x]) => [f, x === undefined ? x : { ...x, sources: s }]),
    );
    const interval = o.valid !== undefined && o.valid !== "corrected_span";
    return { ...rest, fields, ...(interval ? { validSources: s } : {}) } as Op;
  }
  if (o.kind === "revoke") {
    const { validSources: _, ...rest } = o;
    return { ...rest, ...(o.valid !== undefined ? { validSources: s } : {}) } as Op;
  }
  return o;
}

/** The sources the row's writes cite, in seq order. */
const citedOf = (store: PgliteTenantStore, isState: boolean) =>
  store.read(async (tx) =>
    [
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
    ].sort((a, b) => a - b),
  );

/** The open pending items and their entries, as a read of them gives. */
async function openItemsOf(tx: ReadTx) {
  const items = await tx.query<{ id: string; type: string; version_op: unknown }>(
    "SELECT id, type, version_op FROM pending_items WHERE state = 'open' ORDER BY id",
  );
  const entries = await tx.query<{ item_id: string; content_path: string }>(
    "SELECT item_id, content_path FROM pending_entries ORDER BY item_id, content_path",
  );
  return {
    items: items.rows.map((x) => `${x.id} ${x.type} ${Number(x.version_op)}`),
    entries: entries.rows.map((x) => `${x.item_id} ${x.content_path}`),
  };
}

/**
 * Paths a list of positions may hold that the block model does not: the blocks of a write that
 * are not an item's interval or value (its sources, its literal checks), and of its head. Matched
 * by the event's type and the path; any other path fails.
 */
const SKIPPED: readonly { type: string; path: RegExp }[] = [
  // The request's values and intervals as given (data blocks of the head), and the operation's
  // identity blocks (09 §5.1): checked apart, on the fixed histories, to be listed.
  { type: "write.head", path: /^(?:ops\/\d+\/(?:set\/f\d+|valid)|task|request_key|idempotency)$/ },
  // A source's own blocks.
  { type: "source.recorded", path: /^(?:text|request)$/ },
  // A write's value sources, its acknowledgements (listed by their `deps`) and literal checks.
  { type: "write.base", path: /^(?:(?:sources|literal)\/f\d+|ack)\/\d+$/ },
  // An earlier deletion's summary and its results.
  {
    type: "deletion.confirmed",
    path: /^(?:summary|results\/\d+\/(?:existence|fields\/f\d+\/\d+))$/,
  },
  // An item's entries.
  {
    type: "item.created",
    path: /^(?:(?:candidates|current|previous|proposed|impact)\/\d+|scope_valid)$/,
  },
  {
    type: "item.merged",
    path: /^(?:(?:candidates|current|previous|proposed|impact)\/\d+|scope_valid)$/,
  },
  {
    type: "item.refreshed",
    path: /^(?:(?:candidates|current|previous|proposed|impact)\/\d+|scope_valid)$/,
  },
];

/** A list of positions as (giver, item): the block model's terms. Unknown paths are returned apart. */
async function listedOf(
  tx: ReadTx,
  seq: number,
  idOfSeq: ReadonlyMap<number, string>,
): Promise<{ listed: string[]; unknown: string[] }> {
  const r = await tx.query<{ body: string }>(
    "SELECT body FROM content WHERE seq = $1 AND path = 'positions'",
    [seq],
  );
  const positions = JSON.parse(r.rows[0]?.body ?? "[]") as { seq: number; path: string }[];
  const seqs = [...new Set(positions.map((p) => p.seq))];
  const types = new Map(
    (
      await tx.query<{ seq: unknown; type: string }>(
        "SELECT seq, type FROM events WHERE seq = ANY($1)",
        [seqs] as never,
      )
    ).rows.map((x) => [Number(x.seq), x.type]),
  );
  const listed = new Set<string>();
  const unknown: string[] = [];
  for (const p of positions) {
    const type = types.get(p.seq) ?? "?";
    const item = /^(?:span|fields)\/(f\d+|existence)\/(\d+)$/.exec(p.path);
    const existence = /^existence\/(\d+)$/.exec(p.path);
    const restated = /^restated\/(\d+)$/.exec(p.path);
    if (type === "write.base" && item !== null) {
      listed.add(`written ${p.seq}/${item[1]}/${item[2]}`);
    } else if (type === "write.base" && existence !== null) {
      listed.add(`written ${p.seq}/existence/${existence[1]}`);
    } else if (type === "deletion.confirmed" && restated !== null) {
      const b = await tx.query<{ body: string }>(
        "SELECT body FROM content WHERE seq = $1 AND path = $2",
        [p.seq, p.path],
      );
      const x = JSON.parse(b.rows[0]?.body ?? "{}") as {
        event: number;
        field?: string;
        k?: number;
        existence?: number;
      };
      const target = x.field ?? "existence";
      const k = x.k ?? x.existence ?? 0;
      listed.add(`${idOfSeq.get(p.seq) ?? `?${p.seq}`} ${x.event}/${target}/${k}`);
    } else if (!SKIPPED.some((s) => s.type === type && s.path.test(p.path))) {
      unknown.push(`${type} ${p.seq} ${p.path}`);
    }
  }
  return { listed: [...listed].sort(), unknown };
}

let main: ReusableStore;
let scratch: ReusableStore;
beforeAll(async () => {
  main = await openReusable("saveslot-delete-log-prop-");
  scratch = await openReusable("saveslot-delete-log-prop-scratch-");
}, 120_000);
afterAll(async () => {
  await main?.close();
  await scratch?.close();
}, 120_000);

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

type Compare = (
  store: PgliteTenantStore,
  entries: readonly LogEntry[],
  model: InstanceType<typeof BlockModel>,
  done: readonly { id: string; seq: number }[],
) => Promise<void>;

/** The three sides and the block model, after the deletions so far. */
function compareOn(schema: TableSchema, unknownPaths: Set<string>): Compare {
  const isState = schema.kind === "state";
  return async (
    store: PgliteTenantStore,
    entries: readonly LogEntry[],
    model: InstanceType<typeof BlockModel>,
    done: readonly { id: string; seq: number }[],
  ) => {
    const id = isState ? ENTITY : ROW;
    const ids = ["f2", "f3"];
    const ref = evaluateLog(schema, entries as LogEntry[]).final;
    // What a read shows (`readable`): a field empty all along with no giver is not compared, as
    // the store may keep an empty cell where the reference lists nothing (a row created again).
    const refView = readable({
      exists: ref.exists,
      gaps: ref.gaps,
      fields:
        ref.exists || isState
          ? Object.fromEntries(
              ids.map((f) => [f, (ref.fields as Record<string, unknown>)[f] ?? []]),
            )
          : {},
    });
    // The source table holds the items in effect only: candidates and awaiting writes are in the
    // pending items, compared live against replayed (a deletion finds their contributions from
    // the log, not this table).
    const refItems = ref.items
      .filter((x) => x.status === "applied" || x.status === "corroborated")
      .flatMap((x) => {
        const v = (isState ? x.valid : [WHOLE]) as { from: string | null; to: string | null }[];
        return v.map((s) => `${x.event}/${x.target}/${x.k} ${x.status} ${s.from}..${s.to}`);
      })
      .sort();
    const read = (s: PgliteTenantStore) =>
      s.read(async (tx) => ({
        view: readable(await fromCells(tx, isState, ids)),
        items: await storedItems(tx, id),
        open: await openItemsOf(tx),
      }));
    const live = await read(store);
    expect({ view: live.view, items: live.items }).toEqual({ view: refView, items: refItems });
    await scratch.reset();
    const r = await reconcileLog({ live: store, scratch: scratch.store });
    expect(r.mismatches).toEqual([]);
    expect(await read(scratch.store)).toEqual(live);
    // Rule 1, apart from the delete operation's code: each deletion's list as the block model has it.
    const idOfSeq = new Map(done.map((d) => [d.seq, d.id]));
    for (const d of done) {
      const { listed, unknown } = await store.read((tx) => listedOf(tx, d.seq, idOfSeq));
      for (const u of unknown) unknownPaths.add(u);
      const blocks = model.deletions.get(d.id)?.positions ?? new Set();
      const want = [...blocks]
        .map((b) => `${b.kind === "written" ? "written" : b.from} ${b.item}`)
        .sort();
      expect({ deletion: d.id, listed: [...new Set(listed)] }).toEqual({
        deletion: d.id,
        listed: [...new Set(want)],
      });
    }
  };
}

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  const seen = { samples: 0, compared: 0, deletions: 0, skipped: 0, referenced: 0 };
  const refused: Record<string, number> = {};
  const unknownPaths = new Set<string>();

  const compare = compareOn(schema, unknownPaths);

  const checkSample = async (
    raw: readonly Op[],
    decisions: readonly import("@fluxvita/saveslot-kernel/testing").Decision[],
    picks: readonly number[],
  ) => {
    seen.samples++;
    const ops = raw.map(bySourceOfOp).map(asWritten);
    const { steps } = judged(schema, ops, decisions);
    const ctx = {
      table: (isState ? "t2" : "t1") as never,
      target: isState ? { entity: ENTITY as never } : { row: ROW as never },
      shape: shape(schema),
      granularity: "date" as const,
    };
    // No table of the compiled slot refers to another, so no revoke there awaits referrers: a
    // sample whose generator marks one as referred to (high impact ②) is not a history this store
    // can hold, and is skipped.
    if (
      steps.some((x) => x.op.kind === "revoke" && (x.op as { referenced?: boolean }).referenced)
    ) {
      seen.referenced++;
      return;
    }
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
    const kept = steps.map((x) => x.op);
    const records = steps.map((x) => x.judgement.record);
    // No table of the compiled slot refers to another: neither may be referred to, as the
    // delete operation reads it from the slot.
    const model = new BlockModel({ ...shape(schema), referable: false }, records);
    const entries: LogEntry[] = [...kept];
    const done: { id: string; seq: number }[] = [];
    for (const [n, pick] of picks.entries()) {
      const cited = (await citedOf(store, isState)).filter(
        (s) => !entries.some((e) => e.kind === "deletion" && e.sources.includes(`S${s}`)),
      );
      if (cited.length === 0) break;
      const src = cited[pick % cited.length] as number;
      const id = DELETIONS[n] as string;
      const out = await store.write(async (tx) => {
        try {
          const plan = await planDeletionOf(tx, { slot: SLOT, sources: [src as never] });
          const { seq } = await appendDeletion(tx, plan, {
            id,
            dueAt: DUE,
            newId: () => `pi_YY${String(++newItems).padStart(14, "0")}`,
            actor: USER as never,
            now: NOW_DELETE as never,
          });
          return { seq: seq as number };
        } catch (e) {
          if (e instanceof JudgeError) return { refused: `judge ${e.reason}` };
          if (e instanceof WriteError && e.detail.reason === "not_implemented")
            return { refused: String((e.detail as { kind?: unknown }).kind) };
          throw e;
        }
      });
      if ("refused" in out) {
        refused[out.refused] = (refused[out.refused] ?? 0) + 1;
        break;
      }
      try {
        model.confirm(id, deletedContributions(kept, new Set([`S${src}`]), isState));
      } catch (e) {
        if (!(e instanceof JudgeError)) throw e;
        refused[`model ${e.reason}: ${e.message}`] =
          (refused[`model ${e.reason}: ${e.message}`] ?? 0) + 1;
        break;
      }
      entries.push({ kind: "deletion", op: out.seq as never, id, sources: [`S${src}`] });
      done.push({ id, seq: out.seq });
      seen.deletions++;
      await compare(store, entries, model, done);
    }
    if (done.length > 0) seen.compared++;
  };

  it("the store as applied, replayed from empty, and the reference evaluator agree; each list of positions is rule 1's", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenario(isState),
        fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
        async ({ ops, decisions }, picks) => checkSample(ops, decisions, picks),
      ),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    const counts = JSON.stringify({ ...seen, refused, unknownPaths: [...unknownPaths] });
    if (process.env["DELETE_LOG_STATS"])
      appendFileSync(process.env["DELETE_LOG_STATS"], `${schema.kind} ${counts}\n`);
    expect({ unknownPaths: [...unknownPaths], counts }).toEqual({ unknownPaths: [], counts });
    expect({ compared: seen.compared >= Math.ceil(RUNS / 4), counts }).toEqual({
      compared: true,
      counts,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Fixed histories through the delete operation's entry (`previewDeletion`, then
// `confirmDeletion`): the scenario's ops sent as write requests, operation numbers ten times
// larger, one source each (`s_<op>`, `S<op>` to the reference); each deletion previewed and
// confirmed as a caller would, refused never (a refusal fails the case). The same three ways and
// rule 1 after each; before the first deletion the store and the reference must agree already, so
// that a difference after it is the deletion's, not this test's mapping of ops to requests.

const NAME: Record<string, string> = { f2: "b", f3: "c" };

/** The ops as sent (write-items.prop.test.ts): numbers ten times larger, a source each, `seen` given. */
function asSent(o: Op, i: number): Op {
  const x = asWritten(o, i);
  const op = x.op * 10;
  const event = op + 2;
  const seen = "seen" in x && x.seen !== undefined ? x.seen * 10 : undefined;
  if (x.kind === "write" || x.kind === "revoke")
    return bySourceOfOp(
      i === 0 ? ({ ...x, op, event } as Op) : ({ ...x, op, event, seen: seen ?? op - 1 } as Op),
    );
  if (x.kind === "undo")
    return {
      ...x,
      op,
      event,
      target: x.target * 10,
      ...(seen !== undefined ? { seen } : {}),
    } as Op;
  return { ...x, op, event } as Op;
}

/** The write request of an op as sent (write-items.prop.test.ts). */
function requestOf(o: Op, first: boolean, isState: boolean): Record<string, unknown> {
  const table = isState ? "entities" : "rows";
  const target = first ? {} : isState ? { entity: ENTITY } : { row: ROW };
  const ver = "seen" in o && o.seen !== undefined && !first ? { ver: `v${o.seen}.0` } : {};
  const ack =
    "acknowledge" in o && o.acknowledge !== undefined ? { acknowledge: ["overwrite"] } : {};
  const valid: Record<string, string> = {};
  let correct = false;
  if ((o.kind === "write" || o.kind === "revoke") && o.valid !== undefined) {
    if (o.valid === "corrected_span") correct = true;
    else {
      if (o.valid.from.mode === "given") valid["valid_from"] = o.valid.from.value;
      if (o.valid.to.mode === "given") valid["valid_to"] = o.valid.to.value;
      else valid["valid_to"] = o.valid.to.mode;
    }
  }
  if (o.kind === "undo")
    return {
      sv: 1,
      ops: [
        {
          table,
          ...target,
          ...ver,
          ...ack,
          revert: { undo: o.target, include_later: o.includeLater === true },
        },
      ],
    };
  if (o.kind === "revoke")
    return { sv: 1, ops: [{ intent: "revoke", table, ...target, ...ver, ...valid }] };
  if (o.kind !== "write") throw new Error(`not sent: ${o.kind}`);
  const set = Object.fromEntries(
    Object.entries(o.fields)
      .filter(([f, x]) => x !== undefined && !o.noop?.includes(f as never))
      .map(([f, x]) => [NAME[f] as string, x?.value ?? null]),
  );
  const explicit = Object.entries(o.fields)
    .filter(([, x]) => x?.explicit === true)
    .map(([f]) => NAME[f] as string);
  return {
    sv: 1,
    ...(explicit.length > 0 ? { evidence: [{ kind: "agent_note", text: `op ${o.op}` }] } : {}),
    ops: [
      {
        intent: first ? "insert" : correct ? "correct" : "update",
        table,
        ...target,
        ...ver,
        ...ack,
        ...valid,
        set,
        ...(explicit.length > 0
          ? { evidence_by_field: Object.fromEntries(explicit.map((n) => [n, [0]])) }
          : {}),
      },
    ],
  };
}

const OTHER_ROW = `r_${"4".repeat(26)}`;
const sourceIdOf = (op: number) => `s_${String(op).padStart(16, "0")}`;

interface Fixed {
  readonly schema: TableSchema;
  readonly ops: readonly Op[];
  /** The deletions in turn, each by the scenario ops whose sources it deletes. */
  readonly deletions: readonly (readonly number[])[];
}

/** A fixed history sent, then deleted from step by step; returns what the checks need after. */
async function runFixed(f: Fixed) {
  const isState = f.schema.kind === "state";
  const sent = f.ops.map(asSent);
  const ops = seenAsVersions(sent, (x) => judged(f.schema, x, []).steps);
  if (ops === undefined) throw new Error("a fixed history's versions are not the scenario's");
  const { steps } = judged(f.schema, ops, []);
  // A fixed history is not refused anywhere: every op judged.
  expect(steps.map((x) => x.op.op)).toEqual(ops.map((o) => o.op));
  await main.reset();
  const store = main.store;
  await createTenant(
    store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: "2026-11-04T00:00:00.000Z",
      confirmation: null,
    }),
  );
  await run(store, createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }));
  let items = 0;
  let fillers = 9_000_000;
  for (const [k, step] of steps.entries()) {
    const o = step.op;
    const tail = (await store.read(readTail))?.seq ?? 0;
    if (tail < o.op - 1)
      await run(store, [
        filler,
        ...Array.from(
          { length: o.op - 2 - tail },
          (): NewEvent => ({
            type: "source.recorded",
            slot: SLOT,
            blocks: {
              target: {
                source_id: `s_${String(++fillers).padStart(16, "0")}`,
                kind: "agent_note",
                level: "agent_inferred",
              },
              text: { text: "filler" },
            },
          }),
        ),
      ]);
    const now = "now" in step.input ? (step.input.now as string) : "2026-11-05";
    if (o.kind === "resolve") {
      // A take of the open conflict item's candidate, at the item's current version.
      const [item] = await store.read(async (tx) =>
        (
          await tx.query<{ id: string; v: unknown }>(
            "SELECT id, version_op AS v FROM pending_items WHERE state = 'open' AND type = 'conflict' ORDER BY id",
          )
        ).rows.map((x) => ({ id: x.id, ver: `iv_${x.id.slice(3)}.${Number(x.v)}.0` })),
      );
      if (item === undefined) throw new Error(`no open conflict item to take at #${o.op}`);
      await resolveOp(store, opsCtx(`step-${k}`, `${now}T04:00:00.000Z`), {
        id: item.id,
        item_ver: item.ver,
        decision: "take_candidate",
        idempotency_key: `step-${k}`,
      });
      continue;
    }
    await store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: `step-${k}`,
        now: `${now}T04:00:00.000Z`,
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params: { ...requestOf(o, k === 0, isState), idempotency_key: `step-${k}` },
        reads: readBufferOf(store),
        newId: (kind) =>
          kind === "row"
            ? ROW
            : kind === "entity"
              ? ENTITY
              : kind === "item"
                ? `pi_${String(++items).padStart(16, "0")}`
                : sourceIdOf(o.op),
      }),
    );
  }
  const kept = steps.map((x) => x.op);
  const records = steps.map((x) => x.judgement.record);
  const model = new BlockModel({ ...shape(f.schema), referable: false }, records);
  const entries: LogEntry[] = [...kept];
  const done: { id: string; seq: number }[] = [];
  const unknownPaths = new Set<string>();
  const check = compareOn(f.schema, unknownPaths);
  // Before any deletion: the mapping of ops to requests gives the reference's state.
  await check(store, entries, model, []);
  const dir = mkdtempSync(join(tmpdir(), "saveslot-delete-log-anchor-"));
  const anchor = openFileAnchorStore(join(dir, "anchor.json"));
  try {
    for (const [n, del] of f.deletions.entries()) {
      const names = del.map((o) => `S${o * 10}`);
      const { binding } = await previewDeletion(store, {
        sources: del.map((o) => sourceIdOf(o * 10)),
      });
      const receipt = await confirmDeletion(store, anchor, deleteCtx(), {
        binding,
        handle: `dc_fixed_${n}`,
      });
      model.confirm(receipt.deletion.id, deletedContributions(kept, new Set(names), isState));
      entries.push({
        kind: "deletion",
        op: receipt.seq as never,
        id: receipt.deletion.id,
        sources: names,
      });
      done.push({ id: receipt.deletion.id, seq: receipt.seq as number });
      await check(store, entries, model, done);
      // The deleted operations' identity blocks (09 §5.1 `task`, `request_key`, `idempotency`) are
      // on the list (§5.9): each one the head has.
      const ids = await store.read(async (tx) => {
        const heads = del.map((o) => o * 10);
        const has = (
          await tx.query<{ seq: unknown; path: string }>(
            `SELECT seq, path FROM content WHERE seq = ANY($1) AND body IS NOT NULL
               AND path IN ('task', 'request_key', 'idempotency')`,
            [heads] as never,
          )
        ).rows.map((x) => `${Number(x.seq)} ${x.path}`);
        const listed = JSON.parse(
          (
            await tx.query<{ body: string }>(
              "SELECT body FROM content WHERE seq = $1 AND path = 'positions'",
              [receipt.seq],
            )
          ).rows[0]?.body ?? "[]",
        ) as { seq: number; path: string }[];
        return { has: has.sort(), listed: listed.map((x) => `${x.seq} ${x.path}`) };
      });
      expect(ids.has.length).toBeGreaterThan(0);
      expect(ids.has.filter((x) => !ids.listed.includes(x))).toEqual([]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect([...unknownPaths]).toEqual([]);
  return { store, entries, model, done, kept, isState };
}

const opsCtx = (task: string, now: string) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now,
    confirmation: null,
  });

let minuteD = 0;
const deleteCtx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: "delete",
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: `2026-11-10T07:${String(++minuteD % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });

const w = (op: number, seen: number, f2: string, extra: Partial<Op> = {}): Op =>
  ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    fields: { f2: { value: f2, sources: [`S${op}`] } },
    acknowledge: ["overwrite"],
    ...extra,
  }) as Op;
const span = (from: string, to?: string) => ({
  valid: {
    from: { mode: "given", value: from },
    to:
      to === undefined
        ? { mode: "open" }
        : to === "next_change"
          ? { mode: "next_change" }
          : { mode: "given", value: to },
  },
});

const sv = (
  op: number,
  seen: number,
  f2: string,
  from: string,
  to?: string,
  extra: Partial<Op> = {},
) => w(op, seen, f2, { ...span(from, to), ...extra } as Partial<Op>);
const take = (op: number, candidate: number): Op =>
  ({
    kind: "resolve",
    op,
    event: op + 1,
    decision: "take_candidate",
    candidates: [candidate * 10 + 2],
    take: candidate * 10 + 2,
    unit: "f2",
  }) as unknown as Op;
/** The kinds of the deletion's events: what a fixed history is built to reach. */
const eventsOf$ = (store: PgliteTenantStore, seq: number) =>
  store.read(async (tx) =>
    (
      await tx.query<{ type: string }>("SELECT type FROM events WHERE op = $1 ORDER BY seq", [seq])
    ).rows.map((x) => x.type),
  );

describe("fixed histories through the delete operation's entry", () => {
  it("one deletion: a correction's words (event table)", async () => {
    await runFixed({ schema: EVENT, ops: [w(1, 0, "45"), w(2, 1, "35")], deletions: [[2]] });
  });

  for (const order of [
    [[2], [3]],
    [[3], [2]],
  ])
    it(`two deletions pending on one row, ${JSON.stringify(order)} (state table)`, async () => {
      await runFixed({
        schema: STATE,
        ops: [
          sv(1, 0, "1", "2026-10-01"),
          sv(2, 1, "2", "2026-11-01", "2026-11-05"),
          sv(3, 2, "3", "2026-11-03", "2026-11-09"),
        ],
        deletions: order,
      });
    });

  it("three deletions pending, a later list holding an earlier one's restatement (state table)", async () => {
    // #4's default end stops at #2's change point. Deleting #2 restates #4 on to #3's, its deps #3;
    // deleting #3 then lists that restatement (rule 1: a dep deleted), not only blocks as written.
    const r = await runFixed({
      schema: STATE,
      ops: [
        sv(1, 0, "1", "2026-10-01"),
        sv(2, 1, "2", "2026-11-05"),
        sv(3, 2, "3", "2026-11-09"),
        sv(4, 3, "4", "2026-11-01", "next_change"),
      ],
      deletions: [[2], [3], [1]],
    });
    const lists = r.done.map((d) => [...(r.model.deletions.get(d.id)?.positions ?? [])]);
    expect(lists.some((xs) => xs.some((b) => b.kind === "confirm"))).toBe(true);
  });

  it("rule 2's carried branch: a take resting on the item it carries, restated as dropped (event table)", async () => {
    // #4 (seen #2) writes 1, a candidate against #3; #5 takes it, carrying it. Deleting #2 makes
    // #4's seen version #1's 1: #4 a no-op, restated as dropped, the take's block resting on it.
    const r = await runFixed({
      schema: EVENT,
      ops: [
        w(1, 0, "1"),
        w(2, 1, "5"),
        w(3, 2, "9"),
        w(4, 2, "1", { acknowledge: undefined } as Partial<Op>),
        take(5, 4),
      ],
      deletions: [[2]],
    });
    const restated = await r.store.read(async (tx) =>
      (
        await tx.query<{ body: string }>(
          "SELECT body FROM content WHERE seq = $1 AND path LIKE 'restated/%'",
          [r.done[0]?.seq as number],
        )
      ).rows.map((x) => JSON.parse(x.body) as { event: number; status: string }),
    );
    expect(restated).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 42, status: "dropped" })]),
    );
  });

  it("a deletion opening an awaiting item (state table)", async () => {
    const r = await runFixed({
      schema: STATE,
      ops: [
        sv(1, 0, "5000", "2026-10-01"),
        sv(2, 1, "4000", "2026-11-10", "2026-11-20"),
        sv(3, 1, "3000", "2026-09-01", "2026-12-01", { acknowledge: undefined } as Partial<Op>),
      ],
      deletions: [[2]],
    });
    expect(await eventsOf$(r.store, r.done[0]?.seq as number)).toContain("item.created");
  });

  it("a conflict's cause deleted: its item superseded (event table)", async () => {
    const r = await runFixed({
      schema: EVENT,
      ops: [w(1, 0, "45"), w(2, 1, "35"), w(3, 1, "30", { acknowledge: undefined } as Partial<Op>)],
      deletions: [[2]],
    });
    expect(await eventsOf$(r.store, r.done[0]?.seq as number)).toContain("item.superseded");
  });

  it("in the grace period, a write to a row the deletion does not affect: taken, the three ways still agree", async () => {
    const r = await runFixed({
      schema: EVENT,
      ops: [w(1, 0, "45"), w(2, 1, "35")],
      deletions: [[2]],
    });
    const before = await r.store.read(readTail);
    await r.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: "other",
        now: "2026-11-10T08:00:00.000Z",
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params: { sv: 1, ops: [{ intent: "insert", table: "rows", set: { b: "12" } }] },
        reads: readBufferOf(r.store),
        newId: (kind) => (kind === "row" ? OTHER_ROW : `s_${"8".repeat(16)}`),
      }),
    );
    expect(((await r.store.read(readTail))?.seq ?? 0) > (before?.seq ?? 0)).toBe(true);
    const unknown = new Set<string>();
    await compareOn(EVENT, unknown)(r.store, r.entries, r.model, r.done);
    expect([...unknown]).toEqual([]);
  });

  it("in the grace period, on the row the deletion affects: no decision, no undo, no write; nothing appended", async () => {
    // As in "a deletion opening an awaiting item": the entity is affected by the pending deletion.
    const r = await runFixed({
      schema: STATE,
      ops: [
        sv(1, 0, "5000", "2026-10-01"),
        sv(2, 1, "4000", "2026-11-10", "2026-11-20"),
        sv(3, 1, "3000", "2026-09-01", "2026-12-01", { acknowledge: undefined } as Partial<Op>),
      ],
      deletions: [[2]],
    });
    const [item] = await r.store.read(async (tx) =>
      (
        await tx.query<{ id: string; v: unknown }>(
          "SELECT id, version_op AS v FROM pending_items WHERE state = 'open'",
        )
      ).rows.map((x) => ({ id: x.id, ver: `iv_${x.id.slice(3)}.${Number(x.v)}.0` })),
    );
    expect(item).toBeDefined();
    const refused = async (f: () => Promise<unknown>) => {
      const at = (await r.store.read(readTail))?.seq;
      let e: { code?: string; detail?: { reason?: string } } | undefined;
      try {
        await f();
      } catch (x) {
        e = x as typeof e;
      }
      expect((await r.store.read(readTail))?.seq).toBe(at);
      return [e?.code, e?.detail?.reason];
    };
    const [row] = (await r.store.read(
      async (tx) =>
        (
          await tx.query<{ ver: unknown }>(
            "SELECT MAX(rec_from) AS ver FROM t_t2_v1__ver WHERE row_id = $1",
            [ENTITY],
          )
        ).rows,
    )) as { ver: unknown }[];
    const ver = `v${Number(row?.ver)}.0`;
    const send = (params: Record<string, unknown>) =>
      r.store.write((tx) =>
        writeInTx(tx, {
          actor: USER as never,
          task: "grace",
          now: "2026-11-10T08:00:00.000Z",
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          visibility: { kind: "all" },
          params,
          reads: readBufferOf(r.store),
          newId: () => `s_${"8".repeat(16)}`,
        }),
      );
    expect(
      await refused(() =>
        resolveOp(r.store, opsCtx("grace", "2026-11-10T08:00:00.000Z"), {
          id: item?.id,
          item_ver: item?.ver,
          decision: "confirm",
        }),
      ),
    ).toEqual(["invalid_argument", "pending_deletion_target"]);
    expect(
      await refused(() =>
        send({ sv: 1, ops: [{ table: "entities", entity: ENTITY, ver, revert: { undo: 20 } }] }),
      ),
    ).toEqual(["invalid_argument", "pending_deletion_target"]);
    expect(
      await refused(() =>
        send({
          sv: 1,
          ops: [
            {
              intent: "update",
              table: "entities",
              entity: ENTITY,
              ver,
              valid_from: "2026-12-05",
              valid_to: "2026-12-10",
              set: { b: "1" },
            },
          ],
        }),
      ),
    ).toEqual(["internal", "not_implemented"]);
    const unknown = new Set<string>();
    await compareOn(STATE, unknown)(r.store, r.entries, r.model, r.done);
    expect([...unknown]).toEqual([]);
  });

  it("one of an item's candidates deleted, another still in conflict (event table)", async () => {
    const r = await runFixed({
      schema: EVENT,
      ops: [
        w(1, 0, "45"),
        w(2, 1, "35"),
        w(3, 1, "30", { acknowledge: undefined } as Partial<Op>),
        w(4, 1, "25", { acknowledge: undefined } as Partial<Op>),
      ],
      deletions: [[3]],
    });
    expect(await eventsOf$(r.store, r.done[0]?.seq as number)).toContain("item.refreshed");
  });
});
