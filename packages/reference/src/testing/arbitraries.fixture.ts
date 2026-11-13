// Generators of operation logs for property tests: a few fields, days and sources, so that
// generated writes meet, cover and conflict often. Shared by the reference evaluator's own property
// tests and by tests that compare an implementation with it (02-architecture §11 «测试矩阵»).

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import type { Op, SourceKey, TableSchema, ToParam, ValidParam, WriteOp } from "../model.ts";

export const STATE: TableSchema = { kind: "state", required: ["f2"] };
export const EVENT: TableSchema = { kind: "event", required: ["f2"] };
export const DAYS = ["11-01", "11-03", "11-05", "11-07", "11-09", "11-11"].map(
  (x) => `2026-${x}` as BizPoint,
);
export const SOURCES = ["S1", "S2", "S3", "S4", "S5", "S6"];

/** One generated step; turned into an op once its operation number is known. */
export type Step =
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

export const step: fc.Arbitrary<Step> = fc.oneof(
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
export function toOps(steps: Step[], state: boolean, head: readonly Op[] = []): Op[] {
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
export function citedSources(ops: readonly Op[]): SourceKey[] {
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
export const withDeletedSets = (ops: fc.Arbitrary<Op[]>, spare: readonly SourceKey[] = []) =>
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

export const scenario = (state: boolean) =>
  withDeletedSets(fc.array(step, { minLength: 2, maxLength: 9 }).map((s) => toOps(s, state)));

/** A generator for one sample in four, a skeleton reaching the checked situation for three. */
export const mostly = <T>(random: fc.Arbitrary<T>, skeleton: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 1, arbitrary: random }, { weight: 3, arbitrary: skeleton });

/** Restates the latest write's value without pointing at evidence: judged a no-op. */
export const sameValue: fc.Arbitrary<Step> = fc.record({
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
export const stale: fc.Arbitrary<Step> = fc.record({
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
export const withSteps = (state: boolean, extra: fc.Arbitrary<Step>, count: number) =>
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
export const revertSkeleton = (state: boolean) =>
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
