// Property tests over logs with deletions interleaved with operations (02-architecture §11,
// «删除的性质»): no kernel.

import { appendFileSync } from "node:fs";
import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { evaluateLog, segmentStats } from "./evaluate.ts";
import {
  covers,
  elementarySegments,
  endpoints,
  type Iv,
  type IvSet,
  intersect,
  isEmpty,
  subtract,
  union,
} from "./interval.ts";
import type {
  Evaluation,
  ItemResult,
  LogEntry,
  LogEvaluation,
  Op,
  TableSchema,
  ToParam,
  WriteOp,
} from "./model.ts";
import { Hits, propRuns } from "./testing/prop-coverage.fixture.ts";
import { stateWithoutIndices, timeline } from "./views.ts";

// An explicit time limit; on a failure (including running out of time) fast-check reports the
// seed and path that reproduce it: `fc.assert(..., { seed, path, endOnFailure: true })`.
vi.setConfig({ testTimeout: 30_000 });
// `PROP_SEED` and `PROP_PATH` replay a failure, as in the other property files.
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
fc.configureGlobal({
  interruptAfterTimeLimit: 25_000,
  markInterruptAsFailure: true,
  ...(SEED !== undefined ? { seed: SEED } : {}),
  ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
});

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const EVENT: TableSchema = { kind: "event", required: ["f2"] };
const DAYS = ["11-01", "11-03", "11-05", "11-07", "11-09"].map((x) => `2026-${x}` as BizPoint);
const SOURCES = ["S1", "S2", "S3", "S4", "S5"];
const RUNS = propRuns(750);

type Step =
  | {
      t: "write";
      f: FieldId;
      v: string;
      src: string;
      from: number;
      to: number | "open" | "next";
      lag: number;
      explicit: boolean;
      ack: boolean;
      /** A write to f2 that also writes f3 with this value (two fields in one write). */
      also?: string;
    }
  /**
   * A revoke: on a state table of [from, to) (to: a day or open), its interval from `src`; on an
   * event table of the whole row.
   */
  | { t: "revoke"; from: number; to: number | "open"; src: string; lag: number }
  /** Restate an earlier write's value for its field, with or without evidence pointed at. */
  | { t: "resend"; back: number; src: string; explicit: boolean }
  | { t: "undo"; back: number }
  /** Undo an earlier undo (a revert), if any. */
  | { t: "undoRevert"; back: number }
  | { t: "delete"; src: string[] }
  | { t: "cancel"; back: number }
  | { t: "execute"; back: number }
  /** Resolve the first open conflict item (by field), if any. */
  | { t: "resolve"; decision: "keep_effective" | "take_candidate" | "take_previous" }
  /** Confirm or reject the first open awaiting item, if any. */
  | { t: "confirm"; reject: boolean };

const write = fc
  .record({
    t: fc.constant("write" as const),
    f: fc.constantFrom<FieldId>("f2", "f2", "f3"),
    v: fc.constantFrom("1", "2", "3"),
    src: fc.constantFrom(...SOURCES),
    from: fc.nat({ max: DAYS.length - 2 }),
    to: fc.oneof(
      fc.constantFrom<"open" | "next">("open", "next"),
      fc.nat({ max: DAYS.length - 1 }),
    ),
    lag: fc.constantFrom(0, 1, 1, 2),
    explicit: fc.boolean(),
    ack: fc.boolean(),
    also: fc.constantFrom<string | undefined>(undefined, undefined, undefined, "a", "b"),
  })
  .map(({ also, ...w }) => (also !== undefined && w.f === "f2" ? { ...w, also } : w));
const revoke = fc.record({
  t: fc.constant("revoke" as const),
  from: fc.nat({ max: DAYS.length - 2 }),
  to: fc.oneof(fc.constant("open" as const), fc.nat({ max: DAYS.length - 1 })),
  src: fc.constantFrom(...SOURCES),
  lag: fc.constantFrom(0, 1, 1, 2),
});
const resend = fc.record({
  t: fc.constant("resend" as const),
  back: fc.nat({ max: 2 }),
  src: fc.constantFrom(...SOURCES),
  explicit: fc.constantFrom(true, true, false),
});
const decisions = fc.oneof(
  fc.record({
    t: fc.constant("resolve" as const),
    decision: fc.constantFrom("keep_effective", "take_candidate", "take_previous") as fc.Arbitrary<
      "keep_effective" | "take_candidate" | "take_previous"
    >,
  }),
  fc.record({ t: fc.constant("confirm" as const), reject: fc.boolean() }),
);

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: write },
  { weight: 2, arbitrary: revoke },
  { weight: 2, arbitrary: resend },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant("undo" as const), back: fc.nat({ max: 2 }) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant("undoRevert" as const), back: fc.nat({ max: 1 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("delete" as const),
      src: fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("cancel" as const), back: fc.nat({ max: 1 }) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant("execute" as const), back: fc.nat({ max: 1 }) }),
  },
  { weight: 4, arbitrary: decisions },
);

/** Operations after two deletion orders: writes, restatements, undos and decisions. */
const furtherStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: write },
  { weight: 1, arbitrary: revoke },
  { weight: 1, arbitrary: resend },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("undo" as const), back: fc.nat({ max: 2 }) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant("undoRevert" as const), back: fc.nat({ max: 1 }) }),
  },
  { weight: 3, arbitrary: decisions },
);

/**
 * Grace-period steps: writes and restatements, no deletion events. No decisions: in the first
 * version a decision on a row the pending deletion affects is refused (see `decisionInGracePeriod`).
 */
const graceStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: write },
  { weight: 1, arbitrary: revoke },
  { weight: 2, arbitrary: resend },
);

function writeOp(
  op: number,
  s: Extract<Step, { t: "write" }>,
  state: boolean,
  first: boolean,
  src = s.src,
): WriteOp {
  const end = typeof s.to === "number" ? Math.max(s.to, s.from + 1) : s.to;
  const to: ToParam =
    end === "open"
      ? { mode: "open" }
      : end === "next"
        ? { mode: "next_change" }
        : { mode: "given", value: DAYS[end] ?? "2026-12-01" };
  const from = (first ? "2026-10-01" : DAYS[s.from]) as BizPoint;
  return {
    kind: "write",
    op,
    event: op + 1,
    seen: Math.max(0, op - 10 * (1 + s.lag)),
    ...(state
      ? {
          valid: { from: { mode: "given", value: from }, to: first ? { mode: "open" } : to },
        }
      : {}),
    fields: {
      [first ? "f2" : s.f]: { value: s.v, sources: [src], explicit: s.explicit && !first },
      ...(s.also !== undefined && !first ? { f3: { value: s.also, sources: [src] } } : {}),
    },
    ...(s.ack ? { acknowledge: ["overwrite"] as const } : {}),
  };
}

const FIRST: Extract<Step, { t: "write" }> = {
  t: "write",
  f: "f2",
  v: "1",
  src: "S1",
  from: 0,
  to: "open",
  lag: 0,
  explicit: false,
  ack: true,
};

/**
 * Appends steps to a log, from operation number `start`. Decisions are aimed at items open at
 * that point, so the log is evaluated before each one. `fresh` gives grace-period writes their
 * own sources.
 */
function extend(
  schema: TableSchema,
  log: LogEntry[],
  steps: readonly Step[],
  start: number,
  fresh?: string,
): LogEntry[] {
  const state = schema.kind === "state";
  const out = [...log];
  const writes = () => out.filter((e): e is WriteOp => e.kind === "write");
  const deletions = () => out.filter((e) => e.kind === "deletion").map((e) => e.id);
  steps.forEach((s, i) => {
    const op = start + 10 * i;
    const src = fresh !== undefined ? `${fresh}${i}` : undefined;
    if (s.t === "write" || out.length === 0) {
      const w = s.t === "write" ? s : FIRST;
      out.push(writeOp(op, w, state, out.length === 0, src ?? w.src));
    } else if (s.t === "revoke") {
      const end = typeof s.to === "number" ? Math.max(s.to, s.from + 1) : s.to;
      out.push({
        kind: "revoke",
        op,
        event: op + 1,
        seen: Math.max(0, op - 10 * (1 + s.lag)),
        ...(state
          ? {
              valid: {
                from: { mode: "given", value: DAYS[s.from] as BizPoint },
                to:
                  end === "open"
                    ? { mode: "open" }
                    : { mode: "given", value: DAYS[end] ?? ("2026-12-01" as BizPoint) },
              },
              validSources: [src ?? s.src],
            }
          : {}),
      });
    } else if (s.t === "resend") {
      const prev = writes()[writes().length - 1 - s.back];
      const [f, input] = Object.entries(prev?.fields ?? {})[0] ?? [];
      if (prev === undefined || f === undefined || input === undefined) return;
      out.push({
        kind: "write",
        op,
        event: op + 1,
        seen: op - 10,
        ...(prev.valid !== undefined ? { valid: prev.valid } : {}),
        fields: { [f]: { value: input.value, sources: [src ?? s.src], explicit: s.explicit } },
      });
    } else if (s.t === "undo") {
      const target = writes()[writes().length - 1 - s.back]?.op;
      if (target !== undefined && target !== writes()[0]?.op) {
        out.push({ kind: "undo", op, event: op + 1, target });
      }
    } else if (s.t === "undoRevert") {
      const undos = out.filter((e) => e.kind === "undo");
      const target = undos[undos.length - 1 - s.back]?.op;
      if (target !== undefined) out.push({ kind: "undo", op, event: op + 1, target });
    } else if (s.t === "delete") {
      out.push({ kind: "deletion", op, id: `pi_${op}`, sources: s.src });
    } else if (s.t === "execute") {
      // Carried out at expiry: one of the latest deletions (refused when not pending).
      const id = deletions()[deletions().length - 1 - s.back];
      if (id !== undefined) {
        out.push({ kind: "execute", op, id });
        counts.executeSteps++;
      }
    } else if (s.t === "cancel") {
      const id = deletions()[deletions().length - 1 - s.back];
      if (id !== undefined && !decisionInGracePeriod(out, id)) out.push({ kind: "cancel", op, id });
    } else {
      const ev = evaluateLog(schema, out).final;
      const open = ev.items.filter(
        (x) =>
          (s.t === "resolve" ? x.status === "candidate" : x.status === "awaiting") && !x.closed,
      );
      const first = open[0];
      if (first === undefined) return;
      if (s.t === "confirm") {
        out.push({ kind: s.reject ? "reject" : "confirm", op, event: op + 1, target: first.event });
        return;
      }
      // The unit of the first open candidate's item: existence for a revoke, and for the fields of
      // a write whose conflict met one; its field otherwise. The item's candidates are the open
      // ones a resolution on that unit accepts (the evaluator rejects one listing a candidate
      // not on the unit, as the kernel does). Found by trying each once. Picked by the evaluator's
      // own validity check: were it to refuse a valid resolution wrongly, the property would not
      // turn red (the resolution is just not generated).
      const fits = (e: number, unit: FieldId | "existence") =>
        evaluateLog(schema, [
          ...out,
          { kind: "resolve", op, event: op + 1, decision: "keep_effective", candidates: [e], unit },
        ]).steps.at(-1)?.refused === false;
      const unit: FieldId | "existence" =
        first.target === "existence" || !fits(first.event, first.target)
          ? "existence"
          : first.target;
      const candidates = [...new Set(open.map((x) => x.event))].filter((e) => fits(e, unit));
      if (!candidates.includes(first.event)) return;
      const existence = unit === "existence";
      out.push({
        kind: "resolve",
        op,
        event: op + 1,
        decision: s.decision,
        candidates,
        unit: existence ? "existence" : first.target,
        ...(s.decision === "take_candidate" ? { take: first.event } : {}),
      });
    }
  });
  // What the generator's later steps reach, per call (checked by "the generator reaches …").
  const added = out.slice(log.length);
  counts.extended++;
  counts.revokes += added.filter((e) => e.kind === "revoke").length;
  counts.twoFieldWrites += added.filter(
    (e) => e.kind === "write" && Object.keys(e.fields).length > 1,
  ).length;
  counts.resolvesOnExistence += added.filter(
    (e) => e.kind === "resolve" && e.unit === "existence",
  ).length;
  return out;
}

const steps = fc.array(step, { minLength: 2, maxLength: 9 });

/** A generator for one sample in four, a skeleton reaching the checked situation for three. */
const mostly = <T>(random: fc.Arbitrary<T>, skeleton: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 1, arbitrary: random }, { weight: 3, arbitrary: skeleton });

/**
 * Random steps, then writes with an old version that do not acknowledge (conflicts or awaiting
 * writes, citing S5), each followed by a deletion of other sources: deletions with pending items
 * around.
 */
const deletionAfterConflict: fc.Arbitrary<Step[]> = fc
  .tuple(
    fc.array(step, { minLength: 1, maxLength: 6 }),
    fc.array(
      fc.tuple(
        write.map((w) => ({ ...w, f: "f2" as FieldId, v: "9", src: "S5", lag: 4, ack: false })),
        fc.record({
          t: fc.constant("delete" as const),
          src: fc.subarray(["S1", "S2", "S3", "S4"], { minLength: 1, maxLength: 2 }),
        }),
      ),
      { minLength: 2, maxLength: 3 },
    ),
  )
  .map(([head, pairs]) => [...head, ...pairs.flat()]);

/**
 * Random steps, then a write in effect (S2), a write with an older version over the same days
 * that does not acknowledge (S5, a candidate), a deletion of S2 that removes the conflict's cause,
 * and its cancellation: the candidate's item, superseded by the deletion, comes back with its kind
 * unchanged (the restored branch of «删除不增加未决事项»).
 */
const restoreAfterCancel: fc.Arbitrary<Step[]> = fc
  .tuple(
    fc.array(step, { maxLength: 4 }),
    fc.nat({ max: DAYS.length - 2 }),
    fc.constantFrom<"open" | "next">("open", "next"),
  )
  .map(([head, from, to]) => [
    ...head,
    {
      t: "write",
      f: "f2",
      v: "2",
      src: "S2",
      from,
      to: "open",
      lag: 0,
      explicit: false,
      ack: true,
    },
    { t: "write", f: "f2", v: "9", src: "S5", from, to, lag: 1, explicit: false, ack: false },
    { t: "delete", src: ["S2"] },
    { t: "cancel", back: 0 },
  ]);

/** Sources the log's writes cite: as a source of a field or as evidence for an interval. */
/**
 * Whether a person decided on the row (a resolution, a confirmation or rejection, an undo) after
 * deletion `id` while it touched the row: in the first version a decision on a row a pending
 * deletion affects is refused, so a log cancelling `id` after one is not one the kernel records
 * (03-deletion «撤回与宽限期»). The generators leave such cancellations out.
 */
function decisionInGracePeriod(log: readonly LogEntry[], id: string): boolean {
  const at = log.findIndex((e) => e.kind === "deletion" && e.id === id);
  const d = log[at];
  if (d === undefined || d.kind !== "deletion") return false;
  const cited = new Set(citedSources(log.slice(0, at)));
  if (!d.sources.some((x) => cited.has(x))) return false;
  return log
    .slice(at + 1)
    .some(
      (e) =>
        e.kind === "resolve" || e.kind === "confirm" || e.kind === "reject" || e.kind === "undo",
    );
}

function citedSources(log: readonly LogEntry[]): string[] {
  const out = new Set<string>();
  for (const e of log) {
    if (e.kind !== "write") continue;
    for (const x of Object.values(e.fields)) for (const y of x?.sources ?? []) out.add(y);
    for (const y of e.validSources ?? []) out.add(y);
  }
  return [...out].sort();
}

/**
 * Steps, and sets of one or two sources to delete after them: mostly sources the log cites, now
 * and then any. `c` is a third set, empty a quarter of the time; with `redo`, the orders compared also
 * delete a set, cancel that deletion and delete it again later.
 */
const withTwoSets = (schema: TableSchema, from: fc.Arbitrary<Step[]> = steps) =>
  from.chain((st) => {
    const cited = citedSources(extend(schema, [], st, 10));
    const any = fc.subarray(SOURCES, { minLength: 1, maxLength: 2 });
    const one =
      cited.length > 0
        ? fc.oneof(
            {
              weight: 7,
              arbitrary: fc.subarray(cited, { minLength: 1, maxLength: Math.min(2, cited.length) }),
            },
            { weight: 1, arbitrary: any },
          )
        : any;
    return fc.record({
      st: fc.constant(st),
      a: one,
      b: one,
      c: fc.oneof(
        { weight: 1, arbitrary: fc.constant([] as string[]) },
        { weight: 3, arbitrary: one },
      ),
      redo: fc.boolean(),
    });
  });

/**
 * Random steps, a deletion carried out right after it is confirmed, then writes: writes judged on
 * what the execution left (an earlier deletion's record of its change possibly removed).
 */
const executeThenWriteSteps: fc.Arbitrary<Step[]> = fc
  .tuple(
    fc.array(step, { minLength: 1, maxLength: 5 }),
    fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
    fc.array(write, { minLength: 1, maxLength: 3 }),
  )
  .map(([before, src, after]) => [
    ...before,
    { t: "delete" as const, src },
    { t: "execute" as const, back: 0 },
    ...after,
  ]);

/** Writes, then an undo of one of them: a revert with write-back items for deletions to restate. */
const revertSteps: fc.Arbitrary<Step[]> = fc
  .tuple(fc.array(write, { minLength: 2, maxLength: 5 }), fc.nat({ max: 2 }))
  .map(([ws, back]) => [...ws, { t: "undo" as const, back }]);

/**
 * Original items of one write split and joined again (09 §5.7), modelled on the counterexamples
 * found by the order-independence properties: a first write; one to three writes that split the
 * timeline; a write with the ver of the first write (so the others are changes it did not see),
 * often with the first write's value, split into candidate and corroborating items; an undo of
 * it; then up to two writes that may join segments again (default ends among them). Values, dates, sources and evidence are random; which sources are
 * deleted, in which order and with which cancellations comes from the property.
 */
const cutSteps: fc.Arbitrary<Step[]> = fc
  .record({
    base: fc.constantFrom("1", "2", "3"),
    cutters: fc.array(
      write.map((w) => ({
        ...w,
        f: "f2" as FieldId,
        src: w.src === "S1" || w.src === "S2" ? "S3" : w.src,
        lag: 0,
        ack: true,
      })),
      { minLength: 1, maxLength: 3 },
    ),
    // Cutters mostly change the value, so the old write is a candidate there and corroborates
    // elsewhere: covered and uncovered items of one write, which deletions can join.
    cutterChanges: fc.array(fc.constantFrom(true, true, true, false), {
      minLength: 3,
      maxLength: 3,
    }),
    old: fc.record({
      sameValue: fc.constantFrom(true, true, true, false),
      v: fc.constantFrom("1", "2", "3"),
      from: fc.nat({ max: 1 }),
      to: fc.constantFrom<"open" | "next">("open", "open", "next"),
    }),
    joiners: fc.array(
      write.map((w) => ({ ...w, f: "f2" as FieldId, lag: 0, ack: true })),
      { maxLength: 2 },
    ),
  })
  .map(({ base, cutters, cutterChanges, old, joiners }): Step[] => {
    const other = (v: string) => (v === "1" ? "2" : "1");
    return [
      { ...FIRST, v: base, src: "S1" },
      ...cutters.map((c, i) => ({ ...c, v: cutterChanges[i] ? other(base) : base })),
      {
        t: "write",
        f: "f2",
        v: old.sameValue ? base : old.v,
        src: "S2",
        from: old.from,
        to: old.to,
        // Its ver is the first write's: written at 10 * (2 + n), seen 10.
        lag: cutters.length,
        explicit: true,
        ack: true,
      },
      { t: "undo", back: 0 },
      ...joiners,
    ];
  });

/**
 * `cutSteps` with sets to delete drawn from the sources the log cites (the first write's S1 and
 * those that split or join the old write), never the old write's own S2: deleting it removes the
 * write whose items are split and joined.
 */
const cutSets = cutSteps.chain((st) => {
  const cited = citedSources(extend(STATE, [], st, 10)).filter((x) => x !== "S2");
  const one = fc.subarray(cited.length > 0 ? cited : ["S1"], {
    minLength: 1,
    maxLength: Math.min(2, Math.max(1, cited.length)),
  });
  return fc.record({
    st: fc.constant(st),
    a: one,
    b: one,
    c: fc.oneof(
      { weight: 1, arbitrary: fc.constant([] as string[]) },
      { weight: 3, arbitrary: one },
    ),
    redo: fc.boolean(),
  });
});

/**
 * The row or entity gone after one deletion and back after the other: #11 (S1) everywhere; #21
 * (S5) with the version before #11, a candidate; #31 (S4) corroborates on the first stretch;
 * take_previous on #21's item writes back "no value" where #21 is; #51 (S1) restates #31's value
 * there, awaiting. Deleting S1 leaves only #31 under the write-back: nothing has a value. Deleting
 * S5 takes the write-back's reason away: #31 gives the value again.
 */
const goneAndBack: fc.Arbitrary<{
  st: Step[];
  a: string[];
  b: string[];
  c: string[];
  redo: boolean;
}> = fc.constant({
  st: [
    {
      t: "write",
      f: "f2",
      v: "1",
      src: "S1",
      from: 0,
      to: "open",
      lag: 0,
      explicit: false,
      ack: true,
    },
    {
      t: "write",
      f: "f2",
      v: "2",
      src: "S5",
      from: 0,
      to: "open",
      lag: 1,
      explicit: false,
      ack: false,
    },
    { t: "write", f: "f2", v: "1", src: "S4", from: 0, to: 1, lag: 0, explicit: true, ack: false },
    { t: "resolve", decision: "take_previous" },
    { t: "write", f: "f2", v: "1", src: "S1", from: 0, to: 1, lag: 0, explicit: true, ack: false },
  ],
  a: ["S1"],
  b: ["S5"],
  c: [],
  redo: false,
});

/**
 * A log, two deleted sets and the further operations: random; a revert restated by the
 * deletions, an undo of it first among the further operations; or the row or entity gone after
 * one deletion and back after the other, an undo first.
 */
const furtherCase = (schema: TableSchema) =>
  fc.oneof(
    {
      weight: 1,
      arbitrary: fc.tuple(
        withTwoSets(schema),
        fc.array(furtherStep, { minLength: 1, maxLength: 4 }),
      ),
    },
    {
      weight: 2,
      arbitrary: fc.tuple(cutSets, fc.array(furtherStep, { maxLength: 2 })),
    },
    {
      weight: 2,
      arbitrary: fc.tuple(
        withTwoSets(schema, revertSteps),
        fc
          .array(furtherStep, { maxLength: 2 })
          .map((xs): Step[] => [{ t: "undoRevert", back: 0 }, ...xs]),
      ),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(
        goneAndBack,
        fc
          .array(furtherStep, { maxLength: 2 })
          .map((xs): Step[] => [{ t: "undo", back: 0 }, ...xs]),
      ),
    },
  );

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

const etKey = (x: { event: number; target: string }) => `${x.event}/${x.target}`;

/**
 * The deletion orders compared for «顺序无关», after a log ending at operation `last`: disjoint
 * sets, none pending, each deleted once and not cancelled in the end. With three sets, four of
 * the six orders; with `redo`, also orders that first delete a set, cancel that deletion and
 * delete the set again later; and all sets deleted at once. Undefined when fewer than two sets
 * are left non-empty. Each order takes at most seven operation numbers after `last`.
 */
/**
 * The same deletion events with each deletion never cancelled among them carried out right after
 * it is confirmed (`execute`), numbered again in order from the first.
 */
function withExecutions(ds: readonly LogEntry[]): LogEntry[] {
  const cancelled = new Set(ds.filter((e) => e.kind === "cancel").map((e) => e.id));
  const first = ds[0]?.op ?? 0;
  const out: LogEntry[] = [];
  for (const e of ds) {
    out.push({ ...e, op: first + out.length } as LogEntry);
    if (e.kind === "deletion" && !cancelled.has(e.id)) {
      out.push({ kind: "execute", op: first + out.length, id: e.id });
    }
  }
  return out;
}

function deletionOrders(
  log: readonly LogEntry[],
  sets: { a: string[]; b: string[]; c: string[]; redo: boolean },
  pending: ReadonlySet<string>,
): { orders: LogEntry[][]; parts: string[][] } | undefined {
  const aOnly = sets.a.filter((x) => !sets.b.includes(x) && !pending.has(x));
  const bOnly = sets.b.filter((x) => !pending.has(x));
  const cOnly = sets.c.filter((x) => !aOnly.includes(x) && !bOnly.includes(x) && !pending.has(x));
  if (aOnly.length === 0 || bOnly.length === 0) return undefined;
  const parts = cOnly.length > 0 ? [aOnly, bOnly, cOnly] : [aOnly, bOnly];
  const last = Math.max(...log.map((o) => o.op));
  const perms =
    parts.length === 3
      ? [
          [0, 1, 2],
          [1, 2, 0],
          [2, 0, 1],
          [2, 1, 0],
        ]
      : [
          [0, 1],
          [1, 0],
        ];
  const seqs: { redo?: number; perm: number[] }[] = perms.map((perm) => ({ perm }));
  if (sets.redo)
    seqs.push({ redo: 0, perm: perms[1] as number[] }, { redo: 1, perm: perms[0] as number[] });
  const orders = seqs.map(({ redo, perm }) => {
    const out: LogEntry[] = [];
    const at = () => last + 1 + out.length;
    if (redo !== undefined) {
      out.push({ kind: "deletion", op: at(), id: `pi_r${redo}`, sources: parts[redo] as string[] });
      out.push({ kind: "cancel", op: at(), id: `pi_r${redo}` });
    }
    for (const i of perm) {
      out.push({ kind: "deletion", op: at(), id: `pi_${i}`, sources: parts[i] as string[] });
    }
    return out;
  });
  orders.push([{ kind: "deletion", op: last + 1, id: "pi_all", sources: parts.flat() }]);
  return { orders, parts };
}
const isPending = (x: ItemResult) =>
  (x.status === "candidate" || x.status === "awaiting") && x.closed === undefined;

/** Sources pending deletion at the end of a run. */
function pendingSources(run: LogEvaluation): Set<string> {
  const pending = new Map<string, readonly string[]>();
  for (const s of run.steps) {
    if (s.refused) continue;
    if (s.entry.kind === "deletion") pending.set(s.entry.id, s.entry.sources);
    if (s.entry.kind === "cancel") pending.delete(s.entry.id);
  }
  return new Set([...pending.values()].flat());
}

/** Statuses each (write, field) got at write time: from the step at which the op entered. */
function writeTimeStatuses(run: LogEvaluation): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of run.steps) {
    if (s.refused || s.entry.kind === "deletion" || s.entry.kind === "cancel") continue;
    const e = s.entry;
    for (const x of s.state.items) {
      if (x.op === e.op) out.set(etKey(x), [...(out.get(etKey(x)) ?? []), x.status]);
    }
  }
  return out;
}

/** Whether deleting `sources` after `log` changes its state or items. */
function changes(schema: TableSchema, log: LogEntry[], sources: string[]): boolean {
  const last = Math.max(...log.map((o) => o.op));
  const before = evaluateLog(schema, log).final;
  const after = evaluateLog(schema, [
    ...log,
    { kind: "deletion", op: last + 1, id: "pi_probe", sources },
  ]).final;
  return JSON.stringify(stateWithoutIndices(after)) !== JSON.stringify(stateWithoutIndices(before));
}

const counts = {
  restoredByDeletion: 0,
  restoredByCancel: 0,
  keptEffective: 0,
  refusedInBase: 0,
  putBackDiffers: 0,
  withDecisions: 0,
  decidedInGrace: 0,
  decidedDiffers: 0,
  undoOfRevert: 0,
  undoOfRevertRegained: 0,
  mergePath: 0,
  replacedAfterEarlier: 0,
  furtherOps: 0,
  threeDeletions: 0,
  redo: 0,
  extended: 0,
  executeSteps: 0,
  prefixLogs: 0,
  executeThenWrite: 0,
  executedOrders: 0,
  revokes: 0,
  twoFieldWrites: 0,
  resolvesOnExistence: 0,
  /** Cancellations of a deletion keeping something in effect or superseded (not compared). */
  cancelKeeps: 0,
};

/**
 * Whether the cancellation of deletion `id` in `log` keeps a write in effect or an item superseded
 * (03-deletion «撤回与宽限期»): then it leaves a trace by the spec.
 */
function cancelKeeps(schema: TableSchema, log: readonly LogEntry[], id: string): boolean {
  return evaluateLog(schema, log).steps.some(
    (x) =>
      x.entry.kind === "cancel" &&
      x.entry.id === id &&
      ((x.keptSuperseded?.length ?? 0) > 0 || (x.keptEffective?.length ?? 0) > 0),
  );
}

/**
 * No segment endpoint comes from a deleted source: every endpoint of the final state is a date
 * that some write with its sources intact gave itself (deletions cancelled since do not count).
 */
function noEndpointLeak(full: readonly LogEntry[], run: LogEvaluation): void {
  const pending = new Map<string, readonly string[]>();
  for (const st of run.steps) {
    if (st.refused) continue;
    if (st.entry.kind === "deletion") pending.set(st.entry.id, st.entry.sources);
    if (st.entry.kind === "cancel") pending.delete(st.entry.id);
  }
  const deleted = new Set([...pending.values()].flat());
  const dates = new Set<string>();
  for (const o of full) {
    // A revoke's interval gives endpoints too, unless its sources are deleted.
    if (o.kind === "revoke") {
      if (o.valid === undefined || o.validSources?.some((y) => deleted.has(y))) continue;
      if (o.valid.from.mode === "given") dates.add(o.valid.from.value);
      if (o.valid.to.mode === "given") dates.add(o.valid.to.value);
      continue;
    }
    if (o.kind !== "write" || o.valid === undefined || o.valid === "corrected_span") continue;
    if (Object.values(o.fields).some((x) => x?.sources.some((y) => deleted.has(y)))) continue;
    if (o.valid.from.mode === "given") dates.add(o.valid.from.value);
    if (o.valid.to.mode === "given") dates.add(o.valid.to.value);
  }
  for (const segs of Object.values(run.final.fields)) {
    for (const seg of segs ?? []) {
      for (const x of seg.valid)
        for (const p of [x.from, x.to]) if (p !== null) expect(dates).toContain(p);
    }
  }
}

/**
 * «撤回还原» (03-deletion «推论»): delete `pi_d` (the last entry of `withD`), then the grace-period
 * entries, then cancel at `cancelOp`; the part grace-period writes did not cover must be as the
 * replay of `prefix` and the grace-period entries without the deletion, with the writes the
 * cancellation kept in effect forced in effect and those it kept superseded forced out. Compared:
 * field values outside grace-period coverage, and the judgement and openness of every item of
 * the operations in `prefix`. The cancellation's own rules go first: a grace-period decision the
 * replay refuses, and a candidate put back and judged again, are compared by what they gave.
 * Undefined when the deletion itself is refused.
 */
/** Grace-period resolutions' candidates partly the same as the value after the cancellation. */
let decidedPartial = 0;

function checkCancelRestores(
  schema: TableSchema,
  prefix: readonly LogEntry[],
  withD: readonly LogEntry[],
  graceAll: readonly LogEntry[],
  cancelOp: number,
):
  | {
      kept: number;
      refusedInBase: number;
      putBackDiffers: number;
      withDecisions: boolean;
      decided: { nonEmpty: boolean; differs: boolean };
    }
  | undefined {
  const state = schema.kind === "state";
  const run = evaluateLog(schema, [
    ...withD,
    ...graceAll,
    { kind: "cancel", op: cancelOp, id: "pi_d" },
  ]);
  // Entries refused in the run never entered the log; the baseline has none of them.
  const refused = new Set(run.steps.filter((x) => x.refused).map((x) => x.entry));
  if (refused.has(withD[withD.length - 1] as LogEntry)) return undefined;
  const grace = graceAll.filter((e) => !refused.has(e));
  const cancelStep = run.steps.at(-1);
  const kept = cancelStep?.keptEffective ?? [];
  const cancelled = run.final;
  // People's decisions in the grace period, as the run recorded them (what each decided): the
  // baseline executes them on those items (03-deletion «撤回与宽限期»: they stay after the
  // cancellation; a decision is as recorded in every replay).
  const decidedInGrace = new Map<number, readonly string[]>();
  for (const st of run.steps) {
    if (!st.refused && grace.includes(st.entry) && st.decided !== undefined) {
      decidedInGrace.set(st.entry.op, st.decided);
    }
  }
  const baseLog = [...prefix.filter((e) => !refused.has(e)), ...grace];
  const baseRun = evaluateLog(schema, baseLog, {
    forcedEffective: kept,
    forcedSuperseded: cancelStep?.keptSuperseded ?? [],
    forcedDecided: decidedInGrace,
  });
  const base = baseRun.final;
  // Checked without the record passed: each grace-period decision's items are, after the
  // cancellation, closed by it and of its kind (a resolution's candidates, a confirmation's or
  // rejection's awaiting items); a confirmation of items still there wrote its items.
  for (const [op, keys] of decidedInGrace) {
    const d = grace.find((e) => e.op === op);
    if (d === undefined || (d.kind !== "resolve" && d.kind !== "confirm" && d.kind !== "reject"))
      continue;
    const kind = d.kind === "resolve" ? "candidate" : "awaiting";
    const ofKey = cancelled.items.filter((x) => keys.includes(`${x.event}/${x.target}`));
    const still = ofKey.filter((x) => x.status !== "dropped");
    // The sameness rule comes first (05-time «同值的基准是写入方所见的版本»; 03-deletion «同值判断»):
    // a decided item the same as the version its write saw, over its whole range, is no change —
    // a corroboration with evidence pointed at, a no-op without; only an item still a change is
    // the one the decision closed. The seen version is recomputed apart: the log up to it, with
    // the deletions in force after the cancellation.
    for (const key of [...new Set(ofKey.map((x) => `${x.event}/${x.target}`))]) {
      const [ev, target] = key.split("/") as [string, string];
      const xs = ofKey.filter((x) => `${x.event}/${x.target}` === key);
      const live = xs.filter((x) => x.status !== "dropped");
      const o = [...withD, ...graceAll].find(
        (e): e is WriteOp => e.kind === "write" && e.event === Number(ev),
      );
      const input = target === "existence" ? undefined : o?.fields[target as FieldId];
      if (o === undefined || input === undefined) {
        for (const x of live) {
          expect({ op, item: etKey(x), status: x.status, closed: x.closed === true }).toEqual({
            op,
            item: etKey(x),
            status: kind,
            closed: true,
          });
        }
        continue;
      }
      const seenAt = o.seen ?? o.op - 1;
      const all: LogEntry[] = [...withD, ...graceAll, { kind: "cancel", op: cancelOp, id: "pi_d" }];
      const cancelledIds = new Set(all.flatMap((e) => (e.kind === "cancel" ? [e.id] : [])));
      // The state as of operation `at` in the replay after the cancellation, as 03-deletion
      // «重放规则» reads it (the «同值判断» row: the seen version as it is after the deletions; and
      // «撤回»: a cancelled deletion no longer counts as deleted) — not 05-time's write-time view:
      // the log up to `at` with the deletions in force now where they are (one confirmed before a
      // write changes how the writes between are judged), a cancelled deletion as never made, and
      // the deletions confirmed after `at` that are in force now (a deletion reaches back).
      // Fields a write left no value on when written stay no-ops in every replay (03-deletion,
      // deviation one: «写入时没有留下值的部分保持原样»), as the run judged them.
      const asWritten = all.map((e) => {
        if (e.kind !== "write") return e;
        const st = run.steps.find((x) => x.entry === e && !x.refused);
        if (st === undefined) return e;
        const noop = (Object.keys(e.fields) as FieldId[]).filter(
          (f) => !st.state.items.some((x) => x.event === e.event && x.target === f),
        );
        return noop.length > 0 ? { ...e, noop: [...(e.noop ?? []), ...noop] } : e;
      });
      const stateAt = (at: number) => {
        const later = all.flatMap((e) =>
          e.kind === "deletion" && e.op > at && !cancelledIds.has(e.id) ? e.sources : [],
        );
        // With what the cancellation recorded as kept in effect and kept superseded (people's
        // decisions in the grace period rest on them), as the baseline takes them.
        return evaluateLog(
          schema,
          [
            ...asWritten.filter(
              (e) =>
                e.op <= at &&
                !(e.kind === "deletion" && cancelledIds.has(e.id)) &&
                e.kind !== "cancel",
            ),
            ...(later.length > 0
              ? [{ kind: "deletion" as const, op: at + 0.5, id: "pi_at", sources: later }]
              : []),
          ],
          { forcedEffective: kept, forcedSuperseded: cancelStep?.keptSuperseded ?? [] },
        ).final;
      };
      const seenState = stateAt(seenAt);
      // A corroboration also needs the value still the same just before the write (05-time
      // «用同样的值写»): a part changed since the seen version is judged as an ordinary write.
      const nowState = stateAt(o.op - 1);
      const range = union(...xs.filter((x) => !isEmpty(x.valid)).map((x) => x.valid));
      const seenSegs = seenState.fields[target as FieldId] ?? [];
      const nowSegs = nowState.fields[target as FieldId] ?? [];
      const segs = state
        ? elementarySegments(
            endpoints([range, ...seenSegs.map((g) => g.valid), ...nowSegs.map((g) => g.valid)]),
          ).filter((g) => covers(range, g))
        : [{ from: null, to: null }];
      if (segs.length === 0) continue;
      const sameIn = (ev: Evaluation, gs: typeof seenSegs) =>
        segs.map(
          (g) =>
            (state || ev.exists) &&
            JSON.stringify(gs.find((h) => covers(h.valid, g))?.value) ===
              JSON.stringify(input.value),
        );
      const same = sameIn(seenState, seenSegs);
      const sameNow = sameIn(nowState, nowSegs);
      if (same.some(Boolean) && !same.every(Boolean)) {
        decidedPartial++;
        continue;
      }
      const shown = [...new Set(live.map((x) => `${x.status}${x.closed ? " closed" : ""}`))].sort();
      const expected = !same.every(Boolean)
        ? [`${kind} closed`]
        : !input.explicit
          ? []
          : [
              ...(sameNow.some(Boolean) ? ["corroborated"] : []),
              ...(sameNow.some((x) => !x) ? [`${kind} closed`] : []),
            ].sort();
      expect({ op, key, shown }).toEqual({ op, key, shown: expected });
    }
    // A confirmation of items still awaiting (still a change, not same-valued now) wrote its items.
    if (d.kind === "confirm" && still.some((x) => x.status === "awaiting")) {
      const wrote = cancelled.items.filter((x) => x.event === d.event && x.status !== "dropped");
      expect({ op, confirmationWrote: wrote.length > 0 }).toEqual({ op, confirmationWrote: true });
    }
  }
  const decidedNonEmpty = [...decidedInGrace.values()].some((k) => k.length > 0);
  const statsFile = process.env["DECIDED_STATS"];
  if (statsFile && decidedNonEmpty) appendFileSync(statsFile, `DECIDED ${schema.kind}\n`);
  const graceEvents = new Set(
    grace.filter((e): e is Op => e.kind !== "deletion" && e.kind !== "cancel").map((e) => e.event),
  );
  // A candidate the cancellation put back is judged again on the state at the cancellation
  // (03-deletion «撤回与宽限期»), which is the definition; the forced replay may judge it otherwise
  // (a write kept in effect can change its judgement there). Where the two judgements differ, its
  // intervals go by the cancellation's, not the replay's (03-deletion «推论» «撤回还原»).
  const putBackOf = (ev: Evaluation, x: { event: number; target: string }) =>
    ev.items.filter((y) => y.event === x.event && y.target === x.target);
  const judgedAs = (items: ItemResult[]) =>
    JSON.stringify(items.map((y) => [y.status, y.closed === true, y.valid]));
  const putBackDiffers = (cancelStep?.putBack ?? []).filter(
    (x) => judgedAs(putBackOf(cancelled, x)) !== judgedAs(putBackOf(base, x)),
  );
  for (const f of ["f2", "f3"] as FieldId[]) {
    const coveredBy = (ev: Evaluation): IvSet[] =>
      ev.items
        .filter(
          // A grace-period write to a required field also covers whether the row or
          // entity has a value there, which every field shows.
          (x) =>
            graceEvents.has(x.event) &&
            (x.target === f ||
              x.target === "existence" ||
              schema.required.includes(x.target as FieldId)),
        )
        .map((x) => x.valid);
    const rejudged = putBackDiffers
      .filter(
        (x) =>
          x.target === f ||
          x.target === "existence" ||
          schema.required.includes(x.target as FieldId),
      )
      .flatMap((x) => [...putBackOf(cancelled, x), ...putBackOf(base, x)].map((y) => y.valid));
    const covered = union(...coveredBy(cancelled), ...coveredBy(base), ...rejudged);
    const sets: IvSet[] = [covered, cancelled.gaps, base.gaps];
    for (const ev of [cancelled, base]) for (const x of ev.fields[f] ?? []) sets.push(x.valid);
    const segs = state ? elementarySegments(endpoints(sets)) : [{ from: null, to: null }];
    for (const g of segs) {
      if (covers(covered, g)) continue;
      const at = (ev: Evaluation) => {
        if (state && ev.gaps.some((x) => covers([x], g))) return "no value";
        if (!state && !ev.exists) return "no row";
        return JSON.stringify((ev.fields[f] ?? []).find((x) => covers(x.valid, g))?.value ?? null);
      };
      expect({ f, at: g, value: at(cancelled) }).toEqual({ f, at: g, value: at(base) });
    }
  }
  // Items of the operations before the deletion.
  const prefixEvents = new Set(
    prefix.filter((e): e is Op => e.kind !== "deletion" && e.kind !== "cancel").map((e) => e.event),
  );
  const excluded = new Set((cancelStep?.putBack ?? []).map((x) => String(x.event)));
  // A decision taken in the grace period is judged on the state after the deletion, and stays
  // in effect after the cancellation (03-deletion «撤回与宽限期»). The baseline may refuse it
  // (a take_candidate whose required field has no value there without the deletion): what it
  // closed is then the grace period's doing, covered like the parts its writes cover.
  const refusedInBase = baseRun.steps
    .filter((x) => x.refused && grace.includes(x.entry))
    .map((x) => x.entry);
  for (const e of refusedInBase) {
    if (e.kind === "resolve") for (const c of e.candidates) excluded.add(String(c));
    if (e.kind === "confirm") excluded.add(String(e.target));
  }
  // Per (write, target, status, openness): the business time its items cover. Index
  // bookkeeping (how a segment is cut into items, 09 §5.7) is not part of the state.
  const judgement = (ev: Evaluation) => {
    const by = new Map<string, IvSet[]>();
    for (const x of ev.items) {
      if (!prefixEvents.has(x.event) || x.status === "dropped") continue;
      if (excluded.has(String(x.event))) continue;
      const key = `${etKey(x)} ${x.status}${x.closed ? " closed" : ""}`;
      by.set(key, [...(by.get(key) ?? []), x.valid]);
    }
    return [...by.entries()].map(([key, vs]) => `${key} ${JSON.stringify(union(...vs))}`).sort();
  };
  expect(judgement(cancelled)).toEqual(judgement(base));
  // Whether passing the record made a difference: the same baseline judging the decisions anew.
  const differs =
    decidedNonEmpty &&
    JSON.stringify(
      judgement(
        evaluateLog(schema, baseLog, {
          forcedEffective: kept,
          forcedSuperseded: cancelStep?.keptSuperseded ?? [],
        }).final,
      ),
    ) !== JSON.stringify(judgement(base));
  if (statsFile && differs) appendFileSync(statsFile, `DIFFERS ${schema.kind}\n`);
  if (statsFile) appendFileSync(statsFile, `PARTIAL ${decidedPartial}\n`);
  return {
    kept: kept.length,
    refusedInBase: refusedInBase.length,
    putBackDiffers: putBackDiffers.length,
    withDecisions: grace.some(
      (e) =>
        e.kind === "resolve" || e.kind === "confirm" || e.kind === "reject" || e.kind === "undo",
    ),
    decided: { nonEmpty: decidedNonEmpty, differs },
  };
}

describe.each(both)("%s table", (_, schema, state) => {
  it("successive deletions: A then B = B then A = {A, B} at once, after any log", () => {
    // 02-architecture §11 «顺序无关». The log before the deletions keeps its own deletions,
    // cancellations and grace-period writes. Two or three sets (about 0.17 of the samples run
    // have three), in several orders; in about 0.4, also orders that delete a set, cancel that
    // deletion and delete it again later (its restatements stay among the items' interval blocks,
    // 03-deletion «回掉的权威定义» step 6).
    // Half the samples come from `cutSteps`, which reach original items landing in one segment
    // at a deletion confirmation, where they merge (09 §5.7); that share is checked apart (state
    // table only).
    // Measured share of hits: about 0.79 (state) and 0.78 (event). Of merges: about 0.36 (state).
    const hits = new Hits(0.5);
    const merges = new Hits(0.2);
    fc.assert(
      fc.property(
        fc.oneof(withTwoSets(schema), cutSets, withTwoSets(schema, executeThenWriteSteps)),
        hits.track(
          merges.track((sets) => {
            const mergedBefore = segmentStats.merged;
            const log = extend(schema, [], sets.st, 10);
            const before = evaluateLog(schema, log);
            const pending = pendingSources(before);
            // A deletion carried out with an accepted write after it, in the log before the
            // deletion orders: the later write judged on what the execution left (its L).
            const accepted = before.steps.filter((st) => !st.refused).map((st) => st.entry.kind);
            const firstExec = accepted.indexOf("execute");
            counts.prefixLogs++;
            if (firstExec >= 0 && accepted.slice(firstExec + 1).includes("write"))
              counts.executeThenWrite++;
            const d = deletionOrders(log, sets, pending);
            fc.pre(d !== undefined);
            const [p0, p1, p2] = d.parts;
            if (changes(schema, log, p0 ?? []) && changes(schema, log, p1 ?? [])) hits.hit();
            if (p2 !== undefined) counts.threeDeletions++;
            if (sets.redo) counts.redo++;
            const [x, ...rest] = d.orders.map((ds) =>
              stateWithoutIndices(evaluateLog(schema, [...log, ...ds]).final),
            );
            if (segmentStats.merged > mergedBefore) merges.hit();
            counts.mergePath += segmentStats.merged - mergedBefore;
            for (const y of rest) expect(y).toEqual(x);
            // Carrying the deletions out as they come (03-deletion «到期物理删除»: the state
            // does not change; a later deletion's replay reads what is left) gives the same
            // values; indices may differ (09 §5.7: they follow the blocks left readable).
            for (const ds of d.orders) {
              const run = evaluateLog(schema, [...log, ...withExecutions(ds)]);
              if (run.steps.some((st) => st.entry.kind === "execute" && !st.refused))
                counts.executedOrders++;
              expect(stateWithoutIndices(run.final)).toEqual(x);
            }
          }),
        ),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    if (state) merges.check();
  });

  it("successive deletions, carried out or not: an earlier write judged on a record resting on a deleted contribution (seed -516159584)", () => {
    // #71 (f2 1, f3 b) is a candidate on f3 when written, judged again in every replay. An
    // earlier deletion's record of its change rests on a contribution S5 deletes; whether that
    // deletion is carried out or not, #71 is judged on the same (09-references «冲突判据»: by the
    // deleted set). Carried out, it used to be judged otherwise.
    if (!state) return;
    const sets = {
      st: [
        {
          t: "write",
          f: "f2",
          v: "1",
          src: "S3",
          from: 0,
          to: "open",
          lag: 0,
          explicit: false,
          ack: false,
        },
        { t: "delete", src: ["S2"] },
        { t: "resend", back: 0, src: "S2", explicit: true },
        {
          t: "write",
          f: "f2",
          v: "1",
          src: "S1",
          from: 0,
          to: 0,
          lag: 0,
          explicit: false,
          ack: false,
          also: "b",
        },
        {
          t: "write",
          f: "f2",
          v: "1",
          src: "S5",
          from: 0,
          to: "open",
          lag: 0,
          explicit: false,
          ack: false,
        },
        { t: "cancel", back: 0 },
        {
          t: "write",
          f: "f2",
          v: "1",
          src: "S1",
          from: 0,
          to: "open",
          lag: 1,
          explicit: false,
          ack: false,
          also: "b",
        },
        {
          t: "write",
          f: "f2",
          v: "1",
          src: "S4",
          from: 0,
          to: "open",
          lag: 0,
          explicit: false,
          ack: false,
        },
      ] as Step[],
      a: ["S5"],
      b: ["S3"],
      c: [] as string[],
      redo: false,
    };
    const log = extend(schema, [], sets.st, 10);
    const d = deletionOrders(log, sets, pendingSources(evaluateLog(schema, log)));
    expect(d).toBeDefined();
    const orders = d?.orders ?? [];
    const [x] = orders.map((ds) => stateWithoutIndices(evaluateLog(schema, [...log, ...ds]).final));
    for (const ds of orders) {
      expect(stateWithoutIndices(evaluateLog(schema, [...log, ...ds]).final)).toEqual(x);
      expect(
        stateWithoutIndices(evaluateLog(schema, [...log, ...withExecutions(ds)]).final),
      ).toEqual(x);
    }
  });

  it("successive deletions: the same further operations after either order give the same result", () => {
    // 03-deletion «推论» «顺序无关»: writes carrying the current ver, and operations judged without
    // a ver (undo, take_previous and the other decisions), appended after each of the deletion
    // orders of the property above (two or three sets, with and without deleting again after a
    // cancellation) give the same state and items. A write with an old ver may be judged
    // differently: a deletion counts as a change over the intervals it recorded.
    // One sample in four comes from `cutSteps` (see the property above); the share of samples
    // reaching a merge is checked apart (state table only).
    // Measured share of hits: about 0.86 (state) and 0.84 (event). Of merges: about 0.21 (state).
    const hits = new Hits(0.7);
    const merges = new Hits(0.12);
    fc.assert(
      fc.property(
        furtherCase(schema),
        hits.track(
          merges.track(([sets, after]) => {
            const mergedBefore = segmentStats.merged;
            const log = extend(schema, [], sets.st, 10);
            const pending = pendingSources(evaluateLog(schema, log));
            const d = deletionOrders(log, sets, pending);
            fc.pre(d !== undefined);
            const [p0, p1, p2] = d.parts;
            if (changes(schema, log, p0 ?? []) && changes(schema, log, p1 ?? [])) hits.hit();
            if (p2 !== undefined) counts.threeDeletions++;
            if (sets.redo) counts.redo++;
            const last = Math.max(...log.map((o) => o.op));
            const orders = d.orders;
            // Built once (decisions aimed at items open after the first order) and appended to
            // every order; each write and revoke carries the current ver: nothing happened after its `seen`.
            const ab = [...log, ...(orders[0] as LogEntry[])];
            const tail = extend(schema, ab, after, last + 10)
              .slice(ab.length)
              .map((e) =>
                e.kind === "write" || e.kind === "revoke" ? { ...e, seen: e.op - 1 } : e,
              );
            if (tail.some((e) => e.kind === "undo" || e.kind === "resolve")) counts.furtherOps++;
            const [x, ...rest] = orders.map((ds) =>
              stateWithoutIndices(evaluateLog(schema, [...log, ...ds, ...tail]).final),
            );
            if (segmentStats.merged > mergedBefore) merges.hit();
            counts.mergePath += segmentStats.merged - mergedBefore;
            for (const y of rest) expect(y).toEqual(x);
          }),
        ),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    if (state) merges.check();
  });

  it("a cancelled deletion leaves no trace: delete A, cancel A, delete B = delete B (either cancel point)", () => {
    // 03-deletion «撤回与宽限期»: a cancelled deletion no longer counts as deleted, so it must not
    // change what a later deletion gives, including how items are numbered (step 6). No grace-period
    // writes in between: nothing is kept in effect.
    // Unless the cancellation keeps an item superseded, which a write made while a candidate was
    // taken out by any pending deletion can cause, an earlier one in the log too, cancelled since:
    // "结果只取决于被删集合"只在宽限期内没有写入、撤回没有留下保持生效与保持已被取代时成立
    // (03-deletion «撤回与宽限期»). Such an order is not compared, and counted (`cancelKeeps`); the
    // fixed case below holds one.
    // Measured share of hits: about 0.66 (state) and 0.64 (event).
    const hits = new Hits(0.35);
    fc.assert(
      fc.property(
        withTwoSets(schema),
        hits.track((sets) => {
          const log = extend(schema, [], sets.st, 10);
          const pending = pendingSources(evaluateLog(schema, log));
          const d = deletionOrders(log, { ...sets, c: [], redo: false }, pending);
          fc.pre(d !== undefined);
          const [a, b] = d.parts as [string[], string[]];
          if (changes(schema, log, a) && changes(schema, log, b)) hits.hit();
          const last = Math.max(...log.map((o) => o.op));
          const run = (entries: LogEntry[]) =>
            stateWithoutIndices(evaluateLog(schema, [...log, ...entries]).final);
          const onlyB = run([{ kind: "deletion", op: last + 1, id: "pi_b", sources: b }]);
          for (const entries of [
            [
              { kind: "deletion", op: last + 1, id: "pi_a", sources: a },
              { kind: "cancel", op: last + 2, id: "pi_a" },
              { kind: "deletion", op: last + 3, id: "pi_b", sources: b },
            ],
            [
              { kind: "deletion", op: last + 1, id: "pi_a", sources: a },
              { kind: "deletion", op: last + 2, id: "pi_b", sources: b },
              { kind: "cancel", op: last + 3, id: "pi_a" },
            ],
          ] as LogEntry[][]) {
            if (cancelKeeps(schema, [...log, ...entries], "pi_a")) {
              counts.cancelKeeps++;
              continue;
            }
            expect(run(entries)).toEqual(onlyB);
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("taking a candidate changes no value a write outside its cover set gives", () => {
    // 01-objects «各处理方式的执行语义» take_candidate; 03-deletion «搬运的值»: a take_candidate
    // records its merge base and cover set O; a write in effect after the merge base and before
    // the resolution, not in O and not a candidate of the item, keeps giving its value where it
    // gives one, under any deletions. Checked against the same log with the resolution replaced
    // by one of the same operation number that writes nothing: a keep_effective listing the same
    // candidates, which stay the candidates it closed, so the writes between them and the
    // resolution are judged as with it (the later operations keep the versions they saw):
    // wherever such a write gives the value there, the take does not give it in the log with the
    // resolution. The
    // item's own candidates are left out: the resolution closes the ones it does not take, so
    // without it a deletion may put them in effect, and the taken one is the resolution's value.
    // Reaching the check is built in on the state table (the fixed sample below); the random
    // samples, half of them drawn on the reaching shape, only guard against a generator gone
    // degenerate. On the event table O lists every
    // write in effect on the unit when the item is resolved, so a write outside O giving a value
    // there only comes from a deletion putting another item's candidate in effect: the samples
    // are checked, a share of hits is not required.
    const hits = new Hits(Number.MIN_VALUE);
    let reverseChecked = 0;
    let restorableMet = 0;
    let revHits = 0;
    const check = (
      h: { hit(): void },
      log: LogEntry[],
      rev: { hit(): void } = { hit() {} },
      // The evaluator checked; a test hands a wrong one to show the check turns red.
      evaluate: typeof evaluateLog = evaluateLog,
    ) => {
      const run = evaluate(schema, log);
      for (const tc of run.final.takeCandidates) {
        const resolve = log.find((e) => e.kind === "resolve" && e.op === tc.op);
        if (resolve?.kind !== "resolve" || resolve.take === undefined) continue;
        const cover = new Set(tc.cover.map((e) => `${e.event}/${e.target}`));
        // Every recorded restorable item, checked apart from the evaluator's record: the log up to
        // the take replayed without the deletions pending then has it in effect over the recorded
        // interval, where the log as it was then has not (directly removed, or judged otherwise
        // through the removal: either way back once those deletions are cancelled).
        if ((tc.restorable ?? []).length > 0) {
          const prefix = log.filter((e) => e.op < tc.op);
          const cancelledThen = new Set(prefix.flatMap((e) => (e.kind === "cancel" ? [e.id] : [])));
          const pendingThen = new Set(
            prefix.flatMap((e) =>
              e.kind === "deletion" && !cancelledThen.has(e.id) ? [e.id] : [],
            ),
          );
          const asThen = evaluateLog(schema, prefix).final;
          const withoutPending = evaluateLog(
            schema,
            prefix.filter((e) => !(e.kind === "deletion" && pendingThen.has(e.id))),
          ).final;
          const inEffect = (ev: Evaluation, key: string) =>
            union(
              ...ev.items
                .filter((x) => `${x.event}/${x.target}` === key && x.status === "applied")
                .map((x) => x.valid),
            );
          for (const r of tc.restorable ?? []) {
            const gone = subtract(inEffect(withoutPending, r.key), inEffect(asThen, r.key));
            expect({
              take: tc.op,
              item: r.key,
              eligible: isEmpty(subtract(r.valid, gone)),
            }).toEqual({
              take: tc.op,
              item: r.key,
              eligible: true,
            });
          }
        }
        const without = evaluate(
          schema,
          log.map((e) =>
            e === resolve
              ? {
                  kind: "resolve" as const,
                  op: resolve.op,
                  event: resolve.event,
                  decision: "keep_effective" as const,
                  candidates: resolve.candidates,
                  unit: resolve.unit,
                }
              : e,
          ),
        ).final;
        // Where the take would write: the taken write's items on the unit (a hit is a write
        // outside O there, whether or not it covers the take).
        const taken = union(
          ...run.final.items
            .filter((x) => x.event === resolve.take && x.status !== "dropped")
            .map((x) => x.valid),
        );
        // Carried from one of the item's candidates, following `carried` only (a revert writing a
        // candidate's value back, a revert of that, ...): whether it gives a value depends on the
        // resolution as the candidate's own does, which closes the candidate; without the
        // resolution a deletion may put the candidate in effect, and what is carried from it with
        // it (the event-table counterexample below). Other references are not followed.
        const fromCandidate = (
          y: { readonly carried?: readonly { event: number; target: string; k: number }[] },
          seen: Set<string> = new Set(),
        ): boolean =>
          (y.carried ?? []).some((c) => {
            if (resolve.candidates.includes(c.event)) return true;
            const key = `${c.event}/${c.target}/${c.k}`;
            if (seen.has(key)) return false;
            seen.add(key);
            const z = without.items.find(
              (i) => i.event === c.event && i.target === c.target && i.k === c.k,
            );
            return z !== undefined && fromCandidate(z, seen);
          });
        for (const [f, segs] of Object.entries(without.fields)) {
          for (const seg of segs ?? []) {
            if (seg.by === undefined) continue;
            const by = seg.by;
            const x = without.items.find(
              (y) => y.event === by.event && y.target === by.target && y.k === by.k,
            );
            if (
              x === undefined ||
              x.op <= tc.mergeBase ||
              x.op >= tc.op ||
              resolve.candidates.includes(x.event) ||
              fromCandidate(x) ||
              cover.has(`${x.event}/${x.target}`)
            ) {
              continue;
            }
            // Removed by a deletion pending when the take was judged and back since: the take wins
            // there (03-deletion «撤回与宽限期»: a take is a write in the grace period).
            const back = union(
              ...(tc.restorable ?? [])
                .filter((r) => r.key === `${x.event}/${x.target}`)
                .map((r) => r.valid),
            );
            if (!isEmpty(intersect(seg.valid, back))) restorableMet++;
            if (isEmpty(subtract(seg.valid, back))) continue;
            if (!isEmpty(intersect(seg.valid, taken))) h.hit();
            // Where x gives the value without the resolution, the take never gives it. (Later
            // operations may be judged otherwise without the resolution, so the values there are
            // not compared, only who gives them.)
            const now = run.final.fields[f as FieldId] ?? [];
            const ends = endpoints([seg.valid, back, ...now.map((g) => g.valid)]);
            for (const g of state ? elementarySegments(ends) : [{ from: null, to: null }]) {
              if (!covers(seg.valid, g) || covers(back, g)) continue;
              const giver = now.find((h2) => covers(h2.valid, g))?.by?.event;
              expect({ f, at: g, x: x.event, takeGives: giver === resolve.event }).toEqual({
                f,
                at: g,
                x: x.event,
                takeGives: false,
              });
            }
          }
        }
        // The other direction: where the taken write's items lie and, without the resolution,
        // no write outside O gives the value, the take gives it, unless the value there is
        // already the taken one or there is no value either way (a hole). Checked when nothing
        // but deletions and cancellations follows the take, on a field unit, the take not refused.
        const takenOp = log.find((e) => e.kind === "write" && e.event === resolve.take);
        const onlyDeletionsAfter = log
          .filter((e) => e.op > tc.op)
          .every((e) => e.kind === "deletion" || e.kind === "cancel");
        const refused = run.steps.some((st) => st.entry === resolve && st.refused);
        if (resolve.unit === "existence" || takenOp?.kind !== "write" || !onlyDeletionsAfter)
          continue;
        if (refused) continue;
        for (const f of (Array.isArray(resolve.unit)
          ? resolve.unit
          : [resolve.unit]) as FieldId[]) {
          const input = takenOp.fields[f];
          if (input === undefined) continue;
          const mine = union(
            ...run.final.items
              .filter((x) => x.event === resolve.take && x.target === f && x.status !== "dropped")
              .map((x) => x.valid),
          );
          const now = run.final.fields[f] ?? [];
          const was = without.fields[f] ?? [];
          const ends = endpoints([mine, ...now.map((g) => g.valid), ...was.map((g) => g.valid)]);
          for (const g of state ? elementarySegments(ends) : [{ from: null, to: null }]) {
            if (!covers(mine, g)) continue;
            const giver = now.find((h2) => covers(h2.valid, g));
            reverseChecked++;
            if (giver?.by?.event === resolve.event) {
              rev.hit();
              continue;
            }
            if (giver !== undefined && JSON.stringify(giver.value) === JSON.stringify(input.value))
              continue;
            // No value there with the take and without it (a write-back of "no value", which the
            // view names no giver for, or nothing at all): the take gives nothing there and changes
            // nothing a write gives.
            const wasHere = was.find((h2) => covers(h2.valid, g));
            if ((giver === undefined || giver.value === null) && (wasHere?.value ?? null) === null)
              continue;
            const by = wasHere?.by;
            const x =
              by === undefined
                ? undefined
                : without.items.find(
                    (y) => y.event === by.event && y.target === by.target && y.k === by.k,
                  );
            const outsideO =
              x !== undefined &&
              x.op > tc.mergeBase &&
              x.op < tc.op &&
              !resolve.candidates.includes(x.event) &&
              !cover.has(`${x.event}/${x.target}`);
            if (outsideO) continue;
            if (state && giver === undefined && x === undefined) continue;
            // An event row the deletions removed whole (no required field left): no field gives.
            if (!state && !run.final.exists) continue;
            expect({ f, at: g, by: x?.event, takeGives: false }).toEqual({
              f,
              at: g,
              by: x?.event,
              takeGives: true,
            });
          }
        }
      }
    };
    // A skeleton of the reaching shape with its days and deletions drawn at random (state
    // table): X, a write; Y over part of X with X's version; Z over part of Y with Y's version;
    // C with X's version to the next change, a candidate where Y changed the value; C taken;
    // deletions among the sources. Z outside O is what the check needs.
    const day = (i: number) => DAYS[i] as BizPoint;
    const skeleton = fc
      .record({
        x: fc.integer({ min: 0, max: 1 }),
        y: fc.integer({ min: 1, max: 2 }),
        z: fc.integer({ min: 2, max: 3 }),
        cv: fc.constantFrom("1", "2"),
        dels: fc.constantFrom<string[][]>([["S1"]], [["S1"], ["S2"]], [["S2"]], [["S9"]], []),
      })
      .map(({ x, y, z, cv, dels }): LogEntry[] => {
        const span = (from: number, to: number | null): WriteOp["valid"] => ({
          from: { mode: "given", value: day(from) },
          to: to === null ? { mode: "next_change" } : { mode: "given", value: day(to) },
        });
        const w = (op: number, v: string, src: string, valid: WriteOp["valid"], seen: number) =>
          ({
            kind: "write",
            op,
            event: op + 1,
            seen,
            valid,
            fields: {
              f2: { value: v, sources: [src], ...(src === "S6" ? { explicit: true } : {}) },
            },
            ...(src === "S6" ? {} : { acknowledge: ["overwrite"] }),
          }) as LogEntry;
        return [
          w(10, "1", "S1", span(x, y + 1), 0),
          w(20, "3", "S2", span(y, 4), 10),
          w(30, "5", "S3", span(z, z + 1), 20),
          w(60, cv, "S6", span(x, null), 10),
          {
            kind: "resolve",
            op: 100,
            event: 101,
            decision: "take_candidate",
            candidates: [61],
            take: 61,
            unit: "f2",
          },
          ...dels.map((sources, i) => ({
            kind: "deletion" as const,
            op: 110 + i,
            id: `pi_${i}`,
            sources,
          })),
        ];
      });
    const random = withTwoSets(schema).map(({ st, a, b }): LogEntry[] => {
      const head = extend(schema, [], st, 10);
      const last = Math.max(...head.map((e) => e.op));
      return [
        ...head,
        { kind: "deletion", op: last + 1, id: "pi_x", sources: a },
        ...(b.length > 0
          ? [{ kind: "deletion" as const, op: last + 2, id: "pi_y", sources: b }]
          : []),
      ];
    });
    fc.assert(
      fc.property(
        state ? fc.oneof(random, skeleton) : random,
        hits.track((log) => check(hits, log, { hit: () => revHits++ })),
      ),
      { numRuns: RUNS },
    );
    if (!state) {
      // Built in (seed -1884293232): deleting #30's words takes the take's cover set away, so the
      // take gives nothing; #50, an undo of #20 outside the cover set, writes back "no value" on
      // f3, with the take and without it. No value on either side: nothing the take changed.
      check(hits, [
        {
          kind: "write",
          op: 10,
          event: 11,
          seen: 0,
          fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "write",
          op: 20,
          event: 21,
          seen: 0,
          fields: { f3: { value: "2", sources: ["S4"], explicit: true } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "write",
          op: 30,
          event: 31,
          seen: 20,
          fields: { f3: { value: "1", sources: ["S5"], explicit: true } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "write",
          op: 40,
          event: 41,
          seen: 20,
          fields: {
            f2: { value: "3", sources: ["S4"], explicit: false },
            f3: { value: "a", sources: ["S4"] },
          },
        },
        { kind: "undo", op: 50, event: 51, target: 20 },
        {
          kind: "resolve",
          op: 60,
          event: 61,
          decision: "take_candidate",
          candidates: [41],
          unit: "f3",
          take: 41,
        },
        { kind: "deletion", op: 61, id: "pi_x", sources: ["S5"] },
        { kind: "deletion", op: 62, id: "pi_y", sources: ["S5"] },
      ] as unknown as LogEntry[]);
    }
    if (!state) {
      // The event table: a write outside O giving the value there comes only from a deletion
      // putting it in effect, and on an event table a unit has one item (a candidate there is in
      // the item, put back if removed and frozen as judged), so the only such write is one a
      // deletion pending when the take was judged removed and that is back after the
      // cancellation — which does not cover the take (03-deletion «撤回与宽限期»). Built in: the
      // check meets it and the take gives the value.
      {
        const ew = (op: number, v: string, src: string, seen: number, extra: object = {}) =>
          ({
            kind: "write",
            op,
            event: op + 1,
            seen,
            fields: { f2: { value: v, sources: [src] } },
            ...extra,
          }) as LogEntry;
        const log: LogEntry[] = [
          ew(10, "1", "S1", 0),
          ew(20, "2", "S2", 10, { acknowledge: ["overwrite"] }),
          ew(25, "7", "S7", 20, { acknowledge: ["overwrite"] }),
          ew(30, "5", "S5", 10),
          { kind: "deletion", op: 40, id: "pi_7", sources: ["S7"] },
          {
            kind: "resolve",
            op: 50,
            event: 51,
            decision: "take_candidate",
            candidates: [31],
            take: 31,
            unit: "f2",
          },
          { kind: "cancel", op: 60, id: "pi_7" },
        ];
        const before = restorableMet;
        check({ hit() {} }, log);
        expect({ restorableMet: restorableMet > before }).toEqual({ restorableMet: true });
        expect(evaluateLog(schema, log).final.fields["f2"]?.[0]?.value).toBe("5");
      }
      // The event table, a write carried from the item's candidate (seed 1554879808): #21 is a
      // candidate against #11, undone by #31 and that undo undone by #41. Without the resolution,
      // deleting S1 puts #21 in effect: #31 takes it back and #41 writes 1 back, carried from
      // #21/f2/0. With it, #21 stays closed, #31 and #41 have nothing on f2, and the take gives
      // the 1. Not a write outside O giving a value the take covers: left out of the check.
      {
        const log: LogEntry[] = [
          {
            kind: "write",
            op: 10,
            event: 11,
            seen: 0,
            fields: { f2: { value: "1", sources: ["S1"] } },
            acknowledge: ["overwrite"],
          },
          {
            kind: "write",
            op: 20,
            event: 21,
            seen: 0,
            fields: { f2: { value: "1", sources: ["S4"] }, f3: { value: "a", sources: ["S4"] } },
            acknowledge: ["overwrite"],
          },
          { kind: "undo", op: 30, event: 31, target: 20 },
          { kind: "undo", op: 40, event: 41, target: 30 },
          {
            kind: "write",
            op: 60,
            event: 61,
            seen: 50,
            fields: { f2: { value: "1", sources: ["S1"] } },
          },
          {
            kind: "resolve",
            op: 70,
            event: 71,
            decision: "take_candidate",
            candidates: [21],
            unit: "f2",
            take: 21,
          },
          { kind: "deletion", op: 71, id: "pi_x", sources: ["S1"] },
        ];
        check({ hit() {} }, log);
        const f2 = evaluateLog(schema, log).final.fields["f2"] ?? [];
        expect(f2.map((g) => [g.value, g.by?.event])).toEqual([["1", 71]]);
      }
      // The event table: the other direction is built in, as the random samples seldom reach it.
      // #31 is a candidate against #21 and taken; a later deletion of #11's source, or of #21's
      // (then #31 is no candidate and gives its own value), leaves the take giving 5 or the value
      // already 5.
      const ew = (op: number, v: string, src: string, seen: number, extra: object = {}) =>
        ({
          kind: "write",
          op,
          event: op + 1,
          seen,
          fields: { f2: { value: v, sources: [src] } },
          ...extra,
        }) as LogEntry;
      const base: LogEntry[] = [
        ew(10, "1", "S1", 0),
        ew(20, "2", "S2", 10, { acknowledge: ["overwrite"] }),
        ew(30, "5", "S5", 10),
        {
          kind: "resolve",
          op: 40,
          event: 41,
          decision: "take_candidate",
          candidates: [31],
          take: 31,
          unit: "f2",
        },
      ];
      for (const tail of [[], [["S1"]], [["S2"]]] as string[][][]) {
        let landed = false;
        const before = reverseChecked;
        check(
          { hit: () => {} },
          [
            ...base,
            ...tail.map((sources, i) => ({
              kind: "deletion" as const,
              op: 50 + i,
              id: `pi_${i}`,
              sources,
            })),
          ],
          { hit: () => (landed = true) },
        );
        expect({ tail, checked: reverseChecked > before }).toEqual({ tail, checked: true });
        if (tail.length === 0 || tail[0]?.[0] === "S1")
          expect({ tail, landed }).toEqual({ tail, landed: true });
      }
      return;
    }
    hits.check();
    // The other direction is reached by the random samples on the state table (about 0.9 of the
    // segments checked are where the take gives the value): required there.
    expect({ reverseLanded: revHits > 0 }).toEqual({ reverseLanded: true });
    // A sample that reaches the check: #61 is taken where it was a candidate, [11-09, 11-11);
    // deleting S1 extends it to [11-09, ∞), over #31's 5 on [11-15, 11-18). #31 does not meet
    // the item's interval at the resolution, so it is not in O and keeps its 5.
    const g = (from: string, to: string | null): ToParam | { from: unknown; to: unknown } => ({
      from: { mode: "given", value: `2026-${from}` as BizPoint },
      to:
        to === null ? { mode: "next_change" } : { mode: "given", value: `2026-${to}` as BizPoint },
    });
    const write = (op: number, v: string, src: string, valid: unknown, extra: object = {}) =>
      ({
        kind: "write",
        op,
        event: op + 1,
        valid,
        fields: { f2: { value: v, sources: [src] } },
        ...extra,
      }) as LogEntry;
    let fixed = false;
    let fixedLanded = false;
    const reaching: LogEntry[] = [
      write(10, "1", "S1", g("11-03", "11-11")),
      write(20, "3", "S2", g("11-09", "11-20"), { seen: 10, acknowledge: ["overwrite"] }),
      write(30, "5", "S3", g("11-15", "11-18"), { seen: 20, acknowledge: ["overwrite"] }),
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 10,
        valid: g("11-03", null),
        fields: { f2: { value: "1", sources: ["S6"], explicit: true } },
      } as LogEntry,
      {
        kind: "resolve",
        op: 100,
        event: 101,
        decision: "take_candidate",
        candidates: [61],
        take: 61,
        unit: "f2",
      },
      { kind: "deletion", op: 110, id: "pi_1", sources: ["S1"] },
    ];
    check({ hit: () => (fixed = true) }, reaching, { hit: () => (fixedLanded = true) });
    expect({ fixedSampleReachesTheCheck: fixed }).toEqual({ fixedSampleReachesTheCheck: true });
    // Leaving out what is carried from the item's candidates does not leave out a write that is
    // not: an evaluator whose take also gives the value where #31 (outside O, its own value) gives
    // 5 makes the check fail.
    const wrong: typeof evaluateLog = (sch, l, o) => {
      const r = evaluateLog(sch, l, o);
      if (!l.some((e) => e.kind === "resolve" && e.decision === "take_candidate")) return r;
      const f2 = (r.final.fields["f2"] ?? []).map((g) => ({
        ...g,
        by: { event: 101, target: "f2" as FieldId, k: 0 },
      }));
      return { ...r, final: { ...r.final, fields: { ...r.final.fields, f2 } } };
    };
    expect(() => check({ hit() {} }, reaching, { hit() {} }, wrong)).toThrow(
      /expected \{ f: 'f2', at:/,
    );
    // The other direction on the same sample: where no write outside O gives the value, the take
    // gives it.
    expect({ fixedSampleLands: fixedLanded }).toEqual({ fixedSampleLands: true });
    // A counterexample to comparing values instead of givers (seed 687768209): without the
    // resolution, #51 is not high-impact and takes effect, so the entity has a value where it has
    // none with the resolution; the take gives nothing there.
    check({ hit: () => {} }, [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 0,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "3", sources: ["S4"], explicit: true } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: { from: { mode: "given", value: "2026-11-07" }, to: { mode: "next_change" } },
        fields: { f3: { value: "2", sources: ["S4"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_candidate",
        candidates: [21],
        unit: "f2",
        take: 21,
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S4"], explicit: true } },
      },
      { kind: "reject", op: 60, event: 61, target: 51 },
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 60,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f3: { value: "2", sources: ["S4"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      { kind: "deletion", op: 71, id: "pi_x", sources: ["S3"] },
      { kind: "deletion", op: 72, id: "pi_y", sources: ["S1"] },
    ] as LogEntry[]);
    // The comparison keeps the item's candidates closed (a keep_effective listing them): a
    // candidate a resolution listed stays the candidate it closed in every replay (01-objects
    // «处理之后事项不重开»), and writes between it and the resolution are judged against that.
    // With no candidates listed, the comparison has the candidate in effect and judges those
    // writes otherwise. Two such logs, each failing the other direction when the comparison listed
    // none (state table):
    // - #20 a candidate against #10; #30 revokes from 11-01; #50 writes 1 on [11-01, 11-03) with
    //   evidence; #21 taken; S1 deleted. With #21 closed, #51 takes effect and gives 1 there.
    // - #31 a candidate against #21; #41 writes 2 from 11-01 to the next change; #31 taken; S3 and
    //   S4 deleted. With #31 closed it gives no change point, so #41 runs on over [11-07, 11-09).
    if (state) {
      const sw = (
        op: number,
        seen: number,
        f: string,
        v: string,
        src: string,
        valid: object,
        extra: object = {},
      ) =>
        ({
          kind: "write",
          op,
          event: op + 1,
          seen,
          valid,
          fields: { [f]: { value: v, sources: [src] } },
          ...extra,
        }) as LogEntry;
      const span = (from: string, to?: string) => ({
        from: { mode: "given", value: `2026-${from}` },
        to: to === undefined ? { mode: "open" } : { mode: "given", value: `2026-${to}` },
      });
      const take = (op: number, c: number): LogEntry => ({
        kind: "resolve",
        op,
        event: op + 1,
        decision: "take_candidate",
        candidates: [c],
        unit: "f2",
        take: c,
      });
      const between: LogEntry[] = [
        sw(10, 0, "f2", "1", "S1", span("10-01"), { acknowledge: ["overwrite"] }),
        sw(20, 0, "f2", "3", "S5", span("11-01")),
        {
          kind: "revoke",
          op: 30,
          event: 31,
          seen: 20,
          valid: span("11-01"),
          validSources: ["S4"],
        } as LogEntry,
        sw(50, 20, "f2", "1", "S3", span("11-01", "11-03"), {
          fields: { f2: { value: "1", sources: ["S3"], explicit: true } },
        }),
        take(70, 21),
        { kind: "deletion", op: 72, id: "pi_y", sources: ["S1"] },
      ];
      check({ hit() {} }, between);
      const f2 = evaluateLog(schema, between).final.fields["f2"] ?? [];
      expect(f2.map((x) => [x.value, x.by?.event])).toEqual([
        ["1", 51],
        ["3", 71],
      ]);
      const extended: LogEntry[] = [
        sw(10, 0, "f2", "3", "S3", span("10-01"), { acknowledge: ["overwrite"] }),
        sw(20, 10, "f2", "2", "S4", span("11-07", "11-09"), { acknowledge: ["overwrite"] }),
        sw(30, 0, "f2", "3", "S1", span("11-07", "11-09"), { acknowledge: ["overwrite"] }),
        {
          kind: "write",
          op: 40,
          event: 41,
          seen: 30,
          valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "next_change" } },
          fields: { f2: { value: "2", sources: ["S5"], explicit: true } },
          acknowledge: ["overwrite"],
        } as LogEntry,
        take(90, 31),
        { kind: "deletion", op: 91, id: "pi_x", sources: ["S3"] },
        { kind: "deletion", op: 92, id: "pi_y", sources: ["S4"] },
      ];
      check({ hit() {} }, extended);
      const g2 = evaluateLog(schema, extended).final.fields["f2"] ?? [];
      expect(g2.map((x) => [x.value, x.by?.event])).toEqual([["2", 41]]);
    }
  });

  it("«撤回还原»: after a cancellation, what grace-period writes did not cover is as the forced replay", () => {
    // 03-deletion «推论» «撤回还原»: the part not covered by grace-period writes equals the replay
    // in which the deletion was never confirmed, the writes recorded as kept in effect take
    // effect at their own write numbers, and writes whose items were kept superseded do not take
    // effect. Compared: field values outside grace-period coverage, and the judgement and openness
    // of every item of the operations before the deletion. Other deletions may be pending
    // throughout; grace-period steps include restatements and decisions. Candidates the
    // cancellation put back are left out of the item comparison: their judgement at the
    // cancellation is a rule of its own (03-deletion «撤回与宽限期»). So are the candidates of a
    // grace-period decision the replay refuses: the decision stays in effect, so what it closed
    // is covered by the grace period (the fixed case below).
    // Measured share of hits: about 0.89 on both tables.
    const hits = new Hits(0.75);
    fc.assert(
      fc.property(
        withTwoSets(schema),
        fc.array(graceStep, { maxLength: 3 }),
        fc.boolean(),
        hits.track(({ st, a: sources }, graceSteps, lateVer) => {
          const prefix = extend(schema, [], st, 10);
          const prefixRun = evaluateLog(schema, prefix);
          const pending = pendingSources(prefixRun);
          const dSources = sources.filter((x) => !pending.has(x));
          fc.pre(dSources.length > 0);
          if (changes(schema, prefix, dSources)) hits.hit();
          const dOp = Math.max(...prefix.map((o) => o.op)) + 10;
          const withD: LogEntry[] = [
            ...prefix,
            { kind: "deletion", op: dOp, id: "pi_d", sources: dSources },
          ];
          let grace = extend(schema, withD, graceSteps, dOp + 10, "G").slice(withD.length);
          // With `lateVer`, grace-period writes carry the version after the confirmation, so they
          // can make the cancellation keep a write in effect.
          grace = grace.map((e) =>
            (e.kind === "write" || e.kind === "revoke") && lateVer ? { ...e, seen: e.op - 1 } : e,
          );
          const cancelOp = dOp + 10 * (graceSteps.length + 2);
          const checked = checkCancelRestores(schema, prefix, withD, grace, cancelOp);
          fc.pre(checked !== undefined);
          counts.keptEffective += checked.kept;
          counts.refusedInBase += checked.refusedInBase;
          counts.putBackDiffers += checked.putBackDiffers;
          if (checked.decided.nonEmpty) counts.decidedInGrace++;
          if (checked.decided.differs) counts.decidedDiffers++;
          if (checked.withDecisions) counts.withDecisions++;
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("an accepted undo of a revert leaves none of that revert's write-back items giving a value", () => {
    // 03-deletion «回掉的权威定义» step 1: the undo covers every write-back item of the revert on
    // this row, also those first given by a later deletion's restatement. Where a later write
    // covers one, that write gives the value. Besides random logs, a skeleton reaches the case:
    // W; X covering W (wholly or partly); undo W (no write-back where X covers it); undo that
    // undo; X's source deleted before the second undo (pending: the first undo has write-backs
    // then, so the second is accepted), after it, or not at all.
    const skeleton = fc.record({
      w: fc.tuple(fc.nat({ max: DAYS.length - 2 }), fc.nat({ max: DAYS.length - 1 })),
      x: fc.tuple(fc.nat({ max: DAYS.length - 2 }), fc.nat({ max: DAYS.length - 1 })),
      deleteX: fc.constantFrom(
        "none" as const,
        "before" as const,
        "before" as const,
        "after" as const,
      ),
    });
    // An undo of a revert with no write-back is rejected, so on the event table (X covers W
    // whole) only the skeletons deleting X before the second undo reach the check.
    // Measured share of hits: about 0.79 (state) and 0.45 (event).
    const hits = new Hits(state ? 0.6 : 0.3);
    fc.assert(
      fc.property(
        steps,
        skeleton,
        fc.array(step, { maxLength: 3 }),
        hits.track((st, sk, tail) => {
          const head = extend(schema, [], st, 10);
          const at = Math.max(...head.map((o) => o.op)) + 10;
          const span = ([a, b]: [number, number]) =>
            state
              ? {
                  valid: {
                    from: { mode: "given" as const, value: DAYS[a] as BizPoint },
                    to: { mode: "given" as const, value: DAYS[Math.max(b, a + 1)] ?? "2026-12-01" },
                  },
                }
              : {};
          const body: LogEntry[] = [
            {
              kind: "write",
              op: at,
              event: at + 1,
              ...span(sk.w),
              fields: { f2: { value: "7", sources: ["SW"] } },
            },
            {
              kind: "write",
              op: at + 10,
              event: at + 11,
              ...span(sk.x),
              fields: { f2: { value: "8", sources: ["SX"] } },
            },
            {
              kind: "undo",
              op: at + 20,
              event: at + 21,
              target: at,
              seen: at + 10,
              acknowledge: ["overwrite"],
            },
            ...(sk.deleteX === "before"
              ? [{ kind: "deletion" as const, op: at + 25, id: "pi_x", sources: ["SX"] }]
              : []),
            {
              kind: "undo",
              op: at + 30,
              event: at + 31,
              target: at + 20,
              seen: at + 20,
              acknowledge: ["overwrite"],
            },
            ...(sk.deleteX === "after"
              ? [{ kind: "deletion" as const, op: at + 40, id: "pi_x", sources: ["SX"] }]
              : []),
          ];
          const log = extend(schema, [...head, ...body], tail, at + 50);
          const ev = evaluateLog(schema, log).final;
          const status = new Map(ev.reverts.map((r) => [r.op, r]));
          for (const u of log) {
            if (u.kind !== "undo") continue;
            const undo = status.get(u.op);
            const target = status.get(u.target);
            if (undo?.status !== "applied" || target?.status !== "applied") continue;
            counts.undoOfRevert++;
            hits.hit();
            if (sk.deleteX === "before" && u.op === at + 30) counts.undoOfRevertRegained++;
            for (const [f, segs] of Object.entries(ev.fields)) {
              for (const seg of segs ?? []) {
                expect({ f, by: seg.by?.event }).not.toEqual({ f, by: target.event });
              }
            }
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("original items of one write in one segment: merged, no endpoint leaks", () => {
    // 09 §5.7 with a skeleton that reaches the merge. A write-back k0 of an undo is split by a
    // write y that takes effect only through a deletion; a take_previous may list the undo's
    // write-backs before the deletion; the deletion may be cancelled, or followed by deleting y's
    // own source. Original items landing in one segment merge into one (the smallest index). At a
    // cancellation the items only the cancelled deletion gave are not originals (03-deletion
    // «回掉的权威定义» step 6), and the segment is one item, as never deleted. Checked: no segment
    // endpoint comes from a deleted source, and after the cancellation the values equal the replay
    // in which nothing was deleted.
    if (!state) return;
    const skeleton = fc.record({
      yFrom: fc.constantFrom("2026-11-08", "2026-11-10", "2026-11-12") as fc.Arbitrary<BizPoint>,
      // The merge comes with "delete-y" and with "cancel"; the rest are controls.
      listed: fc.constantFrom(true, true, true, false),
      ending: fc.constantFrom("cancel", "cancel", "delete-y", "delete-y", "none"),
      tailSteps: fc.array(step, { maxLength: 2 }),
    });
    // Half the samples come from `cutSteps` instead, with two or three deleted sets in every order
    // of the order-independence properties, cancellations included: they reach originals sharing
    // a segment at a deletion confirmation.
    // Measured share of hits: about 0.49.
    const hits = new Hits(0.35);
    const fromCut = cutSets.map((sets) => ({ sets }));
    fc.assert(
      fc.property(
        fc.oneof(
          skeleton.map((sk) => ({ kind: "skeleton" as const, ...sk })),
          fromCut.map((c) => ({ kind: "cut" as const, ...c })),
        ),
        hits.track((sample) => {
          if (sample.kind === "cut") {
            const log = extend(schema, [], sample.sets.st, 10);
            const d = deletionOrders(log, sample.sets, pendingSources(evaluateLog(schema, log)));
            fc.pre(d !== undefined);
            const before = { ...segmentStats };
            for (const ds of d.orders) {
              const full = [...log, ...ds];
              noEndpointLeak(full, evaluateLog(schema, full));
            }
            counts.mergePath += segmentStats.merged - before.merged;
            if (segmentStats.merged > before.merged) hits.hit();
            return;
          }
          const { yFrom, listed, ending, tailSteps } = sample;
          const iv = (from: BizPoint, to: BizPoint | null) => ({
            from: { mode: "given" as const, value: from },
            to: to === null ? { mode: "open" as const } : { mode: "given" as const, value: to },
          });
          const wr = (
            op: number,
            from: BizPoint,
            to: BizPoint | null,
            value: string,
            src: string,
            extra: Partial<WriteOp> = {},
          ): WriteOp => ({
            kind: "write",
            op,
            event: op + 1,
            valid: iv(from, to),
            fields: { f2: { value, sources: [src] } },
            ...extra,
          });
          const log: LogEntry[] = [
            wr(10, "2026-10-01", null, "5000", "B1"),
            wr(12, "2026-11-25", null, "4500", "B2"),
            wr(15, yFrom, null, "4000", "B3"),
            wr(20, "2026-11-02", "2026-11-20", "3000", "B4"),
            { kind: "undo", op: 30, event: 31, target: 20, seen: 20, acknowledge: ["overwrite"] },
            ...(listed
              ? [
                  wr(33, "2026-11-03", "2026-11-05", "3500", "B5", { seen: 25 }),
                  {
                    kind: "resolve" as const,
                    op: 35,
                    event: 36,
                    decision: "take_previous" as const,
                    candidates: [34],
                    unit: "f2" as const,
                  },
                ]
              : []),
            { kind: "deletion", op: 40, id: "pi_d", sources: ["B2"] },
            ...(ending === "cancel" ? [{ kind: "cancel" as const, op: 50, id: "pi_d" }] : []),
            ...(ending === "delete-y"
              ? [{ kind: "deletion" as const, op: 50, id: "pi_y", sources: ["B3"] }]
              : []),
          ];
          const full = extend(schema, log, tailSteps, 60);
          const before = { ...segmentStats };
          const run = evaluateLog(schema, full);
          counts.mergePath += segmentStats.merged - before.merged;
          if (segmentStats.merged > before.merged) hits.hit();
          noEndpointLeak(full, run);
          const ev = run.final;
          if (ending === "cancel" && tailSteps.length === 0) {
            const base = evaluateLog(
              schema,
              full.filter((e) => e.kind !== "deletion" && e.kind !== "cancel"),
              {
                forcedEffective: run.steps.at(-1)?.keptEffective ?? [],
                forcedSuperseded: run.steps.at(-1)?.keptSuperseded ?? [],
              },
            ).final;
            expect(timeline(ev, "f2")).toEqual(timeline(base, "f2"));
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("an include_later undo neither confirmed nor in effect when written changes nothing later writes provide", () => {
    // 05-time «高影响写入» ④, 09 §5.7: revert statuses are decided in operation order, each as if
    // in effect. An include_later undo that took back later writes awaits confirmation; if a
    // deletion later puts it in effect without a confirmation, a later item it registers already
    // provides nothing where it is registered (03-deletion «回掉的权威定义» step 5): it is
    // superseded there by a later write, or registered there by an earlier revert. The
    // registration itself is not ruled out: apply does not compute coverage. Samples: some writes; on the state table sometimes a revoke inside the
    // target's interval; the target write; up to three later writes over it and, mostly, an undo
    // of the target (its write-back items are a later operation too); an include_later undo of
    // the target (with or without acknowledge); one or two deletions (the first sometimes
    // cancelled) and further steps. A hit: the undo awaited when written and is in effect at the
    // end — the path where the check bites.
    // Half the samples come from the skeleton; there the undo stays awaiting (it would take back
    // the later undo's item), so they are not hits but catch an evaluator that decides it in effect.
    // Measured share of hits: about 0.08 (state) and 0.10 (event).
    const sample = fc.record({
      pre: fc.array(step, { minLength: 1, maxLength: 3 }),
      revoke: fc.option(
        fc.record({
          from: fc.nat({ max: 2 }),
          to: fc.nat({ max: 3 }),
          src: fc.constantFrom(...SOURCES),
        }),
      ),
      mid: fc.constant([] as Extract<Step, { t: "write" }>[]),
      target: write,
      // Later writes cite S3–S5 and the deletions mostly take those: the later writes the undo
      // took back go away and the undo can come into effect.
      later: fc.array(
        fc
          .tuple(write, fc.constantFrom("S3", "S4", "S5"))
          .map(([w, src]) => ({ ...w, src, lag: 0, ack: true })),
        { maxLength: 3 },
      ),
      ack: fc.boolean(),
      // An undo of the target before the include_later one: its write-back items are a later
      // operation the include_later undo may take back.
      innerUndo: fc.constantFrom(true, true, false),
      dels: fc.array(
        fc.oneof(
          { weight: 1, arbitrary: fc.subarray(["S3", "S4", "S5"], { minLength: 1, maxLength: 2 }) },
          { weight: 1, arbitrary: fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }) },
        ),
        { minLength: 1, maxLength: 2 },
      ),
      cancelFirst: fc.constantFrom(false, false, true),
      tail: fc.array(furtherStep, { maxLength: 2 }),
    });
    // A skeleton after the case that made the evaluator loop: two writes of the required field
    // from S1, a write of f3 from S3, a revoke inside the target's interval, a write of f3 from S5,
    // the target (f3 from S3), an undo of the target, then the include_later one; S1 deleted.
    // Dates and the value are random.
    const skeleton = fc
      .record({
        v: fc.constantFrom("1", "2"),
        f3From: fc.integer({ min: 1, max: 3 }),
        rev: fc.record({ from: fc.nat({ max: 2 }), to: fc.nat({ max: 3 }) }),
        from: fc.nat({ max: 1 }),
        tail: fc.array(furtherStep, { maxLength: 1 }),
      })
      .map(({ v, f3From, rev, from, tail }) => {
        const w = (
          f: FieldId,
          src: string,
          at: number,
          ack: boolean,
        ): Extract<Step, { t: "write" }> => ({
          t: "write",
          f,
          v,
          src,
          from: at,
          to: "open",
          lag: 0,
          explicit: false,
          ack,
        });
        return {
          pre: [w("f2", "S1", 0, true), w("f2", "S1", 0, true), w("f3", "S3", f3From, true)],
          revoke: { ...rev, src: "S2" },
          mid: [w("f3", "S5", from, false)],
          target: w("f3", "S3", from, true),
          later: [] as Extract<Step, { t: "write" }>[],
          ack: true,
          innerUndo: true,
          dels: [["S1"]],
          cancelFirst: false,
          tail,
        };
      });
    // Reaching the checked path is built in (the fixed sample below); the random samples only
    // guard against a generator gone degenerate (about 42 hits on the state table at 750 runs:
    // odds of none about e^-42).
    const hits = new Hits(Number.MIN_VALUE);
    const samples = fc.oneof({ weight: 1, arbitrary: sample }, { weight: 1, arbitrary: skeleton });
    type Sample = typeof samples extends fc.Arbitrary<infer T> ? T : never;
    const check = (
      h: { hit(): void },
      { pre, revoke, mid, target, later, ack, innerUndo, dels, cancelFirst, tail }: Sample,
    ) => {
      const before = extend(schema, [], pre, 10);
      const revokeOp = 10 + 10 * pre.length;
      if (revoke !== null && state) {
        before.push({
          kind: "revoke",
          op: revokeOp,
          event: revokeOp + 1,
          seen: revokeOp - 1,
          valid: {
            from: { mode: "given", value: DAYS[revoke.from] as BizPoint },
            to: {
              mode: "given",
              value: (DAYS[Math.max(revoke.to, revoke.from + 1)] ?? "2026-12-01") as BizPoint,
            },
          },
          validSources: [revoke.src],
        });
      }
      const targetOp = revokeOp + 10 + 10 * mid.length;
      const writes = extend(schema, before, [...mid, target, ...later], revokeOp + 10);
      fc.pre(writes.some((e) => e.kind === "write" && e.op === targetOp));
      const lastWrite = Math.max(...writes.map((e) => e.op));
      const inner: LogEntry[] = innerUndo
        ? [
            {
              kind: "undo",
              op: lastWrite + 10,
              event: lastWrite + 11,
              target: targetOp,
              seen: lastWrite,
              acknowledge: ["overwrite"],
            },
          ]
        : [];
      const last = lastWrite + (innerUndo ? 10 : 0);
      const undoOp = last + 10;
      const log: LogEntry[] = [
        ...writes,
        ...inner,
        {
          kind: "undo",
          op: undoOp,
          event: undoOp + 1,
          target: targetOp,
          includeLater: true,
          seen: last,
          ...(ack ? { acknowledge: ["overwrite"] as const } : {}),
        },
      ];
      dels.forEach((sources, i) => {
        log.push({ kind: "deletion", op: undoOp + 2 + i, id: `pi_${i}`, sources });
      });
      if (cancelFirst) log.push({ kind: "cancel", op: undoOp + 5, id: "pi_0" });
      const full = extend(schema, log, tail, undoOp + 10);
      const run = evaluateLog(schema, full);
      const atWrite = run.steps
        .find((x) => x.entry.op === undoOp)
        ?.state.reverts.find((r) => r.op === undoOp)?.status;
      const confirmed = full.some((e) => e.kind === "confirm" && e.target === undoOp + 1);
      const final = run.final.reverts.find((r) => r.op === undoOp)?.status;
      if (atWrite === "applied" || confirmed || final !== "applied") return;
      if (atWrite === "awaiting") h.hit();
      const items = run.final.items.filter((x) => x.status !== "dropped");
      const regOn = (x: ItemResult, g: Iv, other: (op: number) => boolean) =>
        x.registrations.some((r) => other(r.byOp) && covers(r.valid, g));
      const supersedes = (y: ItemResult, x: ItemResult) => {
        const yField = y.target !== "existence" && y.content.kind === "value";
        if (x.content.kind === "revoke") return y.content.kind === "restore" || yField;
        if (x.content.kind === "restore") return y.content.kind === "revoke";
        return (
          (y.target === x.target && y.content.kind !== "uncovered") || y.content.kind === "revoke"
        );
      };
      const providing: string[] = [];
      for (const x of items) {
        if (x.op === targetOp || x.content.kind === "uncovered") continue;
        for (const reg of x.registrations.filter((r) => r.byOp === undoOp)) {
          for (const g of elementarySegments(endpoints([reg.valid, x.valid]))) {
            if (!covers(reg.valid, g)) continue;
            if (regOn(x, g, (op) => op !== undoOp)) continue;
            const superseded = items.some(
              (y) =>
                y.status === "applied" &&
                y.op > x.op &&
                y.op !== undoOp &&
                supersedes(y, x) &&
                covers(y.valid, g) &&
                !regOn(y, g, () => true),
            );
            if (!superseded) providing.push(`${x.event}/${x.target}/${x.k} ${JSON.stringify(g)}`);
          }
        }
      }
      expect({ undoOp, providing }).toEqual({ undoOp, providing: [] });
    };
    fc.assert(
      fc.property(
        samples,
        hits.track((x) => check(hits, x)),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    // A sample of each table that takes the checked path: the include_later undo awaits when
    // written and a deletion puts it in effect.
    const fixedSample = (state
      ? {
          pre: [{ t: "undoRevert", back: 0 }],
          revoke: null,
          mid: [],
          target: {
            t: "write",
            f: "f3",
            v: "3",
            src: "S4",
            from: 1,
            to: 2,
            lag: 1,
            explicit: false,
            ack: true,
          },
          later: [],
          ack: false,
          innerUndo: false,
          dels: [["S4", "S5"]],
          cancelFirst: false,
          tail: [],
        }
      : {
          pre: [
            { t: "undo", back: 1 },
            { t: "resolve", decision: "take_previous" },
          ],
          revoke: { from: 1, to: 0, src: "S2" },
          mid: [],
          target: {
            t: "write",
            f: "f2",
            v: "3",
            src: "S4",
            from: 1,
            to: "open",
            lag: 1,
            explicit: true,
            ack: true,
          },
          later: [],
          ack: false,
          innerUndo: true,
          dels: [["S5"], ["S3", "S4"]],
          cancelFirst: false,
          tail: [],
        }) as unknown as Sample;
    let fixed = false;
    check({ hit: () => (fixed = true) }, fixedSample);
    expect({ fixedSampleReachesTheCheck: fixed }).toEqual({ fixedSampleReachesTheCheck: true });
  });

  it("deletion events add no pending items beyond the kinds the corollary names", () => {
    // 03-deletion «推论» «删除不增加未决事项»: each new pending item after a deletion is an awaiting
    // item converted from a conflict item this deletion superseded, or comes from the same
    // write's earlier pending item: superseded by an earlier deletion (not closed by a decision
    // since) and back to pending now with its kind unchanged, the original item is restored; with
    // its kind changed (awaiting <-> candidate; the original superseded by this deletion or an
    // earlier one), a new item replaces it one for one. A cancellation may also put back a
    // candidate after its item was resolved (pending at write time, removed by the deletion it
    // cancels). Items are identified by (write, field); a kind is the status the item had when it
    // was last pending.
    // Measured share of hits: about 0.48 (state) and 0.54 (event).
    const hits = new Hits(0.35);
    fc.assert(
      fc.property(
        mostly(
          steps,
          fc.oneof(
            { weight: 2, arbitrary: deletionAfterConflict },
            { weight: 1, arbitrary: restoreAfterCancel },
          ),
        ),
        hits.track((st) => {
          const log = extend(schema, [], st, 10);
          const run = evaluateLog(schema, log);
          const atWrite = writeTimeStatuses(run);
          // Why each item stopped being pending, as of the previous step: a deletion event, or
          // something else (a decision, a later write); and the kinds it had then.
          const supersededBy = new Map<string, { by: "deletion" | "other"; kinds: string[] }>();
          let before: Evaluation | undefined;
          for (const s of run.steps) {
            const prev = before;
            before = s.state;
            if (s.refused || prev === undefined) continue;
            const isDeletion = s.entry.kind === "deletion" || s.entry.kind === "cancel";
            const pendingNow = new Map<string, ItemResult[]>();
            for (const x of s.state.items.filter(isPending)) {
              pendingNow.set(etKey(x), [...(pendingNow.get(etKey(x)) ?? []), x]);
            }
            const pendingPrev = new Map<string, ItemResult[]>();
            for (const x of prev.items.filter(isPending)) {
              pendingPrev.set(etKey(x), [...(pendingPrev.get(etKey(x)) ?? []), x]);
            }
            if (isDeletion) {
              const putBack = new Set((s.putBack ?? []).map(etKey));
              if (pendingNow.size > 0) hits.hit();
              for (const [key, xs] of pendingNow) {
                const prevPending = (pendingPrev.get(key) ?? []).map((x) => x.status);
                const earlier = supersededBy.get(key);
                const original =
                  prevPending.length === 0 && earlier?.by === "deletion" ? earlier.kinds : [];
                for (const x of xs) {
                  const branch = prevPending.includes(x.status)
                    ? "not new"
                    : x.status === "awaiting" && prevPending.includes("candidate")
                      ? "converted"
                      : x.status === "candidate" && prevPending.includes("awaiting")
                        ? "replaced now"
                        : original.includes(x.status)
                          ? "restored"
                          : original.length > 0
                            ? "replaced"
                            : s.entry.kind === "cancel" && putBack.has(key)
                              ? "put back"
                              : "none";
                  if (branch === "restored") {
                    if (s.entry.kind === "deletion") counts.restoredByDeletion++;
                    else counts.restoredByCancel++;
                  }
                  if (branch === "replaced") counts.replacedAfterEarlier++;
                  expect({
                    key,
                    at: s.entry,
                    now: x.status,
                    prevPending,
                    supersededBy: earlier,
                    branch,
                  }).not.toMatchObject({ branch: "none" });
                }
                // One for one: one pending item per write and field and kind (a judgement carried
                // by several contribution items, a write split into several items, is still one), and no
                // more kinds than the items it restores or replaces (a put-back candidate: than at
                // write time).
                const kinds = new Set(xs.map((x) => x.status)).size;
                const before = new Set(
                  prevPending.length > 0
                    ? prevPending
                    : original.length > 0
                      ? original
                      : (atWrite.get(key) ?? []),
                ).size;
                expect({ key, kinds }).toEqual({ key, kinds: Math.min(kinds, before) });
              }
            }
            for (const [key, xs] of pendingPrev) {
              if (!pendingNow.has(key)) {
                supersededBy.set(key, {
                  by: isDeletion ? "deletion" : "other",
                  kinds: [...new Set(xs.map((x) => x.status))],
                });
              }
            }
            for (const key of pendingNow.keys()) supersededBy.delete(key);
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });
});

it("cancellations keep writes in effect in the sampled logs", () => {
  // Guards against a generator that never reaches `kept_effective`.
  expect(counts.keptEffective).toBeGreaterThan(0);
});

it("«撤回还原»: a grace-period decision the replay without the deletion refuses", () => {
  // Fixed log of a sampled case. Op 90 takes the previous value over [11-07, 11-09), so the
  // required f2 has no value there. Deleting S5 removes the candidate op 90 decided on, so f2
  // has a value throughout and the grace-period take_candidate at op 110 is accepted. Without
  // the deletion it is refused (`missing_required`). After the cancellation it stays in effect
  // (03-deletion «撤回与宽限期»): candidate 81 is closed in one run and open in the other, and
  // the comparison leaves it out.
  const given = (from: string, to?: string) => ({
    from: { mode: "given" as const, value: from as BizPoint },
    to:
      to === undefined
        ? { mode: "open" as const }
        : { mode: "given" as const, value: to as BizPoint },
  });
  const prefix: LogEntry[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: given("2026-10-01"),
      fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: given("2026-10-01"),
      fields: { f2: { value: "1", sources: ["S2"], explicit: false } },
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 0,
      valid: given("2026-11-07", "2026-11-09"),
      fields: { f2: { value: "3", sources: ["S5"], explicit: false } },
    },
    {
      kind: "write",
      op: 40,
      event: 41,
      seen: 30,
      valid: {
        from: { mode: "given", value: "2026-11-03" as BizPoint },
        to: { mode: "next_change" },
      },
      fields: { f2: { value: "1", sources: ["S3"], explicit: true } },
    },
    {
      kind: "write",
      op: 70,
      event: 71,
      seen: 60,
      valid: given("2026-11-05"),
      fields: { f3: { value: "3", sources: ["S2"], explicit: false } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 80,
      event: 81,
      seen: 50,
      valid: given("2026-11-05"),
      fields: { f3: { value: "2", sources: ["S3"], explicit: true } },
      acknowledge: ["overwrite"],
    },
    { kind: "resolve", op: 90, event: 91, decision: "take_previous", candidates: [31], unit: "f2" },
  ];
  const withD: LogEntry[] = [...prefix, { kind: "deletion", op: 100, id: "pi_d", sources: ["S5"] }];
  const grace: LogEntry[] = [
    {
      kind: "resolve",
      op: 110,
      event: 111,
      decision: "take_candidate",
      candidates: [81],
      unit: "f3",
      take: 81,
    },
  ];
  expect(checkCancelRestores(STATE, prefix, withD, grace, 130)).toEqual({
    kept: 0,
    refusedInBase: 1,
    putBackDiffers: 0,
    withDecisions: true,
    decided: { nonEmpty: true, differs: false },
  });
  const base = evaluateLog(STATE, [...prefix, ...grace]).steps.at(-1);
  expect({ refused: base?.refused, rejected: base?.rejected }).toEqual({
    refused: true,
    rejected: "missing_required",
  });
  const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 130, id: "pi_d" }]);
  const ev = run.final;
  const item = (event: number) => {
    const x = ev.items.find((y) => y.event === event);
    return { status: x?.status, closed: x?.closed === true, valid: x?.valid };
  };
  expect(item(81)).toEqual({
    status: "candidate",
    closed: true,
    valid: [{ from: "2026-11-05", to: null }],
  });
  expect(item(111)).toEqual({
    status: "applied",
    closed: false,
    valid: [{ from: "2026-11-05", to: null }],
  });
  expect(item(91)).toEqual({
    status: "applied",
    closed: false,
    valid: [{ from: "2026-11-07", to: "2026-11-09" }],
  });
  // After the cancellation, over [11-07, 11-09) item 111 gives f3 its value while the required
  // f2 has none (item 91): a state a write would be refused for (`missing_required`), reached
  // through deletion, grace-period decision and cancellation. As the reference gives it now:
  // the row has no value there, and the fields show it on both sides.
  const seg: Iv = { from: "2026-11-07" as BizPoint, to: "2026-11-09" as BizPoint };
  expect(ev.gaps).toEqual([
    { from: null, to: "2026-10-01" },
    { from: "2026-11-07", to: "2026-11-09" },
  ]);
  expect(ev.fields["f2"]?.map((x) => [x.valid, x.value])).toEqual([
    [[{ from: "2026-10-01", to: "2026-11-07" }], "1"],
    [[{ from: "2026-11-09", to: null }], "1"],
  ]);
  expect(ev.fields["f3"]?.map((x) => [x.valid, x.value, x.by?.event ?? null])).toEqual([
    [[{ from: "2026-10-01", to: "2026-11-05" }], null, null],
    [[{ from: "2026-11-05", to: "2026-11-07" }], "2", 111],
    [[{ from: "2026-11-09", to: null }], "2", 111],
  ]);
  expect((ev.fields["f3"] ?? []).some((x) => covers(x.valid, seg))).toBe(false);
});

it("«撤回还原»: a put-back candidate judged again where the forced replay puts it in effect", () => {
  // Fixed log of a sampled case. Ops 20, 40 and 50 carry stale versions: 21, 41 and 51 are
  // candidates. Deleting S4 removes 31 and 51; 41 takes effect through it. In the grace period,
  // 71 takes candidate 21 on the version after the deletion, so the cancellation keeps 41 in
  // effect. 51's item was resolved in the grace period: put back, it is judged again on the state
  // at the cancellation (03-deletion «撤回与宽限期»): 3 against 1 on [11-03, 11-05), a candidate
  // of a conflict item of its own. In the forced replay 41 in effect moves 51's `next_change` end
  // to 11-05, where nothing changed since its version: it takes effect there, 3. The cancellation's
  // rule is the definition; the comparison takes 51's interval by it.
  const given = (from: string, to?: string) => ({
    from: { mode: "given" as const, value: from as BizPoint },
    to:
      to === undefined
        ? { mode: "open" as const }
        : to === "next"
          ? { mode: "next_change" as const }
          : { mode: "given" as const, value: to as BizPoint },
  });
  const w = (
    op: number,
    seen: number,
    from: string,
    to: string | undefined,
    value: string,
    src: string,
    explicit: boolean,
    ack: boolean,
  ): LogEntry => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: given(from, to),
    fields: { f2: { value, sources: [src], explicit } },
    ...(ack ? { acknowledge: ["overwrite" as const] } : {}),
  });
  const prefix: LogEntry[] = [
    w(10, 0, "2026-10-01", undefined, "1", "S1", false, true),
    w(20, 0, "2026-11-05", undefined, "2", "S2", false, false),
    w(30, 10, "2026-11-07", undefined, "2", "S4", true, true),
    w(40, 10, "2026-11-05", undefined, "3", "S1", true, false),
    w(50, 20, "2026-11-03", "next", "3", "S4", true, true),
  ];
  const withD: LogEntry[] = [...prefix, { kind: "deletion", op: 60, id: "pi_d", sources: ["S4"] }];
  const grace: LogEntry[] = [
    {
      kind: "resolve",
      op: 70,
      event: 71,
      decision: "take_candidate",
      candidates: [21],
      unit: "f2",
      take: 21,
    },
  ];
  expect(checkCancelRestores(STATE, prefix, withD, grace, 90)).toEqual({
    kept: 1,
    refusedInBase: 0,
    putBackDiffers: 1,
    withDecisions: true,
    decided: { nonEmpty: true, differs: false },
  });
  const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 90, id: "pi_d" }]);
  const cancel = run.steps.at(-1);
  expect(cancel?.keptEffective?.map((x) => x.event)).toEqual([41]);
  expect(cancel?.putBack).toEqual([{ event: 51, target: "f2", judged: "candidate" }]);
  const seg: Iv = { from: "2026-11-03" as BizPoint, to: "2026-11-05" as BizPoint };
  const valueAt = (ev: Evaluation) =>
    (ev.fields["f2"] ?? []).find((x) => covers(x.valid, seg))?.value;
  const item51 = (ev: Evaluation) => {
    const x = ev.items.find((y) => y.event === 51);
    return { status: x?.status, closed: x?.closed === true, valid: x?.valid };
  };
  // After the cancellation: 1 on [11-03, 11-05), 51 an open candidate there.
  expect(valueAt(run.final)).toBe("1");
  expect(item51(run.final)).toEqual({ status: "candidate", closed: false, valid: [seg] });
  // The forced replay: 51 in effect, 3.
  const base = evaluateLog(STATE, [...prefix, ...grace], {
    forcedEffective: cancel?.keptEffective ?? [],
    forcedSuperseded: cancel?.keptSuperseded ?? [],
  }).final;
  expect(valueAt(base)).toBe("3");
  expect(item51(base)).toEqual({ status: "applied", closed: false, valid: [seg] });
});

describe("state table: a revert covers by (event, target)", () => {
  const span = (a: number, b: number) => ({
    from: { mode: "given" as const, value: DAYS[a] as BizPoint },
    to: { mode: "given" as const, value: DAYS[Math.max(b, a + 1)] ?? ("2026-12-01" as BizPoint) },
  });
  const valueAt = (ev: Evaluation, f: FieldId, seg: Iv) =>
    JSON.stringify((ev.fields[f] ?? []).find((s) => covers(s.valid, seg))?.value);
  const pair = fc.tuple(fc.nat({ max: DAYS.length - 2 }), fc.nat({ max: DAYS.length - 1 }));

  it("the part of an undone write that takes effect through a deletion is undone too", () => {
    // 03-deletion «删除结果的定义», deviation one: a person's undo takes back the operation on its
    // targets, not only the items in effect when it was written. Skeleton: random steps; C (SC)
    // changes f2; M, with the ver from before C, writes f2 (a candidate: C changed it) and f3 (in
    // effect); undo M (accepted: f3 is in effect); then, mostly, delete SC, so M's f2 takes
    // effect. Checked: once the undo is in effect, no segment of f2 or f3 gets its value from M.
    // Measured share of hits: about 0.36.
    const hits = new Hits(0.25);
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 5 }),
        fc.record({ c: pair, m: pair, deleteC: fc.constantFrom(true, true, true, false) }),
        hits.track((st, sk) => {
          const head = extend(STATE, [], st, 10);
          const at = Math.max(0, ...head.map((o) => o.op)) + 10;
          const m = at + 10;
          const log: LogEntry[] = [
            ...head,
            {
              kind: "write",
              op: at,
              event: at + 1,
              valid: span(...sk.c),
              fields: { f2: { value: "8", sources: ["SC"] } },
            },
            {
              kind: "write",
              op: m,
              event: m + 1,
              seen: at - 1,
              valid: span(...sk.m),
              fields: {
                f2: { value: "7", sources: ["SM"] },
                f3: { value: "5", sources: ["SM3"] },
              },
            },
            {
              kind: "undo",
              op: m + 10,
              event: m + 11,
              target: m,
              seen: m,
              acknowledge: ["overwrite"],
            },
            ...(sk.deleteC
              ? [{ kind: "deletion" as const, op: m + 20, id: "pi_c", sources: ["SC"] }]
              : []),
          ];
          const run = evaluateLog(STATE, log);
          const ev = run.final;
          const undo = ev.reverts.find((r) => r.op === m + 10);
          if (undo?.status !== "applied") return;
          const atUndo = run.steps.find((x) => x.entry.op === m + 10)?.state;
          const pendingThen = (atUndo?.items ?? []).some(
            (x) => x.event === m + 1 && (x.status === "candidate" || x.status === "awaiting"),
          );
          const effectiveNow = ev.items.some(
            (x) => x.event === m + 1 && (x.status === "applied" || x.status === "corroborated"),
          );
          if (pendingThen && effectiveNow) hits.hit();
          for (const f of ["f2", "f3"] as FieldId[]) {
            for (const seg of ev.fields[f] ?? [])
              expect({ f, by: seg.by?.event }).not.toEqual({ f, by: m + 1 });
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("an include_later undo leaves the values outside D(x) as they were", () => {
    // 03-deletion «回掉的权威定义» step 2; 04-write-and-read «回退»: a later write taken back with
    // the undone operation is taken back only where it supersedes the undone operation's items
    // in effect. Skeleton: random steps; M (SM); X (SX), a later write over part of M and maybe
    // beyond; undo M with include_later, confirmed; sometimes a deletion. Checked: outside the
    // intervals of M's items in effect, the values are those of the same log without the undo.
    // Measured share of hits: about 0.11. Reaching the check is built in (the fixed sample below);
    // the random samples only guard against a generator gone degenerate (about 82 hits at 750
    // runs: odds of none about e^-82).
    const hits = new Hits(Number.MIN_VALUE);
    const skeleton = fc.record({
      m: pair,
      x: pair,
      del: fc.constantFrom<string[]>([], [], ["SX"], ["S1"], ["S2", "S3"]),
    });
    type Skeleton = typeof skeleton extends fc.Arbitrary<infer T> ? T : never;
    const check = (h: { hit(): void }, st: Step[], sk: Skeleton) => {
      const head = extend(STATE, [], st, 10);
      const m = Math.max(0, ...head.map((o) => o.op)) + 10;
      const undo: LogEntry[] = [
        { kind: "undo", op: m + 20, event: m + 21, target: m, includeLater: true },
        { kind: "confirm", op: m + 30, event: m + 31, target: m + 21 },
      ];
      const log = (withUndo: boolean): LogEntry[] => [
        ...head,
        {
          kind: "write",
          op: m,
          event: m + 1,
          seen: m - 1,
          valid: span(...sk.m),
          fields: { f2: { value: "7", sources: ["SM"] } },
          acknowledge: ["overwrite"],
        },
        {
          kind: "write",
          op: m + 10,
          event: m + 11,
          seen: m,
          valid: span(...sk.x),
          fields: { f2: { value: "8", sources: ["SX"] } },
          acknowledge: ["overwrite"],
        },
        ...(withUndo ? undo : []),
        ...(sk.del.length > 0
          ? [{ kind: "deletion" as const, op: m + 40, id: "pi_d", sources: sk.del }]
          : []),
      ];
      const ev = evaluateLog(STATE, log(true)).final;
      const without = evaluateLog(STATE, log(false)).final;
      const own = union(
        ...ev.items
          .filter(
            (x) => x.event === m + 1 && (x.status === "applied" || x.status === "corroborated"),
          )
          .map((x) => x.valid),
      );
      const later = ev.reverts
        .find((r) => r.op === m + 30)
        ?.record.some((e) => e.event === m + 11 && e.later === true);
      const beyond = ev.items.some(
        (x) => x.event === m + 11 && x.status === "applied" && !isEmpty(subtract(x.valid, own)),
      );
      if (later && beyond) h.hit();
      const ends = endpoints([
        own,
        ...[ev, without].flatMap((e) => (e.fields["f2"] ?? []).map((s) => s.valid)),
      ]);
      for (const seg of elementarySegments(ends)) {
        if (covers(own, seg)) continue;
        expect({ seg, v: valueAt(ev, "f2", seg) }).toEqual({
          seg,
          v: valueAt(without, "f2", seg),
        });
      }
    };
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 4 }),
        skeleton,
        hits.track((st, sk) => check(hits, st, sk)),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    // A sample that reaches the check: X over [1, 4) taken back with M over [0, 3), and applied
    // beyond M's items.
    let fixed = false;
    check({ hit: () => (fixed = true) }, [{ t: "undoRevert", back: 1 }] as Step[], {
      m: [0, 3],
      x: [1, 4],
      del: [],
    });
    expect({ fixedSampleReachesTheCheck: fixed }).toEqual({ fixedSampleReachesTheCheck: true });
  });
});

it("no grace period with a decision occurs in the sampled logs", () => {
  // In the first version a decision on a row a pending deletion affects is refused: the grace
  // steps carry none (see `decisionInGracePeriod`).
  expect(counts.withDecisions).toBe(0);
});

it("undos of reverts occur in the sampled logs, also ones accepted through a pending deletion", () => {
  expect(counts.undoOfRevert).toBeGreaterThan(0);
  expect(counts.undoOfRevertRegained).toBeGreaterThan(0);
});

it("original items merging in one segment occur in the sampled logs", () => {
  expect(counts.mergePath).toBeGreaterThan(0);
});

it("the restored-item branch occurs in the sampled logs", () => {
  // Guards against a generator that never exercises the restored original item.
  expect(counts.restoredByCancel + counts.restoredByDeletion).toBeGreaterThan(0);
});

it("order independence covers three deletions and deleting again after a cancellation", () => {
  expect(counts.threeDeletions).toBeGreaterThan(0);
  expect(counts.redo).toBeGreaterThan(0);
});

it("further operations after both deletion orders include undos and decisions", () => {
  expect(counts.furtherOps).toBeGreaterThan(0);
});

it("deletions carried out occur in the sampled logs, and remove interval blocks", () => {
  // Executions in the random steps (refused when the deletion is not pending) and in every order
  // of the order-independence property; removals of blocks counted by the evaluator.
  expect(counts.executeSteps).toBeGreaterThan(0);
  expect(counts.executedOrders).toBeGreaterThan(0);
  expect(segmentStats.removed).toBeGreaterThan(0);
  // A deletion carried out with a write after it, in the log before the deletion orders: about
  // 0.18 of those logs (a third of the samples are drawn on that shape).
  expect(counts.executeThenWrite / counts.prefixLogs).toBeGreaterThan(0.08);
});

it("the generator reaches revokes, two-field writes and resolutions on existence", () => {
  // Per call of `extend`. Measured: about 0.25 revokes, 0.36 two-field writes and 0.018
  // resolutions on existence. Not reached at all: a rejected write with a candidate part, and an
  // undo of a confirmation; those two rules are kept by fixed cases (log.test).
  expect(counts.extended).toBeGreaterThan(0);
  expect(counts.revokes / counts.extended).toBeGreaterThan(0.1);
  expect(counts.twoFieldWrites / counts.extended).toBeGreaterThan(0.15);
  expect(counts.resolvesOnExistence).toBeGreaterThan(0);
  expect(counts.resolvesOnExistence / counts.extended).toBeGreaterThan(0.005);
});

describe("«撤回还原»: a grace-period decision is executed in the baseline as recorded", () => {
  // Found by the property (seed 1238607428). #21 is a candidate against #11, resolved by
  // take_previous; #51 (1 from 11-01) is a candidate against #41 when written. Deleting S2
  // removes #41: #51 erases the change point it saw, awaiting confirmation; a person confirms (or
  // rejects) it in the grace period, then the deletion is cancelled and #41 is back.
  const g = (from: string): WriteOp["valid"] => ({
    from: { mode: "given", value: `2026-${from}` as BizPoint },
    to: { mode: "open" },
  });
  const w = (op: number, seen: number, v: string, src: string, from: string): LogEntry =>
    ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      valid: g(from),
      fields: { f2: { value: v, sources: [src], explicit: false } },
    }) as LogEntry;
  const prefix: LogEntry[] = [
    w(10, 0, "1", "S1", "10-01"),
    w(20, 0, "3", "S1", "11-01"),
    { kind: "resolve", op: 30, event: 31, decision: "take_previous", candidates: [21], unit: "f2" },
    w(40, 30, "3", "S2", "11-01"),
    w(50, 30, "1", "S1", "11-01"),
  ];
  const withD: LogEntry[] = [...prefix, { kind: "deletion", op: 60, id: "pi_d", sources: ["S2"] }];
  for (const kind of ["confirm", "reject"] as const) {
    it(`a ${kind}ation of #51`, () => {
      const grace: LogEntry[] = [{ kind, op: 70, event: 71, target: 51 }];
      const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 90, id: "pi_d" }]);
      const items = (ev: Evaluation, e: number) =>
        ev.items
          .filter((x) => x.event === e)
          .map(
            (x) => `${x.target} ${x.status}${x.closed ? " closed" : ""} ${JSON.stringify(x.valid)}`,
          );
      // #51 stays the awaiting item the decision closed; no candidate is left open, so the conflict
      // item it was a candidate of when written has none: no item is open without candidates, and
      // #51 is not both closed by the decision and a candidate there.
      expect(items(run.final, 51)).toEqual([
        'f2 awaiting closed [{"from":"2026-11-01","to":null}]',
      ]);
      // The open conflict items after the cancellation, by unit (an item is its open candidates):
      // none holds #51 or the write it conflicted with, #41.
      const open = new Map<string, number[]>();
      for (const x of run.final.items) {
        if (x.status !== "candidate" || x.closed) continue;
        open.set(x.target, [...(open.get(x.target) ?? []), x.event]);
      }
      expect([...open.values()].filter((es) => es.includes(51) || es.includes(41))).toEqual([]);
      expect(run.final.items.filter((x) => x.status === "candidate" && !x.closed)).toEqual([]);
      expect((run.final.fields["f2"] ?? []).map((x) => [x.valid[0]?.from, x.value])).toEqual(
        kind === "confirm"
          ? [
              ["2026-10-01", "1"],
              ["2026-11-01", "1"],
            ]
          : [
              ["2026-10-01", "1"],
              ["2026-11-01", "3"],
            ],
      );
      // The confirmation wrote #51's value over #41, back after the cancellation; a rejection wrote
      // nothing and #41's 3 is back.
      expect(items(run.final, 71)).toEqual(
        kind === "confirm" ? ['f2 applied [{"from":"2026-11-01","to":null}]'] : [],
      );
      expect(checkCancelRestores(STATE, prefix, withD, grace, 90)?.decided).toEqual({
        nonEmpty: true,
        differs: true,
      });
    });
  }

  it("an event table: keep_effective on existence while one target's source is pending deletion", () => {
    // #31 gives f2 (SX) and f3 (SY) and meets the revoke #21: a candidate on existence for both.
    // Deleting SX removes #31/f2; keep_effective in the grace period closes what is in the item
    // then (#31/f3). The baseline judging it anew would close #31/f2 too.
    const E: TableSchema = { kind: "event", required: ["f2"] };
    const pre: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
      } as LogEntry,
      { kind: "revoke", op: 20, event: 21, seen: 10 },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        fields: { f2: { value: "3", sources: ["SX"] }, f3: { value: "c", sources: ["SY"] } },
      } as LogEntry,
    ];
    const withD: LogEntry[] = [...pre, { kind: "deletion", op: 50, id: "pi_d", sources: ["SX"] }];
    const grace: LogEntry[] = [
      {
        kind: "resolve",
        op: 60,
        event: 61,
        decision: "keep_effective",
        candidates: [31],
        unit: "existence",
      },
    ];
    expect(checkCancelRestores(E, pre, withD, grace, 70)?.decided).toEqual({
      nonEmpty: true,
      differs: true,
    });
  });

  it("a resolution's candidate the same as the value after the cancellation is a corroboration", () => {
    // Found by the property (seed -915449397). #101 (3, evidence pointed at) is a candidate in the
    // grace period, its item kept by keep_effective. The cancellation brings #41's 3 back over
    // #101's whole range: #101 is no longer a change, a corroboration.
    const pre = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 20,
        valid: { from: { mode: "given", value: "2026-11-05" }, to: { mode: "next_change" } },
        fields: { f2: { value: "3", sources: ["S4"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 40,
        valid: {
          from: { mode: "given", value: "2026-11-07" },
          to: { mode: "given", value: "2026-11-09" },
        },
        fields: { f2: { value: "1", sources: ["S1"], explicit: true } },
      },
      {
        kind: "write",
        op: 80,
        event: 81,
        seen: 60,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f3: { value: "2", sources: ["S4"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as LogEntry[];
    const withD: LogEntry[] = [...pre, { kind: "deletion", op: 90, id: "pi_d", sources: ["S4"] }];
    const grace = [
      {
        kind: "write",
        op: 100,
        event: 101,
        seen: 80,
        valid: { from: { mode: "given", value: "2026-11-05" }, to: { mode: "next_change" } },
        fields: { f2: { value: "3", sources: ["G0"], explicit: true } },
      },
      {
        kind: "resolve",
        op: 110,
        event: 111,
        decision: "keep_effective",
        candidates: [101],
        unit: "f2",
      },
    ] as LogEntry[];
    expect(checkCancelRestores(STATE, pre, withD, grace, 130)?.decided.nonEmpty).toBe(true);
    const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 130, id: "pi_d" }]);
    expect(run.final.items.filter((x) => x.event === 101).map((x) => x.status)).toEqual([
      "corroborated",
    ]);
  });

  it("(A) a confirmed write the same as its seen version after the cancellation is a corroboration", () => {
    // Seed -713180905. #41 resends 1 with evidence pointed at, awaiting in the grace period and
    // confirmed; the cancellation brings #11's 1 back: #41 is the same as the version it saw and
    // still the same before it, a corroboration, not the closed awaiting item (the sameness rule
    // comes first; nothing is left to decide).
    const pre = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 0,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "1", sources: ["S5"], explicit: false } },
      },
    ] as LogEntry[];
    const withD: LogEntry[] = [
      ...pre,
      { kind: "deletion", op: 30, id: "pi_d", sources: ["S1"] } as LogEntry,
    ];
    const grace = [
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["G0"], explicit: true } },
      },
      { kind: "confirm", op: 50, event: 51, target: 41 },
    ] as LogEntry[];
    checkCancelRestores(STATE, pre, withD, grace, 70);
    const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 70, id: "pi_d" }]);
    expect(run.final.items.filter((x) => x.event === 41).map((x) => x.status)).toEqual([
      "corroborated",
    ]);
  });

  it("(B) a closed candidate different from its seen version stays closed, the same as the value now or not", () => {
    // Seed 340210005. #61 (2 from 11-03, no evidence pointed at) is a candidate in the grace period,
    // its item kept by keep_effective; after the cancellation it differs from the version it saw
    // (#11's 1 is back) though the same as the value in effect: still the candidate it closed.
    const pre = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S4"], explicit: true } },
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "3", sources: ["S5"], explicit: false } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
    ] as LogEntry[];
    const withD: LogEntry[] = [
      ...pre,
      { kind: "deletion", op: 50, id: "pi_d", sources: ["S1", "S4"] } as LogEntry,
    ];
    const grace = [
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 30,
        valid: { from: { mode: "given", value: "2026-11-03" }, to: { mode: "open" } },
        fields: { f2: { value: "2", sources: ["G0"], explicit: false } },
      },
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 60,
        valid: { from: { mode: "given", value: "2026-11-03" }, to: { mode: "open" } },
        fields: { f2: { value: "2", sources: ["G1"], explicit: true } },
      },
      {
        kind: "resolve",
        op: 80,
        event: 81,
        decision: "keep_effective",
        candidates: [61],
        unit: "f2",
      },
    ] as LogEntry[];
    checkCancelRestores(STATE, pre, withD, grace, 100);
    const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 100, id: "pi_d" }]);
    expect(
      run.final.items
        .filter((x) => x.event === 61)
        .map((x) => `${x.status}${x.closed ? " closed" : ""}`),
    ).toEqual(["candidate closed"]);
  });

  it("a grace-period write still a change after the cancellation stays the decision's (seed -1688483462)", () => {
    // Deleting S1 at 30 comes before #41 (S4), which erases the boundary it saw at 11-01 and
    // awaits confirmation, never in effect. #71, written while S4's deletion is pending, is
    // confirmed; the cancellation brings #41 back, still awaiting: #71's seen version is without
    // a value on [10-01, 11-01), so #71 is still a change, the awaiting item the confirmation
    // closed — not a corroboration.
    const pre = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S5"], explicit: true } },
      },
      { kind: "deletion", op: 30, id: "pi_30", sources: ["S1"] },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S4"], explicit: true } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "1", sources: ["S3"], explicit: false } },
      },
    ] as LogEntry[];
    const withD: LogEntry[] = [...pre, { kind: "deletion", op: 60, id: "pi_d", sources: ["S4"] }];
    const grace = [
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 60,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["G0"], explicit: true } },
      },
      { kind: "confirm", op: 80, event: 81, target: 71 },
    ] as LogEntry[];
    checkCancelRestores(STATE, pre, withD, grace, 100);
    const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 100, id: "pi_d" }]);
    expect(
      run.final.items
        .filter((x) => x.event === 71)
        .map((x) => `${x.status}${x.closed ? " closed" : ""}`),
    ).toEqual(["awaiting closed"]);
  });

  it("a write the cancellation keeps in effect counts before a grace-period write (seed 639604447)", () => {
    // #41 awaits confirmation when written; deleting S5 puts it in effect, and take_previous in the
    // grace period rests on it, so the cancellation keeps it in effect. #61, the same as its seen
    // version, was changed since by #41: still the candidate take_previous closed.
    const pre = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "2", sources: ["S5"], explicit: false } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "2", sources: ["S1"], explicit: false } },
      },
    ] as LogEntry[];
    const withD: LogEntry[] = [
      ...pre,
      { kind: "deletion", op: 50, id: "pi_d", sources: ["S5"] } as LogEntry,
    ];
    const grace = [
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 30,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "1", sources: ["G0"], explicit: true } },
      },
      {
        kind: "resolve",
        op: 70,
        event: 71,
        decision: "take_previous",
        candidates: [61],
        unit: "f2",
      },
    ] as LogEntry[];
    checkCancelRestores(STATE, pre, withD, grace, 90);
    const run = evaluateLog(STATE, [...withD, ...grace, { kind: "cancel", op: 90, id: "pi_d" }]);
    expect(
      run.final.items
        .filter((x) => x.event === 61)
        .map((x) => `${x.status}${x.closed ? " closed" : ""}`),
    ).toEqual(["candidate closed"]);
  });

  it("a write that was a no-op when written stays one after the cancellation (seed -1477265573)", () => {
    // #41, written in the grace period the same as its seen version, is a no-op and stays one
    // (deviation one: what left no value when written stays so). After the cancellation #51 is the
    // same as its seen version and as the value before it: a corroboration.
    const pre = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: "3", sources: ["S2"], explicit: false } },
      },
    ] as LogEntry[];
    const withD: LogEntry[] = [
      ...pre,
      { kind: "deletion", op: 30, id: "pi_d", sources: ["S2"] } as LogEntry,
    ];
    const grace = [
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        fields: { f2: { value: "1", sources: ["G0"], explicit: false } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 20,
        fields: { f2: { value: "3", sources: ["G1"], explicit: true } },
      },
      {
        kind: "resolve",
        op: 60,
        event: 61,
        decision: "keep_effective",
        candidates: [51],
        unit: "f2",
      },
    ] as LogEntry[];
    checkCancelRestores(EVENT, pre, withD, grace, 80);
    const run = evaluateLog(EVENT, [...withD, ...grace, { kind: "cancel", op: 80, id: "pi_d" }]);
    expect(
      run.final.items
        .filter((x) => x.event === 51)
        .map((x) => `${x.status}${x.closed ? " closed" : ""}`),
    ).toEqual(["corroborated"]);
  });

  it("the second review's logs of items 1 and 3 go through the check", () => {
    const span = (from: string, to: string | null): WriteOp["valid"] => ({
      from: { mode: "given", value: `2026-${from}` as BizPoint },
      to: to === null ? { mode: "open" } : { mode: "given", value: `2026-${to}` as BizPoint },
    });
    const wr = (
      op: number,
      fields: Record<string, [string, string]>,
      valid: WriteOp["valid"],
      extra: object = {},
    ): LogEntry =>
      ({
        kind: "write",
        op,
        event: op + 1,
        valid,
        fields: Object.fromEntries(
          Object.entries(fields).map(([f, [value, src]]) => [f, { value, sources: [src] }]),
        ),
        ...extra,
      }) as LogEntry;
    const ack = { acknowledge: ["overwrite"] };
    // Item 1: #21 awaits confirmation when written; deleting S6 makes it a candidate, taken in the
    // grace period; the cancellation must leave the take (#21 the candidate it closed).
    const pre1: LogEntry[] = [
      wr(10, { f2: ["1", "S1"] }, span("10-01", null)),
      wr(12, { f2: ["7", "S7"] }, span("11-01", null), { seen: 10, ...ack }),
      wr(14, { f2: ["4", "S4"] }, span("10-01", "10-15"), { seen: 12, ...ack }),
      wr(16, { f2: ["3", "S6"] }, span("10-01", "10-15"), { seen: 14, ...ack }),
      wr(20, { f2: ["3", "S3"] }, span("10-01", null), { seen: 12 }),
    ];
    checkCancelRestores(
      STATE,
      pre1,
      [...pre1, { kind: "deletion", op: 30, id: "pi_d", sources: ["S6"] }],
      [
        {
          kind: "resolve",
          op: 40,
          event: 41,
          decision: "take_candidate",
          candidates: [21],
          take: 21,
          unit: "f2",
        },
      ],
      50,
    );
    // Item 3: a field group; deleting SX removes #31's f2, the take lists #31 in the grace period;
    // after the cancellation #31's f2 is put back into an item of its own, not taken.
    const G: TableSchema = {
      kind: "state",
      required: ["f2"],
      groups: [["f2" as FieldId, "f3" as FieldId]],
    };
    const pre3: LogEntry[] = [
      wr(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, span("10-01", null)),
      wr(20, { f2: ["2", "S2"], f3: ["b", "S2"] }, span("10-01", null), { seen: 10, ...ack }),
      wr(30, { f2: ["3", "SX"], f3: ["c", "SY"] }, span("11-01", "11-10"), {
        seen: 10,
        validSources: ["SV"],
      }),
      wr(40, { f2: ["4", "S4"] }, span("11-01", "11-10"), { seen: 10 }),
    ];
    checkCancelRestores(
      G,
      pre3,
      [...pre3, { kind: "deletion", op: 50, id: "pi_d", sources: ["SX"] }],
      [
        {
          kind: "resolve",
          op: 60,
          event: 61,
          decision: "take_candidate",
          candidates: [31, 41],
          take: 31,
          unit: ["f2" as FieldId, "f3" as FieldId],
        },
      ],
      70,
    );
  });
});

describe("logs left out: a decision on a row a pending deletion affects, then a cancellation", () => {
  // Seed 689568591 of «撤回还原» (event table): pi_d deletes S5, which #81 cites; in its grace
  // period a keep_effective on the row, then pi_d is cancelled. In the first version that
  // decision is refused (03-deletion «撤回与宽限期»), so the log is not one the kernel records;
  // the generators leave such cancellations out, and the evaluator's results on it are not
  // checked. Writes in the grace period stay in.
  const ev = (op: number, value: string, src: string, seen: number, explicit = false) =>
    ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      fields: { f2: { value, sources: [src], explicit } },
    }) as LogEntry;
  const log: LogEntry[] = [
    ev(10, "3", "S1", 0),
    { kind: "deletion", op: 20, id: "pi_20", sources: ["S1", "S3"] },
    ev(30, "1", "S1", 20),
    { kind: "cancel", op: 40, id: "pi_20" },
    ev(50, "3", "S1", 40, true),
    ev(60, "1", "S1", 30),
    ev(70, "1", "S3", 60),
    ev(80, "1", "S5", 70, true),
    { kind: "deletion", op: 90, id: "pi_d", sources: ["S5"] },
    {
      kind: "resolve",
      op: 100,
      event: 101,
      decision: "keep_effective",
      candidates: [61],
      unit: "f2",
    },
  ];

  it("the decision makes a cancellation of pi_d one the generators leave out", () => {
    expect(decisionInGracePeriod(log, "pi_d")).toBe(true);
    // pi_20 had only a write in its grace period: its cancellation stays in.
    expect(decisionInGracePeriod(log.slice(0, 4), "pi_20")).toBe(false);
    // A deletion touching nothing the row cites does not affect it.
    expect(
      decisionInGracePeriod(
        [
          ...log.slice(0, 8),
          { kind: "deletion", op: 90, id: "pi_x", sources: ["S_NONE"] },
          log[9] as LogEntry,
        ],
        "pi_x",
      ),
    ).toBe(false);
  });
});

describe("state table: a cancelled deletion leaves no trace, by what a later one restates on its own", () => {
  it("delete A, delete B, cancel A = delete B (seed -13174690)", () => {
    // #70 revokes from 11-01, having seen #40: a candidate against #60 (f3 from 11-01). The record
    // of #50 (the cancellation of a deletion of S3) on f3 rests on #30's f3. Deleting S3 takes #60
    // away and #70 takes effect. Deleting S5 as well (#40's corroboration) makes the deletion of S3
    // restate #30's f3 in its event; once that is cancelled, its list of positions is its own
    // (03-deletion «多项删除各自列全位置»): without S5 it does not restate #30's f3, so #50's record
    // is not on it and #70 still takes effect.
    const given = (value: string) => ({ mode: "given" as const, value: value as BizPoint });
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: given("2026-10-01"), to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S2"], explicit: false } },
      },
      { kind: "deletion", op: 20, id: "pi_20", sources: ["S3"] },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: { from: given("2026-11-01"), to: given("2026-11-03") },
        fields: {
          f2: { value: "1", sources: ["S1"], explicit: false },
          f3: { value: "b", sources: ["S1"] },
        },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: { from: given("2026-11-01"), to: given("2026-11-03") },
        fields: { f2: { value: "1", sources: ["S5"], explicit: true } },
      },
      { kind: "cancel", op: 50, id: "pi_20" },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        valid: { from: given("2026-11-01"), to: { mode: "next_change" } },
        fields: { f3: { value: "1", sources: ["S3"], explicit: false } },
      },
      {
        kind: "revoke",
        op: 70,
        event: 71,
        seen: 40,
        valid: { from: given("2026-11-01"), to: { mode: "open" } },
        validSources: ["S1"],
      },
    ] as LogEntry[];
    const run = (entries: LogEntry[]) => evaluateLog(STATE, [...log, ...entries]).final;
    const onlyB = run([{ kind: "deletion", op: 71, id: "pi_b", sources: ["S3"] }]);
    expect(onlyB.items.filter((x) => x.event === 71).map((x) => [x.target, x.status])).toEqual([
      ["existence", "applied"],
    ]);
    for (const entries of [
      [
        { kind: "deletion", op: 71, id: "pi_a", sources: ["S5"] },
        { kind: "deletion", op: 72, id: "pi_b", sources: ["S3"] },
        { kind: "cancel", op: 73, id: "pi_a" },
      ],
      [
        { kind: "deletion", op: 71, id: "pi_a", sources: ["S5"] },
        { kind: "cancel", op: 72, id: "pi_a" },
        { kind: "deletion", op: 73, id: "pi_b", sources: ["S3"] },
      ],
    ] as LogEntry[][]) {
      expect(stateWithoutIndices(run(entries))).toEqual(stateWithoutIndices(onlyB));
    }
  });
});

describe("a cancellation keeping an item superseded through a write in an earlier deletion's grace period (a property counterexample)", () => {
  // State table, seed 2080978230 of "a cancelled deletion leaves no trace". #21 (revoke from 11-07,
  // S4) and #31 (revoke from 11-01, S1) conflict on existence. pi_40 deletes S4, taking #21 out;
  // in its grace period #61 keeps the effective value against #31, and #81 revokes from 11-07 over
  // #21's interval. #90 cancels pi_40: #21 is a candidate again. Deleting S1 then takes #31 away,
  // so #21 takes effect and its item is superseded; cancelling that deletion keeps it superseded:
  // without it #21 is pending (①), and #81 changed existence where #21 lies while a pending
  // deletion had taken #21 out, whichever deletion that was (②, 03-deletion «撤回与宽限期»). So
  // deleting S1 and cancelling it is not the same as never deleting it here, as the spec says.
  const given = (v: string) => ({ mode: "given", value: v });
  const log = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: { from: given("2026-10-01"), to: { mode: "open" } },
      fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "revoke",
      op: 20,
      event: 21,
      seen: 0,
      valid: { from: given("2026-11-07"), to: { mode: "open" } },
      validSources: ["S4"],
    },
    {
      kind: "revoke",
      op: 30,
      event: 31,
      seen: 0,
      valid: { from: given("2026-11-01"), to: { mode: "open" } },
      validSources: ["S1"],
    },
    { kind: "deletion", op: 40, id: "pi_40", sources: ["S4", "S5"] },
    {
      kind: "write",
      op: 50,
      event: 51,
      seen: 20,
      valid: { from: given("2026-11-01"), to: given("2026-11-05") },
      fields: { f3: { value: "2", sources: ["S3"], explicit: false } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "resolve",
      op: 60,
      event: 61,
      decision: "keep_effective",
      candidates: [31],
      unit: "existence",
    },
    {
      kind: "revoke",
      op: 80,
      event: 81,
      seen: 60,
      valid: { from: given("2026-11-07"), to: { mode: "open" } },
      validSources: ["S3"],
    },
    { kind: "cancel", op: 90, id: "pi_40" },
  ] as LogEntry[];
  const deleteAndCancel = [
    ...log,
    { kind: "deletion", op: 91, id: "pi_a", sources: ["S1"] },
    { kind: "cancel", op: 92, id: "pi_a" },
  ] as LogEntry[];
  const item21 = (entries: readonly LogEntry[]) =>
    evaluateLog(STATE, entries).final.items.find((x) => x.event === 21);

  it("never deleted: #21 a candidate, its item open", () => {
    expect(item21(log)).toMatchObject({ status: "candidate" });
    expect(item21(log)?.closed).toBeUndefined();
  });

  it("deleted and cancelled: the cancellation keeps #21's item superseded", () => {
    const steps = evaluateLog(STATE, deleteAndCancel).steps;
    expect(steps.at(-1)?.keptSuperseded).toEqual([21]);
    expect(item21(deleteAndCancel)).toMatchObject({ status: "candidate", closed: true });
  });
});
