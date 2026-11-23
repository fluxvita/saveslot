// `judge` against the reference evaluator on writes by external key (04-write-and-read «按来源键
// 写入»; 09-references-conflict-sync «冲突判据», the paragraph on writes by external key). One row
// of a timeless table, created by key or written by hand and given its key; then syncs (values,
// evidence pointed at or not), a user's changes (on the current version or a stale one), revokes,
// undos and the three resolutions of an open conflict, in any order. No deletions: a log with both
// is not modelled (the deletion phase).
//
// The reference judges every write by key and says what it came to (`outcome`); `unchanged` and
// `skipped` ones leave nothing. The kernel gets the log without them (in the pipeline they take no
// operation number and write no event): every step must leave the row the reference gives, item by
// item; every write by key, those left out included, must come to the same outcome, each field to
// the same result, judged on the same sync baseline (value and position). Apart, the reference
// alone: leaving out the writes that left nothing changes no other step.
//
// The key is modelled on the kernel's side only (the reference has no key fields): the field f9,
// given by the write creating the row by key, or by the write adding the key; left out of the
// comparison.

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import {
  evaluateLog,
  type FieldInput,
  type LogEntry,
  type LogStep,
  type ResolveOp,
  type TableSchema,
  type WriteOp,
} from "@fluxvita/saveslot-reference";
import { Hits, propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp } from "./judge.ts";
import type { JudgeInput, Judgement, TableShape, WriteInput, WriteRecord } from "./model.ts";
import { toInput } from "./scenarios.fixture.ts";
import { EVERYTHING, type Limit, type RowState, refKey } from "./state.ts";
import { syncBaseline, syncOutcome } from "./sync.ts";

vi.setConfig({ testTimeout: 60_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 50_000, markInterruptAsFailure: true });

const RUNS = propRuns(300);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const TIMELESS: TableSchema = { kind: "timeless", required: ["f1"] };
const KEY_FIELD = "f9" as FieldId;
/** The kernel's table: the reference's f1 and f2, and the key field. */
const TABLE: TableShape = {
  kind: "timeless",
  fields: ["f1", "f2", KEY_FIELD],
  valued: ["f1"],
  required: ["f1"],
  groups: [],
};
const VALUES = ["1", "2", "3"];

type Step =
  | { t: "sync"; v: string; explicit: boolean; f1: string }
  | { t: "local"; v: string; lag: number }
  | { t: "revoke" }
  // A revoke undone at once: the writes after it that meet its reach are on existence.
  | { t: "revokeBack" }
  | { t: "undo"; back: number }
  | { t: "resolve"; decision: ResolveOp["decision"]; unit: "f2" | "existence" };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant("sync" as const),
      v: fc.constantFrom(...VALUES),
      explicit: fc.boolean(),
      f1: fc.constantFrom("a", "a", "b"),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("local" as const),
      v: fc.constantFrom(...VALUES),
      lag: fc.constantFrom(0, 0, 1),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("revoke" as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("revokeBack" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("undo" as const), back: fc.nat({ max: 2 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("resolve" as const),
      decision: fc.constantFrom<ResolveOp["decision"]>(
        "take_candidate",
        "keep_effective",
        "take_previous",
      ),
      // On existence: a candidate that met a revoke's reach (a sync after a revoke undone).
      unit: fc.constantFrom<"f2" | "existence">("f2", "existence"),
    }),
  },
);

const field = (value: string, source: string, explicit = false): FieldInput => ({
  value,
  sources: [source],
  ...(explicit ? { explicit: true } : {}),
});
const sync = (op: number, v: string, explicit = false, f1 = "a"): WriteOp => ({
  kind: "write",
  op,
  event: op + 1,
  byKey: true,
  fields: { f1: field(f1, `api${op}`), f2: field(v, `api${op}`, explicit) },
});

/**
 * The log: the row created by key at #10, or written by hand at #10 and given its key at #15; then
 * the steps, one each 10. A resolution lists the open candidates on f2 as the log stands (left out
 * with none); an undo takes a write that entered the log.
 */
function build(byHand: boolean, first: string, steps: readonly Step[]): LogEntry[] {
  const log: LogEntry[] = byHand
    ? [
        {
          kind: "write",
          op: 10,
          event: 11,
          fields: { f1: field("a", "user10"), f2: field(first, "user10") },
        },
        {
          kind: "write",
          op: 15,
          event: 16,
          seen: 10,
          keyAdded: true,
          fields: { f1: field("k", "user15") },
        },
      ]
    : [sync(10, first)];
  steps.forEach((s, i) => {
    const op = 20 + 10 * i;
    const event = op + 1;
    if (s.t === "sync") log.push(sync(op, s.v, s.explicit, s.f1));
    else if (s.t === "local") {
      const seen = Math.max(10, op - 10 * (1 + s.lag));
      log.push({ kind: "write", op, event, seen, fields: { f2: field(s.v, `user${op}`) } });
    } else if (s.t === "revoke") log.push({ kind: "revoke", op, event });
    else if (s.t === "revokeBack") {
      log.push({ kind: "revoke", op, event });
      log.push({ kind: "undo", op: op + 5, event: op + 6, target: op });
    } else if (s.t === "undo") {
      const r = evaluateLog(TIMELESS, log);
      const recorded = r.steps
        .filter((x) => !x.refused && x.outcome !== "unchanged" && x.outcome !== "skipped")
        .map((x) => x.entry)
        .filter((e) => (e.kind === "write" || e.kind === "revoke") && e.op > 15);
      const target = recorded[recorded.length - 1 - s.back]?.op;
      if (target !== undefined) log.push({ kind: "undo", op, event, target });
    } else {
      const open = evaluateLog(TIMELESS, log).final.items.filter(
        (x) =>
          x.status === "candidate" && !x.closed && (s.unit === "existence" || x.target === "f2"),
      );
      const events = [...new Set(open.map((x) => x.event))].sort((a, b) => a - b);
      const take = events.at(-1);
      if (take === undefined) return;
      const o: ResolveOp = {
        kind: "resolve",
        op,
        event,
        decision: s.decision,
        // On existence the latest candidate alone: whether its items are on existence is the
        // reference's to say, so the resolution is kept only when it is not rejected (as the
        // reference's own sync.prop.test.ts does).
        candidates: s.unit === "existence" ? [take] : events,
        unit: s.unit,
        ...(s.decision === "take_candidate" ? { take } : {}),
      };
      if (s.unit === "existence") {
        const judged = evaluateLog(TIMELESS, [...log, o]).steps.at(-1);
        if (judged === undefined || judged.refused || judged.rejected !== undefined) return;
      }
      log.push(o);
    }
  });
  return log;
}

const scenario = fc.record({
  byHand: fc.boolean(),
  first: fc.constantFrom(...VALUES),
  steps: fc.array(step, { minLength: 1, maxLength: 7 }),
});

/** The kernel's input for a log entry: the key on the write creating the row or adding the key. */
function kernelInput(e: LogEntry, hasKey: boolean): JudgeInput {
  const input = toInput(e as never);
  if (e.kind !== "write" || input.kind !== "write") return input;
  const keyed = (w: WriteInput): WriteInput => ({
    ...w,
    fields: { ...w.fields, [KEY_FIELD]: { value: "K" as FieldValue } },
  });
  if (e.keyAdded === true) return keyed(input);
  if (e.byKey !== true) return input;
  return hasKey
    ? { ...input, seen: 0, seenExplicit: false, sync: { keyFields: [KEY_FIELD] } }
    : { ...keyed(input), sync: { keyFields: [KEY_FIELD], creates: true } };
}

/** The kernel's items as the reference lists them (the key field left out). */
function itemsOf(state: RowState) {
  return state.items
    .filter((x) => x.target !== KEY_FIELD)
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
      ...(x.status === "candidate" && state.closedCandidate(x.event, x.target)
        ? { closed: true as const }
        : {}),
    }))
    .sort((a, b) => refKey(a).localeCompare(refKey(b)));
}
const referenceItems = (items: readonly { event: number; target: string; k: number }[]) =>
  [...items].sort((a, b) => refKey(a as never).localeCompare(refKey(b as never)));

/** Each field's result in a write's judgement: its items' status, or `noop`. */
function results(j: Judgement): Record<string, string> {
  const r = j.record as WriteRecord;
  const out: Record<string, string> = {};
  for (const f of r.noop) out[f] = "noop";
  for (const x of r.items) out[x.target] = x.status;
  return out;
}

interface KernelStep {
  /** Absent for an op the kernel refused. */
  readonly outcome?: string;
  readonly fields?: Record<string, { status: string; position: number; value?: FieldValue }>;
  readonly revokedBy?: readonly number[];
  readonly refused?: string;
  /** The state after the step (before it, for a step that left nothing). */
  readonly state: RowState;
}

/**
 * The kernel on the log, as the pipeline would take it: a write by key hitting a revoked row is
 * skipped and one whose every field is a no-op is unchanged; neither enters the state.
 */
function kernelSteps(log: readonly LogEntry[]): KernelStep[] {
  let state = emptyState(TABLE);
  let hasKey = false;
  const out: KernelStep[] = [];
  for (const e of log) {
    const input = kernelInput(e, hasKey);
    const at: Limit = { upTo: e.op - 1, request: { op: e.op, below: 0 } };
    const hit = input.kind === "write" && input.sync !== undefined && input.sync.creates !== true;
    if (hit && state.revoked(at)) {
      out.push({ outcome: "skipped", revokedBy: state.revokedBy(at), state });
      continue;
    }
    const bases = hit
      ? Object.fromEntries(
          Object.keys((input as WriteInput).fields).map((f) => [
            f,
            syncBaseline(state, f as FieldId, { op: e.op, index: 0 }, at, [KEY_FIELD]),
          ]),
        )
      : {};
    let judged: { judgement: Judgement; state: RowState };
    try {
      judged = judgeOp(state, input);
    } catch (err) {
      if (!(err instanceof JudgeError)) throw err;
      out.push({ refused: err.reason, state });
      continue;
    }
    if (input.kind === "write" && input.sync !== undefined) {
      const rs = results(judged.judgement);
      const outcome = input.sync.creates ? "created" : syncOutcome(Object.values(rs) as never);
      const fields = Object.fromEntries(
        Object.entries(rs)
          .filter(([f]) => f !== KEY_FIELD)
          .map(([f, status]) => [
            f,
            {
              status,
              ...(bases[f] !== undefined
                ? {
                    position: bases[f].position,
                    ...(bases[f].value !== undefined ? { value: bases[f].value } : {}),
                  }
                : { position: -1 }),
            },
          ]),
      );
      if (outcome === "unchanged") {
        out.push({ outcome, fields, state });
        continue;
      }
      state = judged.state;
      hasKey = true;
      out.push({ outcome, fields, state });
      continue;
    }
    if (input.kind === "write" && e.kind === "write" && e.keyAdded === true) hasKey = true;
    state = judged.state;
    out.push({ state });
  }
  return out;
}

/** The reference's per-field results, in the kernel's shape (created: no baseline compared). */
function referenceFields(s: LogStep) {
  if (s.syncFields === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(s.syncFields).map(([f, x]) => [
      f,
      {
        status: (x as { status: string }).status,
        ...(s.outcome === "created"
          ? { position: -1 }
          : {
              position: (x as { baseline: { position: number } }).baseline.position,
              ...((x as { baseline: { value?: FieldValue } }).baseline.value !== undefined
                ? { value: (x as { baseline: { value: FieldValue } }).baseline.value }
                : {}),
            }),
      },
    ]),
  );
}

/**
 * Whether the reference has op `o`, after `before`, refuse what the kernel refused for `reason`
 * (as reference.prop.test.ts does): an undo it rejects; a decision it rejects; a write putting a
 * part into effect on a revoked row (the reference models no validation: the kernel refuses it).
 */
function referenceRefuses(before: readonly LogEntry[], o: LogEntry, reason: string): boolean {
  const r = evaluateLog(TIMELESS, [...before, o]);
  const last = r.steps.at(-1) as LogStep;
  if (last.refused) return true;
  if (o.kind === "undo") return r.final.reverts.at(-1)?.status === "rejected";
  if (o.kind === "resolve") return last.rejected !== undefined;
  if (o.kind === "write" && reason === "revoked") {
    const prior = evaluateLog(TIMELESS, before).final.items;
    const live = (x: (typeof prior)[number], kind: string) =>
      x.target === "existence" &&
      x.content.kind === kind &&
      x.status === "applied" &&
      x.registrations.length === 0;
    const revoked = prior.some(
      (x) => live(x, "revoke") && !prior.some((y) => live(y, "restore") && y.op > x.op),
    );
    return (
      revoked &&
      r.final.items.some(
        (x) => x.event === o.event && (x.status === "applied" || x.status === "awaiting"),
      )
    );
  }
  return false;
}

/**
 * Fixed samples, each run: the source sent again unchanged, then the row revoked and a sync
 * skipped, then the revoke undone and the source changed (a candidate on existence); and the row
 * written by hand, given its key, synced, corroborated with evidence, changed by the user, and the
 * same value sent again with evidence (a no-op).
 */
const FIXED: [{ byHand: boolean; first: string; steps: Step[] }][] = [
  // The review's probe P1: f1 synced to b (f2 a no-op), the row revoked and the revoke undone, f1
  // synced to c — a candidate on existence — taken back: the merge base is the candidate's
  // baseline position over the fields it gave (#20, its no-op f2 left out), so f1 is back to b.
  [
    {
      byHand: false,
      first: "1",
      steps: [
        { t: "sync", v: "1", explicit: false, f1: "b" },
        { t: "revokeBack" },
        { t: "sync", v: "1", explicit: false, f1: "c" },
        { t: "resolve", decision: "take_previous", unit: "existence" },
      ],
    },
  ],
  [
    {
      byHand: false,
      first: "1",
      steps: [
        { t: "sync", v: "1", explicit: false, f1: "a" },
        { t: "revoke" },
        { t: "sync", v: "2", explicit: false, f1: "a" },
        { t: "undo", back: 0 },
        { t: "sync", v: "2", explicit: false, f1: "a" },
      ],
    },
  ],
  [
    {
      byHand: true,
      first: "1",
      steps: [
        { t: "sync", v: "2", explicit: false, f1: "k" },
        { t: "sync", v: "2", explicit: true, f1: "k" },
        { t: "local", v: "3", lag: 0 },
        { t: "sync", v: "2", explicit: true, f1: "k" },
      ],
    },
  ],
];

describe("writes by external key: judge against the reference evaluator", () => {
  it("every step leaves the row the reference gives; every write by key comes to the same outcome, field by field, on the same baseline", () => {
    // Hit: a write by key that left nothing (unchanged or skipped) beyond the first, so that
    // leaving it out of the kernel's log is exercised. Both are also built in fixed samples (each
    // run); the minimum only guards against the generator going wrong as a whole: seeds 1 to 8 gave
    // shares 0.18 to 0.24 (mean 0.22) over 300 samples.
    const hits = new Hits(0.1);
    const seen: Record<string, number> = {};
    const count = (k: string) => {
      seen[k] = (seen[k] ?? 0) + 1;
    };
    fc.assert(
      fc.property(
        scenario,
        hits.track(({ byHand, first, steps }) => {
          const log = build(byHand, first, steps);
          const mine = kernelSteps(log);
          // What the kernel refused never enters its log; the reference is given the rest.
          const kept: LogEntry[] = [];
          const keptSteps: KernelStep[] = [];
          log.forEach((e, i) => {
            const k = mine[i] as KernelStep;
            if (k.refused !== undefined) {
              count(`refused_${e.kind}_${k.refused}`);
              expect({
                op: e.op,
                kind: e.kind,
                reason: k.refused,
                theirs: referenceRefuses(kept, e, k.refused),
              }).toEqual({
                op: e.op,
                kind: e.kind,
                reason: k.refused,
                theirs: true,
              });
              return;
            }
            kept.push(e);
            keptSteps.push(k);
          });
          // The kernel judged the rest on the state without what it refused: judged again, as the
          // reference is, the kept log gives the same steps (a refusal leaves the state as it was).
          const ref = evaluateLog(TIMELESS, kept);
          expect(ref.steps.length).toBe(keptSteps.length);
          ref.steps.forEach((s, i) => {
            const k = keptSteps[i] as KernelStep;
            const where = { step: i, op: s.entry.op };
            expect({ ...where, refused: s.refused }).toEqual({ ...where, refused: false });
            if (s.outcome !== undefined) count(`outcome_${s.outcome}`);
            if (s.entry.kind === "resolve" && s.entry.unit === "existence")
              count(`resolve_existence_${s.entry.decision}`);
            if ((s.outcome === "unchanged" || s.outcome === "skipped") && i > 0) hits.hit();
            expect({ ...where, outcome: k.outcome }).toEqual({ ...where, outcome: s.outcome });
            if (s.outcome === "skipped") {
              expect(k.revokedBy).toContain(s.revokedBy);
            } else if (s.syncFields !== undefined) {
              expect({ ...where, fields: k.fields }).toEqual({
                ...where,
                fields: referenceFields(s),
              });
              for (const x of Object.values(k.fields ?? {})) count(`field_${x.status}`);
            }
            expect({ ...where, items: itemsOf(k.state) }).toEqual({
              ...where,
              items: referenceItems(s.state.items),
            });
          });
        }),
      ),
      {
        numRuns: RUNS,
        examples: FIXED,
        ...(SEED !== undefined ? { seed: SEED } : {}),
      },
    );
    if (process.env["JUDGE_STATS"]) console.log(JSON.stringify({ ...seen, share: hits.share }));
    hits.check();
    // Each kind of outcome and field result is reached (a generator gone wrong as a whole).
    for (const k of [
      "outcome_created",
      "outcome_updated",
      "outcome_unchanged",
      "outcome_pending",
      "outcome_skipped",
      "field_applied",
      "field_corroborated",
      "field_candidate",
      "field_noop",
      "resolve_existence_take_previous",
    ])
      expect({ k, reached: (seen[k] ?? 0) > 0 }).toEqual({ k, reached: true });
  });

  it("the reference alone: leaving out the writes by key that left nothing changes no other step", () => {
    fc.assert(
      fc.property(scenario, ({ byHand, first, steps }) => {
        const log = build(byHand, first, steps);
        const ref = evaluateLog(TIMELESS, log);
        const kept = ref.steps.filter((s) => s.outcome !== "unchanged" && s.outcome !== "skipped");
        const again = evaluateLog(
          TIMELESS,
          kept.map((s) => s.entry),
        );
        expect(again.steps.map((s) => [s.entry.op, s.outcome, s.refused])).toEqual(
          kept.map((s) => [s.entry.op, s.outcome, s.refused]),
        );
        again.steps.forEach((s, i) => {
          expect({ op: s.entry.op, items: s.state.items }).toEqual({
            op: s.entry.op,
            items: (kept[i] as LogStep).state.items,
          });
        });
      }),
      { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
  });
});
