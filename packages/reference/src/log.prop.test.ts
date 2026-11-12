// Property tests over logs with deletions interleaved with operations (02-architecture §11,
// «删除的性质»): no kernel.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { evaluateLog } from "./evaluate.ts";
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

// An explicit time limit; on a failure (including running out of time) fast-check reports the
// seed and path that reproduce it: `fc.assert(..., { seed, path, endOnFailure: true })`.
vi.setConfig({ testTimeout: 30_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 25_000, markInterruptAsFailure: true });

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const EVENT: TableSchema = { kind: "event", required: ["f2"] };
const DAYS = ["11-01", "11-03", "11-05", "11-07", "11-09"].map((x) => `2026-${x}` as BizPoint);
const SOURCES = ["S1", "S2", "S3", "S4", "S5"];
const RUNS = 1500;

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
const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

const etKey = (x: { event: number; target: string }) => `${x.event}/${x.target}`;
const isPending = (x: ItemResult) =>
  (x.status === "candidate" || x.status === "awaiting") && x.closed === undefined;

/**
 * The state, without `dropped` entries: those say what one deletion event restated relative to
 * the result last given, so they depend on the history by design.
 */
function comparable(ev: Evaluation) {
  return {
    ...ev,
    items: [...ev.items]
      .filter((x) => x.status !== "dropped")
      .sort((x, y) => x.event - y.event || x.target.localeCompare(y.target) || x.k - y.k),
  };
}

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

const counts = {
  restoredByDeletion: 0,
  restoredByCancel: 0,
  keptEffective: 0,
  withDecisions: 0,
};

describe.each(both)("%s table", (_, schema, state) => {
  it("successive deletions: A then B = B then A = {A, B} at once, after any log", () => {
    // 02-architecture §11 «顺序无关». The log before A and B keeps its own deletions,
    // cancellations and grace-period writes.
    fc.assert(
      fc.property(
        steps,
        fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
        fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
        (st, a, b) => {
          const log = extend(schema, [], st, 10);
          const pending = pendingSources(evaluateLog(schema, log));
          const aOnly = a.filter((x) => !b.includes(x) && !pending.has(x));
          const bOnly = b.filter((x) => !pending.has(x));
          fc.pre(aOnly.length > 0 && bOnly.length > 0);
          const last = Math.max(...log.map((o) => o.op));
          const run = (entries: LogEntry[]) =>
            comparable(evaluateLog(schema, [...log, ...entries]).final);
          const ab = run([
            { kind: "deletion", op: last + 1, id: "pi_a", sources: aOnly },
            { kind: "deletion", op: last + 2, id: "pi_b", sources: bOnly },
          ]);
          const ba = run([
            { kind: "deletion", op: last + 1, id: "pi_b", sources: bOnly },
            { kind: "deletion", op: last + 2, id: "pi_a", sources: aOnly },
          ]);
          const once = run([
            { kind: "deletion", op: last + 1, id: "pi_ab", sources: [...aOnly, ...bOnly] },
          ]);
          expect(ba).toEqual(ab);
          expect(once).toEqual(ab);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("«撤回还原»: after a cancellation, what grace-period writes did not cover is as the forced replay", () => {
    // 03-deletion «推论» «撤回还原»: the part not covered by grace-period writes equals the replay
    // in which the deletion was never confirmed and the writes recorded as kept in effect take
    // effect at their own write numbers. Compared: field values outside grace-period coverage,
    // and the judgement and openness of every item of the operations before the deletion. Other
    // deletions may be pending throughout; grace-period steps include restatements and decisions.
    // Rule-based differences named by the cancellation itself are left out of the item
    // comparison: items it kept superseded and candidates it put back (03-deletion «撤回与宽限期»).
    fc.assert(
      fc.property(
        steps,
        fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
        fc.array(graceStep, { maxLength: 3 }),
        fc.boolean(),
        (st, sources, graceSteps, lateVer) => {
          const prefix = extend(schema, [], st, 10);
          const prefixRun = evaluateLog(schema, prefix);
          const pending = pendingSources(prefixRun);
          const dSources = sources.filter((x) => !pending.has(x));
          fc.pre(dSources.length > 0);
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
          const excluded = new Set([
            ...(cancelStep?.keptSuperseded ?? []).map(String),
            ...(cancelStep?.putBack ?? []).map((x) => String(x.event)),
          ]);
          const judgement = (ev: Evaluation) =>
            ev.items
              .filter(
                (x) =>
                  prefixEvents.has(x.event) &&
                  x.status !== "dropped" &&
                  !excluded.has(String(x.event)),
              )
              .map((x) => `${etKey(x)}/${x.k} ${x.status}${x.closed ? " closed" : ""}`)
              .sort();
          expect(judgement(cancelled)).toEqual(judgement(base));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("deletion events add no pending items beyond the three kinds the corollary names", () => {
    // 03-deletion «推论» «删除不增加未决事项»: each new pending item after a deletion is (1) an
    // awaiting item converted from a conflict item this deletion superseded, (2) the very item an
    // earlier deletion event superseded, restored now (same write, same kind as at write time,
    // not closed by a decision since), or (3) the same write's pending item changed kind. A
    // cancellation may also put back a candidate after its item was resolved (pending at write
    // time, removed by the deletion it cancels). Items are identified by (write, field).
    fc.assert(
      fc.property(steps, (st) => {
        const log = extend(schema, [], st, 10);
        const run = evaluateLog(schema, log);
        const atWrite = writeTimeStatuses(run);
        // Why each item stopped being pending, as of the previous step: a deletion event, or
        // something else (a decision, a later write).
        const supersededBy = new Map<string, "deletion" | "other">();
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
            for (const [key, xs] of pendingNow) {
              const prevPending = (pendingPrev.get(key) ?? []).map((x) => x.status);
              const written = atWrite.get(key) ?? [];
              for (const x of xs) {
                const branch = prevPending.includes(x.status)
                  ? "not new"
                  : x.status === "awaiting" && prevPending.includes("candidate")
                    ? "(1)"
                    : x.status === "candidate" && prevPending.includes("awaiting")
                      ? "(3)"
                      : prevPending.length === 0 &&
                          written.includes(x.status) &&
                          supersededBy.get(key) === "deletion"
                        ? "(2)"
                        : s.entry.kind === "cancel" && putBack.has(key)
                          ? "put back"
                          : "none";
                if (branch === "(2)") {
                  if (s.entry.kind === "deletion") counts.restoredByDeletion++;
                  else counts.restoredByCancel++;
                }
                expect({
                  key,
                  at: s.entry,
                  now: x.status,
                  prevPending,
                  written,
                  supersededBy: supersededBy.get(key),
                  branch,
                }).not.toMatchObject({ branch: "none" });
              }
              expect({ key, count: xs.length }).toEqual({
                key,
                count: Math.min(xs.length, Math.max(prevPending.length, written.length)),
              });
            }
          }
          for (const key of pendingPrev.keys()) {
            if (!pendingNow.has(key)) supersededBy.set(key, isDeletion ? "deletion" : "other");
          }
          for (const key of pendingNow.keys()) supersededBy.delete(key);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

it("cancellations keep writes in effect in the sampled logs", () => {
  // Guards against a generator that never reaches `kept_effective`.
  expect(counts.keptEffective).toBeGreaterThan(0);
});

it("grace periods with decisions occur in the sampled logs", () => {
  expect(counts.withDecisions).toBeGreaterThan(0);
});

it("the restored-item branch occurs in the sampled logs", () => {
  // Guards against a generator that never exercises branch (2).
  expect(counts.restoredByCancel + counts.restoredByDeletion).toBeGreaterThan(0);
});
