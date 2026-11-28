// Fixed cases for replay rules beyond the appendices: no-ops, deviation two for corroborations,
// and an `undo` whose target never took effect. Fictional data.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateLog } from "./evaluate.ts";
import type { Evaluation, Op, TableSchema, ToParam, WriteOp } from "./model.ts";
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
  // 04-write-and-read «撤回某次写入（undo）»: `undo_target` when no item of the target on this row
  // is applied: corroborations and no-ops changed no value.
  const base = put(10, 12, "5000", ["S0"], "10-01", "open");
  const later = (op: number): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    valid: { from: { mode: "given", value: d("11-03") }, to: { mode: "next_change" } },
    fields: { f2: { value: "2000", sources: ["S9"] } },
  });

  it("a corroboration-only write is rejected: it changed no value", () => {
    // 04-write-and-read «第 n 次写入是什么»: "A write that only corroborated the same value" →
    // `invalid_argument`.
    const corroborate = put(20, 21, "5000", ["S1"], "11-05", "11-20", { explicit: true });
    const ev = evaluate(STATE, [
      base,
      corroborate,
      { kind: "undo", op: 30, event: 31, target: 20 },
    ]);
    expect(ev.reverts).toEqual([{ op: 30, event: 31, status: "rejected", record: [] }]);
    // The corroboration still counts: its endpoint 11-05 stops a later default end.
    const after = evaluate(STATE, [
      base,
      corroborate,
      { kind: "undo", op: 30, event: 31, target: 20 },
      later(40),
    ]);
    expect(itemsOf(after, 41)).toEqual(['f2/0 applied [2026-11-03, 2026-11-05) "2000"']);
  });

  it("a write with a part applied is accepted; its corroborated part is registered too", () => {
    // f2 corroborated, f3 applied in one write: the undo lists both and registers both, so the
    // corroboration's endpoints stop counting (05-time «挡点»).
    const mixed: WriteOp = {
      ...put(20, 21, "5000", ["S1"], "11-05", "11-20", { explicit: true }),
      fields: {
        f2: { value: "5000", sources: ["S1"], explicit: true },
        f3: { value: "x", sources: ["S1"] },
      },
    };
    const ev = evaluate(STATE, [
      base,
      mixed,
      // Writing f3 back to nothing erases its change points (①): acknowledged with the current ver.
      { kind: "undo", op: 30, event: 31, target: 20, seen: 20, acknowledge: ["overwrite"] },
      later(40),
    ]);
    expect(ev.reverts).toEqual([
      {
        op: 30,
        event: 31,
        status: "applied",
        record: [
          { event: 21, target: "f2" },
          { event: 21, target: "f3" },
        ],
      },
    ]);
    expect(itemsOf(ev, 41)).toEqual(['f2/0 applied [2026-11-03, inf) "2000"']);
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

it("undoing the write that counts as the first creation is rejected: revoke instead", () => {
  // 04-write-and-read «第 n 次写入是什么»: the first creation cannot be undone. #21 gives only the
  // optional f3, so #31, the first write giving the required f2, is the first creation.
  const ops: Op[] = [
    { kind: "write", op: 20, event: 21, fields: { f3: { value: "1", sources: ["S1"] } } },
    { kind: "write", op: 30, event: 31, fields: { f2: { value: "9", sources: ["S2"] } } },
    { kind: "undo", op: 40, event: 41, target: 30 },
  ];
  const ev = evaluate(EVENT, ops);
  expect(ev.created).toBe(31);
  expect(ev.reverts).toEqual([{ op: 40, event: 41, status: "rejected", record: [] }]);
});

describe("an undo on a revoked row of an event table", () => {
  // 04-write-and-read «撤回某次写入（undo）»: an undo passes the checks on the current state; the
  // row still revoked once the undo is written is `revoked`. Undoing the revoke itself, or taking
  // it back with `include_later` (high impact ④), leaves the row existing.
  const ops: Op[] = [
    { kind: "write", op: 10, event: 11, fields: { f2: { value: "1", sources: ["S1"] } } },
    { kind: "write", op: 20, event: 21, fields: { f2: { value: "2", sources: ["S2"] } } },
    { kind: "revoke", op: 30, event: 31 },
  ];

  it("is rejected while the row stays revoked", () => {
    const ev = evaluate(EVENT, [...ops, { kind: "undo", op: 40, event: 41, target: 20 }]);
    expect(ev.reverts).toEqual([
      { op: 40, event: 41, status: "rejected", reason: "revoked", record: [] },
    ]);
    expect(itemsOf(ev, 41)).toEqual([]);
    expect(ev.exists).toBe(false);
  });

  it("keeps its reason in a replay (a deletion after it)", () => {
    const run = evaluateLog(EVENT, [
      ...ops,
      { kind: "undo", op: 40, event: 41, target: 20 },
      { kind: "deletion", op: 50, id: "pi_1", sources: ["S1"] },
    ]);
    expect(run.final.reverts).toEqual([
      { op: 40, event: 41, status: "rejected", reason: "revoked", record: [] },
    ]);
  });

  it("undoing the revoke is accepted", () => {
    const ev = evaluate(EVENT, [...ops, { kind: "undo", op: 40, event: 41, target: 30 }]);
    expect(ev.reverts[0]?.status).toBe("applied");
    expect(ev.exists).toBe(true);
  });

  it("taking the revoke back with include_later awaits confirmation (④)", () => {
    const ev = evaluate(EVENT, [
      ...ops,
      { kind: "undo", op: 40, event: 41, target: 20, includeLater: true },
    ]);
    expect(ev.reverts).toEqual([
      {
        op: 40,
        event: 41,
        status: "awaiting",
        record: [
          { event: 21, target: "f2" },
          { event: 31, target: "existence", later: true },
        ],
      },
    ]);
  });
});

describe("undoing a revert put into effect by a confirmation", () => {
  // 09 §5.7 «回退记录里列哪些条目»: when m is an awaiting revert put into effect by a confirmation,
  // the confirmation's base write and its revert record are taken, not the proposal's. By the
  // confirming operation the undo is an ordinary one (04-write-and-read «第 n 次写入是什么»).
  const ops: Op[] = [
    put(10, 11, "1", ["S1"], "10-01", "open"),
    put(20, 21, "2", ["S2"], "11-01", "11-05", { seen: 10, acknowledge: ["overwrite"] }),
    put(30, 31, "3", ["S3"], "11-03", "11-09", { seen: 20, acknowledge: ["overwrite"] }),
    { kind: "undo", op: 40, event: 41, target: 20, includeLater: true },
    { kind: "confirm", op: 50, event: 51, target: 41 },
  ];
  const undo = (target: number): Op => ({
    kind: "undo",
    op: 60,
    event: 61,
    target,
    seen: 50,
    acknowledge: ["overwrite"],
  });

  it("by the proposal's operation number", () => {
    const ev = evaluate(STATE, [...ops, undo(40)]);
    expect(ev.reverts.at(-1)).toEqual({
      op: 60,
      event: 61,
      status: "applied",
      record: [{ event: 51, target: "f2" }],
    });
    expect(short(timeline(ev, "f2"))).toEqual([
      '[10-01, 11-01) "1"',
      '[11-01, 11-03) "2"',
      '[11-03, 11-09) "3"',
      '[11-09, inf) "1"',
    ]);
  });

  it("by the confirming operation, the same", () => {
    const by = (target: number) => evaluate(STATE, [...ops, undo(target)]);
    expect(by(50).reverts.at(-1)).toEqual(by(40).reverts.at(-1));
    expect(timeline(by(50), "f2")).toEqual(timeline(by(40), "f2"));
  });
});

it("revoking a revoked row of an event table again is a no-op", () => {
  // 04-write-and-read «已撤销的行不可写»: "revoking again is a no-op". Undoing the first revoke
  // brings the row back.
  const ops: Op[] = [
    { kind: "write", op: 10, event: 11, fields: { f2: { value: "1", sources: ["S1"] } } },
    { kind: "revoke", op: 20, event: 21 },
    { kind: "revoke", op: 30, event: 31 },
  ];
  const ev = evaluate(EVENT, ops);
  expect(itemsOf(ev, 31)).toEqual([]);
  const back = evaluate(EVENT, [...ops, { kind: "undo", op: 40, event: 41, target: 20 }]);
  expect(back.exists).toBe(true);
});

it("take_candidate takes every candidate item of the taken write, not only the first", () => {
  // 09 §5.8 `candidates/<k>`: a candidate is every item of a write that became a candidate on the
  // unit; take_candidate takes all of them. #41 is cut into a candidate, a corroboration and a
  // candidate; taking it puts 1 on both candidate stretches.
  const ops: Op[] = [
    put(10, 11, "1", ["S1"], "10-01", "open"),
    put(20, 21, "2", ["S2"], "11-01", "11-03", { seen: 10, acknowledge: ["overwrite"] }),
    put(30, 31, "2", ["S3"], "11-07", "11-09", { seen: 20, acknowledge: ["overwrite"] }),
    put(40, 41, "1", ["S4"], "11-01", "11-09", { seen: 10, explicit: true }),
    {
      kind: "resolve",
      op: 50,
      event: 51,
      decision: "take_candidate",
      candidates: [41],
      take: 41,
      unit: "f2",
    },
  ];
  const ev = evaluate(STATE, ops);
  expect(itemsOf(ev, 41)).toEqual([
    'f2/0 candidate [2026-11-01, 2026-11-03) "1"',
    'f2/1 corroborated [2026-11-03, 2026-11-07) "1"',
    'f2/2 candidate [2026-11-07, 2026-11-09) "1"',
  ]);
  expect(short(timeline(ev, "f2"))).toEqual(['[10-01, inf) "1"']);
  // One item per stretch: an item has one interval (09 §5.7 `span/<f>/<k>`).
  expect(itemsOf(ev, 51)).toEqual([
    'f2/0 applied [2026-11-01, 2026-11-03) "1" carried #41/f2/0,#41/f2/2',
    'f2/1 applied [2026-11-07, 2026-11-09) "1" carried #41/f2/0,#41/f2/2',
  ]);
});

describe("take_candidate on an item whose unit is existence", () => {
  // 09-references-conflict-sync «撤销与并发修改»; 01-objects «各处理方式的执行语义».
  const take = (op: number, candidate: number): Op => ({
    kind: "resolve",
    op,
    event: op + 1,
    decision: "take_candidate",
    candidates: [candidate],
    take: candidate,
    unit: "existence",
  });
  const sp = (from: string, end: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: end === "open" ? { mode: "open" as const } : { mode: "given" as const, value: d(end) },
  });

  it("state table: a modification fills the gap, required fields carried from the merge base", () => {
    // #31 (ver 10) writes f3 over [11-03, 11-09) while #21 revoked [11-01, 11-07): a candidate on
    // existence. Taken: f3 = 2 on [11-03, 11-09); f2 carried from #11 where there is no value,
    // [11-03, 11-07); [11-01, 11-03) stays without a value. No existence item.
    const ops: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: sp("10-01", "open"),
        fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: sp("11-01", "11-07"),
        validSources: ["S2"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: sp("11-03", "11-09"),
        fields: { f3: { value: "2", sources: ["S3"] } },
      },
    ];
    expect(itemsOf(evaluate(STATE, ops), 31)).toEqual([
      'f3/0 candidate [2026-11-03, 2026-11-09) "2"',
    ]);
    const ev = evaluate(STATE, [...ops, take(40, 31)]);
    expect(itemsOf(ev, 41)).toEqual([
      'f2/0 applied [2026-11-03, 2026-11-07) "1" carried #11/f2/0',
      'f3/0 applied [2026-11-03, 2026-11-09) "2" carried #31/f3/0',
    ]);
    expect(short(ev.gaps.map((g) => `[${g.from}, ${g.to})`))).toEqual([
      "[null, 10-01)",
      "[11-01, 11-03)",
    ]);
  });

  it("state table: a required field the merge base does not give either is required_in_gap", () => {
    const ops: Op[] = [
      put(10, 11, "1", ["S1"], "11-05", "open"),
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: sp("11-05", "11-09"),
        validSources: ["S2"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: sp("11-01", "11-07"),
        fields: { f3: { value: "x", sources: ["S3"] } },
      },
    ];
    expect(itemsOf(evaluate(STATE, ops), 31)).toEqual([
      'f3/0 candidate [2026-11-01, 2026-11-07) "x"',
    ]);
    // Rejected when judged, the take is refused: it writes and closes nothing.
    const step = evaluateLog(STATE, [...ops, take(40, 31)]).steps.at(-1);
    expect({ refused: step?.refused, rejected: step?.rejected }).toEqual({
      refused: true,
      rejected: "required_in_gap",
    });
    expect(itemsOf(step?.state as Evaluation, 41)).toEqual([]);
    expect(step?.state.items.filter((x) => x.event === 31).map((x) => x.closed)).toEqual([
      undefined,
    ]);
  });

  it("event table: a modification restores the row; undoing the take revokes it again", () => {
    const ops: Op[] = [
      { kind: "write", op: 10, event: 11, fields: { f2: { value: "1", sources: ["S1"] } } },
      { kind: "revoke", op: 20, event: 21, seen: 10 },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        fields: { f2: { value: "2", sources: ["S3"] } },
      },
    ];
    expect(itemsOf(evaluate(EVENT, ops), 31)).toEqual(['f2/0 candidate [-inf, inf) "2"']);
    const ev = evaluate(EVENT, [...ops, take(40, 31)]);
    expect(itemsOf(ev, 41)).toEqual([
      "existence/0 applied [-inf, inf) restore",
      'f2/0 applied [-inf, inf) "2" carried #31/f2/0',
    ]);
    expect(ev.exists).toBe(true);
    const undone = evaluate(EVENT, [
      ...ops,
      take(40, 31),
      { kind: "undo", op: 50, event: 51, target: 40 },
    ]);
    expect(undone.reverts.at(-1)?.status).toBe("applied");
    expect(undone.exists).toBe(false);
  });

  it("a revoke taken takes effect", () => {
    const ops: Op[] = [
      { kind: "write", op: 10, event: 11, fields: { f2: { value: "1", sources: ["S1"] } } },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: "2", sources: ["S2"] } },
      },
      { kind: "revoke", op: 30, event: 31, seen: 10 },
    ];
    expect(itemsOf(evaluate(EVENT, ops), 31)).toEqual(["existence/0 candidate [-inf, inf) revoke"]);
    const ev = evaluate(EVENT, [...ops, take(40, 31)]);
    expect(itemsOf(ev, 41)).toEqual(["existence/0 applied [-inf, inf) revoke"]);
    expect(ev.exists).toBe(false);
  });
});

it("take_candidate on a field of a revoked event row is rejected (revoked)", () => {
  // 04-write-and-read «判定顺序» step 5: the candidate takes effect when taken, so the revoked row
  // check applies then, as to an ordinary write. Undoing the revoke afterwards restores the row.
  const ops: Op[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
    },
    { kind: "write", op: 20, event: 21, fields: { f2: { value: "2", sources: ["S2"] } } },
    { kind: "write", op: 30, event: 31, seen: 10, fields: { f2: { value: "3", sources: ["S3"] } } },
    { kind: "revoke", op: 35, event: 36, seen: 30 },
    {
      kind: "resolve",
      op: 40,
      event: 41,
      decision: "take_candidate",
      candidates: [31],
      take: 31,
      unit: "f2",
    },
  ];
  const step = evaluateLog(EVENT, ops).steps.at(-1);
  expect({ refused: step?.refused, rejected: step?.rejected }).toEqual({
    refused: true,
    rejected: "revoked",
  });
  expect(evaluate(EVENT, [...ops, { kind: "undo", op: 50, event: 51, target: 35 }]).exists).toBe(
    true,
  );
});

it("take_candidate on a field into a stretch without a value, without the required fields, is rejected", () => {
  // 05-time «无值区间»: the part taking effect where the entity has no value must give every
  // required field; the same write with the current ver would be refused.
  const ops: Op[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      valid: {
        from: { mode: "given", value: d("11-05") },
        to: { mode: "open" },
      },
      fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: {
        from: { mode: "given", value: d("11-05") },
        to: { mode: "given", value: d("11-09") },
      },
      fields: { f3: { value: "b", sources: ["S2"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 10,
      valid: {
        from: { mode: "given", value: d("11-01") },
        to: { mode: "given", value: d("11-07") },
      },
      fields: { f3: { value: "c", sources: ["S3"] } },
    },
    {
      kind: "resolve",
      op: 40,
      event: 41,
      decision: "take_candidate",
      candidates: [31],
      take: 31,
      unit: "f3",
    },
  ];
  const run = evaluateLog(STATE, ops);
  expect(itemsOf(run.final, 31)).toEqual(['f3/0 candidate [2026-11-01, 2026-11-07) "c"']);
  const step = run.steps.at(-1);
  expect({ refused: step?.refused, rejected: step?.rejected }).toEqual({
    refused: true,
    rejected: "missing_required",
  });
});

it("take_candidate on existence of a candidate cut in stretches: one item per stretch", () => {
  // #31 (ver 10, f3 = a with evidence) is the same as seen on [11-01, 11-09) but changed since on
  // [11-01, 11-03) (#21) and revoked on [11-07, 11-09) (#26): two candidate stretches on
  // existence around a corroboration. Taken, f3 is written on each stretch as its own item, and
  // f2 is carried where there is no value.
  const sp = (from: string, end: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: end === "open" ? { mode: "open" as const } : { mode: "given" as const, value: d(end) },
  });
  const ops: Op[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      valid: sp("10-01", "open"),
      fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: sp("11-01", "11-03"),
      fields: { f3: { value: "b", sources: ["S2"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "revoke",
      op: 25,
      event: 26,
      seen: 20,
      valid: sp("11-07", "11-09"),
      validSources: ["S3"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 10,
      valid: sp("11-01", "11-09"),
      fields: { f3: { value: "a", sources: ["S4"], explicit: true } },
    },
    {
      kind: "resolve",
      op: 40,
      event: 41,
      decision: "take_candidate",
      candidates: [31],
      take: 31,
      unit: "existence",
    },
  ];
  expect(itemsOf(evaluate(STATE, ops.slice(0, 4)), 31)).toEqual([
    'f3/0 candidate [2026-11-01, 2026-11-03) "a"',
    'f3/1 corroborated [2026-11-03, 2026-11-07) "a"',
    'f3/2 candidate [2026-11-07, 2026-11-09) "a"',
  ]);
  expect(itemsOf(evaluate(STATE, ops), 41)).toEqual([
    'f2/0 applied [2026-11-07, 2026-11-09) "1" carried #11/f2/0',
    'f3/0 applied [2026-11-01, 2026-11-03) "a" carried #31/f3/0,#31/f3/2',
    'f3/1 applied [2026-11-07, 2026-11-09) "a" carried #31/f3/0,#31/f3/2',
  ]);
});

describe("a decision closes a write's candidates in its own unit only", () => {
  // 01-objects «目标与合并»: a write that became a candidate in two units is two items, resolved
  // apart. #31, seeing #10, meets the take_previous #15 on both f2 and f3: an item each.
  const ops: Op[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
      acknowledge: ["overwrite"],
    },
    { kind: "revoke", op: 13, event: 14, seen: 2 },
    {
      kind: "resolve",
      op: 15,
      event: 16,
      decision: "take_previous",
      candidates: [14],
      unit: "existence",
    },
    { kind: "revoke", op: 20, event: 21, seen: 10 },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 10,
      fields: { f2: { value: "2", sources: ["S30"] }, f3: { value: "b", sources: ["S30"] } },
    },
    {
      kind: "resolve",
      op: 33,
      event: 34,
      decision: "take_candidate",
      candidates: [31],
      unit: "f2",
      take: 31,
    },
  ];
  const closedOf = (ops: readonly Op[]) =>
    evaluateLog(EVENT, ops)
      .final.items.filter((x) => x.event === 31 && x.status === "candidate")
      .map((x) => [x.target, x.closed === true]);

  it("taking #31 on f2's item leaves its candidate on f3 open", () => {
    expect(closedOf(ops)).toEqual([
      ["f2", true],
      ["f3", false],
    ]);
  });

  it("each unit's item resolved: both closed", () => {
    expect(
      closedOf([
        ...ops,
        {
          kind: "resolve",
          op: 36,
          event: 37,
          decision: "keep_effective",
          candidates: [31],
          unit: "f3",
        },
      ]),
    ).toEqual([
      ["f2", true],
      ["f3", true],
    ]);
  });
});
