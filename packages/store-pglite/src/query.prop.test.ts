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
// The view itself equals the reference evaluator's at each step (apply-write.prop checks it).

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  type NewEvent,
  query,
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
import type { TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

vi.setConfig({ testTimeout: 300_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 270_000, markInterruptAsFailure: true });

const RUNS = propRuns(30);
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
    const op = await appendOperation(tx, { actor: USER as never, now: nextNow(), events });
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
    const reach = (k: string) => {
      reached[k] = (reached[k] ?? 0) + 1;
    };
    await fc.assert(
      fc.asyncProperty(
        scenario(isState),
        extra,
        fc.array(read, { minLength: 1, maxLength: 3 }),
        async ({ ops, decisions: some }, more, reads) => {
          seen.samples++;
          const { steps } = judged(schema, ops.map(asInThisPhase), [...some, ...more]);
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
          for (const [k, evs] of perStep.entries()) {
            const head = evs[0]?.seq as number;
            for (let tail = (await store.read(readTail))?.seq ?? 0; tail < head - 1; tail++)
              await run(store, [filler]);
            await run(
              store,
              evs.map((e) => ({ type: e.type as never, slot: SLOT, blocks: e.blocks as never })),
            );
            const v = JSON.parse(JSON.stringify(view((steps[k] as (typeof steps)[number]).state)));

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
            for (const r of reads) {
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
        },
      ),
      { numRuns: RUNS },
    );
    expect(seen.run / seen.samples).toBeGreaterThanOrEqual(0.8);
    if (process.env["JUDGE_STATS"]) console.log(JSON.stringify({ ...seen, reached }));
    const needed = isState
      ? [
          "valid_at",
          "at",
          "during",
          "valid_at: nothing",
          "during: nothing",
          "several segments",
          "inner gap",
        ]
      : ["row", "revoked row"];
    for (const n of needed)
      expect({ n, reached: (reached[n] ?? 0) > 0 }).toEqual({ n, reached: true });
  });
});
