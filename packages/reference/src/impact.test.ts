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
