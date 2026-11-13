// Fixed cases for replay rules beyond the appendices: no-ops, deviation two for corroborations,
// and an `undo` whose target never took effect. Fictional data.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.ts";
import type { Op, TableSchema, ToParam, WriteOp } from "./model.ts";
import { itemsOf, timeline } from "./views.ts";

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const EVENT: TableSchema = { kind: "event", required: ["f2"] };
const d = (md: string) => `2026-${md}` as BizPoint;
const short = (xs: string[]) => xs.map((s) => s.replaceAll("2026-", ""));

function put(
  op: number,
  event: number,
  value: string,
  sources: string[],
  from: string,
  end: string,
  opts: Partial<Omit<WriteOp, "kind" | "op" | "event" | "fields">> & { explicit?: boolean } = {},
): WriteOp {
  const { explicit, ...rest } = opts;
  const to: ToParam = end === "open" ? { mode: "open" } : { mode: "given", value: d(end) };
  return {
    kind: "write",
    op,
    event,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: { f2: { value, sources, ...(explicit ? { explicit } : {}) } },
    ...rest,
  };
}

describe("a field judged a no-op at write time stays a no-op", () => {
  // 03-deletion «删除结果的定义», deviation one; «重放规则», no-op row; «推论» «不漏删».
  it("event table: the same value resent without evidence does not survive its original", () => {
    const ops: Op[] = [
      { kind: "write", op: 21, event: 23, fields: { f2: { value: "X", sources: ["S1"] } } },
      { kind: "write", op: 25, event: 27, fields: { f2: { value: "X", sources: ["S2"] } } },
    ];
    expect(itemsOf(evaluate(EVENT, ops), 27)).toEqual([]);
    const ev = evaluate(EVENT, ops, ["S1"]);
    expect(itemsOf(ev, 27)).toEqual([]);
    expect(ev.exists).toBe(false);
  });

  it("state table: the same value restated without evidence does not survive its original", () => {
    const ops: Op[] = [
      put(10, 12, "5000", ["S1"], "10-01", "open"),
      put(20, 22, "5000", ["S2"], "11-01", "open"),
    ];
    const ev = evaluate(STATE, ops, ["S1"]);
    expect(itemsOf(ev, 22)).toEqual([]);
    expect(ev.exists).toBe(false);
  });
});

it("a corroboration counts as in effect: turned into a change by a deletion, it takes effect", () => {
  // 03-deletion «删除结果的定义», deviation two (corroborations included).
  const ops: Op[] = [
    put(10, 11, "5000", ["S0"], "09-01", "open"),
    put(12, 13, "6000", ["S2"], "10-15", "open"),
    put(14, 15, "4000", ["S3"], "10-01", "open", { acknowledge: ["overwrite"], seen: 12 }),
    put(16, 17, "4000", ["S4"], "10-01", "11-01", { explicit: true }),
  ];
  expect(short(itemsOf(evaluate(STATE, ops), 17))).toEqual([
    'f2/0 corroborated [10-01, 11-01) "4000"',
  ]);
  const ev = evaluate(STATE, ops, ["S3"]);
  expect(short(itemsOf(ev, 17))).toEqual(['f2/0 applied [10-01, 11-01) "4000"']);
  expect(short(timeline(ev, "f2"))).toEqual([
    '[09-01, 10-01) "5000"',
    '[10-01, 11-01) "4000"',
    '[11-01, inf) "6000"',
  ]);
});

describe("undo of a write that never took effect itself is rejected", () => {
  // 04-write-and-read «撤回某次写入（undo）»: `undo_target`; the confirming operation is undoable.
  const ops: Op[] = [
    put(10, 11, "5000", ["S0"], "10-01", "open"),
    put(12, 13, "4000", ["S1"], "11-10", "open"),
    put(14, 15, "3000", ["S2"], "11-02", "open"),
    { kind: "confirm", op: 16, event: 17, target: 15 },
  ];
  const undo = (target: number): Op => ({
    kind: "undo",
    op: 20,
    event: 21,
    target,
    seen: 16,
    acknowledge: ["overwrite"],
  });

  it("by the awaiting write's own operation number", () => {
    const ev = evaluate(STATE, [...ops, undo(14)]);
    expect(itemsOf(ev, 15)).toEqual(['f2/0 awaiting [2026-11-02, inf) "3000"']);
    expect(ev.reverts).toEqual([{ op: 20, event: 21, status: "rejected", record: [] }]);
    expect(itemsOf(ev, 21)).toEqual([]);
    expect(short(timeline(ev, "f2"))).toEqual(['[10-01, 11-02) "5000"', '[11-02, inf) "3000"']);
  });

  it("by the confirming operation", () => {
    const ev = evaluate(STATE, [...ops, undo(16)]);
    expect(ev.reverts[0]?.status).toBe("applied");
    expect(short(timeline(ev, "f2"))).toEqual(['[10-01, 11-10) "5000"', '[11-10, inf) "4000"']);
  });
});

it("an undo lists its target's targets as of its write; no-op fields are not targets", () => {
  // 03-deletion «回掉的权威定义» ①, 09 §5.7: the record lists the undone write's targets as of its
  // write (its write-time blocks), whatever their status then. A field the write left a no-op
  // has no item and is not a target. `skipped` (entries already superseded when the undo is
  // written, with `by_op`) is for history and receipts only and plays no part in coverage: the
  // reference evaluator does not produce it.
  const ev = evaluate(EVENT, [
    {
      kind: "write",
      op: 10,
      event: 11,
      fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "x", sources: ["S1"] } },
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      fields: { f2: { value: "2", sources: ["S2"] }, f3: { value: "x", sources: ["S2"] } },
    },
    { kind: "write", op: 25, event: 26, fields: { f2: { value: "3", sources: ["S3"] } } },
    { kind: "undo", op: 30, event: 31, target: 20 },
  ]);
  expect(ev.reverts).toEqual([
    { op: 30, event: 31, status: "applied", record: [{ event: 21, target: "f2" }] },
  ]);
});

describe("which undo targets are accepted", () => {
  // 04-write-and-read «撤回某次写入（undo）»: `undo_target` only when no item of the target on this
  // row ever took effect (in effect or corroborated).
  const base = put(10, 12, "5000", ["S0"], "10-01", "open");
  const later = (op: number): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    valid: { from: { mode: "given", value: d("11-03") }, to: { mode: "next_change" } },
    fields: { f2: { value: "2000", sources: ["S9"] } },
  });

  it("a corroboration-only write can be undone: its endpoints stop counting, values stay", () => {
    // 05-time «挡点»: a corroboration reverted by an undo no longer gives endpoints.
    const corroborate = put(20, 21, "5000", ["S1"], "11-05", "11-20", { explicit: true });
    const kept = evaluate(STATE, [base, corroborate, later(40)]);
    expect(itemsOf(kept, 41)).toEqual(['f2/0 applied [2026-11-03, 2026-11-05) "2000"']);
    const undone = evaluate(STATE, [
      base,
      corroborate,
      { kind: "undo", op: 30, event: 31, target: 20 },
    ]);
    expect(undone.reverts).toEqual([
      { op: 30, event: 31, status: "applied", record: [{ event: 21, target: "f2" }] },
    ]);
    expect(short(timeline(undone, "f2"))).toEqual(['[10-01, inf) "5000"']);
    const after = evaluate(STATE, [
      base,
      corroborate,
      { kind: "undo", op: 30, event: 31, target: 20 },
      later(40),
    ]);
    expect(itemsOf(after, 41)).toEqual(['f2/0 applied [2026-11-03, inf) "2000"']);
  });

  it("a write of nothing but no-ops is rejected", () => {
    const ev = evaluate(STATE, [
      base,
      put(20, 21, "5000", ["S1"], "11-05", "11-20"),
      { kind: "undo", op: 30, event: 31, target: 20 },
    ]);
    expect(itemsOf(ev, 21)).toEqual([]);
    expect(ev.reverts).toEqual([{ op: 30, event: 31, status: "rejected", record: [] }]);
  });

  it("a revert in effect with no write-back is rejected", () => {
    // Operation 30 undoes #22, which X has wholly covered: no write-back, `revert` only. Operation
    // 40 undoes operation 30, which changed nothing on this row: `undo_target`, like any target
    // with nothing in effect.
    const ev = evaluate(STATE, [
      base,
      put(20, 22, "3000", ["S22"], "11-02", "11-20"),
      put(23, 25, "3500", ["S_X"], "11-02", "11-20"),
      { kind: "undo", op: 30, event: 32, target: 20, seen: 23, acknowledge: ["overwrite"] },
      { kind: "undo", op: 40, event: 42, target: 30 },
    ]);
    expect(itemsOf(ev, 32)).toEqual([]);
    expect(ev.reverts).toEqual([
      { op: 30, event: 32, status: "applied", record: [{ event: 22, target: "f2" }] },
      { op: 40, event: 42, status: "rejected", record: [] },
    ]);
  });
});

it("an awaiting write whose conflict appears after a deletion becomes a candidate", () => {
  // 03-deletion «重放规则»: `ver` conflicts are recomputed for writes not in effect. Deleting S2
  // lets #41 take effect at its own operation (no longer high impact); #61, which saw only up to
  // operation 30, now conflicts with it. Its awaiting item is superseded by a conflict item, one
  // for one (03-deletion «推论» «删除不增加未决事项»).
  const span = (from: string, end: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: end === "open" ? { mode: "open" as const } : { mode: "given" as const, value: d(end) },
  });
  const ops: Op[] = [
    {
      kind: "write",
      op: 20,
      event: 21,
      valid: span("11-01", "11-03"),
      fields: { f2: { value: "1", sources: ["S2"] } },
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      valid: span("11-01", "11-03"),
      fields: { f3: { value: "1", sources: ["S4"] } },
    },
    {
      kind: "write",
      op: 40,
      event: 41,
      seen: 30,
      valid: span("11-01", "open"),
      fields: { f2: { value: "1", sources: ["S5"] } },
    },
    {
      kind: "write",
      op: 60,
      event: 61,
      seen: 30,
      valid: span("11-01", "open"),
      fields: { f2: { value: "3", sources: ["S6"] } },
    },
  ];
  const asWritten = evaluate(STATE, ops);
  expect(itemsOf(asWritten, 41)).toEqual(['f2/0 awaiting [2026-11-01, inf) "1"']);
  expect(itemsOf(asWritten, 61)).toEqual(['f2/0 awaiting [2026-11-01, inf) "3"']);
  const ev = evaluate(STATE, ops, ["S2"]);
  expect(itemsOf(ev, 41)).toEqual(['f2/0 applied [2026-11-01, inf) "1"']);
  expect(itemsOf(ev, 61)).toEqual(['f2/0 candidate [2026-11-01, inf) "3"']);
  expect(short(timeline(ev, "f2"))).toEqual(['[11-01, inf) "1"']);
});

it("a corroboration does not make the ver stale: acknowledge after it still counts", () => {
  // 05-time «用同样的值写»: a corroboration makes no version and does not change `ver`.
  const ops: Op[] = [
    put(10, 12, "5000", ["S1"], "10-01", "open"),
    put(20, 22, "4000", ["S2"], "11-10", "open", { seen: 10, acknowledge: ["overwrite"] }),
    put(30, 32, "4000", ["S3"], "11-12", "11-15", { seen: 20, explicit: true }),
    put(40, 42, "3000", ["S4"], "11-02", "open", { seen: 20, acknowledge: ["overwrite"] }),
  ];
  const ev = evaluate(STATE, ops);
  const statuses = (event: number) =>
    ev.items.filter((x) => x.event === event).map((x) => x.status);
  expect(statuses(32)).toEqual(["corroborated"]);
  expect(statuses(42)).toEqual(["applied"]);
});
