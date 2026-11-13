// Fixed cases for high impact ① at a value ↔ no value boundary (05-time «高影响写入»): the
// boundary counts only on the fields that define "has a value" (the required fields); other
// fields are compared only where the entity has a value. Fictional data.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluateAsWritten } from "./evaluate.ts";
import type { Op, TableSchema, ToParam, WriteOp } from "./model.ts";

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const d = (md: string) => `2026-${md}` as BizPoint;

function put(
  op: number,
  seen: number,
  fields: Record<string, string>,
  from: string,
  end: string,
): WriteOp {
  const to: ToParam = end === "open" ? { mode: "open" } : { mode: "given", value: d(end) };
  const fs: WriteOp["fields"] = {};
  for (const [f, value] of Object.entries(fields)) {
    (fs as Record<FieldId, { value: string; sources: string[] }>)[f as FieldId] = {
      value,
      sources: [`S${op}`],
    };
  }
  return {
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: fs,
  };
}

const statusOf = (ops: Op[], event: number) =>
  evaluateAsWritten(STATE, ops)
    .items.filter((x) => x.event === event)
    .map((x) => x.status);

describe("high impact ① at a value ↔ no value boundary", () => {
  it("a new entity written in two stretches is not high impact, with an optional field unwritten there", () => {
    // f3 is empty on [10-01, 11-01) and has no value after it until op 20 writes there.
    const ops: Op[] = [
      put(10, 0, { f2: "5000" }, "10-01", "11-01"),
      put(20, 10, { f2: "4000" }, "11-01", "open"),
      put(30, 20, { f3: "x" }, "11-10", "11-15"),
    ];
    expect(statusOf(ops, 21)).toEqual(["applied"]);
  });

  it("an optional field the same on both sides does not count; the required one differs", () => {
    // Before the change, f3's boundary at 11-01 (x ↔ no value) made op 20 high impact.
    const ops: Op[] = [
      put(10, 0, { f2: "5000", f3: "x" }, "10-01", "11-01"),
      put(20, 10, { f2: "4000", f3: "x" }, "11-01", "open"),
    ];
    expect(statusOf(ops, 21)).toEqual(["applied", "applied"]);
  });

  it("the required field the same on both sides: the boundary is gone, still high impact", () => {
    const ops: Op[] = [
      put(10, 0, { f2: "5000" }, "10-01", "11-01"),
      put(20, 10, { f2: "5000" }, "11-01", "open"),
    ];
    expect(statusOf(ops, 21)).toEqual(["awaiting"]);
  });

  it("filling exactly a gap with a value unlike both sides is not high impact", () => {
    const ops: Op[] = [
      put(10, 0, { f2: "5000" }, "10-01", "10-10"),
      { ...put(20, 10, { f2: "4000" }, "10-20", "open"), acknowledge: ["overwrite"] },
      put(30, 20, { f2: "3000" }, "10-10", "10-20"),
    ];
    expect(statusOf(ops, 21)).toEqual(["applied"]);
    expect(statusOf(ops, 31)).toEqual(["applied"]);
  });

  it("an explicit interval across a gap, erasing its ends, is high impact", () => {
    const ops: Op[] = [
      put(10, 0, { f2: "5000" }, "10-01", "10-10"),
      { ...put(20, 10, { f2: "4000" }, "10-20", "open"), acknowledge: ["overwrite"] },
      put(30, 20, { f2: "3000" }, "10-05", "10-25"),
    ];
    expect(statusOf(ops, 31)).toEqual(["awaiting"]);
  });
});

it("an optional field the filling write did not give is empty, not a hole: no change point", () => {
  // 05-time «无值区间»: 可选字段不带就是空. #21 revokes [11-01, 11-03); #31 fills it with f2 only;
  // #41 writes 1 from 11-01 on. Undoing #41 writes back 9 there and no value after 11-03. f3 is
  // empty on both sides of 11-03 (it appears in the log, on other days): no change point of f3
  // is erased, so the undo is not high impact.
  const ops: Op[] = [
    {
      ...put(10, 0, { f2: "1" }, "10-01", "open"),
      fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "x", sources: ["S10"] } },
      valid: {
        from: { mode: "given", value: d("10-01") },
        to: { mode: "given", value: d("10-05") },
      },
    },
    {
      kind: "revoke",
      op: 20,
      event: 21,
      seen: 10,
      valid: {
        from: { mode: "given", value: d("11-01") },
        to: { mode: "given", value: d("11-03") },
      },
      validSources: ["S20"],
    },
    { ...put(30, 20, { f2: "9" }, "11-01", "11-03"), acknowledge: ["overwrite"] },
    { ...put(40, 30, { f2: "1" }, "11-01", "open"), acknowledge: ["overwrite"] },
    { kind: "undo", op: 50, event: 51, target: 40 },
  ];
  expect(evaluateAsWritten(STATE, ops).reverts).toEqual([
    { op: 50, event: 51, status: "applied", record: [{ event: 41, target: "f2" }] },
  ]);
});
