// Fixed cases of the deletion replay (D1-b2a): what it refuses in this version, and the two things
// it keeps from the records as judged when written (a write in effect stays in effect; a no-op
// stays a no-op). The comparison with the reference evaluator is replay-deletion.prop.test.ts.

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp, view } from "./judge.ts";
import type { JudgeInput, OpRecord, TableShape, WriteInput } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import type { RowState } from "./state.ts";
import { judgeWrite } from "./write.ts";

const STATE: TableShape = {
  kind: "state",
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
};

const d = (md: string) => `2026-${md}` as BizPoint;

function write(
  op: number,
  fields: Record<string, FieldValue>,
  o: { seen?: number; from?: string } = {},
): WriteInput {
  const fs: Partial<Record<FieldId, { value: FieldValue }>> = {};
  for (const [f, v] of Object.entries(fields)) fs[f as FieldId] = { value: v };
  return {
    kind: "write",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    seen: o.seen ?? op - 1,
    seenExplicit: true,
    valid: {
      from: { mode: "given", value: d(o.from ?? "10-01") },
      to: { mode: "open" },
    },
    now: d("11-05"),
    fields: fs,
  };
}

function run(inputs: readonly JudgeInput[]): { state: RowState; records: OpRecord[] } {
  let state = emptyState(STATE);
  const records: OpRecord[] = [];
  for (const i of inputs) {
    const r = judgeOp(state, i);
    records.push(r.judgement.record);
    state = r.state;
  }
  return { state, records };
}

function refusal(f: () => unknown): JudgeError {
  try {
    f();
  } catch (e) {
    if (e instanceof JudgeError) return e;
    throw e;
  }
  throw new Error("not refused");
}

const values = (state: RowState, f: FieldId) =>
  (view(state).fields[f] ?? []).map((s) => [s.valid[0]?.from ?? null, s.value]);

describe("what this version refuses", () => {
  // 05-time «写状态» example: 10-01 起 5000 (#10), 11-10 起 4000 (#20); #30 from 11-02 open erases
  // the change point and awaits.
  const awaiting = [
    write(10, { f2: "5000" }, { seen: 0 }),
    { ...write(20, { f2: "4000" }, { from: "11-10" }), acknowledge: true as const },
    write(30, { f2: "3000" }, { from: "11-02" }),
  ];

  it.each(["confirm", "reject"] as const)("a %s in the log: not_implemented, naming it", (kind) => {
    const { records } = run([
      ...awaiting,
      { kind, op: 40, index: 0, event: 41, ruleset: 1, target: 31 },
    ]);
    const e = refusal(() => replayDeletion(STATE, records, new Set()));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ kind, op: 40 });
  });

  it("an undo in the log: not_implemented, naming it", () => {
    const { records } = run([
      ...awaiting.slice(0, 2),
      {
        kind: "undo",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        target: 20,
        seen: 39,
        seenExplicit: true,
      },
    ]);
    const e = refusal(() => replayDeletion(STATE, records, new Set()));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ kind: "undo", op: 40 });
  });

  it("a write whose interval block is gone, with a target left: not_implemented", () => {
    const { records } = run([write(10, { f2: "1" })]);
    const gone = records.map((r) => ({ ...r, validGone: true as const }));
    const e = refusal(() => replayDeletion(STATE, gone, new Set()));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ op: 10 });
    // Every target of it deleted: nothing of it is left, nothing to refuse.
    expect(replayDeletion(STATE, gone, new Set([contributionKey(11, "f2")])).records).toEqual([]);
  });

  it("an operation after a deletion event: not_implemented", () => {
    const { records } = run(awaiting.slice(0, 2));
    expect(replayDeletion(STATE, records, new Set(), [25]).records).toHaveLength(2);
    const e = refusal(() => replayDeletion(STATE, records, new Set(), [15]));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ op: 20 });
  });
});

describe("what the replay keeps from the records", () => {
  it("a target protected by deviation two is judged without the conflict step", () => {
    // #20 did not see #10 and writes another value over it: a conflict when judged now.
    const { state } = run([write(10, { f2: "1" })]);
    const stale = write(20, { f2: "2" }, { seen: 0 });
    expect(judgeWrite(state, stale).items.map((x) => x.status)).toEqual(["candidate"]);
    const kept = judgeWrite(state, stale, { noop: new Set(), protect: new Set(["f2"]) });
    expect(kept.items.map((x) => x.status)).toEqual(["applied"]);
  });

  it("a field judged a no-op when written stays a no-op once what it agreed with is gone", () => {
    const { state, records } = run([write(10, { f2: "1" }), write(20, { f2: "1", f3: "x" })]);
    expect(records[1]).toMatchObject({ noop: ["f2"] });
    expect(values(state, "f2")).toEqual([[d("10-01"), "1"]]);
    const after = replayDeletion(STATE, records, new Set([contributionKey(11, "f2")]));
    // f2 is not written again: the row lacks its required field (a gap), f3 is still applied.
    expect(view(after.state).gaps).toEqual([{ from: null, to: null }]);
    expect(after.records).toHaveLength(1);
    expect(after.records[0]).toMatchObject({
      op: 20,
      noop: ["f2"],
      items: [{ target: "f3", status: "applied", content: { kind: "value", value: "x" } }],
    });
  });

  it("an operation nothing of which is left has no record", () => {
    const { records } = run([write(10, { f2: "1" }), write(20, { f3: "x" })]);
    const after = replayDeletion(STATE, records, new Set([contributionKey(21, "f3")]));
    expect(after.records.map((r) => r.op)).toEqual([10]);
  });
});
