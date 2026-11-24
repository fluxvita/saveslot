// A deletion's positions on a real log (09 §5.9 `positions`, §3.5 rule 1): judged scenarios
// are encoded into events and applied into storage as in apply-write.prop.test.ts, then a set of the
// sources their writes cite is deleted. What the sources take away (delete/taken.ts), the replay's
// restatements (judge's `deletionResult`) and the positions (delete/positions.ts) are worked out as
// the `delete` operation will, and held to two checks made without the dependency index:
//
// - nothing left uncleared: once the listed blocks are taken as removed, no data block left in the
//   log rests on what the deletion takes away or restates — none of the deleted sources' blocks,
//   no block of a contribution taken away, no data block naming one in its `deps` (by event and
//   target) or a restated item (by item; a switch's backfill excepted), no `sources/*` carrying one
//   taken away or restated as dropped, no `sources/*` citing a deleted source;
// - nothing cleared for no reason: every block listed is present, and is one of those, or a raw
//   parameter or identifier of an operation citing a deleted source, or the event's own summary.
//
// The second check reads every data block's content itself, nested `deps` and `carried` included,
// so a gap in the index `positionsOf` reads (`block_deps`) shows as a block left uncleared.
//
// In these logs each op's evidence is its own operation number (the record mapping's fixture),
// with no `source.recorded`: a deletion takes away whole operations' contributions. The `and` of
// several sources of one field is pinned in delete/positions.test.ts.

import { appendFileSync } from "node:fs";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  JudgeError,
  type NewEvent,
  positionsOf,
  type ReadTx,
  readCitations,
  readPositionIndex,
  readTail,
  takenAway,
} from "@fluxvita/saveslot-kernel";
import {
  asWritten,
  COMPILED_V1,
  createSlotEvents,
  type Decision,
  deletionReplayForTests,
  eventsOfSteps,
  judged,
  matchPath,
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

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type Obj = Readonly<Record<string, JsonValue>>;
type Ref = { event: number; target: string; k: number };
const refOf = (r: Obj): Ref =>
  "existence" in r
    ? { event: r["event"] as number, target: "existence", k: r["existence"] as number }
    : { event: r["event"] as number, target: r["field"] as string, k: r["k"] as number };

/** Every `deps` entry and `carried` reference in a block's content, at any depth. */
function refsIn(v: JsonValue, out: { deps: Ref[]; carried: Ref[] }) {
  if (Array.isArray(v)) {
    for (const x of v) refsIn(x, out);
    return;
  }
  if (v === null || typeof v !== "object") return;
  for (const [key, x] of Object.entries(v)) {
    if (key === "deps" && Array.isArray(x)) for (const r of x) out.deps.push(refOf(r as Obj));
    else if (key === "carried" && x !== null && typeof x === "object" && !Array.isArray(x))
      out.carried.push(refOf(x as Obj));
    else refsIn(x as JsonValue, out);
  }
}

/** Every present data block of the log, with its event's type and operation. */
async function dataBlocks(tx: ReadTx) {
  const r = await tx.query<{ seq: unknown; op: unknown; type: string; path: string; body: string }>(
    `SELECT e.seq, e.op, e.type, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
     WHERE c.body IS NOT NULL ORDER BY e.seq, c.path COLLATE "C"`,
  );
  return r.rows
    .filter((x) => matchPath(x.type, x.path)?.kind === "data")
    .map((x) => ({
      seq: Number(x.seq),
      op: Number(x.op),
      type: x.type,
      path: x.path,
      body: JSON.parse(x.body) as JsonValue,
    }));
}

/**
 * A sample per table that lists a block for resting on a restated item ("deps on a restated item"),
 * by construction: random samples reach it only a few times in 40 (event tables: two to four), so
 * the guard below would otherwise hold by chance. Each was a generated sample (seed 12345), kept as
 * it was; that it lists such a block is asserted, not assumed.
 * - state: from 2026-11-01, `b` 1 and `c` a; `b` 5 seen at the first; `b` 2 and `c` b seen at the
 *   first; an undo of the third with later writes.
 * - event: `b` 1 and `c` a; a revoke; `b` 2 seen at the first; the existence item taken as that
 *   write; `b` 9 (not explicit); `b` 1 from two sources.
 */
const RESTATING: Record<"state" | "event", { ops: Op[]; decisions: Decision[]; pick: number }> = {
  state: {
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "5", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "2", sources: ["S30"] }, f3: { value: "b", sources: ["S30f3"] } },
      },
      {
        kind: "undo",
        op: 40,
        event: 41,
        target: 30,
        includeLater: true,
        seen: 30,
        acknowledge: ["overwrite"],
      },
    ],
    decisions: [],
    pick: 1218304737,
  } as never,
  event: {
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      { kind: "revoke", op: 20, event: 21, seen: 10 },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        fields: { f2: { value: "2", sources: ["S30"] } },
      },
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_candidate",
        candidates: [31],
        take: 31,
        unit: "existence",
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 10,
        fields: { f2: { value: "9", sources: ["S4"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 20,
        fields: { f2: { value: "1", sources: ["S5", "S6"], explicit: true } },
      },
    ],
    decisions: [],
    pick: 5,
  } as never,
};

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

let main: ReusableStore;
beforeAll(async () => {
  main = await openReusable("saveslot-delete-positions-");
}, 120_000);
afterAll(async () => {
  await main?.close();
}, 120_000);

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  const seen = { samples: 0, skipped: 0, refused: 0, restated: 0, cascaded: 0 };
  /** The blocks listed, by why they must go. */
  const reasons: Record<string, number> = {};

  /** Checks one sample; returns why each block it listed must go, or undefined if it was not checked. */
  const checkSample = async (
    ops: readonly Op[],
    decisions: readonly Decision[],
    pick: number,
  ): Promise<Set<string> | undefined> => {
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
      return undefined;
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
    const decoySeqs = new Set((await run(store, decoy(isState))).events.map((e) => e.seq));
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

    return store.read(async (tx) => {
      const blocks = await dataBlocks(tx);
      // The sources the row's writes cite; one or two of them deleted.
      const cited = [
        ...new Set(
          blocks.flatMap((b) =>
            b.path.startsWith("sources/") && Array.isArray(b.body)
              ? (b.body as Obj[]).flatMap((e) =>
                  typeof e["source"] === "number" ? [e["source"] as number] : [],
                )
              : [],
          ),
        ),
      ]
        .filter((s) => s !== DECOY_SOURCE)
        .sort((a, b) => a - b);
      if (cited.length === 0) {
        seen.skipped++;
        return undefined;
      }
      const first = cited[pick % cited.length] as number;
      const second = cited[(pick >> 3) % cited.length] as number;
      const sources = [...new Set(pick % 2 === 0 ? [first] : [first, second])];
      const srcSet = new Set(sources);

      const bases = await readCitations(tx, SLOT, sources);
      const deleted = takenAway(bases, srcSet);
      let restated: ReturnType<typeof deletionReplayForTests>["replay"]["restated"];
      try {
        restated = deletionReplayForTests(
          shape(schema),
          steps.map((s) => s.judgement.record),
          deleted,
        ).replay.restated;
      } catch (e) {
        // A form the replay refuses (`not_implemented`): not this check's concern.
        if (e instanceof JudgeError) {
          seen.refused++;
          return undefined;
        }
        throw e;
      }
      seen.samples++;
      if (restated.length > 0) seen.restated++;
      const self = ((await readTail(tx))?.seq ?? 0) + 1;
      const index = await readPositionIndex(tx, {
        slot: SLOT,
        sources,
        bases,
        deleted,
        restated,
      });
      const positions = positionsOf({ sources, deleted, restated, index, self });
      const listed = new Set(positions.map((p) => `${p.seq} ${p.path}`));

      const key = (e: number, t: string) => `${e}/${t}`;
      const item = (r: Ref) => `${r.event}/${r.target}/${r.k}`;
      const restatedItems = new Set(
        restated.map((r) => item({ event: r.item.event, target: r.item.target, k: r.item.k })),
      );
      const dropped = new Set(
        restated
          .filter((r) => r.status === "dropped")
          .map((r) => item({ event: r.item.event, target: r.item.target, k: r.item.k })),
      );
      const citingOps = new Set(
        bases
          .filter((b) =>
            [...[...b.values.values()].flat(), ...(b.valid ?? []), ...b.opSources].some((s) =>
              srcSet.has(s),
            ),
          )
          .map((b) => b.op),
      );

      /** Why a block must go, by its own content; none: it may stay. */
      // What each operation's base writes cite, read from their blocks: by operation, by op and
      // field (`sources/<f>/*`), by op (`valid_sources`); the sources recorded in each operation.
      const cites = await tx.query<{ seq: unknown; op: unknown; path: string; body: string }>(
        `SELECT e.seq, e.op, c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
         WHERE e.type IN ('write.base', 'source.recorded') AND c.body IS NOT NULL
           AND (c.path IN ('target', 'valid_sources', 'op_sources') OR c.path LIKE 'sources/%')`,
      );
      const indexOf = new Map<number, number>();
      for (const x of cites.rows) {
        if (x.path !== "target") continue;
        const t = JSON.parse(x.body) as Obj;
        if (typeof t["op_index"] === "number") indexOf.set(Number(x.seq), t["op_index"] as number);
      }
      const opCited = new Map<number, Set<number>>();
      const opIndexCited = new Map<string, Set<number>>();
      const add = (m: Map<string | number, Set<number>>, k: string | number, v: number) =>
        m.set(k, (m.get(k) ?? new Set()).add(v));
      for (const x of cites.rows) {
        const op = Number(x.op);
        const i = indexOf.get(Number(x.seq));
        const body = JSON.parse(x.body) as JsonValue;
        if (x.path === "target") {
          // A source recorded in the operation.
          if ((body as Obj)["source_id"] !== undefined) add(opCited as never, op, Number(x.seq));
          continue;
        }
        const ss =
          x.path === "valid_sources" || x.path === "op_sources"
            ? (body as number[])
            : (body as Obj[]).flatMap((e) =>
                typeof e["source"] === "number" ? [e["source"] as number] : [],
              );
        for (const v of ss) {
          add(opCited as never, op, v);
          if (i === undefined) continue;
          if (x.path === "valid_sources") add(opIndexCited as never, `${op}/${i}/valid`, v);
          const f = /^sources\/(f\d+)\//.exec(x.path);
          if (f !== null) add(opIndexCited as never, `${op}/${i}/set/${f[1]}`, v);
        }
      }
      const hits = (xs: Set<number> | undefined) => [...(xs ?? [])].some((v) => srcSet.has(v));

      const mustGo = (b: (typeof blocks)[number]): string | undefined => {
        // A head event's request identifiers, an operation's raw values and interval (§5.1, §5.7).
        if (
          b.seq === b.op &&
          ["task", "request_key", "idempotency"].includes(b.path) &&
          hits(opCited.get(b.op))
        )
          return "an identifier of an operation citing a deleted source";
        const set = /^ops\/(\d+)\/set\/(f\d+)$/.exec(b.path);
        if (
          b.type === "write.head" &&
          set !== null &&
          hits(opIndexCited.get(`${b.op}/${set[1]}/set/${set[2]}`))
        )
          return "a raw value from a deleted source";
        const valid = /^ops\/(\d+)\/valid$/.exec(b.path);
        if (
          b.type === "write.head" &&
          valid !== null &&
          hits(opIndexCited.get(`${b.op}/${valid[1]}/valid`))
        )
          return "an interval from a deleted source";
        if (srcSet.has(b.seq) && ["text", "file", "request", "stated_at"].includes(b.path))
          return "a deleted source's block";
        const own = /^(fields|sources|literal|span)\/(f\d+|existence)\/\d+$/.exec(b.path);
        if (b.type === "write.base" && own !== null && deleted.has(key(b.seq, own[2] as string)))
          return "a block of a contribution taken away";
        const refs = { deps: [] as Ref[], carried: [] as Ref[] };
        refsIn(b.body, refs);
        const backfill = b.path.startsWith("backfill/");
        if (refs.deps.some((r) => deleted.has(key(r.event, r.target))))
          return "deps on a contribution taken away";
        if (!backfill && refs.deps.some((r) => restatedItems.has(item(r))))
          return "deps on a restated item";
        if (b.path.startsWith("sources/")) {
          if (refs.carried.some((r) => deleted.has(key(r.event, r.target)) || dropped.has(item(r))))
            return "carrying a contribution taken away or dropped";
          if (
            Array.isArray(b.body) &&
            (b.body as Obj[]).some(
              (e) => typeof e["source"] === "number" && srcSet.has(e["source"] as number),
            )
          )
            return "citing a deleted source";
        } else if (
          refs.carried.some(
            (r) => deleted.has(key(r.event, r.target)) || restatedItems.has(item(r)),
          )
        )
          return "carrying a contribution taken away or restated";
        return undefined;
      };

      // Nothing left uncleared.
      const left = blocks
        .filter((b) => !listed.has(`${b.seq} ${b.path}`))
        .flatMap((b) => {
          const why = mustGo(b);
          return why === undefined ? [] : [`${b.seq} ${b.path}: ${why}`];
        });
      expect({ sources, left }).toEqual({ sources, left: [] });

      // Nothing cleared for no reason.
      const byKey = new Map(blocks.map((b) => [`${b.seq} ${b.path}`, b]));
      const unexplained = positions.flatMap((p) => {
        const k = `${p.seq} ${p.path}`;
        if (p.seq === self) return p.path === "summary" ? [] : [`${k}: of the event itself`];
        const b = byKey.get(k);
        if (b === undefined) return [`${k}: not a present data block`];
        if (mustGo(b) !== undefined) return [];
        // A carried item's field goes with its sources block.
        const field = /^fields\/(f\d+)\/(\d+)$/.exec(p.path);
        if (field !== null && listed.has(`${p.seq} sources/${field[1]}/${field[2]}`)) {
          const s = byKey.get(`${p.seq} sources/${field[1]}/${field[2]}`);
          if (s !== undefined && mustGo(s) !== undefined) return [];
        }
        // A raw parameter or identifier of an operation citing a deleted source.
        if (b.type === "write.head" && (citingOps.has(b.seq) || srcSet.has(b.seq))) return [];
        return [`${k}: no reason`];
      });
      expect({ sources, unexplained }).toEqual({ sources, unexplained: [] });
      const mine = new Set<string>();
      for (const p of positions) {
        const b = byKey.get(`${p.seq} ${p.path}`);
        const why =
          b === undefined ? (p.seq === self ? "summary" : "other") : (mustGo(b) ?? "paired");
        reasons[why] = (reasons[why] ?? 0) + 1;
        mine.add(why);
      }
      // A cascade: a block listed by what it rests on (by deps or what it carries), beyond the
      // contributions' own blocks and the operations' parameters.
      const cascade = positions.some((p) => {
        const b = byKey.get(`${p.seq} ${p.path}`);
        const own = /^(fields|sources|literal|span)\/(f\d+|existence)\/\d+$/.exec(p.path);
        return (
          b !== undefined &&
          b.type !== "write.head" &&
          !(own !== null && deleted.has(key(p.seq, own[2] as string)))
        );
      });
      if (cascade) seen.cascaded++;
      // Nothing of the decoy row.
      expect(positions.filter((p) => decoySeqs.has(p.seq))).toEqual([]);
      return mine;
    });
  };

  it("the positions leave nothing resting on what a deletion takes away or restates, and list nothing else", async () => {
    // The sample that must be there, made so: it reaches the check and lists a block resting on a
    // restated item.
    const fixed = RESTATING[isState ? "state" : "event"];
    const why = await checkSample(fixed.ops, fixed.decisions, fixed.pick);
    expect({ restating: why?.has("deps on a restated item") ?? false }).toEqual({
      restating: true,
    });
    await fc.assert(
      fc.asyncProperty(scenario(isState), fc.nat(), async ({ ops, decisions }, pick) => {
        await checkSample(ops, decisions, pick);
      }),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    // Guards against a generator gone degenerate: most samples reach the check, and some of them
    // restate items and cascade beyond the deleted contributions' own blocks.
    expect(seen.samples).toBeGreaterThan(RUNS / 3);
    expect(seen.restated).toBeGreaterThan(0);
    expect(seen.cascaded).toBeGreaterThan(0);
    // Each kind of block these logs can have is listed in some sample (the fixture's logs have
    // no `source.recorded`, request identifiers, premises, literal checks, deletion events or
    // switches: those kinds are pinned by delete/positions.test.ts).
    for (const why of [
      "a block of a contribution taken away",
      "a raw value from a deleted source",
      "deps on a contribution taken away",
      "deps on a restated item",
      "carrying a contribution taken away or dropped",
      ...(isState ? ["an interval from a deleted source"] : []),
    ]) {
      expect({ why, listed: (reasons[why] ?? 0) > 0 }).toEqual({ why, listed: true });
    }
    if (process.env["POSITIONS_COUNTS"] !== undefined)
      appendFileSync(
        process.env["POSITIONS_COUNTS"],
        `${isState ? "state" : "event"} ${JSON.stringify(reasons)}\n`,
      );
  });
});
