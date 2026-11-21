// apply's check of a changed declaration's `since` (09 §5.7 `ops/<i>/premises/<j>`): after the
// position its ver reads, the ver read where 04-contract §15 says as of the event (`seenOfVer`).
// The event's shape no longer checks `since > ver.op`: a ver given before a restore is recorded as
// given, and past the restore point it reads at the point, so `since` may be below its op.

import type { Seq } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { planHeadPremises } from "./premises.ts";

const SEQ = 120 as Seq;
/** A write head whose op 0 declares one premise, changed since `since`, on ver `op`.`count`. */
const head = (op: number, count: number, since: number) => ({
  "ops/0/target": { table: "t2", row: "r_DEP", intent: "update" },
  "ops/0/premises/0": {
    table: "t1",
    row: "r_TARGET",
    ver: { op, restore_count: count, basis: "explicit" },
    range: "whole",
    state: "changed",
    reason: "update",
    since,
  },
});
const plan = (
  present: Record<string, unknown>,
  restoreAt?: { restoreCount: number; point: number | null },
) => planHeadPremises(SEQ, "u_1", present as never, new Map(), restoreAt as never);

describe("a changed declaration's since, as apply checks it", () => {
  it("no restore: after its ver's op, taken; not after it, inconsistent", () => {
    expect(() => plan(head(40, 0, 41))).not.toThrow();
    expect(() => plan(head(40, 0, 40))).toThrow(/since not after the position seen/);
    expect(() => plan(head(40, 0, 39))).toThrow(/since not after the position seen/);
  });

  it("one count less and not past the point: after its own op", () => {
    const at = { restoreCount: 1, point: 100 };
    expect(() => plan(head(40, 0, 41), at)).not.toThrow();
    expect(() => plan(head(40, 0, 40), at)).toThrow(/since not after the position seen/);
  });

  it("past the point: after the point, below its own op taken", () => {
    const at = { restoreCount: 1, point: 100 };
    // The ver's op (600) is the old timeline's; it reads at the point (100).
    expect(() => plan(head(600, 0, 110), at)).not.toThrow();
    expect(() => plan(head(600, 0, 100), at)).toThrow(/since not after the position seen/);
  });

  it("two counts less: after the point", () => {
    const at = { restoreCount: 2, point: 100 };
    expect(() => plan(head(40, 0, 101), at)).not.toThrow();
    expect(() => plan(head(40, 0, 90), at)).toThrow(/since not after the position seen/);
  });

  it("a count newer than the event's: inconsistent", () => {
    expect(() => plan(head(40, 3, 41), { restoreCount: 1, point: 100 })).toThrow(
      /the position seen not before this operation/,
    );
  });

  it("where the ver reads is before this operation; a token of the current count past it, inconsistent", () => {
    // The current count, its op at or after this operation (120): not a version that was given.
    expect(() => plan(head(SEQ, 0, SEQ))).toThrow(/the position seen not before this operation/);
    expect(() => plan(head(SEQ + 5, 1, SEQ), { restoreCount: 1, point: 100 })).toThrow(
      /the position seen not before this operation/,
    );
    // One count less, its op past this log's end (an import's exporter wrote on): read at the
    // point, so before this operation; since after the point.
    expect(() => plan(head(SEQ + 400, 0, 110), { restoreCount: 1, point: 100 })).not.toThrow();
  });
});
