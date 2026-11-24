// High impact ② in judging (05-time «高影响写入» ②): a revoke whose target the write path found
// still referred to (`RevokeInput.referenced`) awaits confirmation; stale, it is a candidate first;
// on a state table only a revoke of the whole entity. In a deletion's replay (03-deletion «高影响
// （重算）»): undecided, refused (a replay does not see other rows); decided, it awaits as written
// and its decision is executed as recorded. Expected values written by hand from the spec.

import type { BizPoint, FieldValue } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type Op } from "@fluxvita/saveslot-reference";
import { EVENT as EVENT_SCHEMA } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { emptyState, judgeOp } from "./judge.ts";
import type { JudgeInput, Judgement, TableShape, WriteInput } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import { judged } from "./scenarios.fixture.ts";
import type { RowState } from "./state.ts";

const T: TableShape = {
  kind: "timeless",
  fields: ["f2"],
  valued: ["f2"],
  required: [],
  groups: [],
};
const S: TableShape = {
  kind: "state",
  fields: ["f2"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
};
const NOW = "2026-11-05" as BizPoint;
const base = (op: number) => ({ op, index: 0, event: op + 1, ruleset: 1 });
const write = (op: number, seen: number, v: Record<string, FieldValue>): WriteInput => ({
  ...base(op),
  kind: "write",
  seen,
  seenExplicit: true,
  now: NOW,
  fields: Object.fromEntries(Object.entries(v).map(([f, x]) => [f, { value: x }])) as never,
});
const revoke = (op: number, seen: number, extra: Partial<JudgeInput> = {}): JudgeInput =>
  ({ ...base(op), kind: "revoke", seen, seenExplicit: true, now: NOW, ...extra }) as JudgeInput;
const decide = (op: number, kind: "confirm" | "reject", target: number): JudgeInput => ({
  ...base(op),
  kind,
  target,
});

function run(table: TableShape, inputs: readonly JudgeInput[]) {
  let state: RowState = emptyState(table);
  const js: Judgement[] = [];
  for (const i of inputs) {
    const r = judgeOp(state, i);
    js.push(r.judgement);
    state = r.state;
  }
  return { state, last: js[js.length - 1] as Judgement };
}
const existence = (j: Judgement) =>
  ("items" in j.record ? j.record.items : [])
    .filter((x) => x.target === "existence")
    .map((x) => x.status);

describe("judging a revoke of a referenced row", () => {
  it("referenced: its existence item awaits; not referenced: applied", () => {
    expect(
      existence(run(T, [write(10, 9, { f2: "a" }), revoke(20, 10, { referenced: true })]).last),
    ).toEqual(["awaiting"]);
    expect(existence(run(T, [write(10, 9, { f2: "a" }), revoke(20, 10)]).last)).toEqual([
      "applied",
    ]);
  });

  it("stale (changed since the version seen): a candidate, not awaiting", () => {
    const { last } = run(T, [
      write(10, 9, { f2: "a" }),
      write(20, 10, { f2: "b" }),
      revoke(30, 10, { referenced: true }),
    ]);
    expect(existence(last)).toEqual(["candidate"]);
  });

  it("a state table: the whole entity awaits; a revoke of a stretch does not", () => {
    const made = write(10, 9, { f2: "a" });
    expect(existence(run(S, [made, revoke(20, 10, { referenced: true })]).last)).toEqual([
      "awaiting",
    ]);
    const stretch = revoke(20, 10, {
      referenced: true,
      valid: { from: "2026-11-01" as never, to: "2026-11-03" as never },
    } as never);
    expect(existence(run(S, [made, stretch]).last)).toEqual(["applied"]);
  });
});

describe("a deletion's replay of a revoke that awaited for its referrers", () => {
  const records = (more: readonly JudgeInput[]) =>
    run(T, [write(10, 9, { f2: "a" }), revoke(20, 10, { referenced: true }), ...more]).state
      .records;

  it("undecided: refused (not_implemented), never judged as effective", () => {
    let caught: unknown;
    try {
      replayDeletion(T, records([]), new Set());
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      reason: "not_implemented",
      detail: { kind: "referenced_revoke_awaiting", op: 20 },
    });
  });

  it("confirmed: the revoke awaits as written, the confirmation revokes the row", () => {
    const r = replayDeletion(T, records([decide(30, "confirm", 21)]), new Set());
    expect(r.state.revoked({ upTo: 29 as never })).toBe(false);
    expect(r.state.revoked({ upTo: 30 as never })).toBe(true);
  });

  it("rejected: the row stays", () => {
    const r = replayDeletion(T, records([decide(30, "reject", 21)]), new Set());
    expect(r.state.revoked({ upTo: 30 as never })).toBe(false);
  });
});

describe("a deletion's replay of a stale revoke whose conflict the deletion clears", () => {
  // f2 written at 10; changed at 20 (source S20); revoked at 30 having seen 10: a candidate. The
  // deletion of S20 takes the change away, so the conflict is gone in the replay.
  const ops: Op[] = [
    { kind: "write", op: 10, event: 11, seen: 0, fields: { f2: { value: "1", sources: ["S10"] } } },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      fields: { f2: { value: "2", sources: ["S20"] } },
    },
    { kind: "revoke", op: 30, event: 31, seen: 10 },
  ];
  const gone = new Set([contributionKey(21, "f2")]);

  it("on a table that may be referred to: refused (not_implemented), never judged as effective", () => {
    const { table, steps } = judged(EVENT_SCHEMA, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(
      steps[2]?.judgement.record.kind === "revoke" && steps[2].judgement.conflicts.length,
    ).toBe(1);
    let caught: unknown;
    try {
      replayDeletion({ ...table, referable: true }, records, gone);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      reason: "not_implemented",
      detail: { kind: "revoke_conflict_cleared", op: 30 },
    });
  });

  it("referable not given: refused (invalid), never taken as not referable", () => {
    const { table, steps } = judged(EVENT_SCHEMA, ops, []);
    const records = steps.map((x) => x.judgement.record);
    const { referable: _, ...unknown } = table;
    let caught: unknown;
    try {
      replayDeletion(unknown, records, gone);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ reason: "invalid" });
  });

  it("on a table nothing refers to: replayed as before, the revoke in effect, as the reference gives", () => {
    const { table, steps } = judged(EVENT_SCHEMA, ops, []);
    const records = steps.map((x) => x.judgement.record);
    const r = replayDeletion(table, records, gone);
    const ref = evaluateLog(EVENT_SCHEMA, [
      ...ops,
      { kind: "deletion", op: 40, id: "pi_x", sources: ["S20"] },
    ]).final;
    expect(r.state.revoked({ upTo: 30 as never })).toBe(true);
    expect(ref.exists).toBe(false);
  });
});
