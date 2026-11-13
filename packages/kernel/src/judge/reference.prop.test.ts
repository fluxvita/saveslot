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

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type Op, type TableSchema } from "@fluxvita/saveslot-reference";
import {
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
import { type RowState, refKey } from "./state.ts";

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

/** A person's decision inserted after an op: on the `pick`-th open pending item, if any. */
interface Decision {
  readonly after: number;
  readonly pick: number;
  readonly kind: "confirm" | "reject" | "keep";
}

const decision: fc.Arbitrary<Decision> = fc.record({
  after: fc.nat(),
  pick: fc.nat(),
  kind: fc.constantFrom<Decision["kind"]>("confirm", "confirm", "reject", "keep"),
});

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

/** Reverts are judged elsewhere: undo steps are left out. */
const writeStep = fc.oneof(
  { weight: 4, arbitrary: step.filter((s: Step) => s.t !== "undo") },
  { weight: 1, arbitrary: stale },
  { weight: 1, arbitrary: overwrite },
);

const scenario = (state: boolean) =>
  fc
    .record({
      steps: fc.array(writeStep, { minLength: 2, maxLength: 9 }),
      decisions: fc.array(decision, { maxLength: 4 }),
      fallback: fc.array(fc.boolean(), { maxLength: 9 }),
    })
    .map(({ steps, decisions, fallback }) => ({
      ops: toOps(steps, state).map((o, i) => withoutVer(o, fallback[i] === true)),
      decisions,
    }));

/**
 * A write whose `ver` came from the read log rather than the request: the reference's form is an
 * op without `seen` (the current version, not explicit), so `acknowledge` does not count.
 */
function withoutVer(o: Op, drop: boolean): Op {
  if (!drop || o.kind !== "write" || o.op === 10) return o;
  const { seen: _, ...rest } = o;
  return rest;
}

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
    case "confirm":
    case "reject":
      return { ...base, kind: o.kind, target: o.target };
    case "resolve":
      if (o.decision !== "keep_effective") throw new Error("only keep_effective is judged here");
      return {
        ...base,
        kind: "keep_effective",
        unit: o.unit === "existence" ? "existence" : { fields: [o.unit] },
        candidates: o.candidates,
      };
    default:
      throw new Error(`not judged here: ${o.kind}`);
  }
}

/** The items as the reference lists them (registrations aside: no reverts in J1). */
function itemsOf(state: RowState) {
  return state.items
    .map((x) => ({
      event: x.event,
      target: x.target,
      k: x.k,
      op: x.op,
      status: x.status,
      valid: x.valid,
      content: x.content,
      ...(x.carried !== undefined ? { carried: x.carried } : {}),
      ...((x.status === "candidate" && state.closedCandidate(x.event, x.target)) ||
      (x.status === "awaiting" && state.resolvedAwaiting(x.event))
        ? { closed: true as const }
        : {}),
    }))
    .sort((a, b) => refKey(a).localeCompare(refKey(b)));
}

function referenceItems(items: readonly { registrations: unknown }[]) {
  return items
    .map(({ registrations: _, ...x }) => x as { event: number; target: string; k: number })
    .sort((a, b) => refKey(a as never).localeCompare(refKey(b as never)));
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
    enter(o);
    for (const d of decisions.filter((x) => x.after % ops.length === i)) {
      const op = o.op + 5;
      const event = op + 1;
      const open = state.items.filter((x) =>
        d.kind === "keep"
          ? x.status === "candidate" && !state.closedCandidate(x.event, x.target)
          : x.status === "awaiting" && !state.resolvedAwaiting(x.event),
      );
      const x = open[d.pick % Math.max(1, open.length)];
      if (x === undefined || steps.some((k) => k.op.op === op)) continue;
      enter(
        d.kind === "keep"
          ? {
              kind: "resolve",
              op,
              event,
              decision: "keep_effective",
              candidates: [x.event],
              unit: x.target,
            }
          : { kind: d.kind, op, event, target: x.event },
      );
    }
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
    const seen = { awaiting: 0, candidate: 0, corroborated: 0, decided: 0, refused: 0, samples: 0 };
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
          if (kept.some((o) => o.op % 10 === 5)) seen.decided++;
          if (refused.length > 0) seen.refused++;
          if (st.has("awaiting") || st.has("candidate")) hits.hit();

          // Refusals: only a write lacking a required field whose part taking effect fills a gap.
          for (const r of refused) {
            expect({ op: r.op.op, reason: r.reason }).toEqual({
              op: r.op.op,
              reason: "validation_failed",
            });
            expect(lacksRequired(schema, r.op) && fillsGap(schema, r.before, r.op)).toBe(true);
          }
          steps.forEach((x, i) => {
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

            // What the judgement says beyond the items, against the reference's statuses.
            const j = x.judgement;
            const mine = s.state.items.filter((y) => y.event === x.op.event);
            const has = (status: string) => mine.some((y) => y.status === status);
            expect({ step: i, conflict: j.conflicts.length > 0 }).toEqual({
              step: i,
              conflict: has("candidate"),
            });
            expect({ step: i, awaiting: j.erased.length > 0 && !j.acknowledged }).toEqual({
              step: i,
              awaiting: has("awaiting") && (x.op.kind === "write" || x.op.kind === "revoke"),
            });
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
  });
});
