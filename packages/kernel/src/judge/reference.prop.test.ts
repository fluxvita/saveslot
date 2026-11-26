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
// half of 02-architecture «写入路径与参考一致». The reference has no conflict groups and no multi-op requests; those
// are covered by fixed cases (judge.test.ts), as are `deps` and the overwritten stretches.

import { evaluateLog, type Op, type TableSchema } from "@fluxvita/saveslot-reference";
import {
  EVENT,
  groupInstantOps,
  Hits,
  propRuns,
  STATE,
} from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { isNothing, meet } from "../time/index.ts";
import { judgeOp, stateFromRecord, view } from "./judge.ts";
import { type Decision, type Judged, judged, scenario } from "./scenarios.fixture.ts";
import { EVERYTHING, type RowState, refKey } from "./state.ts";

vi.setConfig({ testTimeout: 60_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 50_000, markInterruptAsFailure: true });

const RUNS = propRuns(1500);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
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

/** The two fields of the generator judged together (01-objects «冲突单元»). */
const GROUPS = [["f2", "f3"]] as const;

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
  ["state, group {f2, f3}", { ...STATE, groups: GROUPS }, true],
  ["event, group {f2, f3}", { ...EVENT, groups: GROUPS }, false],
  // "Has a value" defined by two fields (05-time «无值区间»): a value ↔ no value boundary is theirs
  // together (高影响写入), and a write into a gap needs both.
  ["state, f2 and f3 required", { ...STATE, required: ["f2", "f3"] }, true],
] as const;

describe.each(both)("%s table", (_, schema, isState) => {
  it("every step leaves the row or entity the reference evaluator gives", () => {
    // Two required fields: a write of one into a gap is refused, so fewer samples reach an item
    // (about 0.3 a run at the default 1,500 samples, against well over half with one).
    const hits = new Hits(schema.required.length > 1 ? 0.2 : 0.3);
    let takesCompared = 0;
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
    const sample = ({ ops, decisions }: { ops: Op[]; decisions: Decision[] }): void => {
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
        // A corroboration written to the next change, cut by a change since (05-time
        // «用同样的值写»): a corroborated item beside one in effect or a candidate, one field.
        if (
          r.kind === "write" &&
          (r.valid === undefined ||
            (r.valid !== "corrected_span" && r.valid.to.mode === "next_change"))
        ) {
          const byField = new Map<string, Set<string>>();
          for (const i of r.items) {
            const set = byField.get(i.target) ?? new Set<string>();
            set.add(i.status);
            byField.set(i.target, set);
          }
          if ([...byField.values()].some((v) => v.has("corroborated") && v.size > 1)) {
            seen["corroborationCut"] = (seen["corroborationCut"] ?? 0) + 1;
          }
        }
        if (r.kind === "undo") {
          seen["undo"] = (seen["undo"] ?? 0) + 1;
          if (r.status === "awaiting") seen["undoAwaiting"] = (seen["undoAwaiting"] ?? 0) + 1;
          if (r.revert.entries.some((e) => e.later)) seen["later"] = (seen["later"] ?? 0) + 1;
          if (x.judgement.takesBack.length > 0) seen["takesBack"] = (seen["takesBack"] ?? 0) + 1;
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
        // One write with candidates in a field item and in the item on existence (a2).
        if (
          x.judgement.conflicts.some((c) => c.unit === "existence") &&
          x.judgement.conflicts.some((c) => c.unit !== "existence")
        ) {
          seen["mixedUnits"] = (seen["mixedUnits"] ?? 0) + 1;
        }
        // On a field group: one conflict on the group whose candidates are on both fields
        // (conflict criterion ⑤), and a resolution of an item on the group.
        if (
          x.judgement.conflicts.some(
            (c) =>
              c.unit !== "existence" &&
              c.unit.fields.length > 1 &&
              new Set(c.items.map((i) => i.target)).size > 1,
          )
        ) {
          seen["groupWhole"] = (seen["groupWhole"] ?? 0) + 1;
        }
        if (
          (r.kind === "keep_effective" || r.kind === "take_candidate") &&
          r.unit !== "existence" &&
          r.unit.fields.length > 1
        ) {
          seen["groupResolved"] = (seen["groupResolved"] ?? 0) + 1;
        }
        if (x.judgement.conflicts.some((c) => c.unit === "existence" && c.items.length > 1)) {
          seen["existenceSeveralFields"] = (seen["existenceSeveralFields"] ?? 0) + 1;
        }
        if (r.kind === "take_candidate") {
          seen["take"] = (seen["take"] ?? 0) + 1;
          if (r.unit === "existence") seen["takeExistence"] = (seen["takeExistence"] ?? 0) + 1;
          if (r.items.length === 0) seen["takeNothing"] = (seen["takeNothing"] ?? 0) + 1;
          for (const y of r.items) {
            const key = `take_${y.content.kind}${y.carried?.some((c) => c.event !== r.take) ? "_carriedOther" : ""}`;
            seen[key] = (seen[key] ?? 0) + 1;
          }
          // Several stretches: more than one item on a field.
          if (r.items.some((y) => y.target !== "existence" && y.k > 0))
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
        if (r.op.kind === "resolve" || r.op.kind === "confirm" || r.op.kind === "reject") {
          // A decision refused as the reference refuses it: not valid on the state without it
          // (`invalid`), or a take refused as the ordinary write would be (`revoked`, a gap
          // without the required fields), or on existence with a required field nowhere to
          // carry from.
          const rej = evaluateLog(schema, [...r.before, r.op]).steps.at(-1)?.rejected;
          const expected =
            rej === undefined
              ? "accepted"
              : rej === "revoked" || rej === "invalid"
                ? rej
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
        // A take_candidate's merge base and cover set O (09 §5.8 `take`), as each recorded it.
        const rec = x.judgement.record;
        if (rec.kind === "take_candidate") {
          takesCompared++;
          const theirs = s.state.takeCandidates.find((t) => t.op === rec.op);
          expect({
            step: i,
            mergeBase: rec.mergeBase,
            cover: [...rec.cover].sort(byEntry),
          }).toEqual({
            step: i,
            mergeBase: theirs?.mergeBase,
            cover: [...(theirs?.cover ?? [])].sort(byEntry),
          });
        }

        // What the judgement says beyond the items, against the reference's statuses.
        const j = x.judgement;
        // Every item one interval, every (target, index) once (09 §5.7: one span per item).
        if (j.record.kind !== "reject" && j.record.kind !== "keep_effective") {
          const keys = j.record.items.map((y) => `${y.target}/${y.k}`);
          expect({ step: i, unique: new Set(keys).size === keys.length }).toEqual({
            step: i,
            unique: true,
          });
          expect({ step: i, one: j.record.items.every((y) => y.valid.length === 1) }).toEqual({
            step: i,
            one: true,
          });
        }
        const mine = s.state.items.filter((y) => y.event === x.op.event);
        const has = (status: string) => mine.some((y) => y.status === status);
        expect({ step: i, conflict: j.conflicts.length > 0 }).toEqual({
          step: i,
          conflict: has("candidate"),
        });
        if (x.op.kind === "write" || x.op.kind === "revoke") {
          // ① (a change point erased, not acknowledged), or ② (a revoke of a referred row).
          const awaits =
            (j.erased.length > 0 && !j.acknowledged) ||
            (j.record.kind === "revoke" && j.record.items.some((y) => y.status === "awaiting"));
          expect({ step: i, awaiting: awaits }).toEqual({
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
    };
    fc.assert(fc.property(scenario(isState), hits.track(sample)), {
      numRuns: RUNS,
      ...(SEED !== undefined ? { seed: SEED } : {}),
      ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
    });
    if (process.env["JUDGE_STATS"]) console.log(schema.kind, JSON.stringify(seen));
    hits.check();
    // A corroboration cut by a change since (05-time «用同样的值写») is reached, on state tables
    // only: at the default 1,500 samples about 2.5 a run on state tables (1 to 4 over ten seeds),
    // 0 on event tables in all ten (no default end there), so a check at the default would fail
    // about one run in twelve with nothing wrong.
    // It is checked from 6,000 samples on (a soak run; about 10 expected, none with odds under
    // 1e-4); at the default the fixed cases of corroboration-orders.test.ts carry this path. The
    // generator's weights for it are to come.
    if (schema.kind === "state" && RUNS >= 6000)
      expect(seen["corroborationCut"] ?? 0).toBeGreaterThan(0);
    // take_candidate reaches each of these situations: guards against a generator gone
    // degenerate, not shares. At the default 1,500 samples the rarest is take_revoke on event
    // tables, about 14 a run at the least seen over 5 runs: missing it entirely has odds e^-14,
    // under 1e-6 a run. (Shares used to be checked; some of them failed once in a thousand runs.)
    const situations = isState
      ? [
          "take",
          "takeExistence",
          // With two required fields, about one run in 1,500 samples: not a floor there.
          ...(schema.required.length > 1 ? [] : ["takeManyStretches"]),
          "takeRefused_required_in_gap",
          "existenceSeveralFields",
          "takeRefused_missing_required",
          // A write's candidates on two units: f2 and f3 are two units only without the group.
          ...("groups" in schema ? ["groupWhole", "groupResolved"] : ["mixedUnits"]),
        ]
      : [
          "take",
          "takeExistence",
          "take_restore",
          "take_revoke",
          "takeRefused_revoked",
          "existenceSeveralFields",
          ...("groups" in schema ? ["groupWhole", "groupResolved"] : []),
        ];
    for (const key of situations) {
      expect({ key, reached: (seen[key] ?? 0) > 0 }).toEqual({ key, reached: true });
    }
    // Merge bases and cover sets were compared (every take_candidate judged).
    expect({ takesCompared: takesCompared > 0 }).toEqual({ takesCompared: true });
    // Built in, on a field group (09-references «组值», instant by instant): a write whose two fields
    // have seen intervals of their own, one of them stopping short of L's change. The samples
    // reach it seldom (a default end resolved field by field, on a group). Run after the floors
    // above are compared, so they count only what the generator reached.
    if (schema.groups !== undefined && isState) {
      for (const short of ["f2", "f3"] as const)
        sample({ ops: groupInstantOps(short), decisions: [] });
    }
  });
});
