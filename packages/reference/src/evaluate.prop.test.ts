// Property tests on the reference evaluator alone (02-architecture §11, «删除的性质»): no kernel.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { evaluate, evaluateAsWritten, evaluateLog } from "./evaluate.ts";
import { covers, intersect, isEmpty, type Point } from "./interval.ts";
import type {
  Evaluation,
  ItemRef,
  Op,
  SourceKey,
  TableSchema,
  ToParam,
  ValidParam,
  WriteOp,
} from "./model.ts";
import { Hits, propRuns } from "./testing/prop-coverage.fixture.ts";

// An explicit time limit; on a failure (including running out of time) fast-check reports the
// seed and path that reproduce it: `fc.assert(..., { seed, path, endOnFailure: true })`.
vi.setConfig({ testTimeout: 30_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 25_000, markInterruptAsFailure: true });

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const EVENT: TableSchema = { kind: "event", required: ["f2"] };
const DAYS = ["11-01", "11-03", "11-05", "11-07", "11-09", "11-11"].map(
  (x) => `2026-${x}` as BizPoint,
);
const SOURCES = ["S1", "S2", "S3", "S4", "S5", "S6"];

/** One generated step; turned into an op once its operation number is known. */
type Step =
  | {
      t: "write";
      f: FieldId;
      v: string;
      src: string[];
      from: number;
      to: number | "open" | "next";
      lag: number;
      explicit: boolean;
      ack: boolean;
    }
  /**
   * Resend an earlier write's value for its field (a whole-row resend or a restatement): same
   * value, new evidence, with or without `evidence_by_field`, marked `noop` or not.
   */
  | {
      t: "resend";
      back: number;
      src: string;
      explicit: boolean;
      mark: boolean;
      to: number | "same";
    }
  | { t: "revoke"; from: number; to: number; src: string; lag: number }
  | { t: "undo"; back: number; later: boolean; ack: boolean };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("write" as const),
      f: fc.constantFrom<FieldId>("f2", "f2", "f3"),
      v: fc.constantFrom("1", "2", "3"),
      src: fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
      from: fc.nat({ max: DAYS.length - 2 }),
      to: fc.oneof(
        fc.constantFrom<"open" | "next">("open", "next"),
        fc.nat({ max: DAYS.length - 1 }),
      ),
      lag: fc.constantFrom(0, 0, 0, 1, 3),
      explicit: fc.boolean(),
      ack: fc.constantFrom(true, true, false),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("resend" as const),
      back: fc.nat({ max: 3 }),
      src: fc.constantFrom(...SOURCES),
      explicit: fc.boolean(),
      mark: fc.boolean(),
      to: fc.oneof(fc.constant("same" as const), fc.nat({ max: DAYS.length - 1 })),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("revoke" as const),
      from: fc.nat({ max: DAYS.length - 2 }),
      to: fc.nat({ max: DAYS.length - 1 }),
      src: fc.constantFrom(...SOURCES),
      lag: fc.nat({ max: 2 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("undo" as const),
      back: fc.nat({ max: 3 }),
      later: fc.constantFrom(false, false, true),
      ack: fc.constantFrom(true, true, false),
    }),
  },
);

/** Turns steps into ops, continuing after `head` (whose first op created the row or entity). */
function toOps(steps: Step[], state: boolean, head: readonly Op[] = []): Op[] {
  const ops: Op[] = [...head];
  const writes: WriteOp[] = head.filter((o): o is WriteOp => o.kind === "write");
  const start = Math.max(0, ...head.map((o) => o.op));
  steps.forEach((s, i) => {
    const op = start + 10 * (i + 1);
    const event = op + 1;
    const first = i === 0 && head.length === 0;
    const seen = Math.max(0, op - 10 * (1 + (s.t === "write" || s.t === "revoke" ? s.lag : 0)));
    if (s.t === "write" || (first && s.t !== "undo")) {
      const w = s.t === "write" ? s : undefined;
      const from = DAYS[w?.from ?? 0] ?? DAYS[0];
      const end = w ? (typeof w.to === "number" ? Math.max(w.to, w.from + 1) : w.to) : "open";
      const to: ToParam =
        end === "open"
          ? { mode: "open" }
          : end === "next"
            ? { mode: "next_change" }
            : { mode: "given", value: DAYS[end] ?? "2026-12-01" };
      const write: WriteOp = {
        kind: "write",
        op,
        event,
        seen,
        ...(state
          ? {
              valid: {
                from: { mode: "given", value: first ? "2026-10-01" : (from as BizPoint) },
                to: first ? { mode: "open" } : to,
              },
            }
          : {}),
        fields: first
          ? { f2: { value: w?.v ?? "1", sources: w?.src ?? ["S1"] } }
          : {
              [w?.f ?? "f2"]: {
                value: w?.v ?? "1",
                sources: w?.src ?? ["S1"],
                explicit: w?.explicit ?? false,
              },
            },
        ...((w?.ack ?? true) ? { acknowledge: ["overwrite"] as const } : {}),
      };
      ops.push(write);
      writes.push(write);
    } else if (s.t === "resend") {
      const prev = writes[writes.length - 1 - s.back];
      if (prev === undefined) return;
      const [f, input] = Object.entries(prev.fields)[0] ?? [];
      if (f === undefined || input === undefined) return;
      const fid = f as FieldId;
      let valid: ValidParam | undefined = prev.valid;
      if (state && s.to !== "same" && prev.valid !== undefined && prev.valid !== "corrected_span") {
        const pf = prev.valid.from.mode === "given" ? prev.valid.from.value : undefined;
        const end = DAYS[s.to];
        if (pf !== undefined && end !== undefined && end > pf) {
          valid = { from: prev.valid.from, to: { mode: "given", value: end } };
        }
      }
      const write: WriteOp = {
        kind: "write",
        op,
        event,
        seen: op - 10,
        ...(valid !== undefined ? { valid } : {}),
        // A field marked no-op carries no value (09 §5.7 `ops/<i>/noop`).
        fields: s.mark
          ? {}
          : { [fid]: { value: input.value, sources: [s.src], explicit: s.explicit } },
        ...(s.mark ? { noop: [fid] } : {}),
        acknowledge: ["overwrite"],
      };
      ops.push(write);
      writes.push(write);
    } else if (s.t === "revoke") {
      if (!state) return;
      const from = DAYS[s.from] ?? DAYS[0];
      const to = DAYS[Math.max(s.to, s.from + 1)] ?? "2026-12-01";
      if (from === undefined) return;
      ops.push({
        kind: "revoke",
        op,
        event,
        seen,
        valid: {
          from: { mode: "given", value: from },
          to: { mode: "given", value: to as BizPoint },
        },
        validSources: [s.src],
      });
    } else if (s.t === "undo") {
      const target = writes[writes.length - 1 - s.back]?.op;
      if (target === undefined || target === writes[0]?.op) return; // never the first creation
      ops.push({
        kind: "undo",
        op,
        event,
        target,
        includeLater: s.later,
        ...(s.ack ? { seen: op - 10, acknowledge: ["overwrite"] as const } : {}),
      });
    }
  });
  return ops;
}

/** Sources the ops cite: as a source of a field or as evidence for an interval. */
function citedSources(ops: readonly Op[]): SourceKey[] {
  const out = new Set<SourceKey>();
  for (const o of ops) {
    if (o.kind === "write") {
      for (const x of Object.values(o.fields)) for (const y of x?.sources ?? []) out.add(y);
    }
    if (o.kind === "write" || o.kind === "revoke") for (const y of o.validSources ?? []) out.add(y);
  }
  return [...out].sort();
}

/**
 * Two deleted sets for the ops: mostly drawn from the sources they cite (one or two each) except
 * `spare`, now and then from all sources (possibly empty, possibly citing nothing).
 */
const withDeletedSets = (ops: fc.Arbitrary<Op[]>, spare: readonly SourceKey[] = []) =>
  ops.chain((o) => {
    const cited = citedSources(o).filter((x) => !spare.includes(x));
    const some =
      cited.length > 0
        ? fc.oneof(
            {
              weight: 7,
              arbitrary: fc.subarray(cited, { minLength: 1, maxLength: Math.min(2, cited.length) }),
            },
            { weight: 1, arbitrary: fc.subarray(SOURCES, { maxLength: 2 }) },
          )
        : fc.subarray(SOURCES, { maxLength: 2 });
    return fc.record({ ops: fc.constant(o), a: some, b: some });
  });

const scenario = (state: boolean) =>
  withDeletedSets(fc.array(step, { minLength: 2, maxLength: 9 }).map((s) => toOps(s, state)));

/** A generator for one sample in four, a skeleton reaching the checked situation for three. */
const mostly = <T>(random: fc.Arbitrary<T>, skeleton: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 1, arbitrary: random }, { weight: 3, arbitrary: skeleton });

/** Restates the latest write's value without pointing at evidence: judged a no-op. */
const sameValue: fc.Arbitrary<Step> = fc.record({
  t: fc.constant("resend" as const),
  back: fc.constant(0),
  src: fc.constantFrom(...SOURCES),
  explicit: fc.constant(false),
  mark: fc.constant(false),
  to: fc.constant("same" as const),
});

/**
 * A write of a value no other write gives, with a version three ops back and without
 * acknowledging: a conflict or an awaiting write when anything changed since.
 */
const stale: fc.Arbitrary<Step> = fc.record({
  t: fc.constant("write" as const),
  f: fc.constant<FieldId>("f2"),
  v: fc.constant("9"),
  src: fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
  from: fc.nat({ max: DAYS.length - 2 }),
  to: fc.oneof(fc.constantFrom<"open" | "next">("open", "next"), fc.nat({ max: DAYS.length - 1 })),
  lag: fc.constant(3),
  explicit: fc.boolean(),
  ack: fc.constant(false),
});

/** Random steps with `extra` inserted after the first one, `count` times. */
const withSteps = (state: boolean, extra: fc.Arbitrary<Step>, count: number) =>
  withDeletedSets(
    fc
      .tuple(
        fc.array(step, { minLength: 1, maxLength: 7 }),
        fc.array(fc.tuple(extra, fc.nat()), { minLength: count, maxLength: count }),
      )
      .map(([steps, extras]) => {
        const out = [...steps];
        for (const [x, at] of extras) out.splice(1 + (at % out.length), 0, x);
        return toOps(out, state);
      }),
  );

/**
 * A take_previous whose reverted write still gives a value outside the conflict item's interval
 * (03-deletion «回掉的权威定义» step 2: the range is cut to the item's interval). #11 1 (S1);
 * #21 5 from an early day, open (S2); #31 4 on a later stretch with the version before #21, not
 * acknowledged (S3): a candidate; #41 resolves it by take_previous. On a state table #21 is
 * registered as reverted on #31's stretch and gives 5 before it; on an event table the item is
 * whole and is registered as a whole. Random steps follow.
 */
const revertSkeleton = (state: boolean) =>
  withDeletedSets(
    fc
      .tuple(fc.nat({ max: 2 }), fc.nat({ max: 1 }), fc.boolean(), fc.array(step, { maxLength: 3 }))
      .map(([w1From, w2From, w2Open, tail]) => {
        const span = (from: number, to: number | null) =>
          state
            ? {
                valid: {
                  from: { mode: "given" as const, value: DAYS[from] as BizPoint },
                  to:
                    to === null
                      ? { mode: "open" as const }
                      : { mode: "given" as const, value: DAYS[to] as BizPoint },
                },
              }
            : {};
        const head: Op[] = [
          {
            kind: "write",
            op: 10,
            event: 11,
            seen: 0,
            ...(state
              ? {
                  valid: {
                    from: { mode: "given" as const, value: "2026-10-01" as BizPoint },
                    to: { mode: "open" as const },
                  },
                }
              : {}),
            fields: { f2: { value: "1", sources: ["S1"] } },
            acknowledge: ["overwrite"],
          },
          {
            kind: "write",
            op: 20,
            event: 21,
            seen: 10,
            ...span(w1From, null),
            fields: { f2: { value: "5", sources: ["S2"] } },
            acknowledge: ["overwrite"],
          },
          {
            kind: "write",
            op: 30,
            event: 31,
            seen: 10,
            ...span(3 + w2From, w2Open ? null : 5),
            fields: { f2: { value: "4", sources: ["S3"] } },
          },
          {
            kind: "resolve",
            op: 40,
            event: 41,
            decision: "take_previous",
            candidates: [31],
            unit: "f2",
          },
        ];
        return toOps(tail, state, head);
      }),
    // Deleting #21's or #31's source mostly leaves nothing registered; the random scenarios
    // delete them.
    ["S2", "S3"],
  );

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

const RUNS = propRuns(4000);
const pending = (s: string): boolean => s === "candidate" || s === "awaiting";
const effective = (s: string) => s === "applied" || s === "corroborated";
const etKey = (x: { event: number; target: string }) => `${x.event}/${x.target}`;

/** Whether any op cites one of `deleted` as a source or as evidence for its interval. */
function cites(ops: readonly Op[], deleted: readonly SourceKey[]): boolean {
  return ops.some((o) => {
    const own =
      o.kind === "write"
        ? [...Object.values(o.fields).flatMap((x) => x?.sources ?? []), ...(o.validSources ?? [])]
        : o.kind === "revoke"
          ? [...(o.validSources ?? [])]
          : [];
    return own.some((x) => deleted.includes(x));
  });
}

function comparable(ev: Evaluation) {
  return {
    ...ev,
    items: [...ev.items].sort(
      (x, y) => x.event - y.event || x.target.localeCompare(y.target) || x.k - y.k,
    ),
  };
}

/** Fields judged a no-op at write time: marked, or present in the request without any item. */
function writeTimeNoops(ops: readonly Op[], asWritten: Evaluation): string[] {
  const out: string[] = [];
  for (const o of ops) {
    if (o.kind !== "write") continue;
    for (const f of o.noop ?? []) out.push(etKey({ event: o.event, target: f }));
    for (const f of Object.keys(o.fields)) {
      if (!asWritten.items.some((x) => x.event === o.event && x.target === f)) {
        out.push(etKey({ event: o.event, target: f }));
      }
    }
  }
  return out;
}

/** Every source an item's value comes from, following carried references to the end. */
function valueSources(
  ops: readonly Op[],
  ev: Evaluation,
  ref: ItemRef,
  seen = new Set<string>(),
): SourceKey[] {
  const key = `${ref.event}/${ref.target}/${ref.k}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const o = ops.find((x) => x.event === ref.event);
  if (o?.kind === "write") {
    const own = ref.target === "existence" ? [] : (o.fields[ref.target]?.sources ?? []);
    const evidence = Object.values(o.fields).flatMap((x) => x?.sources ?? []);
    return [...own, ...(o.valid !== undefined ? [...(o.validSources ?? evidence)] : [])];
  }
  if (o?.kind === "revoke") return [...(o.validSources ?? [])];
  const item = ev.items.find(
    (x) => x.event === ref.event && x.target === ref.target && x.k === ref.k,
  );
  return (item?.carried ?? []).flatMap((c) => valueSources(ops, ev, c, seen));
}

/** Business dates a surviving op said itself (explicit interval ends with their sources intact). */
function survivingDates(ops: readonly Op[], deleted: ReadonlySet<SourceKey>): Set<Point> {
  const out = new Set<Point>();
  for (const o of ops) {
    if (
      (o.kind !== "write" && o.kind !== "revoke") ||
      o.valid === undefined ||
      o.valid === "corrected_span"
    ) {
      continue;
    }
    const evidence =
      o.kind === "write" ? Object.values(o.fields).flatMap((x) => x?.sources ?? []) : [];
    const sources = o.validSources ?? evidence;
    if (sources.some((s) => deleted.has(s))) continue;
    if (o.valid.from.mode === "given") out.add(o.valid.from.value);
    if (o.valid.to.mode === "given") out.add(o.valid.to.value);
  }
  return out;
}

describe.each(both)("%s table", (_, schema, state) => {
  it("a deletion that removes nothing, at any point of the log, leaves the replay unchanged", () => {
    // 02-architecture §11 «不多删», with the deletion between operations: a deletion event that
    // changed nothing is no change for the operations after it.
    // Measured share of hits: 1 (every sample).
    const hits = new Hits(0.95);
    fc.assert(
      fc.property(
        scenario(state),
        fc.nat(),
        hits.track(({ ops }, at) => {
          const after = ops[at % ops.length]?.op ?? 0;
          const log = [
            ...ops,
            { kind: "deletion" as const, op: after + 5, id: "none", sources: ["S_UNUSED"] },
          ];
          hits.hit();
          expect(comparable(evaluateLog(schema, log).final)).toEqual(
            comparable(evaluateAsWritten(schema, ops)),
          );
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("the result does not depend on how the deleted set is listed", () => {
    // Not yet «顺序无关» itself (delete A, then B): that is a property of logs (log.prop.test.ts).
    // Measured share of hits: about 0.83 on both tables.
    const hits = new Hits(0.7);
    fc.assert(
      fc.property(
        scenario(state),
        hits.track(({ ops, a, b }) => {
          if (cites(ops, a) && cites(ops, b)) hits.hit();
          const ab = evaluate(schema, ops, [...a, ...b]);
          expect(comparable(evaluate(schema, ops, [...b, ...a]))).toEqual(comparable(ab));
          expect(comparable(evaluate(schema, ops, [...a, ...b, ...a]))).toEqual(comparable(ab));
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a field judged a no-op at write time stays a no-op under any deletion", () => {
    // 03-deletion «删除结果的定义», deviation one; 02-architecture §11 «无操作保持无操作».
    // Measured share of hits: about 0.67 (state) and 0.71 (event).
    const hits = new Hits(0.55);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, sameValue, 2)),
        hits.track(({ ops, a }) => {
          const noops = new Set(writeTimeNoops(ops, evaluateAsWritten(schema, ops)));
          if (noops.size > 0 && cites(ops, a)) hits.hit();
          const ev = evaluate(schema, ops, a);
          const revived = ev.items.filter((x) => noops.has(etKey(x)) && x.status !== "dropped");
          expect(revived).toEqual([]);
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a same-value write without evidence produces no item after any deletion", () => {
    // Measured share of hits: about 0.62 (state) and 0.66 (event).
    const hits = new Hits(0.5);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, sameValue, 2)),
        hits.track(({ ops, a }) => {
          const asWritten = evaluateAsWritten(schema, ops);
          const ev = evaluate(schema, ops, a);
          for (const o of ops) {
            if (o.kind !== "write") continue;
            for (const [f, input] of Object.entries(o.fields)) {
              if (input?.explicit) continue;
              if (asWritten.items.some((x) => x.event === o.event && x.target === f)) continue;
              if (cites(ops, a)) hits.hit();
              const items = ev.items.filter(
                (x) => x.event === o.event && x.target === f && x.status !== "dropped",
              );
              expect(items).toEqual([]);
            }
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a deletion adds no pending items", () => {
    // 03-deletion «推论» «删除不增加未决事项»: every new pending item is an awaiting item converted
    // from a conflict item this deletion superseded, or the same write's pending item changed
    // kind (awaiting ↔ conflict), the original superseded by this deletion, a new item replacing
    // it one for one. Items an earlier deletion superseded need deletions interleaved with
    // operations (log.prop.test.ts). The evaluator gives statuses, not items, so "one for one" is
    // checked per (write, field or existence): a pending item now has a pending item of the same
    // write before, and there are no more of them than before.
    // Measured share of hits: about 0.37 (state) and 0.50 (event).
    const hits = new Hits(0.25);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, stale, 3)),
        hits.track(({ ops, a }) => {
          const before = new Map<string, string[]>();
          for (const x of evaluateAsWritten(schema, ops).items) {
            before.set(etKey(x), [...(before.get(etKey(x)) ?? []), x.status]);
          }
          const now = new Map<string, string[]>();
          for (const x of evaluate(schema, ops, a).items) {
            if (pending(x.status)) now.set(etKey(x), [...(now.get(etKey(x)) ?? []), x.status]);
          }
          if (now.size > 0 && cites(ops, a)) hits.hit();
          for (const [key, statuses] of now) {
            const was = (before.get(key) ?? []).filter(pending);
            for (const st of statuses) {
              const branch = was.includes(st)
                ? "not new"
                : st === "awaiting" && was.includes("candidate")
                  ? "conflict → awaiting"
                  : st === "candidate" && was.includes("awaiting")
                    ? "awaiting → conflict"
                    : "none";
              expect({ key, now: st, was, branch }).not.toMatchObject({ branch: "none" });
            }
            // One pending item per write and field and kind: a judgement carried by several
            // contribution items (a segment cut by 09 §5.7) is still one pending item.
            const kinds = new Set(statuses).size;
            expect({ key, kinds }).toEqual({ key, kinds: Math.min(kinds, new Set(was).size) });
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a deletion removes nothing that does not depend on the deleted sources", () => {
    // 02-architecture §11 «不多删»: a deleted set no op cites leaves the result unchanged.
    // Measured share of hits: 1 (every sample).
    const hits = new Hits(0.95);
    fc.assert(
      fc.property(
        scenario(state),
        hits.track(({ ops }) => {
          hits.hit();
          expect(comparable(evaluate(schema, ops, ["S_UNUSED"]))).toEqual(
            comparable(evaluate(schema, ops, [])),
          );
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("no value and no endpoint in the result derives from a deleted source", () => {
    // 02-architecture §11 «不漏删»: every value's sources (through carried references) are
    // intact, and every segment or gap endpoint is a date some surviving op said itself.
    // Measured share of hits: about 0.53 on both tables.
    const hits = new Hits(0.4);
    fc.assert(
      fc.property(
        scenario(state),
        hits.track(({ ops, a }) => {
          const deleted = new Set(a);
          const ev = evaluate(schema, ops, a);
          const dates = survivingDates(ops, deleted);
          if (cites(ops, a) && Object.values(ev.fields).some((x) => (x ?? []).length > 0)) {
            hits.hit();
          }
          for (const segs of Object.values(ev.fields)) {
            for (const seg of segs ?? []) {
              if (seg.by !== undefined) {
                const leaked = valueSources(ops, ev, seg.by).filter((s) => deleted.has(s));
                expect({ by: seg.by, leaked }).toEqual({ by: seg.by, leaked: [] });
              }
              for (const x of seg.valid) {
                for (const p of [x.from, x.to]) if (p !== null) expect(dates).toContain(p);
              }
            }
          }
          for (const g of ev.gaps)
            for (const p of [g.from, g.to]) if (p !== null) expect(dates).toContain(p);
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("what was in effect stays in effect: a deletion turns no effective item pending", () => {
    // 03-deletion «删除结果的定义», deviation two (corroborations included). The assertion fires
    // only on a violation; a hit is a sample in which the deletion removed some item and an item
    // wholly in effect at write time is still there.
    // Measured share of hits: about 0.76 (state) and 0.70 (event).
    const hits = new Hits(0.6);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, stale, 3)),
        hits.track(({ ops, a }) => {
          // Per (write, field) that was wholly in effect at write time; a corroboration split
          // into a corroborated part and a candidate part has a pending part that was never in
          // effect.
          const asWritten = evaluateAsWritten(schema, ops);
          const was = new Map<string, string[]>();
          for (const x of asWritten.items) {
            was.set(etKey(x), [...(was.get(etKey(x)) ?? []), x.status]);
          }
          const ev = evaluate(schema, ops, a);
          const present = new Set(
            ev.items.filter((x) => x.status !== "dropped").map((x) => etKey(x)),
          );
          const removedSome = asWritten.items.some((x) => !present.has(etKey(x)));
          for (const x of ev.items) {
            const before = was.get(etKey(x)) ?? [];
            if (before.length === 0 || !before.every(effective)) continue;
            if (removedSome && x.status !== "dropped") hits.hit();
            if (pending(x.status)) {
              expect({ item: etKey(x), now: x.status }).toEqual({
                item: etKey(x),
                now: before[0],
              });
            }
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a revert never falls back to the reverted value", () => {
    // 03-deletion «回掉的权威定义» step 3: "任何情况下都不落回被回掉的项自己的值". Two checks, each a
    // hit: a segment given by a revert's write-back item carries its value from no write the
    // revert lists; and a segment given by an item registered as reverted lies outside its
    // registrations. On an event table an item is registered as a whole and gives no value at
    // all: an item registered as reverted is a hit.
    // Measured share of hits: about 0.67 (state) and 0.75 (event).
    const hits = new Hits(0.5);
    fc.assert(
      fc.property(
        mostly(scenario(state), revertSkeleton(state)),
        hits.track(({ ops, a }) => {
          const ev = evaluate(schema, ops, a);
          const segs = Object.entries(ev.fields).flatMap(([f, xs]) =>
            (xs ?? []).map((seg) => ({ f, seg })),
          );
          for (const rv of ev.reverts) {
            if (rv.status !== "applied") continue;
            const listed = new Set(rv.record.map((x) => x.event));
            for (const { seg } of segs) {
              if (seg.by?.event !== rv.event) continue;
              hits.hit();
              const item = ev.items.find(
                (x) => x.event === rv.event && x.target === seg.by?.target && x.k === seg.by?.k,
              );
              const from = (item?.carried ?? []).map((x) => x.event).filter((e) => listed.has(e));
              expect({ revert: rv.event, carriedFromListed: from }).toEqual({
                revert: rv.event,
                carriedFromListed: [],
              });
            }
          }
          for (const r of ev.items) {
            if (r.registrations.length === 0) continue;
            if (!state) hits.hit();
            for (const { f, seg } of segs) {
              const by = seg.by;
              if (by === undefined || by.event !== r.event || by.target !== f || by.k !== r.k)
                continue;
              hits.hit();
              for (const reg of r.registrations) {
                // Where it is registered as reverted, the item gives no value.
                expect(isEmpty(intersect(seg.valid, reg.valid))).toBe(true);
              }
            }
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });
});

it("every segment lies outside the gaps after any deletion", () => {
  // Sanity check of the output shape on a state table.
  // Measured share of hits: about 0.60.
  const hits = new Hits(0.45);
  fc.assert(
    fc.property(
      scenario(true),
      hits.track(({ ops, a }) => {
        const ev = evaluate(STATE, ops, a);
        const segs = ev.fields["f2"] ?? [];
        if (ev.gaps.length > 0 && segs.length > 0) hits.hit();
        for (const seg of segs) {
          for (const x of seg.valid) expect(ev.gaps.some((g) => covers([g], x))).toBe(false);
        }
      }),
    ),
    { numRuns: RUNS },
  );
  hits.check();
});
