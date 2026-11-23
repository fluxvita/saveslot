// `coveredOutsideO` (03-deletion «搬运的值»): where writes outside the cover set O cover a taken
// item in a deletion's replay. Cases a generated log rarely reaches.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { emptyState, judgeOp } from "./judge.ts";
import type { JudgeInput, OpRecord, TableShape } from "./model.ts";
import { type Item, RowState } from "./state.ts";
import { coveredOutsideO } from "./take.ts";

const STATE: TableShape = {
  kind: "state",
  fields: ["f2"] as FieldId[],
  valued: ["f2"] as FieldId[],
  required: ["f2"] as FieldId[],
  groups: [],
};
const d = (md: string) => `2026-${md}` as BizPoint;
const span = (from: string, to: string | null) => ({
  from: { mode: "given" as const, value: d(from) },
  to: to === null ? { mode: "open" as const } : { mode: "given" as const, value: d(to) },
});
const iv = (from: string, to: string | null) => [{ from: d(from), to: to === null ? null : d(to) }];

function run(inputs: JudgeInput[]): { state: RowState; records: OpRecord[] } {
  let state = emptyState(STATE);
  const records: OpRecord[] = [];
  for (const i of inputs) {
    const r = judgeOp(state, i);
    records.push(r.judgement.record);
    state = r.state;
  }
  return { state, records };
}
const base = (op: number) => ({ op, index: 0, event: op + 1, ruleset: 1, seenExplicit: true });
const w10: JudgeInput = {
  ...base(10),
  kind: "write",
  seen: 0,
  valid: span("10-01", null),
  now: d("11-05"),
  fields: { f2: { value: "1" } } as never,
};
/** A taken field item over [11-01, 11-09), as a take at #60 would write it. */
const taken: Item = {
  event: 61,
  target: "f2" as FieldId,
  k: 0,
  op: 60,
  index: 0,
  status: "applied",
  valid: iv("11-01", "11-09"),
  content: { kind: "value", value: "3" },
  deps: [],
  explicitEnds: [],
  defaultEnd: false,
};

describe("coveredOutsideO", () => {
  it("O is by (event, target): an event's field item in O does not take its revoke item into O", () => {
    // One event with a field item (listed in O) and a revoke item (not: O lists the unit's
    // targets), as an undo's write-backs can be. The revoke, after the merge base, not filled,
    // covers the taken field item where it lies; matching O by event alone would drop it.
    const { records } = run([w10]);
    const both: OpRecord = {
      ...(records[0] as OpRecord & { kind: "write" }),
      op: 50,
      event: 51,
      items: [
        {
          target: "f2" as FieldId,
          k: 0,
          status: "applied",
          valid: iv("11-01", "11-09"),
          content: { kind: "value", value: "5" },
          deps: [],
        },
        {
          target: "existence",
          k: 0,
          status: "applied",
          valid: iv("11-03", "11-05"),
          content: { kind: "revoke" },
          deps: [],
        },
      ],
    } as OpRecord;
    const state = new RowState(STATE, [...records, both]);
    const rec = { mergeBase: 10, cover: [{ event: 51, target: "f2" as FieldId }], filled: [] };
    expect(coveredOutsideO(state, rec, 60, taken)).toEqual(iv("11-03", "11-05"));
    // Listed in filled: it covers nothing.
    expect(coveredOutsideO(state, { ...rec, filled: [51] }, 60, taken)).toEqual([]);
  });

  it("a revoke outside O that an earlier revert registered covers nothing where registered", () => {
    // #20 revokes [11-03, 11-05); #30 undoes it (registered as reverted over its stretch). Outside
    // O, after the merge base, not filled: it would cover the taken item; registered, it does not.
    const { state } = run([
      w10,
      {
        ...base(20),
        kind: "revoke",
        seen: 10,
        valid: span("11-03", "11-05"),
        now: d("11-05"),
      } as JudgeInput,
      { ...base(30), kind: "undo", target: 20, seen: 29, acknowledge: true } as JudgeInput,
    ]);
    expect(state.items.filter((x) => x.event === 21).map((x) => x.status)).toEqual(["applied"]);
    const rec = { mergeBase: 10, cover: [], filled: [] };
    expect(coveredOutsideO(state, rec, 60, taken)).toEqual([]);
  });
});
