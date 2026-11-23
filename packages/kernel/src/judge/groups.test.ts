// Field groups (09-references-conflict-sync «冲突单元», «组值»; conflict criterion ⑤): the logs on
// a group whose judgement needs more than one field at a time, judged by the kernel, with the
// statuses the reference evaluator gives (reference/src/testing/groups.fixture.ts).

import { evaluate, evaluateLog } from "@fluxvita/saveslot-reference";
import { GROUP_LOGS, GROUP_TAKE_INTO_HOLE } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
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
