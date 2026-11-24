// The item layer across two deletions and their cancellations, on records written into events and
// read back (09 §5.7, §5.8): the judge's case (judge/cancel.test.ts) holds as the log has it.

import { STATE } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { cancelBoth, PART_BACK_OPS } from "../judge/cancel.fixture.ts";
import { openItems } from "../judge/fates.fixture.ts";
import { judged } from "../judge/scenarios.fixture.ts";
import { asWritten, eventsOfSteps } from "./log.fixture.ts";
import { decodeRecords, type RowContext } from "./record.ts";

const CTX = {
  table: "t1",
  target: { entity: `e_${"7".repeat(26)}` },
  shape: { kind: "state", fields: ["f2", "f3"], valued: ["f2"], required: ["f2"], groups: [] },
  granularity: "date",
} as unknown as RowContext;

describe("a part going back pending as its original item's kind, the records read back from the log", () => {
  it("61:existence restored after deleting S1, S5, cancelling S5, then S1; the open items as written", () => {
    const { table, steps } = judged(STATE, PART_BACK_OPS.map(asWritten), []);
    const events = eventsOfSteps(CTX, steps, (after, n) => 1_000_000 + after * 10 + n).flat();
    const records = decodeRecords(
      CTX,
      events.map((e) => ({
        header: { type: e.type, seq: e.seq, ...(e.op !== undefined ? { op: e.op } : {}) },
        blocks: e.blocks,
      })) as never,
    );
    const r = cancelBoth(
      table,
      records,
      steps.map((x) => x.op),
      ["S1"],
      ["S5"],
    );
    expect(r.g2.of.get("61/f2")).toBe("61:existence>awaiting");
    expect(r.cA.items.restored).toEqual(["61:existence"]);
    expect(openItems(r.end, r.cA.replay.state)).toEqual(openItems(r.g0, r.cA.replay.state));
    expect(openItems(r.end, r.cA.replay.state)).toEqual(["61:existence conflict: 61/f2"]);
  });
});
