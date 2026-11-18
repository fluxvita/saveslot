// settle and the "reverted" registrations on hand-built items (09-event-format §5.7; 03-deletion
// «重放规则», «回掉的权威定义»): the spec's example, and what judged logs never put apart (a no-value
// item over a value not registered, a revoke registered without a restore). The comparison with
// judge and the reference evaluator is write/settle.prop.test.ts.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { interval, WHOLE } from "../time/index.ts";
import { registrations, type SettleItem, settle } from "./settle.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const iv = (from: string, to?: string) => interval(d(from), to === undefined ? null : d(to));
const STATE = {
  kind: "state" as const,
  fields: ["f2", "f3"] as FieldId[],
  required: ["f2"] as FieldId[],
};
const EVENT = {
  kind: "event" as const,
  fields: ["f2", "f3"] as FieldId[],
  required: ["f2"] as FieldId[],
};

const item = (
  event: number,
  target: string,
  content: SettleItem["content"],
  valid = [WHOLE] as SettleItem["valid"],
  o: { k?: number; reverted?: SettleItem["reverted"]; status?: SettleItem["status"] } = {},
): SettleItem => ({
  event,
  target: target as FieldId | "existence",
  k: o.k ?? 0,
  status: o.status ?? "applied",
  valid,
  content,
  reverted: o.reverted ?? [],
});
const v = (value: string) => ({ kind: "value" as const, value });
const by = (event: number, target = "f2", k = 0) => ({ event, target, k });

describe("settle: a state table", () => {
  it("09 §5.7: an undo over two stretches writes back each, the business rows merge by value", () => {
    // #12 [10-01, ∞) 5000; #15 [11-10, ∞) 4000; #22 [11-02, 11-20) 3000, undone by op 30 (#32).
    const items = [
      item(12, "f2", v("5000"), iv("10-01")),
      item(15, "f2", v("4000"), iv("11-10")),
      item(22, "f2", v("3000"), iv("11-02", "11-20"), {
        reverted: [{ op: 30, valid: iv("11-02", "11-20") }],
      }),
      item(32, "f2", v("5000"), iv("11-02", "11-10")),
      item(32, "f2", v("4000"), iv("11-10", "11-20"), { k: 1 }),
    ];
    const s = settle(STATE, items);
    expect(s.rows).toEqual([
      {
        valid: { from: d("10-01"), to: d("11-10") },
        revoked: false,
        values: { f2: "5000", f3: null },
      },
      { valid: { from: d("11-10"), to: null }, revoked: false, values: { f2: "4000", f3: null } },
    ]);
    expect(s.cells.filter((c) => c.field === "f2")).toEqual([
      { field: "f2", valid: { from: d("10-01"), to: d("11-02") }, value: "5000", by: by(12) },
      { field: "f2", valid: { from: d("11-02"), to: d("11-10") }, value: "5000", by: by(32) },
      {
        field: "f2",
        valid: { from: d("11-10"), to: d("11-20") },
        value: "4000",
        by: by(32, "f2", 1),
      },
      { field: "f2", valid: { from: d("11-20"), to: null }, value: "4000", by: by(15) },
    ]);
    // An optional field without items is empty where the entity has a value, from no item.
    expect(s.cells.filter((c) => c.field === "f3")).toEqual([
      { field: "f3", valid: { from: d("10-01"), to: null }, value: null, by: null },
    ]);
  });

  it("a registration-only write-back exposes what was under the undone write: a revoke's gap", () => {
    // #20 revokes [11-01, 11-05); #30 fills [11-02, 11-04) and is undone by op 40, written back
    // by an `uncovered` item.
    const items = [
      item(10, "f2", v("A"), iv("10-01")),
      item(20, "existence", { kind: "revoke" }, iv("11-01", "11-05")),
      item(30, "f2", v("B"), iv("11-02", "11-04"), {
        reverted: [{ op: 40, valid: iv("11-02", "11-04") }],
      }),
      item(41, "f2", { kind: "uncovered" }, iv("11-02", "11-04")),
    ];
    expect(settle(STATE, items).rows.map((r) => r.valid)).toEqual([
      { from: d("10-01"), to: d("11-01") },
      { from: d("11-05"), to: null },
    ]);
  });

  it("a no-value item over a value not registered empties it; on a required field, a gap", () => {
    const items = [
      item(10, "f2", v("A"), iv("10-01")),
      item(10, "f3", v("x"), iv("10-01")),
      item(20, "f3", { kind: "no_value" }, iv("11-01", "11-03")),
      item(30, "f2", { kind: "no_value" }, iv("11-05", "11-07")),
    ];
    const s = settle(STATE, items);
    expect(s.rows).toEqual([
      { valid: { from: d("10-01"), to: d("11-01") }, revoked: false, values: { f2: "A", f3: "x" } },
      {
        valid: { from: d("11-01"), to: d("11-03") },
        revoked: false,
        values: { f2: "A", f3: null },
      },
      { valid: { from: d("11-03"), to: d("11-05") }, revoked: false, values: { f2: "A", f3: "x" } },
      { valid: { from: d("11-07"), to: null }, revoked: false, values: { f2: "A", f3: "x" } },
    ]);
  });

  it("cells of a no-value item: by that item, also where a required field's is a gap", () => {
    const items = [
      item(10, "f2", v("A"), iv("10-01")),
      item(10, "f3", v("x"), iv("10-01")),
      item(20, "f3", { kind: "no_value" }, iv("11-01", "11-03")),
      item(30, "f2", { kind: "no_value" }, iv("11-05", "11-07")),
    ];
    const cells = settle(STATE, items).cells;
    expect(cells.filter((c) => c.value === null)).toEqual([
      // Where the entity has a value, f3 is empty: not a no-value cell.
      { field: "f3", valid: { from: d("11-01"), to: d("11-03") }, value: null, by: by(20, "f3") },
      // In the gap only the cell saying why, marked so: f3's value is not kept there.
      {
        field: "f2",
        valid: { from: d("11-05"), to: d("11-07") },
        value: null,
        noValue: true,
        by: by(30),
      },
    ]);
    expect(cells.some((c) => c.field === "f3" && c.valid?.from === d("11-05"))).toBe(false);
  });

  it("cells of a revoke: an existence cell marked revoked where it empties the entity, over its field items", () => {
    const whole = [item(10, "f2", v("A"), iv("10-01")), item(20, "existence", { kind: "revoke" })];
    expect(settle(STATE, whole)).toEqual({
      rows: [],
      cells: [
        {
          field: "existence",
          valid: { from: d("10-01"), to: null },
          value: null,
          revoked: true,
          by: by(20, "existence"),
        },
      ],
    });
    const part = [
      item(10, "f2", v("A"), iv("10-01")),
      item(20, "existence", { kind: "revoke" }, iv("11-01", "11-05")),
      item(30, "f2", v("B"), iv("11-02", "11-03")),
    ];
    expect(settle(STATE, part).cells.filter((c) => c.field === "existence")).toEqual([
      {
        field: "existence",
        valid: { from: d("11-01"), to: d("11-02") },
        value: null,
        revoked: true,
        by: by(20, "existence"),
      },
      {
        field: "existence",
        valid: { from: d("11-03"), to: d("11-05") },
        value: null,
        revoked: true,
        by: by(20, "existence"),
      },
    ]);
  });

  it("with two required fields, the entity has a value only where both have one", () => {
    const two = { ...STATE, required: ["f2", "f3"] as FieldId[] };
    const items = [item(10, "f2", v("A"), iv("10-01")), item(20, "f3", v("x"), iv("11-01"))];
    expect(settle(two, items).rows).toEqual([
      { valid: { from: d("11-01"), to: null }, revoked: false, values: { f2: "A", f3: "x" } },
    ]);
  });

  it("a corroborating item gives no value", () => {
    const items = [
      item(10, "f2", v("A"), iv("10-01")),
      item(20, "f2", v("B"), iv("11-01"), { status: "corroborated" }),
    ];
    expect(settle(STATE, items).rows).toEqual([
      { valid: { from: d("10-01"), to: null }, revoked: false, values: { f2: "A", f3: null } },
    ]);
  });
});

describe("settle: an event table", () => {
  it("a revoke in effect: the row revoked, its values and field cells kept, an existence cell by the revoke", () => {
    // 04-write-and-read: a revoke changes only existence; the values stay on the row.
    const items = [item(10, "f2", v("A")), item(20, "existence", { kind: "revoke" })];
    expect(settle(EVENT, items)).toEqual({
      rows: [{ revoked: true, values: { f2: "A", f3: null } }],
      cells: [
        { field: "f2", value: "A", by: by(10) },
        { field: "f3", value: null, by: null },
        { field: "existence", value: null, revoked: true, by: by(20, "existence") },
      ],
    });
  });

  it("a revoke registered as reverted no longer counts; a later restore gives the existence cell", () => {
    const fieldsCells = [
      { field: "f2", value: "A", by: by(10) },
      { field: "f3", value: null, by: null },
    ];
    const registered = [
      item(10, "f2", v("A")),
      item(20, "existence", { kind: "revoke" }, [WHOLE], {
        reverted: [{ op: 30, valid: [WHOLE] }],
      }),
    ];
    expect(settle(EVENT, registered)).toEqual({
      rows: [{ revoked: false, values: { f2: "A", f3: null } }],
      cells: fieldsCells,
    });
    // The field cells are the same as before the revoke (not reopened); the restore, taking the
    // revoke back, is the existence cell.
    const restored = [
      item(10, "f2", v("A")),
      item(20, "existence", { kind: "revoke" }, [WHOLE], {
        reverted: [{ op: 30, valid: [WHOLE] }],
      }),
      item(31, "existence", { kind: "restore" }),
    ];
    expect(settle(EVENT, restored)).toEqual({
      rows: [{ revoked: false, values: { f2: "A", f3: null } }],
      cells: [...fieldsCells, { field: "existence", value: null, by: by(31, "existence") }],
    });
    // Revoked again after the restore (an undo of the undo writes back a revoke).
    const again = [
      ...restored.slice(0, 2),
      item(31, "existence", { kind: "restore" }, [WHOLE], {
        reverted: [{ op: 40, valid: [WHOLE] }],
      }),
      item(41, "existence", { kind: "revoke" }),
    ];
    expect(settle(EVENT, again).rows).toEqual([{ revoked: true, values: { f2: "A", f3: null } }]);
  });

  it("with two required fields, the row exists only with both given", () => {
    const two = { ...EVENT, required: ["f2", "f3"] as FieldId[] };
    expect(settle(two, [item(10, "f2", v("A"))]).rows).toEqual([]);
    expect(settle(two, [item(10, "f2", v("A")), item(10, "f3", v("x"))]).rows).toEqual([
      { revoked: false, values: { f2: "A", f3: "x" } },
    ]);
  });

  it("the row exists with every required field given and some field not empty", () => {
    expect(settle(EVENT, [item(10, "f3", v("x"))]).rows).toEqual([]);
    expect(settle(EVENT, [item(10, "f2", { kind: "value", value: null })]).rows).toEqual([]);
    expect(
      settle(EVENT, [item(10, "f2", { kind: "value", value: null }), item(10, "f3", v("x"))]).rows,
    ).toEqual([{ revoked: false, values: { f2: null, f3: "x" } }]);
  });
});

describe("registrations", () => {
  const undone = item(22, "f2", v("3000"), iv("11-02", "11-20"));
  const later = item(27, "f2", v("2000"), iv("11-08", "11-25"));
  const other = item(28, "f3", v("x"), iv("11-08", "11-25"));

  it("an entry's items on their interval ∩ this event's write-backs on the same target", () => {
    const writeBacks = [item(32, "f2", v("5000"), iv("11-02", "11-10"))];
    expect(registrations([undone], [{ event: 22, target: "f2" }], writeBacks)).toEqual([
      { item: by(22), valid: iv("11-02", "11-10") },
    ]);
  });

  it("T is the write-backs on the item's own target, not on every target", () => {
    const writeBacks = [
      item(32, "f2", v("5000"), iv("11-02", "11-10")),
      item(32, "f3", v("y"), iv("11-10", "11-20"), { k: 1 }),
    ];
    expect(registrations([undone], [{ event: 22, target: "f2" }], writeBacks)).toEqual([
      { item: by(22), valid: iv("11-02", "11-10") },
    ]);
  });

  it("an entry marked later that is a revoke supersedes the undone operation's field item", () => {
    // #27 revokes [11-08, 11-25) after #22; undone with #22, written back by a restore there.
    const revoke = item(27, "existence", { kind: "revoke" }, iv("11-08", "11-25"));
    const writeBacks = [
      item(32, "f2", { kind: "uncovered" }, iv("11-02", "11-20")),
      item(32, "existence", { kind: "restore" }, iv("11-08", "11-25")),
    ];
    const entries = [
      { event: 22, target: "f2" },
      { event: 27, target: "existence", later: true as const },
    ];
    expect(registrations([undone, revoke], entries, writeBacks)).toEqual([
      { item: by(22), valid: iv("11-02", "11-20") },
      // D(#27) = #22's interval, which the revoke supersedes.
      { item: by(27, "existence"), valid: iv("11-08", "11-20") },
    ]);
  });

  it("an entry marked later: only within what it supersedes of the undone operation's items", () => {
    const writeBacks = [
      item(32, "f2", v("5000"), iv("11-02", "11-30")),
      item(32, "f3", { kind: "no_value" }, iv("11-08", "11-25"), { k: 1 }),
    ];
    const entries = [
      { event: 22, target: "f2" },
      { event: 27, target: "f2", later: true as const },
      { event: 28, target: "f3", later: true as const },
    ];
    expect(registrations([undone, later, other], entries, writeBacks)).toEqual([
      { item: by(22), valid: iv("11-02", "11-20") },
      // D(#27) = #22's interval: [11-08, 11-25) ∩ [11-02, 11-20).
      { item: by(27), valid: iv("11-08", "11-20") },
      // #28 is on f3: it supersedes nothing of the undone operation, D is empty, no registration.
    ]);
  });

  it("supersession by kind: a revoke supersedes a field item; a no-value item fills no revoked stretch", () => {
    const revoke = item(22, "existence", { kind: "revoke" }, iv("11-01", "11-10"));
    const fill = item(27, "f2", v("B"), iv("11-02", "11-04"));
    const empty = item(28, "f2", { kind: "no_value" }, iv("11-05", "11-06"));
    const writeBacks = [
      item(32, "existence", { kind: "restore" }, iv("11-01", "11-10")),
      item(32, "f2", { kind: "uncovered" }, iv("11-01", "11-10"), { k: 1 }),
    ];
    const entries = [
      { event: 22, target: "existence" },
      { event: 27, target: "f2", later: true as const },
      { event: 28, target: "f2", later: true as const },
    ];
    expect(registrations([revoke, fill, empty], entries, writeBacks)).toEqual([
      { item: by(22, "existence"), valid: iv("11-01", "11-10") },
      { item: by(27), valid: iv("11-02", "11-04") },
    ]);
  });
});
