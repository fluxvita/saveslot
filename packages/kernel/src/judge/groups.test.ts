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
import { view } from "./judge.ts";
import { judged } from "./scenarios.fixture.ts";

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
