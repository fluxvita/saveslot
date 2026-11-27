// Field groups (09-references-conflict-sync «冲突单元», «组值»; conflict criterion ⑤): the logs on
// a group whose judgement needs more than one field at a time, judged by the kernel, with the
// statuses the reference evaluator gives (reference/src/testing/groups.fixture.ts).

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import { evaluate, evaluateLog, type Op, type TableSchema } from "@fluxvita/saveslot-reference";
import {
  GROUP_LOGS,
  GROUP_TAKE_INTO_HOLE,
  GROUP_TAKE_NOOP_FIELD,
  GROUP_TAKE_NOOP_FIELD_EVENT,
} from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { candidateImpact } from "./items.ts";
import { view } from "./judge.ts";
import { judged } from "./scenarios.fixture.ts";
import { type RowState, refOf } from "./state.ts";

describe("field groups, as the reference evaluator judges them", () => {
  it.each(Object.entries(GROUP_LOGS))("%s", (_, { schema, ops, event, want }) => {
    const { steps } = judged(schema, ops, []);
    expect(steps).toHaveLength(ops.length);
    const state = steps.at(-1)?.state;
    const kernel = (state?.items ?? [])
      .filter((x) => x.event === event)
      .map((x) => [x.target, x.status])
      .sort();
    const ref = evaluate(schema, ops)
      .items.filter((x) => x.event === event)
      .map((x) => [x.target, x.status])
      .sort();
    expect(kernel).toEqual(want);
    expect(ref).toEqual(want);
  });
});

// High impact ① at a value ↔ no value boundary (05-time «高影响写入»), what the judgement lists as
// erased when the write acknowledges the overwrite (its items take effect either way): nothing while
// one defining field still changes across the boundary; every defining field when none does.
describe("a value ↔ no value boundary's erasure, as listed", () => {
  const d = (md: string) => `2026-${md}` as BizPoint;
  const write = (op: number, seen: number, from: string, to: string, f2: string, f3: string): Op =>
    ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      valid: { from: { mode: "given", value: d(from) }, to: { mode: "given", value: d(to) } },
      fields: { f2: { value: f2, sources: [`S${op}`] }, f3: { value: f3, sources: [`S${op}`] } },
      acknowledge: ["overwrite"],
    }) as Op;
  const schema: TableSchema = { kind: "state", required: ["f2", "f3"] };
  it.each([
    ["one defining field still changing: nothing erased", "2", []],
    [
      "every defining field the same on both sides: both listed",
      "1",
      [
        { field: "f2", at: [d("11-05")] },
        { field: "f3", at: [d("11-05")] },
      ],
    ],
  ] as const)("%s", (_, f2, erased) => {
    const { steps } = judged(
      schema,
      [write(10, 0, "11-01", "11-05", "1", "a"), write(20, 10, "11-05", "11-09", f2, "a")],
      [],
    );
    const last = steps.at(-1);
    expect(last?.judgement.erased).toEqual(erased);
    expect(last?.state.items.filter((x) => x.event === 21).map((x) => x.status)).toEqual([
      "applied",
      "applied",
    ]);
  });
});

// A candidate's impact if taken (01-objects «影响», "if a candidate would be high-impact when it
// takes effect") by the same rule: two required fields; #11 (1, a) over [11-01, 11-09); #21 revokes
// [11-05, 11-09); #31, having seen neither, writes (x, a) over [11-05, 11-09): a candidate. Taking
// (2, a) fills the gap with f2 still changing at 11-05: no impact; taking (1, a) leaves both the
// same on both sides: impact.
describe("a candidate's impact at a value ↔ no value boundary", () => {
  const d = (md: string) => `2026-${md}` as BizPoint;
  const span = (from: string, to: string) => ({
    from: { mode: "given", value: d(from) },
    to: { mode: "given", value: d(to) },
  });
  const schema: TableSchema = { kind: "state", required: ["f2", "f3"] };
  it.each([
    ["f2 still changing: none", "2", false],
    ["both the same on both sides: some", "1", true],
  ] as const)("%s", (_, f2, some) => {
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: span("11-01", "11-09"),
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: span("11-05", "11-09"),
        validSources: ["S20"],
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 0,
        valid: span("11-05", "11-09"),
        fields: { f2: { value: f2, sources: ["S30"] }, f3: { value: "a", sources: ["S30"] } },
      },
    ] as Op[];
    const { steps } = judged(schema, ops, []);
    const state = steps.at(-1)?.state as RowState;
    const refs = state.items.filter((x) => x.event === 31).map(refOf);
    expect(refs.length).toBeGreaterThan(0);
    expect(state.items.filter((x) => x.event === 31).every((x) => x.status === "candidate")).toBe(
      true,
    );
    expect(candidateImpact(state, refs, { upTo: 30 as never }).length > 0).toBe(some);
  });
});

// The first creation on a table with no required field (03-deletion «首次创建标记»): the first
// write with a field in effect, a clearing too, whatever fields are written after it.
describe("the first creation, no required field", () => {
  const d = (md: string) => `2026-${md}` as BizPoint;
  const write = (op: number, seen: number, fields: Record<string, string | null>): Op =>
    ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "open" } },
      fields: Object.fromEntries(
        Object.entries(fields).map(([f, value]) => [f, { value, sources: [`S${op}${f}`] }]),
      ),
      acknowledge: ["overwrite"],
    }) as Op;
  const schema: TableSchema = { kind: "state", required: [] };
  it.each([
    [
      "f2 first, f3 later: the first write",
      [write(10, 0, { f2: "1" }), write(20, 10, { f3: "a" })],
    ],
    ["a clearing first: the clearing", [write(10, 0, { f2: null }), write(20, 10, { f3: "a" })]],
  ] as const)("%s", (_, ops) => {
    const { steps } = judged(schema, [...ops], []);
    expect(view(steps.at(-1)?.state as never).created).toBe(11);
    expect(evaluate(schema, [...ops]).created).toBe(11);
  });
});

// 09 «组值», the example's two halves: W and L, from the same version, write one field of a group
// to the same value. On a state table the group values are equal, so W takes effect; on an event
// table values are not compared, the unit changed after V is a conflict.
describe("the group value where W and L write the same", () => {
  const write = (op: number, seen: number, fields: Record<string, string>, state: boolean): Op => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    ...(state
      ? {
          valid: { from: { mode: "given", value: "2026-10-01" as BizPoint }, to: { mode: "open" } },
        }
      : {}),
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, value]) => [f, { value, sources: [`S${op}${f}`] }]),
    ),
  });
  it.each([
    ["a state table: no conflict, in effect", "state", "applied"],
    ["an event table: a candidate", "event", "candidate"],
  ] as const)("W and L both write f2 of a group to the same value on %s", (_, kind, want) => {
    const schema: TableSchema = { kind, required: ["f2"], groups: [["f2", "f3"]] };
    const state = kind === "state";
    const ops = [
      write(5, 0, { f2: "0", f3: "a" }, state),
      write(10, 5, { f2: "1" }, state),
      write(20, 5, { f2: "1" }, state),
    ];
    const { steps } = judged(schema, ops, []);
    expect(steps).toHaveLength(ops.length);
    const kernel = (steps.at(-1)?.state.items ?? [])
      .filter((x) => x.event === 21)
      .map((x) => [x.target, x.status]);
    const ref = evaluate(schema, ops)
      .items.filter((x) => x.event === 21)
      .map((x) => [x.target, x.status]);
    expect(kernel).toEqual([["f2", want]]);
    expect(ref).toEqual([["f2", want]]);
  });
});

describe("a take on a group into a hole (a property counterexample)", () => {
  it("judge refuses it as the reference does: the no-op field is not written", () => {
    const { schema, ops } = GROUP_TAKE_INTO_HOLE;
    // The take inserted after #40, on the item holding #30's candidate.
    const { steps, refused } = judged(schema, ops, [
      { after: 3, pick: 0, kind: "take", flag: 0, focus: false },
    ]);
    expect(steps.map((x) => x.op.op)).toEqual([10, 20, 30, 40]);
    expect(refused.map((r) => [r.op.op, r.op.kind, r.reason])).toEqual([
      [43, "resolve", "validation_failed"],
    ]);
    const r = refused[0];
    const last =
      r === undefined ? undefined : evaluateLog(schema, [...r.before, r.op]).steps.at(-1);
    expect(last).toMatchObject({ refused: true, rejected: "missing_required" });
  });
});

describe("a take on a group of a write with a field it gave as a no-op (property counterexamples)", () => {
  it.each([
    ["state table", GROUP_TAKE_NOOP_FIELD],
    ["event table", GROUP_TAKE_NOOP_FIELD_EVENT],
  ] as const)(
    "%s: judge and the reference write only the candidate's field",
    (_, { schema, ops }) => {
      // The take inserted after #40, on the item holding #30's and #40's candidates.
      const { steps, refused } = judged(schema, ops, [
        { after: 3, pick: 0, kind: "take", flag: 0, focus: false },
      ]);
      expect(refused).toEqual([]);
      const last = steps.at(-1);
      expect(last?.op).toMatchObject({ kind: "resolve", take: 31, candidates: [31, 41] });
      const kernel = view(last?.state as never).fields;
      const ref = evaluateLog(
        schema,
        steps.map((x) => x.op),
      ).final.fields as unknown as Record<string, { value: unknown; by?: { event: number } }[]>;
      const of = (xs: readonly { value: unknown; by?: { event: number } }[] | undefined) =>
        (xs ?? []).map((x) => [x.value, x.by?.event]);
      expect(of(kernel["f2" as never])).toEqual([["5", 21]]);
      expect(of(ref["f2"])).toEqual(of(kernel["f2" as never]));
      expect(of(ref["f3"])).toEqual(of(kernel["f3" as never]));
    },
  );
});
