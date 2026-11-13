// Property tests over logs with deletions interleaved with operations (02-architecture §11,
// «删除的性质»): no kernel.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { evaluateLog, segmentStats } from "./evaluate.ts";
import { covers, elementarySegments, endpoints, type IvSet, union } from "./interval.ts";
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
fc.configureGlobal({ interruptAfterTimeLimit: 25_000, markInterruptAsFailure: true });

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const EVENT: TableSchema = { kind: "event", required: ["f2"] };
const DAYS = ["11-01", "11-03", "11-05", "11-07", "11-09"].map((x) => `2026-${x}` as BizPoint);
const SOURCES = ["S1", "S2", "S3", "S4", "S5"];
const RUNS = propRuns(1500);

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
    }
  /** Restate an earlier write's value for its field, with or without evidence pointed at. */
  | { t: "resend"; back: number; src: string; explicit: boolean }
  | { t: "undo"; back: number }
  /** Undo an earlier undo (a revert), if any. */
  | { t: "undoRevert"; back: number }
  | { t: "delete"; src: string[] }
  | { t: "cancel"; back: number }
  /** Resolve the first open conflict item (by field), if any. */
  | { t: "resolve"; decision: "keep_effective" | "take_candidate" | "take_previous" }
  /** Confirm or reject the first open awaiting item, if any. */
  | { t: "confirm"; reject: boolean };

const write = fc.record({
  t: fc.constant("write" as const),
  f: fc.constantFrom<FieldId>("f2", "f2", "f3"),
  v: fc.constantFrom("1", "2", "3"),
  src: fc.constantFrom(...SOURCES),
  from: fc.nat({ max: DAYS.length - 2 }),
  to: fc.oneof(fc.constantFrom<"open" | "next">("open", "next"), fc.nat({ max: DAYS.length - 1 })),
  lag: fc.constantFrom(0, 1, 1, 2),
  explicit: fc.boolean(),
  ack: fc.boolean(),
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
  { weight: 4, arbitrary: decisions },
);

/** Operations after two deletion orders: writes, restatements, undos and decisions. */
const furtherStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: write },
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

/** Grace-period steps: writes, restatements and decisions, no deletion events. */
const graceStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: write },
  { weight: 2, arbitrary: resend },
  { weight: 2, arbitrary: decisions },
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
    } else if (s.t === "cancel") {
      const id = deletions()[deletions().length - 1 - s.back];
      if (id !== undefined) out.push({ kind: "cancel", op, id });
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
      if (first.target === "existence") return;
      const candidates = [
        ...new Set(open.filter((x) => x.target === first.target).map((x) => x.event)),
      ];
      out.push({
        kind: "resolve",
        op,
        event: op + 1,
        decision: s.decision,
        candidates,
        unit: first.target,
        ...(s.decision === "take_candidate" ? { take: first.event } : {}),
      });
    }
  });
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

/** Sources the log's writes cite: as a source of a field or as evidence for an interval. */
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

/** Writes, then an undo of one of them: a revert with write-back items for deletions to restate. */
const revertSteps: fc.Arbitrary<Step[]> = fc
  .tuple(fc.array(write, { minLength: 2, maxLength: 5 }), fc.nat({ max: 2 }))
  .map(([ws, back]) => [...ws, { t: "undo" as const, back }]);

/**
 * Original items of one write cut and joined again (09 §5.7), modelled on the counterexamples
 * found by the order-independence properties: a first write; one to three writes that cut the
 * timeline; a write with the ver of the first write (so the others are changes it did not see),
 * often with the first write's value, cut into candidate and corroborating items; an undo of it
 * that lists only its effective items; then up to two writes that may join segments again
 * (default ends among them). Values, dates, sources and evidence are random; which sources are
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
 * those that cut or join the old write), never the old write's own S2: deleting it removes the write whose
 * items are cut and joined.
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
  withDecisions: 0,
  undoOfRevert: 0,
  undoOfRevertRegained: 0,
  splitPath: 0,
  mergePath: 0,
  replacedAfterEarlier: 0,
  furtherOps: 0,
  threeDeletions: 0,
  redo: 0,
};

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

describe.each(both)("%s table", (_, schema, state) => {
  it("successive deletions: A then B = B then A = {A, B} at once, after any log", () => {
    // 02-architecture §11 «顺序无关». The log before the deletions keeps its own deletions,
    // cancellations and grace-period writes. Two or three sets (about 0.17 of the samples run
    // have three), in several orders; in about 0.4, also orders that delete a set, cancel that
    // deletion and delete it again later (its restatements stay among the items' interval blocks,
    // 03-deletion «回掉的权威定义» step 6).
    // Half the samples come from `cutSteps`, which reach the cut of original items at a
    // deletion confirmation (09 §5.7); its share is checked apart (state table only).
    // Measured share of hits: about 0.80 (state) and 0.77 (event). Of cuts: about 0.23 (state).
    const hits = new Hits(0.5);
    const splits = new Hits(0.15);
    fc.assert(
      fc.property(
        fc.oneof(withTwoSets(schema), cutSets),
        hits.track(
          splits.track((sets) => {
            const splitBefore = segmentStats.split;
            const log = extend(schema, [], sets.st, 10);
            const pending = pendingSources(evaluateLog(schema, log));
            const d = deletionOrders(log, sets, pending);
            fc.pre(d !== undefined);
            const [p0, p1, p2] = d.parts;
            if (changes(schema, log, p0 ?? []) && changes(schema, log, p1 ?? [])) hits.hit();
            if (p2 !== undefined) counts.threeDeletions++;
            if (sets.redo) counts.redo++;
            const [x, ...rest] = d.orders.map((ds) =>
              stateWithoutIndices(evaluateLog(schema, [...log, ...ds]).final),
            );
            if (segmentStats.split > splitBefore) splits.hit();
            counts.splitPath += segmentStats.split - splitBefore;
            for (const y of rest) expect(y).toEqual(x);
          }),
        ),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    if (state) splits.check();
  });

  it("successive deletions: the same further operations after either order give the same result", () => {
    // 03-deletion «推论» «顺序无关»: writes carrying the current ver, and operations judged without
    // a ver (undo, take_previous and the other decisions), appended after each of the deletion
    // orders of the property above (two or three sets, with and without deleting again after a
    // cancellation) give the same state and items. A write with an old ver may be judged
    // differently: a deletion counts as a change over the intervals it recorded.
    // One sample in four comes from `cutSteps` (see the property above); the share of samples
    // reaching the cut is checked apart (state table only).
    // Measured share of hits: about 0.86 (state) and 0.86 (event). Of cuts: about 0.12 (state).
    const hits = new Hits(0.7);
    const splits = new Hits(0.07);
    fc.assert(
      fc.property(
        furtherCase(schema),
        hits.track(
          splits.track(([sets, after]) => {
            const splitBefore = segmentStats.split;
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
            // every order; each write carries the current ver: nothing happened after its `seen`.
            const ab = [...log, ...(orders[0] as LogEntry[])];
            const tail = extend(schema, ab, after, last + 10)
              .slice(ab.length)
              .map((e) => (e.kind === "write" ? { ...e, seen: e.op - 1 } : e));
            if (tail.some((e) => e.kind === "undo" || e.kind === "resolve")) counts.furtherOps++;
            const [x, ...rest] = orders.map((ds) =>
              stateWithoutIndices(evaluateLog(schema, [...log, ...ds, ...tail]).final),
            );
            if (segmentStats.split > splitBefore) splits.hit();
            counts.splitPath += segmentStats.split - splitBefore;
            for (const y of rest) expect(y).toEqual(x);
          }),
        ),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    if (state) splits.check();
  });

  it("a cancelled deletion leaves no trace: delete A, cancel A, delete B = delete B (either cancel point)", () => {
    // 03-deletion «撤回与宽限期»: a cancelled deletion no longer counts as deleted, so it must not
    // change what a later deletion gives, including how items are cut (step 6). No grace-period
    // writes in between: nothing is kept in effect.
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
          expect(
            run([
              { kind: "deletion", op: last + 1, id: "pi_a", sources: a },
              { kind: "cancel", op: last + 2, id: "pi_a" },
              { kind: "deletion", op: last + 3, id: "pi_b", sources: b },
            ]),
          ).toEqual(onlyB);
          expect(
            run([
              { kind: "deletion", op: last + 1, id: "pi_a", sources: a },
              { kind: "deletion", op: last + 2, id: "pi_b", sources: b },
              { kind: "cancel", op: last + 3, id: "pi_a" },
            ]),
          ).toEqual(onlyB);
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("«撤回还原»: after a cancellation, what grace-period writes did not cover is as the forced replay", () => {
    // 03-deletion «推论» «撤回还原»: the part not covered by grace-period writes equals the replay
    // in which the deletion was never confirmed, the writes recorded as kept in effect take
    // effect at their own write numbers, and writes whose items were kept superseded do not take
    // effect. Compared: field values outside grace-period coverage, and the judgement and openness
    // of every item of the operations before the deletion. Other deletions may be pending
    // throughout; grace-period steps include restatements and decisions. Candidates the
    // cancellation put back are left out of the item comparison: their judgement at the
    // cancellation is a rule of its own (03-deletion «撤回与宽限期»).
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
          grace = grace.map((e) => (e.kind === "write" && lateVer ? { ...e, seen: e.op - 1 } : e));
          const cancelOp = dOp + 10 * (graceSteps.length + 2);
          const run = evaluateLog(schema, [
            ...withD,
            ...grace,
            { kind: "cancel", op: cancelOp, id: "pi_d" },
          ]);
          // Entries refused in the run never entered the log; the baseline has none of them.
          const refused = new Set(run.steps.filter((x) => x.refused).map((x) => x.entry));
          fc.pre(!refused.has(withD[withD.length - 1] as LogEntry));
          grace = grace.filter((e) => !refused.has(e));
          const cancelStep = run.steps.at(-1);
          const kept = cancelStep?.keptEffective ?? [];
          counts.keptEffective += kept.length;
          if (grace.some((e) => e.kind !== "write")) counts.withDecisions++;
          const cancelled = run.final;
          const base = evaluateLog(schema, [...prefix.filter((e) => !refused.has(e)), ...grace], {
            forcedEffective: kept,
            forcedSuperseded: cancelStep?.keptSuperseded ?? [],
          }).final;
          const graceEvents = new Set(
            grace
              .filter((e): e is Op => e.kind !== "deletion" && e.kind !== "cancel")
              .map((e) => e.event),
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
            const covered = union(...coveredBy(cancelled), ...coveredBy(base));
            const sets: IvSet[] = [covered, cancelled.gaps, base.gaps];
            for (const ev of [cancelled, base])
              for (const x of ev.fields[f] ?? []) sets.push(x.valid);
            const segs = state ? elementarySegments(endpoints(sets)) : [{ from: null, to: null }];
            for (const g of segs) {
              if (covers(covered, g)) continue;
              const at = (ev: Evaluation) => {
                if (state && ev.gaps.some((x) => covers([x], g))) return "no value";
                if (!state && !ev.exists) return "no row";
                return JSON.stringify(
                  (ev.fields[f] ?? []).find((x) => covers(x.valid, g))?.value ?? null,
                );
              };
              expect({ f, at: g, value: at(cancelled) }).toEqual({ f, at: g, value: at(base) });
            }
          }
          // Items of the operations before the deletion.
          const prefixEvents = new Set(
            prefix
              .filter((e): e is Op => e.kind !== "deletion" && e.kind !== "cancel")
              .map((e) => e.event),
          );
          const excluded = new Set((cancelStep?.putBack ?? []).map((x) => String(x.event)));
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
            return [...by.entries()]
              .map(([key, vs]) => `${key} ${JSON.stringify(union(...vs))}`)
              .sort();
          };
          expect(judgement(cancelled)).toEqual(judgement(base));
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
    // undo; then, sometimes, X's source deleted.
    const skeleton = fc.record({
      w: fc.tuple(fc.nat({ max: DAYS.length - 2 }), fc.nat({ max: DAYS.length - 1 })),
      x: fc.tuple(fc.nat({ max: DAYS.length - 2 }), fc.nat({ max: DAYS.length - 1 })),
      deleteX: fc.boolean(),
    });
    // Measured share of hits: about 0.86 (state) and 0.91 (event).
    const hits = new Hits(0.7);
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
            {
              kind: "undo",
              op: at + 30,
              event: at + 31,
              target: at + 20,
              seen: at + 20,
              acknowledge: ["overwrite"],
            },
            ...(sk.deleteX
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
            if (
              undo.record.length === 0 &&
              ev.items.some((x) => x.event === u.event && x.status !== "dropped")
            ) {
              counts.undoOfRevertRegained++;
            }
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

  it("original items of one write in one segment: cut only on intervals not cleared, no endpoint leaks", () => {
    // 09 §5.7 with a skeleton that reaches both paths. A write-back k0 of an undo is split by a
    // write y that takes effect only through a deletion; a take_previous may list k0 before the
    // deletion; the deletion may be cancelled, or followed by deleting y's own source (the
    // boundary cleared: merged). At a cancellation nothing is cut any more: the items only the
    // cancelled deletion gave are not originals (03-deletion «回掉的权威定义» step 6), and the
    // segment is one item, as never deleted. Checked: no segment endpoint comes from a deleted
    // source, and after the cancellation the values equal the replay in which nothing was deleted.
    if (!state) return;
    const skeleton = fc.record({
      yFrom: fc.constantFrom("2026-11-08", "2026-11-10", "2026-11-12") as fc.Arbitrary<BizPoint>,
      // The cut comes with a listing and "cancel", the forced merge with a listing and
      // "delete-y"; the rest are controls.
      listed: fc.constantFrom(true, true, true, false),
      ending: fc.constantFrom("cancel", "cancel", "delete-y", "delete-y", "none"),
      tailSteps: fc.array(step, { maxLength: 2 }),
    });
    // Half the samples come from `cutSteps` instead, with two or three deleted sets in every order
    // of the order-independence properties, cancellations included: they reach the cut at a
    // deletion confirmation, counted apart.
    // Measured share of hits: about 0.20. Of cuts: about 0.15.
    const hits = new Hits(0.15);
    const splits = new Hits(0.1);
    const fromCut = cutSets.map((sets) => ({ sets }));
    fc.assert(
      fc.property(
        fc.oneof(
          skeleton.map((sk) => ({ kind: "skeleton" as const, ...sk })),
          fromCut.map((c) => ({ kind: "cut" as const, ...c })),
        ),
        hits.track(
          splits.track((sample) => {
            if (sample.kind === "cut") {
              const log = extend(schema, [], sample.sets.st, 10);
              const d = deletionOrders(log, sample.sets, pendingSources(evaluateLog(schema, log)));
              fc.pre(d !== undefined);
              const before = { ...segmentStats };
              for (const ds of d.orders) {
                const full = [...log, ...ds];
                noEndpointLeak(full, evaluateLog(schema, full));
              }
              counts.splitPath += segmentStats.split - before.split;
              counts.mergePath += segmentStats.forcedMerge - before.forcedMerge;
              if (segmentStats.split > before.split) splits.hit();
              if (
                segmentStats.split > before.split ||
                segmentStats.forcedMerge > before.forcedMerge
              ) {
                hits.hit();
              }
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
            counts.splitPath += segmentStats.split - before.split;
            counts.mergePath += segmentStats.forcedMerge - before.forcedMerge;
            if (
              segmentStats.split > before.split ||
              segmentStats.forcedMerge > before.forcedMerge
            ) {
              hits.hit();
            }
            if (segmentStats.split > before.split) splits.hit();
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
      ),
      { numRuns: RUNS },
    );
    hits.check();
    splits.check();
  });

  it("an include_later undo neither confirmed nor in effect when written never takes back a later write's item", () => {
    // 05-time «高影响写入» ④, 09 §5.7: revert statuses are decided in operation order, each as if
    // in effect. An include_later undo that took back later writes awaits confirmation; if a
    // deletion later puts it in effect without a confirmation, what it executes registers only
    // items of its target. Samples: some writes; on the state table sometimes a revoke inside the
    // target's interval; the target write; up to three later writes over it and, mostly, an undo
    // of the target (its write-back items are a later operation too); an include_later undo of
    // the target (with or without acknowledge); one or two deletions (the first sometimes
    // cancelled) and further steps. A hit: the undo awaited when written and is in effect at the
    // end — the path where the check bites.
    // Half the samples come from the skeleton; there the undo stays awaiting (it would take back
    // the later undo's item), so they are not hits but catch an evaluator that decides it in effect.
    // Measured share of hits: about 0.06 (state) and 0.09 (event).
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
    const hits = new Hits(0.04);
    fc.assert(
      fc.property(
        fc.oneof({ weight: 1, arbitrary: sample }, { weight: 1, arbitrary: skeleton }),
        hits.track(
          ({ pre, revoke, mid, target, later, ack, innerUndo, dels, cancelFirst, tail }) => {
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
            if (atWrite === "awaiting") hits.hit();
            const foreign = run.final.items
              .filter((x) => x.registrations.some((r) => r.byOp === undoOp) && x.op !== targetOp)
              .map((x) => `${x.event}/${x.target}/${x.k}`);
            expect({ undoOp, foreign }).toEqual({ undoOp, foreign: [] });
          },
        ),
      ),
      { numRuns: RUNS },
    );
    hits.check();
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
        mostly(steps, deletionAfterConflict),
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
                // by several contribution items, a segment cut by 09 §5.7, is still one), and no
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

it("grace periods with decisions occur in the sampled logs", () => {
  expect(counts.withDecisions).toBeGreaterThan(0);
});

it("undos of reverts occur in the sampled logs, also ones whose target regained write-back items", () => {
  expect(counts.undoOfRevert).toBeGreaterThan(0);
  expect(counts.undoOfRevertRegained).toBeGreaterThan(0);
});

it("original items in one segment: both the cut and the forced merge occur in the sampled logs", () => {
  expect(counts.splitPath).toBeGreaterThan(0);
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
