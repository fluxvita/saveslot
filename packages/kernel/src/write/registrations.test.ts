// The "reverted" registrations apply makes from a revert's blocks, against judge's (09-event-format
// §5.7 `revert`; 03-deletion «回掉的权威定义» step 5): on hand-built items, the two must register the
// same items on the same intervals, judgement and recording being one rule. Here because `write`
// may import both `apply` and `judge`.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { registrations, type SettleItem } from "../apply/settle.ts";
import { type Item, registrationsOf } from "../judge/state.ts";
import { type IntervalSet, interval } from "../time/index.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const iv = (from: string, to?: string) => interval(d(from), to === undefined ? null : d(to));

/** An item as judge holds it, and as apply reads it from storage. */
function item(
  op: number,
  target: string,
  content: Item["content"],
  valid: IntervalSet,
  k = 0,
): { judge: Item; apply: SettleItem } {
  const judge: Item = {
    event: op + 1,
    target: target as FieldId,
    k,
    op,
    index: 0,
    status: "applied",
    valid,
    content,
    deps: [],
    explicitEnds: [],
    defaultEnd: false,
  };
  const apply: SettleItem = {
    event: op + 1,
    target: target as FieldId,
    k,
    status: "applied",
    valid,
    content: content as SettleItem["content"],
    reverted: [],
  };
  return { judge, apply };
}

const v = (value: string) => ({ kind: "value" as const, value });

function both(
  items: { judge: Item; apply: SettleItem }[],
  entries: { event: number; target: string; later?: true }[],
  writeBacks: { judge: Item; apply: SettleItem }[],
  op: number,
) {
  const fromApply = registrations(
    items.map((x) => x.apply),
    entries,
    writeBacks.map((x) => x.apply),
  ).map((r) => ({ event: r.item.event, target: r.item.target, k: r.item.k, valid: r.valid }));
  const fromJudge = registrationsOf(
    items.map((x) => x.judge),
    { op, index: 0, entries: entries as never },
    writeBacks.map((x) => x.judge),
  ).map((r) => ({ event: r.item.event, target: r.item.target, k: r.item.k, valid: r.reg.valid }));
  return { fromApply, fromJudge };
}

describe("apply registers what judge registers", () => {
  it("an undone item skipped where a write outside the record covers it, itself covered by a later entry", () => {
    // m (#21) on f2 from 10-05; c (#31, not in the record) covers [11-01, 11-10); r2 (#41, marked
    // later) covers [10-25, 11-20). The undo (op 50) writes back over [10-05, ∞).
    const m = item(20, "f2", v("M"), iv("10-05"));
    const c = item(30, "f2", v("C"), iv("11-01", "11-10"));
    const r2 = item(40, "f2", v("R"), iv("10-25", "11-20"));
    const back = item(50, "f2", v("A"), iv("10-05"));
    const entries = [
      { event: 21, target: "f2" },
      { event: 41, target: "f2", later: true as const },
    ];
    const { fromApply, fromJudge } = both([m, c, r2], entries, [back], 50);
    expect(fromApply).toEqual(fromJudge);
    // Read from the blocks only: m is registered on its interval ∩ the write-backs, at c's
    // stretch too, where the definition skips it (it makes no difference to what is written: the
    // write-back covers that stretch).
    expect(fromApply).toEqual([
      { event: 21, target: "f2", k: 0, valid: iv("10-05") },
      { event: 41, target: "f2", k: 0, valid: iv("10-25", "11-20") },
    ]);
  });

  it("supersession by kind, revokes and restores, and entries with nothing in effect", () => {
    const revoke = item(20, "existence", { kind: "revoke" }, iv("11-01", "11-10"));
    const fill = item(30, "f2", v("B"), iv("11-02", "11-04"));
    const empty = item(31, "f2", { kind: "no_value" }, iv("11-05", "11-06"));
    const later = item(32, "existence", { kind: "restore" }, iv("11-03", "11-08"));
    const backs = [
      item(50, "existence", { kind: "restore" }, iv("11-01", "11-10")),
      item(50, "f2", { kind: "uncovered" }, iv("11-01", "11-10"), 1),
    ];
    const entries = [
      { event: 21, target: "existence" },
      { event: 31, target: "f2", later: true as const },
      { event: 32, target: "f2", later: true as const },
      { event: 33, target: "existence", later: true as const },
      { event: 99, target: "f2" },
    ];
    const { fromApply, fromJudge } = both([revoke, fill, empty, later], entries, backs, 50);
    expect(fromApply).toEqual(fromJudge);
    expect(fromApply.map((r) => r.event)).toEqual([21, 31, 33]);
  });
});
