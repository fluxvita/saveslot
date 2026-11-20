// `query` on PGlite against judge's view (02-architecture §11 «测试矩阵»; 04-contract §4, §10
// `query`; 05-time «查询»). The judged scenarios of the write comparison (apply-write.prop) are
// applied operation by operation; after each step `query` must give what judge's view of the row
// or entity gives:
// - state tables: the entity's segments where it has a value (pieces of the same values run
//   together), at a point (`valid_at`, or the day of `at`), over an interval (every segment it
//   meets; merged by the fields read when they read the same and carry the same marks; clipped
//   when asked), nothing in a gap;
// - event and timeless tables: the row when it exists, with its values; a revoked row only with
//   `include_revoked`, marked revoked.
// At the end, `history` as of each step's operation must give that step's view (05-time «记录时间
// 一侧»: as of S, every operation numbered up to S in effect). The view itself equals the reference
// evaluator's at each step (apply-write.prop checks it).

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  type NewEvent,
  query,
  readTail,
  view,
} from "@fluxvita/saveslot-kernel";
import {
  asWritten,
  COMPILED_V1,
  createSlotEvents,
  type Decision,
  eventsOfSteps,
  judged,
  SLOT,
  scenario,
  shape,
  withConfirmations,
} from "@fluxvita/saveslot-kernel/testing";
import type { TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

vi.setConfig({ testTimeout: 300_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 270_000, markInterruptAsFailure: true });

const RUNS = propRuns(12);
/** `PROP_SEED` fixes the seed. */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const FILLER = `e_${"9".repeat(26)}`;
const DECOY = { state: `e_${"5".repeat(26)}`, event: `r_${"5".repeat(26)}` };

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
    // A decision confirms the item's entries as they are (09 §5.8): the hash the pipeline gives.
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: nextNow(),
      events: await withConfirmations(tx, events),
    });
    await applyEvents(tx, eventsOf(op));
    return op;
  });

/** Another row or entity of the same table: the query must give it apart. */
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
const filler: NewEvent = {
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: CTX,
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t2", entity: FILLER, intent: "update" },
  },
};

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

/** Points around the scenarios' days (2026-11-01 … 11-11, odd days; 10-01 for open starts). */
const POINTS = [
  "2026-09-30",
  "2026-10-01",
  "2026-10-20",
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-12-01",
];
const read = fc.record({
  kind: fc.constantFrom("valid_at", "at", "during", "during", "during"),
  a: fc.nat({ max: POINTS.length - 1 }),
  b: fc.option(fc.nat({ max: POINTS.length - 1 }), { nil: undefined, freq: 4 }),
  fields: fc.constantFrom("all", "b", "c"),
  clip: fc.boolean(),
  coalesce: fc.boolean(),
});

type Iv = { from: string | null; to: string | null };
type Seg = { from: string; to: string | null; values: Record<string, string | null> };
type Stretch = { valid: readonly Iv[]; value: unknown };

const before = (a: string | null, b: string | null) =>
  a === null ? b !== null : b !== null && a < b;

/** The entity's segments by judge's view: where it has a value, equal pieces run together. */
function segmentsOfView(v: {
  gaps: readonly Iv[];
  fields: Readonly<Record<string, readonly Stretch[] | undefined>>;
}): Seg[] {
  const points = new Set<string>();
  const all = [
    ...v.gaps,
    ...Object.values(v.fields).flatMap((s) => (s ?? []).flatMap((x) => x.valid)),
  ];
  for (const x of all) {
    if (x.from !== null) points.add(x.from);
    if (x.to !== null) points.add(x.to);
  }
  const sorted = [...points].sort();
  const pieces: Iv[] = [];
  let at: string | null = null;
  for (const p of sorted) {
    pieces.push({ from: at, to: p });
    at = p;
  }
  pieces.push({ from: at, to: null });
  const inside = (piece: Iv, x: Iv) =>
    !before(piece.from, x.from) && (x.to === null || (piece.to !== null && piece.to <= x.to));
  const valueAt = (f: string, piece: Iv) =>
    ((v.fields[f] ?? []).find((s) => s.valid.some((x) => inside(piece, x)))?.value ?? null) as
      | string
      | null;
  const out: Seg[] = [];
  for (const piece of pieces) {
    if (v.gaps.some((g) => inside(piece, g))) continue;
    if (piece.from === null) throw new Error("a value without a start");
    const values = { b: valueAt("f2", piece), c: valueAt("f3", piece) };
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.to === piece.from &&
      JSON.stringify(last.values) === JSON.stringify(values)
    )
      last.to = piece.to;
    else out.push({ from: piece.from, to: piece.to, values });
  }
  return out;
}

const meets = (s: Seg, a: string, b: string | null) =>
  (s.to === null || s.to > a) && (b === null || s.from < b);
const contains = (s: Seg, p: string) => s.from <= p && (s.to === null || p < s.to);

/**
 * Fixed scenarios every run begins with, so what must be covered always is. State: a value from
 * 10-01 on, revoked over [11-01, 11-07), written again over [11-03, 11-05): several segments and
 * inner gaps. Timeless: a row written, then revoked.
 */
const EXAMPLES = {
  state: {
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: {
          f2: { value: "1", sources: ["S10"] },
          f3: { value: "a", sources: ["S10"] },
        },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-07" },
        },
        validSources: ["S20"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: {
          f2: { value: "2", sources: ["S30"] },
          f3: { value: "b", sources: ["S30"] },
        },
      },
    ],
    decisions: [],
  },
  timeless: {
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
    ],
    decisions: [],
  },
};
/**
 * A row or entity the scenario's only write never put in effect (stale on an empty target, so it
 * left no cell): history knows no such target, as_of is not_found (04-contract §10 `history`).
 */
const UNWRITTEN = {
  state: {
    ops: [
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f3: { value: "1", sources: ["S4"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ],
    decisions: [],
  },
  timeless: {
    ops: [
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        fields: { f3: { value: "1", sources: ["S4"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ],
    decisions: [],
  },
};
const EXAMPLE_READS = [
  { kind: "valid_at", a: 4, b: undefined, fields: "all", clip: false, coalesce: false },
];

describe.each([
  ["state", STATE, true],
  ["timeless", EVENT, false],
] as const)("%s table", (_, schema: TableSchema, isState) => {
  let main: ReusableStore;
  beforeAll(async () => {
    main = await openReusable("saveslot-query-prop-");
  }, 120_000);
  afterAll(async () => {
    await main?.close();
  }, 120_000);

  it("query gives judge's view at each step", async () => {
    // Samples, and those run (a scenario whose events would collide in seq is not).
    const seen = { samples: 0, run: 0 };
    const reached: Record<string, number> = {};
    // Samples that reached each case at least once.
    const bySample: Record<string, number> = {};
    let thisSample = new Set<string>();
    const reach = (k: string) => {
      reached[k] = (reached[k] ?? 0) + 1;
      if (!thisSample.has(k)) bySample[k] = (bySample[k] ?? 0) + 1;
      thisSample.add(k);
    };
    await fc.assert(
      fc.asyncProperty(
        scenario(isState),
        extra,
        fc.array(read, { minLength: 1, maxLength: 3 }),
        async ({ ops, decisions: some }, more, reads) => {
          seen.samples++;
          thisSample = new Set();
          const { steps } = judged(schema, ops.map(asWritten), [...some, ...more]);
          const perStep = eventsOfSteps(
            {
              table: (isState ? "t2" : "t1") as never,
              target: isState ? { entity: ENTITY as never } : { row: ROW as never },
              shape: shape(schema),
              granularity: "date",
            },
            steps,
            (after, n) => after + 1 + n,
          );
          if (
            perStep.some(
              (evs, k) => (evs.at(-1)?.seq ?? 0) >= (perStep[k + 1]?.[0]?.seq ?? Infinity),
            )
          )
            return;
          seen.run++;
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
          const q = (params: Record<string, unknown>) =>
            query(
              store,
              createOpsContext({
                tenant: TENANT,
                actor: USER,
                trigger: null,
                task: null,
                visibility: { kind: "all" },
                idempotency_key_window: 0,
                idempotency_window: 0,
                now: "2026-11-10T04:00:00.000Z",
                confirmation: null,
              }),
              { table: isState ? "entities" : "rows", limit: 200, ...params },
            );
          const opsSeen: number[] = [];
          // What query gave at each step, revoked rows included: as_of that step gives the same.
          type Seen = {
            from?: string;
            to?: string | null;
            ver: string;
            values: unknown;
            marks: unknown;
          };
          const seenAt: Seen[][] = [];
          // Marks the record keeps; disputed and awaiting are pending items at the time of reading.
          const kept = (m: Record<string, unknown> | undefined) => {
            const o = Object.fromEntries(
              Object.entries(m ?? {}).filter(([k]) => k === "revoked" || k === "corrected"),
            );
            return Object.keys(o).length === 0 ? null : o;
          };
          const seenOf = (rows: Awaited<ReturnType<typeof q>>["rows"]): Seen[] =>
            rows
              .filter((x) => (isState ? x.entity === ENTITY : x.row === ROW))
              .map((x) => ({
                ...(isState ? { from: x.valid_from, to: x.valid_to } : {}),
                ver: (x.ver as string).replace(/^v/, "h"),
                values: x.values,
                marks: kept(x.marks as never),
              }));
          for (const [k, evs] of perStep.entries()) {
            opsSeen.push(evs[0]?.seq as number);
            const head = evs[0]?.seq as number;
            for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++)
              await run(store, [filler]);
            await run(
              store,
              evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
            );
            const v = JSON.parse(JSON.stringify(view((steps[k] as (typeof steps)[number]).state)));
            seenAt.push(
              seenOf(
                (
                  await q(
                    isState
                      ? { valid_during: ["2026-09-01", null], coalesce: false }
                      : { include_revoked: true },
                  )
                ).rows,
              ),
            );

            if (!isState) {
              const own = (r: Awaited<ReturnType<typeof q>>) => r.rows.filter((x) => x.row === ROW);
              const shown = own(await q({}));
              const value = (f: string) => (v.fields[f]?.[0]?.value ?? null) as string | null;
              expect({ step: k, rows: shown.map((x) => x.values) }).toEqual({
                step: k,
                rows: v.exists ? [{ b: value("f2"), c: value("f3") }] : [],
              });
              const withRevoked = own(await q({ include_revoked: true }));
              expect(withRevoked.length).toBeGreaterThanOrEqual(shown.length);
              for (const r of withRevoked) {
                expect({ step: k, revoked: r.marks?.revoked !== undefined }).toEqual({
                  step: k,
                  revoked: !v.exists,
                });
                if (!v.exists) reach("revoked row");
              }
              if (v.exists) reach("row");
              continue;
            }

            const segs = segmentsOfView(v);
            if (segs.length > 1) reach("several segments");
            if (v.gaps.length > 1) reach("inner gap");
            // Besides the random reads, every step reads each way at the first point (before every
            // scenario's days: nothing) and at its first segment's start (something), so neither
            // case rests on what the random reads pick.
            const fixed = (a: number) =>
              (["valid_at", "at", "during"] as const).map((kind) => ({
                kind,
                a,
                b: undefined,
                fields: "all" as const,
                clip: false,
                coalesce: false,
              }));
            const start = segs[0] === undefined ? undefined : POINTS.indexOf(segs[0].from);
            expect({ step: k, start }).not.toEqual({ step: k, start: -1 });
            for (const r of [...reads, ...fixed(0), ...(start === undefined ? [] : fixed(start))]) {
              const a = POINTS[r.a] as string;
              const pick = r.fields === "all" ? ["b", "c"] : [r.fields];
              const proj = (s: Seg) => ({
                from: s.from,
                to: s.to,
                values: Object.fromEntries(pick.map((f) => [f, s.values[f] ?? null])),
              });
              const params: Record<string, unknown> =
                r.fields === "all" ? {} : { fields: [r.fields] };
              let expected: ReturnType<typeof proj>[];
              if (r.kind === "valid_at" || r.kind === "at") {
                // The first point: a day before every scenario's (it falls in no segment).
                const p = r.a === 0 ? "2026-09-01" : a;
                expected = segs.filter((s) => contains(s, p)).map(proj);
                if (r.kind === "valid_at") params["valid_at"] = p;
                // 04:00Z is noon of the same day in the slot's zone.
                else params["at"] = `${p}T04:00:00Z`;
              } else {
                const bIdx = r.b;
                // The first point: an interval before every scenario's days (it meets nothing).
                const da = r.a === 0 ? "2026-09-01" : a;
                const b =
                  r.a === 0
                    ? "2026-09-30"
                    : bIdx === undefined || bIdx <= r.a
                      ? null
                      : (POINTS[bIdx] as string);
                params["valid_during"] = [da, b];
                params["coalesce"] = r.coalesce;
                params["clip"] = r.clip;
                // 04-contract §4: merge every segment of the entity by the values read (whatever
                // the marks), then keep what meets the interval, then clip.
                let all = segs.map(proj);
                if (r.coalesce && r.fields !== "all") {
                  const m: typeof all = [];
                  for (const s of all) {
                    const last = m.at(-1);
                    if (
                      last !== undefined &&
                      last.to === s.from &&
                      JSON.stringify(last.values) === JSON.stringify(s.values)
                    )
                      last.to = s.to;
                    else m.push({ ...s });
                  }
                  if (m.length < all.length) reach("merged by the fields read");
                  all = m;
                }
                let over = all.filter((s) => meets(s as never, da, b));
                if (r.clip) {
                  over = over.map((s) => ({
                    ...s,
                    from: [s.from, da].sort()[1] as string,
                    to: b === null ? s.to : s.to === null || s.to > b ? b : s.to,
                  }));
                }
                expected = over;
              }
              const got = (await q(params)).rows
                .filter((x) => x.entity === ENTITY)
                .map((x) => ({ from: x.valid_from, to: x.valid_to, values: x.values }));
              expect({ step: k, params, got }).toEqual({ step: k, params, got: expected });
              reach(expected.length === 0 ? `${r.kind}: nothing` : r.kind);
            }
          }
          // history as_of each operation gives that step's view (05-time «记录时间一侧»).
          const ctx = createOpsContext({
            tenant: TENANT,
            actor: USER,
            trigger: null,
            task: null,
            visibility: { kind: "all" },
            idempotency_key_window: 0,
            idempotency_window: 0,
            now: "2026-11-10T04:00:00.000Z",
            confirmation: null,
          });
          // A target no write ever put in effect has no cell in the version table: history knows no
          // such target, so as_of at every step is not_found (and nothing else is compared).
          const versions = isState ? "t_t2_v1__ver" : "t_t1_v1__ver";
          const known = (
            await store.read((tx) =>
              tx.query(`SELECT 1 FROM ${versions} WHERE row_id = $1 LIMIT 1`, [
                isState ? ENTITY : ROW,
              ]),
            )
          ).rows.length;
          if (known === 0) {
            const which = isState ? "entity" : "row";
            for (const op of opsSeen) {
              const e = await history(store, ctx, {
                table: isState ? "entities" : "rows",
                [which]: isState ? ENTITY : ROW,
                mode: "as_of",
                as_of: op,
              }).then(
                () => undefined,
                (x: { code?: string; detail?: unknown }) => ({ code: x.code, detail: x.detail }),
              );
              expect({ op, e }).toEqual({
                op,
                e: { code: "not_found", detail: { reason: which, param: which } },
              });
            }
            reach("as_of not_found");
            return;
          }
          for (const [k, op] of opsSeen.entries()) {
            const v = JSON.parse(JSON.stringify(view((steps[k] as (typeof steps)[number]).state)));
            type AsOfRow = {
              values: Record<string, unknown>;
              valid_from?: string;
              valid_to?: string | null;
              ver: string;
              marks?: { revoked?: unknown };
            };
            const asOf = async (extra: Record<string, unknown> = {}) =>
              (
                (await history(store, ctx, {
                  table: isState ? "entities" : "rows",
                  ...(isState ? { entity: ENTITY } : { row: ROW }),
                  mode: "as_of",
                  as_of: op,
                  limit: 200,
                  ...extra,
                })) as unknown as { rows: AsOfRow[] }
              ).rows;
            const r = { rows: await asOf() };
            const asSeen = (rows: AsOfRow[]): Seen[] =>
              rows.map((x) => ({
                ...(isState ? { from: x.valid_from, to: x.valid_to } : {}),
                ver: x.ver,
                values: x.values,
                marks: kept(x.marks as never),
              }));
            // Versions, values and marks, revoked rows included, as query gave them then.
            expect({ step: k, as_of: asSeen(r.rows) }).toEqual({ step: k, as_of: seenAt[k] });
            if (seenAt[k]?.some((x) => x.marks !== null)) reach("as_of marks");
            if (isState) {
              // At a business point: the segment holding it, a segment's end excluded.
              const a = POINTS[k % POINTS.length] as string;
              expect({ step: k, valid_at: a, as_of: asSeen(await asOf({ valid_at: a })) }).toEqual({
                step: k,
                valid_at: a,
                as_of: (seenAt[k] ?? []).filter((x) =>
                  contains({ from: x.from, to: x.to } as never, a),
                ),
              });
            }
            if (isState) {
              const got = r.rows.map((x) => ({
                from: x.valid_from,
                to: x.valid_to,
                values: x.values,
              }));
              expect({ step: k, as_of: got }).toEqual({ step: k, as_of: segmentsOfView(v) });
              reach("as_of");
            } else {
              const value = (f: string) => (v.fields[f]?.[0]?.value ?? null) as string | null;
              const live = r.rows
                .filter((x) => x.marks?.revoked === undefined)
                .map((x) => x.values);
              expect({ step: k, as_of: live }).toEqual({
                step: k,
                as_of: v.exists ? [{ b: value("f2"), c: value("f3") }] : [],
              });
              reach(v.exists ? "as_of row" : "as_of none");
            }
          }
        },
      ),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        examples: [
          [EXAMPLES[isState ? "state" : "timeless"], [], EXAMPLE_READS] as never,
          [UNWRITTEN[isState ? "state" : "timeless"], [], EXAMPLE_READS] as never,
        ],
      },
    );
    // The examples run; random samples are seldom skipped (events colliding in seq).
    expect(seen.run / seen.samples).toBeGreaterThanOrEqual(0.5);
    if (process.env["JUDGE_STATS"]) console.log(JSON.stringify({ ...seen, reached, bySample }));
    const needed = isState
      ? [
          "valid_at",
          "at",
          "during",
          "valid_at: nothing",
          "during: nothing",
          "several segments",
          "inner gap",
          "as_of not_found",
        ]
      : ["row", "revoked row", "as_of marks", "as_of not_found"];
    for (const n of needed)
      expect({ n, reached: (reached[n] ?? 0) > 0 }).toEqual({ n, reached: true });
  });
});
