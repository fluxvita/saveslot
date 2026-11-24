// apply of `deletion.confirmed` against judge's deletion replay (09-event-format §5.9 `apply`;
// 03-deletion «结果怎么落进日志»): judged scenarios are written into storage as in
// apply-write.prop.test.ts, then one or two of the sources their writes cite are deleted. The event
// is made as the `delete` operation will make it: what the sources take away and the positions by
// the kernel's `delete` module, the results, restatements and first creations by judge's replay,
// encoded by `encodeDeletion`. It is appended and applied; then
//
// - the version table's open cells are judge's view of the replay's state (values, the items
//   giving them, the gaps, existence);
// - the source table's items in effect, with their intervals, and their "reverted" registrations
//   are the replay's;
// - the blocks listed are pending (read no more through the log), and the deletion is registered;
// - replaying the whole log into an empty storage gives the same tables.
//
// Item events (`item.superseded`, `item.refreshed`, `item.created`) are the `delete` operation's
// to make and already applied by their own code: not made here; `superseded_items` is written as
// judge gives it. A replay judge refuses, or a deletion apply refuses as not implemented yet, skips
// the sample and is counted.

import { appendFileSync } from "node:fs";
import {
  ApplyError,
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  encodeCancellation,
  encodeDeletion,
  eventsOf,
  JudgeError,
  type NewEvent,
  positionsOf,
  type ReadTx,
  readCitations,
  readEvents,
  readPositionIndex,
  readTail,
  reconcileLog,
  takenAway,
  view,
} from "@fluxvita/saveslot-kernel";
import {
  asWritten,
  COMPILED_V1,
  cancellationReplayForTests,
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

const plain = (v: { exists: boolean; gaps: unknown; fields: object }) =>
  JSON.parse(JSON.stringify({ exists: v.exists, gaps: v.gaps, fields: v.fields })) as View;

const CTX_DELETE = {
  now: "2026-11-10T06:00:00.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
};
const DELETION = `pi_${"7".repeat(16)}`;
const HASH = "c".repeat(64);
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
  main = await openReusable("saveslot-apply-deletion-");
  scratch = await openReusable("saveslot-apply-deletion-scratch-");
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
    judgeUnlisted: 0,
    listed: 0,
    restated: 0,
    cancelled: 0,
    cancelRefused: 0,
  };
  let unlisted: string | undefined;
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

    // The deletion, as the `delete` operation will make it.
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
      const restated = replay.replay.restated;
      const self = ((await readTail(tx))?.seq ?? 0) + 1;
      const index = await readPositionIndex(tx, {
        slot: SLOT,
        sources,
        bases,
        deleted,
        restated,
      });
      const positions = positionsOf({ sources, deleted, restated, index, self });
      const r = replay.result;
      const blocks = encodeDeletion({
        id: DELETION,
        sources,
        dueAt: "2026-11-11T06:00:00.000Z",
        origin: "request",
        positions,
        summaryHash: HASH,
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
        // The items' IDs are the log's; judge's are its own names: not written here.
        superseded: [],
      });
      return { replay, positions, self, listed: r.listed, blocks, sources };
    });
    if (made === undefined) {
      seen.skipped++;
      return;
    }
    if (made === "refused") {
      seen.refused++;
      return;
    }
    // judge's replay changing what a read shows of the row without listing it is judge's to
    // answer (09 §5.9 «列哪些»), not apply's: counted, the first such sample kept, skipped.
    if (
      !made.listed &&
      JSON.stringify(plain(view(made.replay.before))) !==
        JSON.stringify(plain(view(made.replay.replay.state)))
    ) {
      seen.judgeUnlisted++;
      unlisted ??= JSON.stringify({ ops, decisions, pick });
      return;
    }
    try {
      await run(store, [
        { type: "deletion.confirmed", slot: SLOT, blocks: { ctx: CTX_DELETE, ...made.blocks } },
      ] as NewEvent[]);
    } catch (e) {
      const a = e instanceof ApplyError ? e : (e as { cause?: unknown }).cause;
      if (a instanceof ApplyError && a.reason === "not_implemented") {
        seen.notYet++;
        notYet[a.message.replace(/.*: /, "")] = (notYet[a.message.replace(/.*: /, "")] ?? 0) + 1;
        return;
      }
      throw e;
    }
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

    // The deletion cancelled (09 §5.9 `deletion.cancelled`), as the cancellation will be made:
    // judge's replay without it, encoded; then the same checks, the blocks readable again and the
    // deletion cancelled. With no write since, the row is back to what it was.
    const records = steps.map((x) => x.judgement.record);
    const deleted = await store.read(async (tx) =>
      takenAway(await readCitations(tx, SLOT, made.sources), new Set(made.sources)),
    );
    let back: ReturnType<typeof cancellationReplayForTests>;
    try {
      back = cancellationReplayForTests(
        shape(schema),
        records,
        deleted,
        made.replay.replay.restated,
      );
    } catch (e) {
      if (e instanceof JudgeError) {
        seen.cancelRefused++;
        return;
      }
      throw e;
    }
    const b = back.result;
    if (
      !b.listed &&
      JSON.stringify(plain(view(back.before))) !== JSON.stringify(plain(view(back.replay.state)))
    ) {
      seen.judgeUnlisted++;
      return;
    }
    const cancelBlocks = encodeCancellation({
      id: DELETION,
      origin: "request",
      results: b.listed
        ? [
            {
              table: isState ? "t2" : "t1",
              id,
              outcome: back.outcome as string,
              stretches: b.stretches,
              ...(b.gaps !== undefined ? { gaps: b.gaps } : {}),
            },
          ]
        : [],
      restated: back.replay.restated,
      recreated: b.recreated,
      // The items' IDs are the log's; no item events were made with the deletion.
      restoredItems: [],
      keptSuperseded: [],
      keptEffective: [],
    });
    try {
      await run(store, [
        { type: "deletion.cancelled", slot: SLOT, blocks: { ctx: CTX_DELETE, ...cancelBlocks } },
      ] as NewEvent[]);
    } catch (e) {
      const a = e instanceof ApplyError ? e : (e as { cause?: unknown }).cause;
      if (a instanceof ApplyError && a.reason === "not_implemented") {
        seen.notYet++;
        return;
      }
      throw e;
    }
    seen.cancelled++;
    const backState = back.replay.state;
    const vb = plain(view(backState));
    expect(
      plain(await store.read((tx) => fromCells(tx, isState, Object.keys(vb.fields).sort()))),
    ).toEqual(vb);
    expect(await store.read((tx) => storedItems(tx, id))).toEqual(
      backState.items
        .filter((x) => x.status === "applied" || x.status === "corroborated")
        .map((x) => {
          const w = x.valid[0];
          const iv = isState ? `${w?.from ?? null}..${w?.to ?? null}` : "null..null";
          return `${item(x)} ${x.status} ${iv}`;
        })
        .sort(),
    );
    await store.read(async (tx) => {
      const evs = await readEvents(tx, 1, (await readTail(tx))?.seq ?? 0);
      expect(evs.flatMap((e) => [...e.blocks].filter(([, x]) => x.state === "pending"))).toEqual(
        [],
      );
      const d = await tx.query("SELECT id, state FROM deletions");
      expect(d.rows).toEqual([{ id: DELETION, state: "cancelled" }]);
    });
    await scratch.reset();
    const r2 = await reconcileLog({ live: store, scratch: scratch.store });
    expect(r2.mismatches).toEqual([]);
  };

  it("apply of a deletion gives judge's replay, and replays the same", async () => {
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
        `${isState ? "state" : "event"} ${JSON.stringify({ seen, notYet, unlisted })}\n`,
      );
    expect(seen.samples).toBeGreaterThan(RUNS / 4);
    expect(seen.listed).toBeGreaterThan(0);
    expect(seen.restated).toBeGreaterThan(0);
    expect(seen.cancelled).toBeGreaterThan(RUNS / 4);
  });
});
