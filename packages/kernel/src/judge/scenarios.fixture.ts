// Scenarios of the comparison of `judge` with the reference evaluator (reference.prop.test.ts),
// shared with the tests that need judged logs (the record round trip of `write`): random logs,
// skeletons reaching chosen situations, people's decisions and undos inserted as the log so far
// makes them possible, judged op by op with refused ops left out.

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import type { Op, TableSchema, WriteOp } from "@fluxvita/saveslot-reference";
import { DAYS, type Step, stale, step, toOps } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { canonical, type IntervalSet, meet } from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp } from "./judge.ts";
import type { JudgeInput, Judgement, TableShape, Target } from "./model.ts";
import { contributionKey } from "./replay-deletion.ts";
import type { RowState } from "./state.ts";
import { versionsOf } from "./versions.fixture.ts";

const NOW = "2026-11-05";

export const shape = (s: TableSchema): TableShape => ({
  kind: s.kind,
  fields: ["f2", "f3"],
  valued: s.required,
  required: s.required,
  groups: s.groups ?? [],
});

/**
 * An op inserted after another, as the log so far makes it possible: a person's decision on the
 * `pick`-th open pending item (on every open candidate of its unit: the whole item); an undo of the
 * `pick`-th operation in the log, whatever it was (a revoke, a revert, a confirmation, the first
 * creation; with `focus`, among the operations that are not plain writes), with `include_later`,
 * `acknowledge` and an explicit `ver` by `flag`; on event tables, a revoke.
 */
export interface Decision {
  readonly after: number;
  readonly pick: number;
  readonly kind: "confirm" | "reject" | "keep" | "previous" | "take" | "undo" | "revoke";
  readonly flag: number;
  readonly focus: boolean;
}

const decision: fc.Arbitrary<Decision> = fc.record({
  after: fc.nat(),
  pick: fc.nat(),
  kind: fc.constantFrom<Decision["kind"]>(
    "confirm",
    "confirm",
    "reject",
    "keep",
    "previous",
    "take",
    "take",
    "undo",
    "undo",
    "revoke",
  ),
  flag: fc.nat({ max: 7 }),
  focus: fc.boolean(),
});

/** Inserted ops take these offsets after the op they follow; their events are the next number. */
const SLOTS = [3, 5, 7];

/** A current write without `acknowledge`: high impact whenever it erases a change point. */
const overwrite: fc.Arbitrary<Step> = fc.record({
  t: fc.constant("write" as const),
  f: fc.constant<FieldId>("f2"),
  v: fc.constantFrom("1", "2", "3"),
  src: fc.constant(["S1"]),
  from: fc.nat({ max: 4 }),
  to: fc.oneof(fc.constant<"open">("open"), fc.nat({ max: 5 })),
  lag: fc.constant(0),
  explicit: fc.constant(false),
  ack: fc.constant(false),
});

const writeStep = fc.oneof(
  { weight: 4, arbitrary: step },
  { weight: 1, arbitrary: stale },
  { weight: 1, arbitrary: overwrite },
);

const day = (i: number) => DAYS[Math.min(i, DAYS.length - 1)] as BizPoint;
const span = (from: number, to: number | null) => ({
  from: { mode: "given" as const, value: day(from) },
  to: to === null ? { mode: "open" as const } : { mode: "given" as const, value: day(to) },
});
const put = (
  op: number,
  seen: number,
  v: string,
  valid: ReturnType<typeof span> | undefined,
  ack = true,
): WriteOp => ({
  kind: "write",
  op,
  event: op + 1,
  seen,
  ...(valid !== undefined ? { valid } : {}),
  fields: { f2: { value: v, sources: [`S${op}`] } },
  ...(ack ? { acknowledge: ["overwrite"] as const } : {}),
});

/**
 * An include_later undo of a write that a later write overlaps: high impact ④, then often a
 * decision on it; or its confirmation and an undo of the revert so put into effect, by the
 * proposal's operation or the confirmation's (09 §5.7); or its rejection. Random steps follow.
 */
const laterSkeleton = (state: boolean) =>
  fc
    .tuple(
      fc.nat({ max: 1 }),
      fc.nat({ max: 1 }),
      fc.boolean(),
      fc.constantFrom<null | 40 | 50 | "reject">(null, null, 40, 50, "reject"),
      fc.array(writeStep, { maxLength: 3 }),
    )
    .map(([a, b, ack, undoConfirmed, tail]) => {
      const sp = (f: number, t: number | null) => (state ? span(f, t) : undefined);
      const head: Op[] = [
        {
          ...put(
            10,
            0,
            "1",
            state
              ? { ...span(0, null), from: { mode: "given", value: "2026-10-01" as BizPoint } }
              : undefined,
          ),
          seen: 0,
        },
        put(20, 10, "2", sp(a, a + 2)),
        put(30, 20, "3", sp(a + 1 + b, a + 4 + b)),
        {
          kind: "undo",
          op: 40,
          event: 41,
          target: 20,
          includeLater: true,
          ...(ack ? { seen: 30, acknowledge: ["overwrite"] as const } : {}),
        },
        ...(undoConfirmed === null
          ? []
          : undoConfirmed === "reject"
            ? [{ kind: "reject" as const, op: 50, event: 50, target: 41 }]
            : [
                { kind: "confirm" as const, op: 50, event: 51, target: 41 },
                {
                  kind: "undo" as const,
                  op: 60,
                  event: 61,
                  target: undoConfirmed,
                  ...(ack ? { seen: 50, acknowledge: ["overwrite"] as const } : {}),
                },
              ]),
      ];
      return toOps(tail, state, head);
    });

/**
 * State tables: a revoked stretch, a fill in it undone (an `uncovered` write-back), the revoke
 * undone (a restore), a write in the restored stretch, and the undo of the revoke undone (a
 * write-back revoke that hides it: ④). Random steps follow.
 */
const holeSkeleton = fc
  .tuple(fc.nat({ max: 1 }), fc.boolean(), fc.array(writeStep, { maxLength: 3 }))
  .map(([a, ack, tail]) => {
    const head: Op[] = [
      {
        ...put(10, 0, "1", {
          ...span(0, null),
          from: { mode: "given", value: "2026-10-01" as BizPoint },
        }),
        seen: 0,
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: span(a, a + 3),
        validSources: ["S20"],
      },
      put(30, 20, "5", span(a + 1, a + 2)),
      { kind: "undo", op: 40, event: 41, target: 30, seen: 30, acknowledge: ["overwrite"] },
      { kind: "undo", op: 50, event: 51, target: 20, seen: 40, acknowledge: ["overwrite"] },
      put(60, 50, "6", span(a, a + 1)),
      {
        kind: "undo",
        op: 70,
        event: 71,
        target: 50,
        ...(ack ? { seen: 60, acknowledge: ["overwrite"] as const } : {}),
      },
    ];
    return toOps(tail, true, head);
  });

/**
 * Two candidates of one item with different versions: #21 and #31 change f2; #41 (ver 10) and #51
 * (ver 20) conflict with them. A take_previous on both goes back to the earliest version (01-objects
 * «各处理方式的执行语义»: the merge base). Random steps follow.
 */
const candidatesSkeleton = (state: boolean) =>
  fc
    .tuple(fc.nat({ max: 1 }), fc.boolean(), fc.boolean(), fc.array(writeStep, { maxLength: 3 }))
    .map(([a, take, undoIt, tail]) => {
      const sp = (f: number, t: number | null) => (state ? span(f, t) : undefined);
      const head: Op[] = [
        {
          ...put(
            10,
            0,
            "1",
            state
              ? { ...span(0, null), from: { mode: "given", value: "2026-10-01" as BizPoint } }
              : undefined,
          ),
          seen: 0,
        },
        put(20, 10, "2", sp(a, a + 3)),
        put(30, 20, "3", sp(a + 1, a + 4)),
        put(40, 10, "4", sp(a, a + 2), false),
        put(50, 20, "5", sp(a + 1, a + 3), false),
        ...(take
          ? [
              {
                kind: "resolve" as const,
                op: 60,
                event: 61,
                decision: "take_previous" as const,
                candidates: [41, 51],
                unit: "f2" as FieldId,
              },
              ...(undoIt ? [{ kind: "undo" as const, op: 70, event: 71, target: 60 }] : []),
            ]
          : []),
      ];
      return toOps(tail, state, head);
    });

/**
 * An item whose unit is existence, taken: #21 revokes (on a state table, a stretch); #31, with the
 * version before it, writes f2 or the optional f3 and becomes a candidate on existence; #41 takes
 * it. On a state table the entity may start late, so that the merge base has no f2 where the
 * candidate fills (`required_in_gap`). Random steps follow.
 */
const existenceSkeleton = (state: boolean) =>
  fc
    .tuple(
      fc.nat({ max: 2 }),
      fc.nat({ max: 2 }),
      fc.constantFrom(true, true, false),
      fc.constantFrom<FieldId>("f2", "f3"),
      fc.array(writeStep, { maxLength: 3 }),
    )
    .map(([b, c, late, f, tail]) => {
      const head: Op[] = [
        {
          kind: "write",
          op: 10,
          event: 11,
          seen: 0,
          ...(state
            ? {
                valid: late
                  ? span(2, null)
                  : { ...span(0, null), from: { mode: "given", value: "2026-10-01" as BizPoint } },
              }
            : {}),
          fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "revoke",
          op: 20,
          event: 21,
          seen: 10,
          ...(state ? { valid: span(b, b + 3), validSources: ["S20"] } : {}),
        },
        {
          kind: "write",
          op: 30,
          event: 31,
          seen: 10,
          ...(state ? { valid: span(c, c + 3) } : {}),
          fields: { [f]: { value: "2", sources: ["S30"] } },
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
      ];
      return toOps(tail, state, head);
    });

/**
 * State tables: a candidate cut into several stretches around a corroboration (#41: the version
 * before #21 and #31, explicit), taken whole. Random steps follow.
 */
const splitSkeleton = fc
  .tuple(fc.nat({ max: 1 }), fc.array(writeStep, { maxLength: 3 }))
  .map(([a, tail]) => {
    const head: Op[] = [
      {
        ...put(10, 0, "1", {
          ...span(0, null),
          from: { mode: "given", value: "2026-10-01" as BizPoint },
        }),
        seen: 0,
      },
      put(20, 10, "2", span(a, a + 1)),
      put(30, 20, "2", span(a + 3, a + 4)),
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 10,
        valid: span(a, a + 4),
        fields: { f2: { value: "1", sources: ["S40"], explicit: true } },
      },
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "take_candidate",
        candidates: [41],
        take: 41,
        unit: "f2",
      },
    ];
    return toOps(tail, true, head);
  });

/**
 * A take on a field the checks on the current state refuse, as they would the ordinary write: on
 * an event table the row revoked after the candidate (#41); on a state table the candidate reaching
 * where the entity has no value, without the required f2. `revokeIt` false leaves the event row
 * existing, the take accepted. Random steps follow.
 */
const refusedTakeSkeleton = (state: boolean) =>
  fc
    .tuple(fc.boolean(), fc.nat({ max: 1 }), fc.array(writeStep, { maxLength: 3 }))
    .map(([revokeIt, a, tail]) => {
      const sp = (f: number, t: number | null) => (state ? { valid: span(f, t) } : {});
      const head: Op[] = state
        ? [
            {
              kind: "write",
              op: 10,
              event: 11,
              seen: 0,
              ...sp(2, null),
              fields: {
                f2: { value: "1", sources: ["S10"] },
                f3: { value: "a", sources: ["S10"] },
              },
              acknowledge: ["overwrite"],
            },
            {
              kind: "write",
              op: 20,
              event: 21,
              seen: 10,
              ...sp(2, 4),
              fields: { f3: { value: "b", sources: ["S20"] } },
              acknowledge: ["overwrite"],
            },
            {
              kind: "write",
              op: 30,
              event: 31,
              seen: 10,
              ...sp(a, 3),
              fields: { f3: { value: "c", sources: ["S30"] } },
            },
          ]
        : [
            {
              kind: "write",
              op: 10,
              event: 11,
              seen: 0,
              fields: {
                f2: { value: "1", sources: ["S10"] },
                f3: { value: "a", sources: ["S10"] },
              },
              acknowledge: ["overwrite"],
            },
            put(20, 10, "2", undefined),
            put(30, 10, "3", undefined, false),
            ...(revokeIt ? [{ kind: "revoke" as const, op: 40, event: 41, seen: 30 }] : []),
          ];
      return toOps(tail, state, [
        ...head,
        {
          kind: "resolve",
          op: 50,
          event: 51,
          decision: "take_candidate",
          candidates: [31],
          take: 31,
          unit: state ? "f3" : "f2",
        },
      ]);
    });

/**
 * A stale write of both fields meeting a revoke: one candidate on existence with both items
 * (09-references-conflict-sync «撤销与并发修改»), often decided on afterwards. Random steps follow.
 */
const twoFieldsSkeleton = (state: boolean) =>
  fc.tuple(fc.nat({ max: 1 }), fc.array(writeStep, { maxLength: 3 })).map(([a, tail]) => {
    const head: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        ...(state
          ? {
              valid: { ...span(0, null), from: { mode: "given", value: "2026-10-01" as BizPoint } },
            }
          : {}),
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        ...(state ? { valid: span(a, a + 3), validSources: ["S20"] } : {}),
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        ...(state ? { valid: span(a + 1, a + 2) } : {}),
        fields: { f2: { value: "2", sources: ["S30"] }, f3: { value: "b", sources: ["S30"] } },
      },
    ];
    return toOps(tail, state, head);
  });

/**
 * A stale write giving both fields after a change of one (09-references-conflict-sync «冲突单元»):
 * #20 changes f2 only; #30, having seen #10, writes f2 and f3. With f2 and f3 in a group the
 * conflict is the group's and both are candidates (conflict criterion ⑤); without, only f2.
 * Decisions on the item follow at random, with random steps.
 */
const groupSkeleton = (state: boolean) =>
  fc
    .tuple(fc.nat({ max: 1 }), fc.constantFrom("1", "2"), fc.array(writeStep, { maxLength: 3 }))
    .map(([a, v, tail]) => {
      const sp = (f: number, t: number | null) => (state ? { valid: span(f, t) } : {});
      const head: Op[] = [
        {
          kind: "write",
          op: 10,
          event: 11,
          seen: 0,
          ...sp(0, null),
          fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "write",
          op: 20,
          event: 21,
          seen: 10,
          ...sp(a, null),
          fields: { f2: { value: "5", sources: ["S20"] } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "write",
          op: 30,
          event: 31,
          seen: 10,
          ...sp(a, null),
          fields: { f2: { value: v, sources: ["S30"] }, f3: { value: "b", sources: ["S30f3"] } },
        },
      ];
      return toOps(tail, state, head);
    });

/**
 * One write, two units (the review's a2, state tables): its f2 runs to the next change, #21's
 * start, and meets #31's change only (the f2 item); its f3 runs on and meets the revoke #41 (the
 * item on existence). Decisions on either item follow at random, with random steps. Ops 10 apart:
 * inserted decisions go between them in op order.
 */
const mixedUnitsSkeleton = fc.array(writeStep, { maxLength: 3 }).map((tail) => {
  const head: Op[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: span(0, null),
      fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: span(4, null),
      fields: { f2: { value: "7", sources: ["S12"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 20,
      valid: span(1, 2),
      fields: { f2: { value: "2", sources: ["S20"] } },
      acknowledge: ["overwrite"],
    },
    { kind: "revoke", op: 40, event: 41, seen: 30, valid: span(5, null), validSources: ["S30"] },
    {
      kind: "write",
      op: 50,
      event: 51,
      seen: 20,
      valid: { from: { mode: "given", value: day(1) }, to: { mode: "next_change" } },
      fields: { f2: { value: "5", sources: ["S40"] }, f3: { value: "b", sources: ["S40"] } },
    },
  ];
  return toOps(tail, true, head);
});

/**
 * Whole revokes on a state table (09 §5.7 span, §5.8 entries: the whole time `{}`, a start left
 * open `{to}`): an interval revoke, a revoke of the whole entity and its undo, whose write-backs
 * are the whole time cut by the interval revoke; or a whole revoke from an older version meeting
 * another whole revoke, a candidate over the whole time. Random steps follow.
 */
const wholeSkeleton = fc
  .tuple(fc.nat({ max: 3 }), fc.boolean(), fc.array(writeStep, { maxLength: 3 }))
  .map(([a, undoIt, tail]) => {
    const head: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { ...span(0, null), from: { mode: "given", value: "2026-10-01" as BizPoint } },
        fields: { f2: { value: "1", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      ...(undoIt
        ? ([
            { kind: "revoke", op: 20, event: 21, seen: 10, valid: span(a, a + 2) },
            { kind: "revoke", op: 30, event: 31, seen: 20 },
            { kind: "undo", op: 40, event: 41, target: 30, seen: 30, acknowledge: ["overwrite"] },
          ] as Op[])
        : ([
            { kind: "revoke", op: 20, event: 21, seen: 10 },
            { kind: "revoke", op: 30, event: 31, seen: 10 },
          ] as Op[])),
    ];
    return toOps(tail, true, head);
  });

/**
 * State tables, a take that fills a revoke (09 §5.8 `take.filled`): #20 revokes a stretch; #30
 * writes over it (filling it); #40, having seen #20, writes another value over the same stretch:
 * a candidate against #30. #50 takes it: the revoke in effect meeting its stretch is filled.
 * Random steps follow, then any deletion may make the filled revoke or another one cover the take.
 * Ops 10 apart, as the other skeletons: inserted decisions go between them in op order.
 */
const filledTakeSkeleton = fc
  .tuple(fc.nat({ max: 1 }), fc.boolean(), fc.array(writeStep, { maxLength: 3 }))
  .map(([a, withSources, tail]) => {
    const head: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: span(0, null),
        fields: { f2: { value: "1", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: span(a + 1, a + 2),
        ...(withSources ? { validSources: ["S20"] } : {}),
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: span(a, a + 3),
        fields: { f2: { value: "5", sources: ["S30"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 20,
        valid: span(a, a + 3),
        fields: { f2: { value: "3", sources: ["S40"] } },
      },
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "take_candidate",
        candidates: [41],
        unit: "f2",
        take: 41,
      },
    ];
    return toOps(tail, true, head);
  });

export const scenario = (state: boolean) =>
  fc
    .record({
      steps: fc.array(writeStep, { minLength: 2, maxLength: 9 }),
      skeleton: state
        ? fc.oneof(
            { weight: 3, arbitrary: fc.constant(null) },
            { weight: 1, arbitrary: laterSkeleton(true) },
            { weight: 1, arbitrary: holeSkeleton },
            { weight: 1, arbitrary: candidatesSkeleton(true) },
            { weight: 1, arbitrary: filledTakeSkeleton },
            { weight: 1, arbitrary: existenceSkeleton(true) },
            { weight: 1, arbitrary: splitSkeleton },
            { weight: 1, arbitrary: refusedTakeSkeleton(true) },
            { weight: 1, arbitrary: twoFieldsSkeleton(true) },
            { weight: 1, arbitrary: groupSkeleton(true) },
            { weight: 1, arbitrary: wholeSkeleton },
            { weight: 1, arbitrary: mixedUnitsSkeleton },
          )
        : fc.oneof(
            { weight: 2, arbitrary: fc.constant(null) },
            { weight: 1, arbitrary: laterSkeleton(false) },
            { weight: 1, arbitrary: candidatesSkeleton(false) },
            { weight: 1, arbitrary: existenceSkeleton(false) },
            { weight: 1, arbitrary: refusedTakeSkeleton(false) },
            { weight: 1, arbitrary: twoFieldsSkeleton(false) },
            { weight: 1, arbitrary: groupSkeleton(false) },
          ),
      decisions: fc.array(decision, { maxLength: 5 }),
      fallback: fc.array(fc.boolean(), { maxLength: 9 }),
    })
    .map(({ steps, skeleton, decisions, fallback }) => ({
      ops: (skeleton ?? toOps(steps, state)).map((o, i) => withoutVer(o, fallback[i] === true)),
      decisions,
    }));

/**
 * A write or undo whose `ver` came from the read log rather than the request: the reference's form
 * is an op without `seen` (the current version, not explicit), so `acknowledge` does not count.
 */
function withoutVer(o: Op, drop: boolean): Op {
  if (!drop || (o.kind !== "write" && o.kind !== "undo") || o.op === 10) return o;
  const { seen: _, ...rest } = o;
  return rest;
}

/** The unit of the item a candidate item belongs to, as the reference names it. */
/**
 * The open conflict items of a unit, as the pipeline groups the candidates still open there
 * (01-objects «目标与合并»): by write, in log order, a write's candidates joining the earliest item
 * whose interval meets theirs (on state tables), or opening one.
 */
function itemsOfUnit(state: RowState, unit: UnitName): { events: number[]; spans: IntervalSet }[] {
  const spansOf = new Map<number, IntervalSet>();
  for (const x of state.items) {
    if (x.status !== "candidate" || unitKeyOf(unitOf(x, state.table.groups)) !== unitKeyOf(unit))
      continue;
    if (state.closedCandidate(x.event, x.target)) continue;
    spansOf.set(x.event, canonical([...(spansOf.get(x.event) ?? []), ...x.valid]));
  }
  const items: { events: number[]; spans: IntervalSet }[] = [];
  for (const [event, spans] of [...spansOf].sort(([a], [b]) => a - b)) {
    const it = items.find((i) => !state.isState || meet(i.spans, spans).length > 0);
    if (it === undefined) items.push({ events: [event], spans });
    else {
      it.events.push(event);
      it.spans = canonical([...it.spans, ...spans]);
    }
  }
  return items;
}

/** A conflict unit as the reference names it: a field, a field group, or existence. */
export type UnitName = FieldId | readonly FieldId[] | "existence";

const unitKeyOf = (u: UnitName): string =>
  u === "existence" ? u : typeof u === "string" ? u : [...u].sort().join(",");

/**
 * The unit of the item a candidate item belongs to, as the reference names it: existence when it
 * met a revoke; else its field's group (01-objects «冲突单元») when the field is in one, or the
 * field.
 */
export const unitOf = (
  x: { target: string; onExistence?: true },
  groups: readonly (readonly FieldId[])[] = [],
): UnitName => {
  if (x.target === "existence" || x.onExistence === true) return "existence";
  const group = groups.find((g) => g.includes(x.target as FieldId));
  return group !== undefined && group.length > 1 ? [...group].sort() : (x.target as FieldId);
};

export function toInput(o: Op): JudgeInput {
  const base = { op: o.op, index: 0, event: o.event, ruleset: 1, policy: 1 };
  switch (o.kind) {
    case "write": {
      const fields: Partial<Record<FieldId, { value: FieldValue; explicit?: boolean }>> = {};
      for (const [f, x] of Object.entries(o.fields)) {
        if (x === undefined || o.noop?.includes(f as FieldId)) continue;
        fields[f as FieldId] = { value: x.value, ...(x.explicit ? { explicit: true } : {}) };
      }
      return {
        ...base,
        kind: "write",
        seen: o.seen ?? o.op - 1,
        seenExplicit: o.seen !== undefined,
        ...(o.seenCurrent ? { seenCurrent: true as const } : {}),
        ...(o.valid !== undefined ? { valid: o.valid } : {}),
        now: o.now ?? NOW,
        fields,
        ...(o.acknowledge !== undefined ? { acknowledge: true } : {}),
      };
    }
    case "revoke":
      return {
        ...base,
        kind: "revoke",
        seen: o.seen ?? o.op - 1,
        seenExplicit: o.seen !== undefined,
        ...(o.seenCurrent ? { seenCurrent: true as const } : {}),
        ...(o.valid !== undefined ? { valid: o.valid } : {}),
        now: o.now ?? NOW,
      };
    case "undo":
      return {
        ...base,
        kind: "undo",
        target: o.target,
        ...(o.includeLater ? { includeLater: true } : {}),
        seen: o.seen ?? o.op - 1,
        seenExplicit: o.seen !== undefined,
        ...(o.seenCurrent ? { seenCurrent: true as const } : {}),
        ...(o.acknowledge !== undefined ? { acknowledge: true } : {}),
      };
    case "confirm":
    case "reject":
      return { ...base, kind: o.kind, target: o.target };
    case "resolve": {
      const unit =
        o.unit === "existence"
          ? ("existence" as const)
          : { fields: typeof o.unit === "string" ? [o.unit] : [...o.unit] };
      if (o.decision === "take_candidate") {
        if (o.take === undefined) throw new Error("take_candidate needs `take`");
        return {
          ...base,
          kind: "take_candidate",
          unit,
          candidates: o.candidates,
          take: o.take,
        };
      }
      return { ...base, kind: o.decision, unit, candidates: o.candidates };
    }
    default:
      throw new Error(`not judged here: ${(o as Op).kind}`);
  }
}

export interface Judged {
  readonly op: Op;
  readonly input: JudgeInput;
  readonly judgement: Judgement;
  readonly before: RowState;
  readonly state: RowState;
}

/**
 * Judges the log op by op, inserting the decisions; ops `judge` refuses are dropped. Returns the
 * steps that entered the log and the refusals, each with the ops before it.
 */
/**
 * A write, revoke or undo whose explicit `ver` is the row's current version, marked so. The version
 * is the version table's: the latest step before it that changed a cell (versions.fixture.ts), so
 * an existence item that changes nothing (a revoke over a stretch never written) makes none, as in
 * the pipeline.
 */
function markCurrent(o: Op, steps: readonly Judged[]): Op {
  if (o.kind !== "write" && o.kind !== "revoke" && o.kind !== "undo") return o;
  const latest = versionsOf(steps.filter((x) => x.op.op < o.op)).at(-1);
  if (o.seen === undefined || o.seen !== latest) return o;
  return { ...o, seenCurrent: true };
}

export function judged(
  schema: TableSchema,
  ops: readonly Op[],
  decisions: readonly Decision[],
  /**
   * Where inserted ops go: their offsets after the op they follow, and how far after its operation
   * an inserted op's event comes (1: right after; 2: a source between, as the pipeline appends a
   * decision that writes with its `api_call` source).
   */
  numbering: { readonly slots?: readonly number[]; readonly eventAfter?: number } = {},
) {
  const table = shape(schema);
  const isEventTable = schema.kind !== "state";
  let state = emptyState(table);
  const steps: Judged[] = [];
  const refused: { op: Op; reason: string; before: readonly Op[] }[] = [];
  let lastOp = 0;
  const enter = (given: Op) => {
    // A log's operation numbers only grow: a skeleton or an inserted decision out of order is a
    // fixture error, not a log to judge.
    if (given.op <= lastOp) throw new Error(`op ${given.op} after op ${lastOp}: not in order`);
    lastOp = given.op;
    // An explicit `ver` that is the row's current version is marked so, here, at the write, as the
    // pipeline does (09 §5.2 `ver.current`); judge and the reference take the mark.
    const o = markCurrent(given, steps);
    const input = toInput(o);
    try {
      const r = judgeOp(state, input);
      steps.push({ op: o, input, judgement: r.judgement, before: state, state: r.state });
      state = r.state;
    } catch (e) {
      if (!(e instanceof JudgeError)) throw e;
      refused.push({ op: o, reason: e.reason, before: steps.map((x) => x.op) });
    }
  };
  ops.forEach((o, i) => {
    if (o.kind === "resolve") {
      // A skeleton's resolution, on one item of its unit as the items are now: the candidates still
      // open there, grouped as the pipeline groups them (01-objects «目标与合并»: a write's
      // candidates join the earliest item whose interval meets theirs, or open one). A
      // take_candidate goes to the item holding the candidate taken; another decision to the
      // earliest item. (A dropped `ver` may have changed which writes conflict.)
      // A skeleton names a field; on a schema with groups the item is its group's.
      const named =
        o.unit === "existence" || typeof o.unit !== "string"
          ? o.unit
          : unitOf({ target: o.unit }, table.groups);
      const items = itemsOfUnit(state, named);
      const item =
        o.take === undefined ? items[0] : items.find((i) => i.events.includes(o.take as number));
      if (item !== undefined) enter({ ...o, unit: named, candidates: item.events });
    } else if (o.kind === "confirm" || o.kind === "reject") {
      // A skeleton's decision, on an item still awaiting.
      const awaiting = state.items.some(
        (x) => x.event === o.target && x.status === "awaiting" && !state.resolvedAwaiting(x.event),
      );
      if (awaiting) enter(o);
    } else enter(o);
    decisions
      .filter((x) => x.after % ops.length === i)
      .forEach((d, j) => {
        const slot = (numbering.slots ?? SLOTS)[j];
        if (slot === undefined) return;
        const op = o.op + slot;
        // A decision that writes nothing (reject, keep_effective) is its own operation: its event
        // is the decision itself, numbered as the operation (09 §4.1). Others write a base event.
        const event =
          d.kind === "reject" || d.kind === "keep" ? op : op + (numbering.eventAfter ?? 1);
        if (d.kind === "undo") {
          const pool = d.focus ? steps.filter((k) => k.op.kind !== "write") : steps;
          const target = pool[d.pick % Math.max(1, pool.length)]?.op.op;
          if (target === undefined) return;
          enter({
            kind: "undo",
            op,
            event,
            target,
            includeLater: (d.flag & 1) === 1,
            ...((d.flag & 4) === 4 ? { seen: op - 1 } : {}),
            ...((d.flag & 2) === 2 ? { acknowledge: ["overwrite"] as const } : {}),
          });
          return;
        }
        if (d.kind === "revoke") {
          if (!isEventTable) return;
          enter({ kind: "revoke", op, event, seen: (d.flag & 1) === 1 ? op - 11 : op - 1 });
          return;
        }
        const resolving = d.kind === "keep" || d.kind === "previous" || d.kind === "take";
        const open = state.items.filter((x) =>
          resolving
            ? x.status === "candidate" && !state.closedCandidate(x.event, x.target)
            : x.status === "awaiting" && !state.resolvedAwaiting(x.event),
        );
        const x = open[d.pick % Math.max(1, open.length)];
        if (x === undefined) return;
        const unit = unitOf(x, table.groups);
        // A decision on the item holding the candidate picked (01-objects «目标与合并»).
        const candidates = resolving
          ? (itemsOfUnit(state, unit).find((i) => i.events.includes(x.event))?.events ?? [x.event])
          : [x.event];
        enter(
          resolving
            ? {
                kind: "resolve",
                op,
                event,
                decision:
                  d.kind === "keep"
                    ? "keep_effective"
                    : d.kind === "take"
                      ? "take_candidate"
                      : "take_previous",
                candidates,
                unit,
                ...(d.kind === "take" ? { take: x.event } : {}),
              }
            : { kind: d.kind, op, event, target: x.event },
        );
      });
  });
  return { table, steps, refused };
}

/**
 * The (event, target) the deleted source data take away (as the caller works out from
 * `base_sources`): a field whose value sources include one; every target of a write or revoke
 * whose interval's sources include one (03-deletion «区间参数»). A write on a state table that maps
 * no evidence to its interval has all its evidence as the interval's sources; a revoke without
 * `valid_sources` has none.
 */
export function deletedContributions(
  ops: readonly Op[],
  deleted: ReadonlySet<string>,
  isState: boolean,
): Set<string> {
  const out = new Set<string>();
  for (const o of ops) {
    if (o.kind !== "write" && o.kind !== "revoke") continue;
    if (o.kind === "revoke") {
      if ((o.validSources ?? []).some((s) => deleted.has(s)))
        out.add(contributionKey(o.event, "existence"));
      continue;
    }
    const evidence = Object.values(o.fields).flatMap((x) => x?.sources ?? []);
    const intervalGone = isState && (o.validSources ?? evidence).some((s) => deleted.has(s));
    for (const [f, x] of Object.entries(o.fields)) {
      if (intervalGone || (x?.sources ?? []).some((s) => deleted.has(s)))
        out.add(contributionKey(o.event, f as Target));
    }
  }
  return out;
}
