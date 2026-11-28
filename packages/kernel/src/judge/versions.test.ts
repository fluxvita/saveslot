// Direct unit tests of `givesVersion` and `cellsOf` (02-architecture §8 «版本表»; 04-contract §2
// `ver`): each edge case where what is read stays the same (or has no value) while a version-table
// cell either changes or stays as it was.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { EVENT } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { emptyState, judgeOp } from "./judge.ts";
import type { JudgeInput, TableShape } from "./model.ts";
import { judged } from "./scenarios.fixture.ts";
import type { RowState } from "./state.ts";
import { cellsOf, givesVersion } from "./versions.ts";

const STATE: TableShape = {
  kind: "state",
  fields: ["f1", "f2", "f3"],
  valued: ["f1", "f2"],
  required: ["f1", "f2"],
  groups: [],
};

const GROUPED_EVENT: TableShape = {
  kind: "event",
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [["f2", "f3"]],
};

const d = (md: string) => `2026-${md}` as BizPoint;
const span = (from: string, to?: string) => ({
  from: { mode: "given" as const, value: d(from) },
  to:
    to === undefined
      ? ({ mode: "open" as const } as const)
      : ({ mode: "given" as const, value: d(to) } as const),
});

function run(table: TableShape, inputs: readonly JudgeInput[]) {
  let state: RowState = emptyState(table);
  const steps: { before: RowState; state: RowState; gives: boolean }[] = [];
  for (const input of inputs) {
    const before = state;
    const step = judgeOp(before, input);
    const gives = givesVersion(steps.length === 0 ? undefined : before, step);
    steps.push({ before, state: step.state, gives });
    state = step.state;
  }
  return steps;
}

describe("givesVersion and cellsOf", () => {
  it("state table: changing an optional field on a no-value stretch gives no version", () => {
    const steps = run(STATE, [
      {
        kind: "write",
        op: 10,
        index: 0,
        event: 11,
        ruleset: 1,
        seen: 0,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("10-01", "11-01"),
        fields: {
          f1: { value: "café", explicit: true },
          f2: { value: "1", explicit: true },
          f3: { value: "x", explicit: true },
        },
      },
      {
        kind: "write",
        op: 20,
        index: 0,
        event: 21,
        ruleset: 1,
        seen: 10,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("12-01"),
        fields: {
          f1: { value: "café", explicit: true },
          f2: { value: "2", explicit: true },
          f3: { value: "y", explicit: true },
        },
      },
      {
        kind: "write",
        op: 30,
        index: 0,
        event: 31,
        ruleset: 1,
        seen: 20,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("12-01"),
        fields: { f3: { value: "w", explicit: true } },
      },
      // Undo op 20: awaits confirmation because op 30 is on [12-01, ..); confirm it.
      {
        kind: "undo",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        seen: 30,
        seenExplicit: true,
        target: 20,
        includeLater: false,
        acknowledge: true,
      },
      { kind: "confirm", op: 45, index: 0, event: 46, ruleset: 1, target: 41 },
      // Undo op 30: f3 changes on [12-01, ..), where the entity has no value (f1, f2 are no_value).
      {
        kind: "undo",
        op: 50,
        index: 0,
        event: 51,
        ruleset: 1,
        seen: 45,
        seenExplicit: true,
        target: 30,
        includeLater: false,
      },
    ]);
    expect(steps[4]?.gives).toBe(true);
    expect(steps[5]?.gives).toBe(false);
    expect(cellsOf(steps[4]?.state as RowState)).toBe(cellsOf(steps[5]?.state as RowState));
  });

  it("state table: same non-null value with a new giver gives a version", () => {
    const steps = run(STATE, [
      {
        kind: "write",
        op: 10,
        index: 0,
        event: 11,
        ruleset: 1,
        seen: 0,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("10-01"),
        fields: { f1: { value: "café", explicit: true }, f2: { value: "9", explicit: true } },
      },
      {
        kind: "write",
        op: 20,
        index: 0,
        event: 21,
        ruleset: 1,
        seen: 10,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("10-01"),
        fields: { f2: { value: "1", explicit: true } },
        acknowledge: true,
      },
      {
        kind: "undo",
        op: 30,
        index: 0,
        event: 31,
        ruleset: 1,
        seen: 20,
        seenExplicit: true,
        target: 20,
        includeLater: false,
        acknowledge: true,
      },
      {
        kind: "undo",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        seen: 30,
        seenExplicit: true,
        target: 20,
        includeLater: true,
        acknowledge: true,
      },
      { kind: "confirm", op: 45, index: 0, event: 46, ruleset: 1, target: 41 },
    ]);
    expect(steps[2]?.gives).toBe(true);
    expect(steps[3]?.gives).toBe(false);
    // Op 45 writes back f2 = "9" again, changing only its giver from event 31 to event 46.
    expect(steps[4]?.gives).toBe(true);
  });

  it("state table: re-giving a no_value cell gives a version, both on valued and no-value stretches", () => {
    const onValued = run(STATE, [
      {
        kind: "write",
        op: 10,
        index: 0,
        event: 11,
        ruleset: 1,
        seen: 0,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("10-01"),
        fields: { f1: { value: "café", explicit: true }, f2: { value: "9", explicit: true } },
      },
      {
        kind: "write",
        op: 20,
        index: 0,
        event: 21,
        ruleset: 1,
        seen: 10,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("10-01"),
        fields: { f3: { value: "1", explicit: true } },
      },
      {
        kind: "undo",
        op: 30,
        index: 0,
        event: 31,
        ruleset: 1,
        seen: 20,
        seenExplicit: true,
        target: 20,
        includeLater: false,
      },
      {
        kind: "undo",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        seen: 30,
        seenExplicit: true,
        target: 20,
        includeLater: true,
      },
      { kind: "confirm", op: 45, index: 0, event: 46, ruleset: 1, target: 41 },
    ]);
    expect(onValued[4]?.gives).toBe(true);

    const onNoValue = run(STATE, [
      {
        kind: "write",
        op: 10,
        index: 0,
        event: 11,
        ruleset: 1,
        seen: 0,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("10-01", "11-01"),
        fields: { f1: { value: "café", explicit: true }, f2: { value: "9", explicit: true } },
      },
      {
        kind: "write",
        op: 20,
        index: 0,
        event: 21,
        ruleset: 1,
        seen: 10,
        seenExplicit: true,
        now: d("11-05"),
        valid: span("12-01"),
        fields: { f1: { value: "café", explicit: true }, f2: { value: "1", explicit: true } },
      },
      {
        kind: "undo",
        op: 30,
        index: 0,
        event: 31,
        ruleset: 1,
        seen: 20,
        seenExplicit: true,
        target: 20,
        includeLater: false,
        acknowledge: true,
      },
      {
        kind: "undo",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        seen: 30,
        seenExplicit: true,
        target: 20,
        includeLater: true,
        acknowledge: true,
      },
      { kind: "confirm", op: 45, index: 0, event: 46, ruleset: 1, target: 41 },
    ]);
    expect(onNoValue[4]?.gives).toBe(true);
  });

  it("event table: a candidate on a previously unwritten optional field in a conflict group gives no version", () => {
    const steps = run(GROUPED_EVENT, [
      {
        kind: "write",
        op: 10,
        index: 0,
        event: 11,
        ruleset: 1,
        seen: 0,
        seenExplicit: true,
        now: d("11-05"),
        fields: { f2: { value: "a", explicit: true } },
      },
      {
        kind: "write",
        op: 20,
        index: 0,
        event: 21,
        ruleset: 1,
        seen: 10,
        seenExplicit: true,
        now: d("11-05"),
        fields: { f2: { value: "b", explicit: true } },
      },
      // Stale write touching optional f3 (never written before) in the same conflict group as f2:
      // becomes a candidate, changing no version cell.
      {
        kind: "write",
        op: 30,
        index: 0,
        event: 31,
        ruleset: 1,
        seen: 10,
        seenExplicit: true,
        now: d("11-05"),
        fields: { f3: { value: "c", explicit: true } as { value: string; explicit: boolean } },
      },
    ]);
    expect(steps[2]?.gives).toBe(false);
    // Double-check the optional field was never written before op 30 and became a candidate there.
    expect(
      steps[2]?.state.items.some(
        (x) => x.event === 31 && x.target === ("f3" as FieldId) && x.status === "candidate",
      ),
    ).toBe(true);
  });

  it("event table: a restore on a row that neither exists nor is revoked gives no version", () => {
    // f2 is required and never applied: the row only ever has cells while revoked. Op 33 revokes it
    // (a revoked row with cells), op 53 takes the previous back on f2's candidate (a restore: the
    // row leaves the version table), op 63 does so again on the next candidate (a restore on a row
    // with no cells before or after: nothing changes).
    const write = (op: number, seen: number, field: string, value: string, source: string) => ({
      kind: "write" as const,
      op,
      event: op + 1,
      seen,
      fields: { [field]: { value, sources: [source], explicit: false } },
      acknowledge: ["overwrite" as const],
    });
    const previous = { pick: 0, kind: "previous" as const, flag: 0, focus: false };
    const { steps } = judged(
      EVENT,
      [
        write(20, 10, "f3", "1", "S5"),
        write(30, 20, "f3", "1", "S6"),
        write(40, 30, "f2", "1", "S4"),
        write(50, 40, "f2", "1", "S2"),
        { ...write(60, 20, "f2", "9", "S5"), acknowledge: [] },
        write(70, 60, "f2", "9", "S1"),
        write(80, 70, "f2", "9", "S1"),
        {
          kind: "undo",
          op: 90,
          event: 91,
          target: 80,
          includeLater: false,
          seen: 80,
          acknowledge: ["overwrite"],
        },
      ] as never,
      [
        { after: 140523945, pick: 0, kind: "revoke", flag: 0, focus: false },
        { after: 717448851, ...previous },
        { after: 398313780, ...previous },
      ] as never,
    );
    const kinds = steps.map((x) => x.op.kind);
    expect(kinds.slice(0, 7)).toEqual([
      "write",
      "write",
      "revoke",
      "write",
      "resolve",
      "write",
      "resolve",
    ]);
    const gives = steps.map((x, n) => givesVersion(steps[n - 1]?.state, x));
    expect(gives[2]).toBe(true);
    expect(gives[4]).toBe(true);
    expect(gives[6]).toBe(false);
  });
});
