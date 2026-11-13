// `judge` against the reference evaluator with nothing deleted (02-architecture §11 «测试矩阵»,
// «写入路径与参考一致»). Random logs of writes, same-valued resends, revokes and people's decisions
// (confirm, reject, keep the effective value) are judged op by op; every step must leave the same
// row or entity as the reference evaluator's write-time judgement, item by item, and what the
// judgement says beyond the items (conflicts, awaiting or acknowledged, no-ops) must agree with the
// reference's statuses.
//
// An op `judge` refuses never enters the log. The reference evaluator models no validation, so
// each refusal is checked against it: a write lacking a required field is refused exactly when the
// reference puts a part of it that takes effect into a gap (05-time «无值区间»), and nothing else is
// refused. Each next op is also judged on the state rebuilt from the records after a JSON round
// trip, and must get the same judgement: together with the comparison this is the write path's
// half of «写入路径与参考一致». The reference has no conflict groups and no multi-op requests; those
// are covered by fixed cases (judge.test.ts), as are `deps` and the overwritten stretches.

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type Op, type TableSchema, type WriteOp } from "@fluxvita/saveslot-reference";
import {
  DAYS,
  EVENT,
  Hits,
  propRuns,
  STATE,
  type Step,
  stale,
  step,
  toOps,
} from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { isNothing, meet } from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp, stateFromRecord, view } from "./judge.ts";
import type { JudgeInput, Judgement, TableShape } from "./model.ts";
import { EVERYTHING, type RowState, refKey } from "./state.ts";

vi.setConfig({ testTimeout: 60_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 50_000, markInterruptAsFailure: true });

const RUNS = propRuns(1500);
const NOW = "2026-11-05";

const shape = (s: TableSchema): TableShape => ({
  kind: s.kind,
  fields: ["f2", "f3"],
  valued: s.required,
  required: s.required,
  groups: [],
});

/**
 * An op inserted after another, as the log so far makes it possible: a person's decision on the
 * `pick`-th open pending item (take_previous on every open candidate of its unit); an undo of the
 * `pick`-th operation in the log, whatever it was (a revoke, a revert, a confirmation, the first
 * creation; with `focus`, among the operations that are not plain writes), with `include_later`,
 * `acknowledge` and an explicit `ver` by `flag`; on event tables, a revoke.
 */
interface Decision {
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
 * proposal's operation or the confirmation's (09 §5.7). Random steps follow.
 */
const laterSkeleton = (state: boolean) =>
  fc
    .tuple(
      fc.nat({ max: 1 }),
      fc.nat({ max: 1 }),
      fc.boolean(),
      fc.constantFrom<null | 40 | 50>(null, null, 40, 50),
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

const scenario = (state: boolean) =>
  fc
    .record({
      steps: fc.array(writeStep, { minLength: 2, maxLength: 9 }),
      skeleton: state
        ? fc.oneof(
            { weight: 3, arbitrary: fc.constant(null) },
            { weight: 1, arbitrary: laterSkeleton(true) },
            { weight: 1, arbitrary: holeSkeleton },
            { weight: 1, arbitrary: candidatesSkeleton(true) },
            { weight: 1, arbitrary: existenceSkeleton(true) },
            { weight: 1, arbitrary: splitSkeleton },
            { weight: 1, arbitrary: refusedTakeSkeleton(true) },
          )
        : fc.oneof(
            { weight: 2, arbitrary: fc.constant(null) },
            { weight: 1, arbitrary: laterSkeleton(false) },
            { weight: 1, arbitrary: candidatesSkeleton(false) },
            { weight: 1, arbitrary: existenceSkeleton(false) },
            { weight: 1, arbitrary: refusedTakeSkeleton(false) },
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
const unitOf = (x: { target: string; onExistence?: true }): FieldId | "existence" =>
  x.target === "existence" || x.onExistence === true ? "existence" : (x.target as FieldId);

function toInput(o: Op): JudgeInput {
  const base = { op: o.op, index: 0, event: o.event, ruleset: 1 };
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
        ...(o.acknowledge !== undefined ? { acknowledge: true } : {}),
      };
    case "confirm":
    case "reject":
      return { ...base, kind: o.kind, target: o.target };
    case "resolve": {
      const unit = o.unit === "existence" ? ("existence" as const) : { fields: [o.unit] };
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

/**
 * The items as the reference lists them, with their registrations. The proposal of an awaiting
 * undo (its write-backs with status awaiting) is left out: the reference keeps it in the revert's
 * result only.
 */
function itemsOf(state: RowState) {
  const proposals = new Set(
    state.records.filter((r) => r.kind === "undo" && r.status === "awaiting").map((r) => r.event),
  );
  return state.items
    .filter((x) => !proposals.has(x.event))
    .map((x) => ({
      event: x.event,
      target: x.target,
      k: x.k,
      op: x.op,
      status: x.status,
      valid: x.valid,
      content: x.content.kind === "no_value" ? { kind: "noValue" } : x.content,
      ...(x.carried !== undefined ? { carried: x.carried } : {}),
      registrations: state
        .registrations(x, EVERYTHING)
        .map((r) => ({ byOp: r.op, valid: r.valid })),
      ...((x.status === "candidate" && state.closedCandidate(x.event, x.target)) ||
      (x.status === "awaiting" && state.resolvedAwaiting(x.event))
        ? { closed: true as const }
        : {}),
    }))
    .sort((a, b) => refKey(a).localeCompare(refKey(b)));
}

function referenceItems(items: readonly { event: number; target: string; k: number }[]) {
  return [...items].sort((a, b) => refKey(a as never).localeCompare(refKey(b as never)));
}

const byEntry = (a: { event: number; target: string }, b: { event: number; target: string }) =>
  a.event - b.event || a.target.localeCompare(b.target);

/** The reverts in effect or awaiting, as the reference lists them (record sorted). */
function revertsOf(steps: readonly Judged[]) {
  return steps.flatMap((x) => {
    const r = x.judgement.record;
    const spec =
      r.kind === "undo" || r.kind === "take_previous"
        ? { status: r.status, revert: r.revert }
        : r.kind === "confirm" && r.revert !== undefined
          ? { status: "applied" as const, revert: r.revert }
          : undefined;
    if (spec === undefined) return [];
    return [
      {
        op: r.op,
        event: r.event,
        status: spec.status,
        record: [...spec.revert.entries].sort(byEntry),
        ...(x.judgement.warnings.length > 0 ? { warnings: ["overwrote_corroborated"] } : {}),
      },
    ];
  });
}

interface Judged {
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
function judged(schema: TableSchema, ops: readonly Op[], decisions: readonly Decision[]) {
  const table = shape(schema);
  const isEventTable = schema.kind !== "state";
  let state = emptyState(table);
  const steps: Judged[] = [];
  const refused: { op: Op; reason: string; before: readonly Op[] }[] = [];
  const enter = (o: Op) => {
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
      // A skeleton's resolution, on the candidates still open (a dropped `ver` may have changed
      // which writes conflict).
      const open = new Set(
        state.items
          .filter(
            (x) =>
              x.status === "candidate" &&
              unitOf(x) === o.unit &&
              !state.closedCandidate(x.event, x.target),
          )
          .map((x) => x.event),
      );
      const candidates = o.candidates.filter((e) => open.has(e));
      if (candidates.length > 0 && (o.take === undefined || candidates.includes(o.take))) {
        enter({ ...o, candidates });
      }
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
        const slot = SLOTS[j];
        if (slot === undefined) return;
        const op = o.op + slot;
        const event = op + 1;
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
        const unit = unitOf(x);
        const candidates =
          d.kind === "previous" || d.kind === "take"
            ? [...new Set(open.filter((y) => unitOf(y) === unit).map((y) => y.event))]
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
 * Whether the reference puts a part of write `o` that takes effect (applied, or awaiting: in
 * effect but for high impact) where the entity had no value before it.
 */
function fillsGap(schema: TableSchema, before: readonly Op[], o: Op): boolean {
  const gaps = evaluateLog(schema, before).final.gaps;
  const after = evaluateLog(schema, [...before, o]).final;
  return after.items.some(
    (x) =>
      x.event === o.event &&
      (x.status === "applied" || x.status === "awaiting") &&
      !isNothing(meet(x.valid, gaps)),
  );
}

/**
 * Event tables: the reference has a revoke in effect on the row after `before`: not registered as
 * reverted, and no restore in effect after it (a take_candidate's restore).
 */
const revokedRow = (schema: TableSchema, before: readonly Op[]) => {
  const items = evaluateLog(schema, before).final.items;
  const live = (x: (typeof items)[number], kind: string) =>
    x.target === "existence" &&
    x.content.kind === kind &&
    x.status === "applied" &&
    x.registrations.length === 0;
  return items.some(
    (r) => live(r, "revoke") && !items.some((y) => live(y, "restore") && y.op > r.op),
  );
};

/** The reference puts a part of `o` into effect (applied, or awaiting: in effect but for ①). */
const takesEffect = (schema: TableSchema, before: readonly Op[], o: Op) =>
  evaluateLog(schema, [...before, o]).final.items.some(
    (x) => x.event === o.event && (x.status === "applied" || x.status === "awaiting"),
  );

const lacksRequired = (schema: TableSchema, o: Op) =>
  o.kind === "write" && schema.required.some((f) => o.fields[f] === undefined);

/** A JSON round trip, as the records will make through events. */
const roundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

describe.each(both)("%s table", (_, schema, isState) => {
  it("every step leaves the row or entity the reference evaluator gives", () => {
    const hits = new Hits(0.3);
    const seen: Record<string, number> & {
      samples: number;
      awaiting: number;
      candidate: number;
      corroborated: number;
      decided: number;
      refused: number;
    } = {
      awaiting: 0,
      candidate: 0,
      corroborated: 0,
      decided: 0,
      refused: 0,
      samples: 0,
      undo: 0,
      undoAwaiting: 0,
      undoRefused: 0,
      later: 0,
      takesBack: 0,
      hides: 0,
      skipped: 0,
      takePrevious: 0,
      confirmUndo: 0,
    };
    fc.assert(
      fc.property(
        scenario(isState),
        hits.track(({ ops, decisions }) => {
          const { table, steps, refused } = judged(schema, ops, decisions);
          const kept = steps.map((x) => x.op);
          const fin = steps[steps.length - 1]?.state;
          const st = new Set(fin?.items.map((x) => x.status) ?? []);
          seen.samples++;
          if (st.has("awaiting")) seen.awaiting++;
          if (st.has("candidate")) seen.candidate++;
          if (st.has("corroborated")) seen.corroborated++;
          if (kept.some((o) => o.op % 10 !== 0)) seen.decided++;
          if (refused.length > 0) seen.refused++;
          if (st.has("awaiting") || st.has("candidate")) hits.hit();
          for (const x of steps) {
            const r = x.judgement.record;
            if (r.kind === "undo") {
              seen["undo"] = (seen["undo"] ?? 0) + 1;
              if (r.status === "awaiting") seen["undoAwaiting"] = (seen["undoAwaiting"] ?? 0) + 1;
              if (r.revert.entries.some((e) => e.later)) seen["later"] = (seen["later"] ?? 0) + 1;
              if (x.judgement.takesBack.length > 0)
                seen["takesBack"] = (seen["takesBack"] ?? 0) + 1;
              if (x.judgement.hides.length > 0) seen["hides"] = (seen["hides"] ?? 0) + 1;
              if (r.revert.skipped.length > 0) seen["skipped"] = (seen["skipped"] ?? 0) + 1;
            }
            if (r.kind === "undo") {
              const target = steps.find((k) => k.op.op === (x.op as { target: number }).target);
              const tr = target?.judgement.record;
              const kind =
                tr === undefined
                  ? "none"
                  : tr.kind === "undo" && tr.status === "awaiting"
                    ? steps.some(
                        (k) =>
                          k.judgement.record.kind === "confirm" &&
                          k.judgement.record.target === tr.event,
                      )
                      ? "confirmedProposal"
                      : "proposal"
                    : tr.kind;
              seen[`undoOf_${kind}`] = (seen[`undoOf_${kind}`] ?? 0) + 1;
            }
            if (r.kind === "take_candidate") {
              seen["take"] = (seen["take"] ?? 0) + 1;
              if (r.unit === "existence") seen["takeExistence"] = (seen["takeExistence"] ?? 0) + 1;
              if (r.items.length === 0) seen["takeNothing"] = (seen["takeNothing"] ?? 0) + 1;
              for (const y of r.items) {
                const key = `take_${y.content.kind}${y.carried?.some((c) => c.event !== r.take) ? "_carriedOther" : ""}`;
                seen[key] = (seen[key] ?? 0) + 1;
              }
              if (r.items.some((y) => y.target !== "existence" && y.valid.length > 1))
                seen["takeManyStretches"] = (seen["takeManyStretches"] ?? 0) + 1;
            }
            if (r.kind === "take_previous") {
              seen["takePrevious"] = (seen["takePrevious"] ?? 0) + 1;
              if ((r.revert.candidates?.length ?? 0) > 1)
                seen["takePreviousMany"] = (seen["takePreviousMany"] ?? 0) + 1;
            }
            if (r.kind === "confirm" && r.revert !== undefined)
              seen["confirmUndo"] = (seen["confirmUndo"] ?? 0) + 1;
            if (
              (r.kind === "undo" || r.kind === "take_previous" || r.kind === "confirm") &&
              "items" in r
            ) {
              for (const y of r.items)
                seen[`wb_${y.content.kind}`] = (seen[`wb_${y.content.kind}`] ?? 0) + 1;
            }
          }
          if (refused.some((x) => x.op.kind === "undo"))
            seen["undoRefused"] = (seen["undoRefused"] ?? 0) + 1;

          // Refusals: a write lacking a required field whose part taking effect fills a gap, a
          // write taking effect on a revoked event row, or an undo the reference rejects (for
          // `undo_target`, or `revoked`); nothing else.
          for (const r of refused) {
            if (r.op.kind === "undo") {
              const last = evaluateLog(schema, [...r.before, r.op]).final.reverts.at(-1);
              expect({ op: r.op.op, reason: r.reason }).toEqual({
                op: r.op.op,
                reason: last?.reason === "revoked" ? "revoked" : "invalid_argument",
              });
              expect({ op: r.op.op, status: last?.status }).toEqual({
                op: r.op.op,
                status: "rejected",
              });
              seen[`undoRefused_${r.reason}`] = (seen[`undoRefused_${r.reason}`] ?? 0) + 1;
              continue;
            }
            if (r.op.kind === "resolve") {
              // A take refused: as the ordinary write would be (`revoked`, a gap without the
              // required fields), or on existence with a required field nowhere to carry from.
              const rej = evaluateLog(schema, [...r.before, r.op]).steps.at(-1)?.rejected;
              const expected =
                rej === undefined
                  ? "accepted"
                  : rej === "revoked"
                    ? "revoked"
                    : "validation_failed";
              expect({ op: r.op.op, reason: r.reason }).toEqual({ op: r.op.op, reason: expected });
              seen[`takeRefused_${rej}`] = (seen[`takeRefused_${rej}`] ?? 0) + 1;
              continue;
            }
            if (r.reason === "revoked") {
              expect({
                op: r.op.op,
                kind: r.op.kind,
                revoked: revokedRow(schema, r.before),
                effective: takesEffect(schema, r.before, r.op),
              }).toEqual({ op: r.op.op, kind: "write", revoked: true, effective: true });
              seen["writeRevoked"] = (seen["writeRevoked"] ?? 0) + 1;
              continue;
            }
            expect({ op: r.op.op, reason: r.reason }).toEqual({
              op: r.op.op,
              reason: "validation_failed",
            });
            expect(lacksRequired(schema, r.op) && fillsGap(schema, r.before, r.op)).toBe(true);
          }
          steps.forEach((x, i) => {
            if (!isState && x.op.kind === "write" && takesEffect(schema, kept.slice(0, i), x.op)) {
              expect({ op: x.op.op, revoked: revokedRow(schema, kept.slice(0, i)) }).toEqual({
                op: x.op.op,
                revoked: false,
              });
            }
            if (isState && lacksRequired(schema, x.op)) {
              expect({ op: x.op.op, fillsGap: fillsGap(schema, kept.slice(0, i), x.op) }).toEqual({
                op: x.op.op,
                fillsGap: false,
              });
            }
          });

          const ref = evaluateLog(schema, kept);
          expect(ref.steps.length).toBe(steps.length);
          ref.steps.forEach((s, i) => {
            const x = steps[i] as Judged;
            expect(s.refused).toBe(false);
            expect({ step: i, view: view(x.state) }).toEqual({
              step: i,
              view: {
                kind: s.state.kind,
                exists: s.state.exists,
                gaps: s.state.gaps,
                fields: s.state.fields,
                created: s.state.created,
              },
            });
            expect({ step: i, items: itemsOf(x.state) }).toEqual({
              step: i,
              items: referenceItems(s.state.items),
            });
            expect({ step: i, reverts: revertsOf(steps.slice(0, i + 1)) }).toEqual({
              step: i,
              reverts: s.state.reverts.map((r) => ({ ...r, record: [...r.record].sort(byEntry) })),
            });

            // What the judgement says beyond the items, against the reference's statuses.
            const j = x.judgement;
            const mine = s.state.items.filter((y) => y.event === x.op.event);
            const has = (status: string) => mine.some((y) => y.status === status);
            expect({ step: i, conflict: j.conflicts.length > 0 }).toEqual({
              step: i,
              conflict: has("candidate"),
            });
            if (x.op.kind === "write" || x.op.kind === "revoke") {
              expect({ step: i, awaiting: j.erased.length > 0 && !j.acknowledged }).toEqual({
                step: i,
                awaiting: has("awaiting"),
              });
            }
            if (j.acknowledged) expect(j.erased.length).toBeGreaterThan(0);
            if (x.input.kind === "write" && j.record.kind === "write") {
              const given = Object.keys(x.input.fields).sort();
              expect({ step: i, noop: j.record.noop }).toEqual({
                step: i,
                noop: given.filter((f) => !mine.some((y) => y.target === f)),
              });
            }

            // The next op judged on the state rebuilt from the records after a round trip.
            const rebuilt = stateFromRecord(table, roundTrip(x.before.records));
            expect({ step: i, judgement: judgeOp(rebuilt, x.input).judgement }).toEqual({
              step: i,
              judgement: j,
            });
          });
        }),
      ),
      { numRuns: RUNS },
    );
    if (process.env["JUDGE_STATS"]) console.log(schema.kind, JSON.stringify(seen));
    hits.check();
    // take_candidate is reached often enough to count: per sample, at least these shares.
    const share = (key: string) => (seen[key] ?? 0) / seen.samples;
    const minimum: Record<string, number> = isState
      ? {
          take: 0.1,
          takeExistence: 0.03,
          takeManyStretches: 0.03,
          takeRefused_required_in_gap: 0.005,
          takeRefused_missing_required: 0.005,
        }
      : {
          take: 0.1,
          takeExistence: 0.08,
          take_restore: 0.06,
          take_revoke: 0.002,
          takeRefused_revoked: 0.005,
        };
    for (const [key, min] of Object.entries(minimum)) {
      expect({ key, enough: share(key) >= min }).toEqual({ key, enough: true });
    }
  });
});
