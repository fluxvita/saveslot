// Fixed cases of `judge`: the examples of docs/zh-CN/spec/03-data-model/05-time.md and
// 09-references-conflict-sync.md, and what the reference evaluator does not model (conflict
// groups, several ops in one request, `ver` taken from the read log).

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp, stateFromRecord, view } from "./judge.ts";
import type {
  JudgeInput,
  Judgement,
  RevokeInput,
  TableShape,
  ToParam,
  WriteInput,
} from "./model.ts";
import type { RowState } from "./state.ts";

const STATE: TableShape = {
  kind: "state",
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
};
const EVENT: TableShape = { ...STATE, kind: "event" };
/** One conflict group {a, b}: a is f4 (required), b is f5. */
const GROUPED: TableShape = {
  kind: "state",
  fields: ["f4", "f5"],
  valued: ["f4"],
  required: ["f4"],
  groups: [["f4", "f5"]],
};
const GROUPED_EVENT: TableShape = { ...GROUPED, kind: "event" };

const d = (md: string) => `2026-${md}` as BizPoint;

/** `to`: a day, "open", or "next" for the default end. */
function span(from: string, to: string): { from: { mode: "given"; value: BizPoint }; to: ToParam } {
  return {
    from: { mode: "given", value: d(from) },
    to:
      to === "open"
        ? { mode: "open" }
        : to === "next"
          ? { mode: "next_change" }
          : { mode: "given", value: d(to) },
  };
}

interface W {
  op: number;
  seen?: number;
  fields: Record<string, FieldValue>;
  valid?: WriteInput["valid"];
  explicit?: boolean;
  ack?: boolean;
  fallback?: boolean;
  index?: number;
  now?: string;
}

function write(w: W): WriteInput {
  const fields: Partial<Record<FieldId, { value: FieldValue; explicit?: boolean }>> = {};
  for (const [f, v] of Object.entries(w.fields)) {
    fields[f as FieldId] = { value: v, ...(w.explicit ? { explicit: true } : {}) };
  }
  return {
    kind: "write",
    op: w.op,
    index: w.index ?? 0,
    event: w.op + 1 + (w.index ?? 0),
    ruleset: 1,
    seen: w.seen ?? w.op - 1,
    seenExplicit: !w.fallback,
    ...(w.valid !== undefined ? { valid: w.valid } : {}),
    now: d(w.now ?? "11-05"),
    fields,
    ...(w.ack ? { acknowledge: true } : {}),
  };
}

function revoke(op: number, valid?: RevokeInput["valid"], seen = op - 1): RevokeInput {
  return {
    kind: "revoke",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    seen,
    seenExplicit: true,
    ...(valid !== undefined ? { valid } : {}),
    now: d("11-05"),
  };
}

function run(
  table: TableShape,
  inputs: readonly JudgeInput[],
): { state: RowState; js: Judgement[] } {
  let state = emptyState(table);
  const js: Judgement[] = [];
  for (const i of inputs) {
    const r = judgeOp(state, i);
    js.push(r.judgement);
    state = r.state;
  }
  return { state, js };
}

const last = (js: readonly Judgement[]) => js[js.length - 1] as Judgement;

function items(j: Judgement) {
  if (j.record.kind === "reject" || j.record.kind === "keep_effective") return [];
  return j.record.items.map((x) => ({
    target: x.target,
    k: x.k,
    status: x.status,
    valid: x.valid,
    ...(x.content.kind === "value" ? { value: x.content.value } : { revoke: true }),
  }));
}

const iv = (from: string | null, to: string | null = null) => [
  { from: from === null ? null : d(from), to: to === null ? null : d(to) },
];

/** The values of a field after the operations, as [from, to, value]: equal neighbours joined. */
function stretches(state: RowState, f: FieldId) {
  const out: [BizPoint | null, BizPoint | null, FieldValue][] = [];
  for (const s of view(state).fields[f] ?? []) {
    const from = s.valid[0]?.from ?? null;
    const to = s.valid[s.valid.length - 1]?.to ?? null;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev[1] === from && prev[2] === s.value) prev[1] = to;
    else out.push([from, to, s.value]);
  }
  return out;
}

// 05-time «写状态» example: 10-01 起 5000 (#10), 11-10 起 4000 (#20).
const BUDGET = [
  write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } }),
  write({ op: 20, valid: span("11-10", "open"), fields: { f2: "4000" }, ack: true }),
];

describe("05-time «写状态：参数与默认»", () => {
  it("a default end stops at the next blocking point; deps are its givers", () => {
    const { js } = run(STATE, [
      ...BUDGET,
      write({ op: 30, valid: span("11-02", "next"), fields: { f2: "3000" } }),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      { target: "f2", k: 0, status: "applied", valid: iv("11-02", "11-10"), value: "3000" },
    ]);
    if (j.record.kind !== "write") throw new Error();
    expect(j.record.items[0]?.deps).toEqual([{ event: 21, target: "f2", k: 0 }]);
    expect(j.erased).toEqual([]);
  });

  it("an open end over a change point is high impact: awaiting, overwritten stretches listed", () => {
    const { state, js } = run(STATE, [
      ...BUDGET,
      write({ op: 30, valid: span("11-02", "open"), fields: { f2: "3000" } }),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      { target: "f2", k: 0, status: "awaiting", valid: iv("11-02"), value: "3000" },
    ]);
    expect(j.erased).toEqual([{ field: "f2", at: [d("11-10")] }]);
    expect(
      j.overwritten.map((o) => [o.valid, o.was.kind === "value" ? o.was.value : o.was.kind]),
    ).toEqual([
      [iv("11-02", "11-10"), "5000"],
      [iv("11-10"), "4000"],
    ]);
    // An overwritten stretch's deps: who gave the value and who gave its ends.
    expect(j.overwritten[1]?.deps).toEqual([{ event: 21, target: "f2", k: 0 }]);
    expect(stretches(state, "f2")).toEqual([
      [d("10-01"), d("11-10"), "5000"],
      [d("11-10"), null, "4000"],
    ]);
  });

  it("an explicit end over a change point is high impact; a stretch between them is not", () => {
    const over = run(STATE, [
      ...BUDGET,
      write({ op: 30, valid: span("11-02", "11-20"), fields: { f2: "3000" } }),
    ]);
    expect(items(last(over.js))[0]?.status).toBe("awaiting");
    const inside = run(STATE, [
      ...BUDGET,
      write({ op: 30, valid: span("11-02", "11-05"), fields: { f2: "3000" } }),
    ]);
    expect(items(last(inside.js))[0]?.status).toBe("applied");
  });

  it("corrected_span takes the stretch around now between blocking points", () => {
    const { js } = run(STATE, [
      ...BUDGET,
      write({ op: 30, valid: "corrected_span", fields: { f2: "6000" } }),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      { target: "f2", k: 0, status: "applied", valid: iv("10-01", "11-10"), value: "6000" },
    ]);
    if (j.record.kind !== "write") throw new Error();
    expect(j.record.items[0]?.deps).toEqual([
      { event: 11, target: "f2", k: 0 },
      { event: 21, target: "f2", k: 0 },
    ]);
  });

  it("corrected_span where the field has no value now is invalid_argument", () => {
    const { state } = run(STATE, BUDGET);
    expect(() =>
      judgeOp(
        state,
        write({ op: 30, valid: "corrected_span", now: "09-01", fields: { f2: "6000" } }),
      ),
    ).toThrow(expect.objectContaining({ reason: "invalid_argument" }));
  });

  it("each field of a default-end write stops at its own next blocking point", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000", f3: "zhang" } }),
      write({ op: 20, valid: span("11-10", "open"), fields: { f3: "li" }, ack: true }),
      write({ op: 30, valid: span("11-20", "open"), fields: { f2: "4000" }, ack: true }),
      write({ op: 40, valid: span("11-02", "next"), fields: { f2: "3000", f3: "wang" } }),
    ]);
    expect(items(last(js)).map((x) => [x.target, x.valid])).toEqual([
      ["f2", iv("11-02", "11-20")],
      ["f3", iv("11-02", "11-10")],
    ]);
  });
});

describe("05-time «无值区间»", () => {
  // [10-01, 10-10) 5000, no value, [10-20, ∞) 4000; f2 required.
  const GAPPED = [
    write({ op: 10, seen: 0, valid: span("10-01", "10-10"), fields: { f2: "5000" } }),
    write({ op: 20, valid: span("10-20", "open"), fields: { f2: "4000" }, ack: true }),
  ];

  it("a default end does not enter the gap", () => {
    const { js } = run(STATE, [
      ...GAPPED,
      write({ op: 30, valid: span("10-05", "next"), fields: { f2: "3000" } }),
    ]);
    expect(items(last(js))[0]?.valid).toEqual(iv("10-05", "10-10"));
  });

  it("an explicit interval across the gap is high impact", () => {
    const { js } = run(STATE, [
      ...GAPPED,
      write({ op: 30, valid: span("10-05", "10-25"), fields: { f2: "3000" } }),
    ]);
    const j = last(js);
    expect(items(j)[0]?.status).toBe("awaiting");
    expect(j.erased).toEqual([{ field: "f2", at: [d("10-10"), d("10-20")] }]);
    expect(j.overwritten.map((o) => [o.valid, o.was.kind])).toEqual([
      [iv("10-05", "10-10"), "value"],
      [iv("10-10", "10-20"), "no_value"],
      [iv("10-20", "10-25"), "value"],
    ]);
  });

  it("a boundary counts on the required fields only: filling exactly the gap is not high impact", () => {
    const { js } = run(STATE, [
      ...GAPPED,
      write({ op: 30, valid: span("10-10", "10-20"), fields: { f2: "3000" } }),
    ]);
    expect(items(last(js))[0]?.status).toBe("applied");
  });

  it("a new entity written in two stretches: an optional field's boundary does not count", () => {
    const two = (v: string) =>
      run(STATE, [
        write({ op: 10, seen: 0, valid: span("10-01", "11-01"), fields: { f2: "5000", f3: "x" } }),
        write({ op: 20, valid: span("11-01", "open"), fields: { f2: v, f3: "x" } }),
      ]);
    expect(items(last(two("4000").js)).map((x) => x.status)).toEqual(["applied", "applied"]);
    // The required field the same on both sides: the boundary is gone, still high impact.
    expect(last(two("5000").js).erased).toEqual([{ field: "f2", at: [d("11-01")] }]);
  });

  it("writing into the gap without the required fields is validation_failed", () => {
    const { state } = run(STATE, GAPPED);
    expect(() =>
      judgeOp(state, write({ op: 30, valid: span("10-12", "10-15"), fields: { f3: "x" } })),
    ).toThrow(expect.objectContaining({ reason: "validation_failed" }));
  });
});

describe("05-time «用同样的值写»", () => {
  it("same value without evidence is a no-op; with evidence a corroboration", () => {
    const base = [write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } })];
    const noop = run(STATE, [
      ...base,
      write({ op: 20, valid: span("11-20", "open"), fields: { f2: "5000" } }),
    ]);
    expect(last(noop.js).record).toMatchObject({ items: [], noop: ["f2"] });
    const cor = run(STATE, [
      ...base,
      write({ op: 20, valid: span("11-20", "open"), fields: { f2: "5000" }, explicit: true }),
    ]);
    expect(items(last(cor.js))).toEqual([
      { target: "f2", k: 0, status: "corroborated", valid: iv("11-20"), value: "5000" },
    ]);
  });

  it("a stale corroboration splits: the same part corroborates, the changed part is judged", () => {
    // 05-time example «一个字段两项».
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } }),
      write({ op: 20, seen: 10, valid: span("11-02", "11-10"), fields: { f2: "3000" }, ack: true }),
      write({
        op: 30,
        seen: 10,
        valid: span("11-05", "11-20"),
        fields: { f2: "5000" },
        explicit: true,
      }),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      { target: "f2", k: 0, status: "candidate", valid: iv("11-05", "11-10"), value: "5000" },
      { target: "f2", k: 1, status: "corroborated", valid: iv("11-10", "11-20"), value: "5000" },
    ]);
    if (j.record.kind !== "write") throw new Error();
    // The write after the seen version cut it into items.
    expect(j.record.items[0]?.deps).toEqual([{ event: 21, target: "f2", k: 0 }]);
  });

  it("covering a corroboration with another value warns overwrote_corroborated", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } }),
      write({ op: 20, valid: span("11-05", "11-10"), fields: { f2: "5000" }, explicit: true }),
      write({ op: 30, valid: span("11-06", "11-08"), fields: { f2: "3000" } }),
    ]);
    const j = last(js);
    expect(items(j)[0]?.status).toBe("applied");
    expect(j.warnings).toEqual([
      {
        field: "f2",
        valid: iv("11-06", "11-08"),
        corroboration: { event: 21, target: "f2", k: 0 },
      },
    ]);
  });
});

describe("05-time «高影响写入»: arrival order does not matter", () => {
  const base = write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } });
  const both = (a: (op: number) => WriteInput, b: (op: number) => WriteInput) => [
    run(STATE, [base, a(20), b(30)]),
    run(STATE, [base, b(20), a(30)]),
  ];

  it("two default-end writes from different days merge either way, nothing awaits", () => {
    const rs = both(
      (op) => write({ op, seen: 10, valid: span("11-10", "next"), fields: { f2: "3000" } }),
      (op) => write({ op, seen: 10, valid: span("11-02", "next"), fields: { f2: "3000" } }),
    );
    for (const r of rs) {
      expect(r.js.flatMap(items).map((x) => x.status)).not.toContain("awaiting");
      expect(stretches(r.state, "f2")).toEqual([
        [d("10-01"), d("11-02"), "5000"],
        [d("11-02"), null, "3000"],
      ]);
    }
  });

  it("overlapping explicit writes of the same value merge either way", () => {
    const rs = both(
      (op) => write({ op, seen: 10, valid: span("11-01", "11-20"), fields: { f2: "3000" } }),
      (op) => write({ op, seen: 10, valid: span("11-10", "12-01"), fields: { f2: "3000" } }),
    );
    for (const r of rs) {
      expect(r.js.flatMap(items).map((x) => x.status)).not.toContain("awaiting");
      expect(stretches(r.state, "f2")).toEqual([
        [d("10-01"), d("11-01"), "5000"],
        [d("11-01"), d("12-01"), "3000"],
        [d("12-01"), null, "5000"],
      ]);
    }
  });
});

describe("09-references-conflict-sync «冲突判据» (state table example)", () => {
  const base = write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } });
  const orders = (a: (op: number) => WriteInput, b: (op: number) => WriteInput) => [
    run(STATE, [base, a(20), b(30)]),
    run(STATE, [base, b(20), a(30)]),
  ];

  it("default ends from different days merge", () => {
    for (const r of orders(
      (op) => write({ op, seen: 10, valid: span("11-10", "next"), fields: { f2: "3000" } }),
      (op) => write({ op, seen: 10, valid: span("11-02", "next"), fields: { f2: "4000" } }),
    )) {
      expect(r.js.flatMap((j) => j.conflicts)).toEqual([]);
      expect(stretches(r.state, "f2")).toEqual([
        [d("10-01"), d("11-02"), "5000"],
        [d("11-02"), d("11-10"), "4000"],
        [d("11-10"), null, "3000"],
      ]);
    }
  });

  it("a default end against an explicit interval over it conflicts either way", () => {
    for (const r of orders(
      (op) => write({ op, seen: 10, valid: span("11-10", "next"), fields: { f2: "3000" } }),
      (op) =>
        write({ op, seen: 10, valid: span("11-02", "open"), fields: { f2: "4000" }, ack: true }),
    )) {
      const j = last(r.js);
      expect(items(j)[0]?.status).toBe("candidate");
      expect(j.conflicts).toEqual([
        { unit: { fields: ["f2"] }, with: [20], items: [{ event: 31, target: "f2", k: 0 }] },
      ]);
    }
  });

  it("disjoint intervals merge", () => {
    for (const r of orders(
      (op) => write({ op, seen: 10, valid: span("12-01", "12-31"), fields: { f2: "3000" } }),
      (op) => write({ op, seen: 10, valid: span("11-20", "12-01"), fields: { f2: "4000" } }),
    )) {
      expect(r.js.flatMap((j) => j.conflicts)).toEqual([]);
    }
  });

  it("the ops of the same request are not concurrent writes", () => {
    const { js } = run(STATE, [
      base,
      write({ op: 20, seen: 10, valid: span("11-01", "11-10"), fields: { f2: "3000" } }),
      write({ op: 20, index: 1, seen: 10, valid: span("11-05", "11-08"), fields: { f2: "4000" } }),
    ]);
    expect(items(last(js))[0]?.status).toBe("applied");
  });
});

describe("conflict groups: the group value", () => {
  // #10 [10-01, ∞) a=1, b=1. W and L both saw #10.
  const base = write({
    op: 10,
    seen: 0,
    valid: span("10-01", "open"),
    fields: { f4: "1", f5: "1" },
  });
  const conflicted = (
    table: TableShape,
    x: (op: number) => WriteInput,
    y: (op: number) => WriteInput,
  ) =>
    [run(table, [base, x(20), y(30)]), run(table, [base, y(20), x(30)])].map(
      (r) => last(r.js).conflicts.length > 0,
    );
  const at =
    (fields: Record<string, string>, valid = span("11-01", "11-10")) =>
    (op: number) =>
      write({ op, seen: 10, valid, fields });

  it("W(a), L(b): conflict both ways", () => {
    expect(conflicted(GROUPED, at({ f4: "2" }), at({ f5: "2" }))).toEqual([true, true]);
    expect(conflicted(GROUPED_EVENT, at({ f4: "2" }), at({ f5: "2" }))).toEqual([true, true]);
  });

  it("W(a=x), L(a=x, b=y): conflict both ways", () => {
    expect(conflicted(GROUPED, at({ f4: "2" }), at({ f4: "2", f5: "2" }))).toEqual([true, true]);
  });

  it("W(a=x), L(a=x): no conflict either way", () => {
    expect(conflicted(GROUPED, at({ f4: "2" }), at({ f4: "2" }))).toEqual([false, false]);
  });

  it("default end against default end from the same day, W(a) and L(b): conflict both ways", () => {
    const next = span("11-01", "next");
    expect(conflicted(GROUPED, at({ f4: "2" }, next), at({ f5: "2" }, next))).toEqual([true, true]);
  });

  it("L1 writes (a=x, b=y), L2 changes b back, then W writes a=x: no conflict (by value)", () => {
    // Read by history ("L changed a field W did not write") it would conflict.
    const { js } = run(GROUPED, [
      base,
      write({ op: 20, seen: 10, valid: span("11-01", "11-10"), fields: { f4: "2", f5: "2" } }),
      write({ op: 30, seen: 20, valid: span("11-01", "11-10"), fields: { f5: "1" }, ack: true }),
      write({ op: 40, seen: 10, valid: span("11-01", "11-10"), fields: { f4: "2" } }),
    ]);
    expect(last(js).conflicts).toEqual([]);
    expect(items(last(js))[0]?.status).toBe("applied");
  });

  it("a field W does not write, in two stretches in V: a conflict only where they differ", () => {
    // V: #10 a=1 b=1; #15 b=2 from 11-05. L writes a=2, b=2 on [11-01, 11-10); W writes a=2.
    const v = [
      base,
      write({ op: 15, seen: 10, valid: span("11-05", "open"), fields: { f5: "2" }, ack: true }),
    ];
    const l = (op: number) =>
      write({
        op,
        seen: 15,
        valid: span("11-01", "11-10"),
        fields: { f4: "2", f5: "2" },
        ack: true,
      });
    const w = (valid: WriteInput["valid"]) => (op: number) =>
      write({ op, seen: 15, valid, fields: { f4: "2" } });
    const verdicts = (valid: WriteInput["valid"]) =>
      [run(GROUPED, [...v, l(20), w(valid)(30)]), run(GROUPED, [...v, w(valid)(20), l(30)])].map(
        (r) => last(r.js).conflicts.length > 0,
      );
    expect(verdicts(span("11-06", "11-09"))).toEqual([false, false]);
    expect(verdicts(span("11-02", "11-04"))).toEqual([true, true]);
  });
});

describe("several ops in one request", () => {
  it("a new entity written in two stretches; a later op protects the change point they made", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "11-01"), fields: { f2: "5000" } }),
      write({ op: 10, index: 1, seen: 0, valid: span("11-01", "open"), fields: { f2: "4000" } }),
      write({ op: 10, index: 2, seen: 0, valid: span("10-15", "11-15"), fields: { f2: "4500" } }),
    ]);
    expect(js.map((j) => items(j)[0]?.status)).toEqual(["applied", "applied", "awaiting"]);
    expect(last(js).erased).toEqual([{ field: "f2", at: [d("11-01")] }]);
  });
});

describe("acknowledge", () => {
  const hi = (o: Partial<W>) => [
    ...BUDGET,
    write({ op: 30, valid: span("11-02", "open"), fields: { f2: "3000" }, ack: true, ...o }),
  ];

  it("takes effect with the current ver given explicitly; the overwritten stretches are kept", () => {
    const j = last(run(STATE, hi({})).js);
    expect(items(j)[0]?.status).toBe("applied");
    expect(j.acknowledged).toBe(true);
    expect(j.overwritten).toHaveLength(2);
  });

  it("does not count with a ver from the read log, or a ver that is not current", () => {
    expect(items(last(run(STATE, hi({ fallback: true })).js))[0]?.status).toBe("awaiting");
    expect(items(last(run(STATE, hi({ seen: 10 })).js))[0]?.status).not.toBe("applied");
  });
});

describe("revokes", () => {
  it("a revoke with only a start stops at the next blocking point of any field", () => {
    const { js } = run(STATE, [
      ...BUDGET,
      revoke(30, { from: { mode: "given", value: d("11-02") }, to: { mode: "next_change" } }),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      { target: "existence", k: 0, status: "applied", valid: iv("11-02", "11-10"), revoke: true },
    ]);
    if (j.record.kind !== "revoke") throw new Error();
    expect(j.record.items[0]?.deps).toEqual([{ event: 21, target: "f2", k: 0 }]);
  });

  it("a stale revoke meeting a change becomes a candidate", () => {
    const { js } = run(STATE, [
      ...BUDGET,
      revoke(30, span("11-12", "11-15") as RevokeInput["valid"], 10),
    ]);
    expect(items(last(js))[0]?.status).toBe("candidate");
    expect(last(js).conflicts[0]?.unit).toBe("existence");
  });

  it("event tables: a revoked row cannot be written; revoking it again is a no-op", () => {
    const { state } = run(EVENT, [write({ op: 10, seen: 0, fields: { f2: "1" } }), revoke(20)]);
    expect(() => judgeOp(state, write({ op: 30, fields: { f2: "2" } }))).toThrow(
      expect.objectContaining({ reason: "revoked" }),
    );
    expect(judgeOp(state, revoke(30)).judgement.record).toMatchObject({ items: [] });
  });
});

describe("decisions", () => {
  const awaiting = [
    ...BUDGET,
    write({ op: 30, valid: span("11-02", "open"), fields: { f2: "3000" } }),
  ];
  const decide = (kind: "confirm" | "reject", target = 31): JudgeInput => ({
    kind,
    op: 40,
    index: 0,
    event: 41,
    ruleset: 1,
    target,
  });

  it("confirm executes the proposal as recorded, carried from the awaiting item", () => {
    const { state, js } = run(STATE, [...awaiting, decide("confirm")]);
    const r = last(js).record;
    expect(r).toMatchObject({
      kind: "confirm",
      items: [
        { target: "f2", k: 0, status: "applied", carried: [{ event: 31, target: "f2", k: 0 }] },
      ],
    });
    expect(stretches(state, "f2")).toEqual([
      [d("10-01"), d("11-02"), "5000"],
      [d("11-02"), null, "3000"],
    ]);
  });

  it("reject leaves the values; resolving twice, or a write not awaiting, is invalid", () => {
    const { state } = run(STATE, [...awaiting, decide("reject")]);
    expect(stretches(state, "f2")).toHaveLength(2);
    expect(() => judgeOp(state, { ...decide("confirm"), op: 50, event: 51 })).toThrow(JudgeError);
    expect(() => judgeOp(state, { ...decide("confirm", 21), op: 50, event: 51 })).toThrow(
      JudgeError,
    );
  });

  it("keep_effective closes the candidates of the item", () => {
    const { state } = run(STATE, [
      ...BUDGET,
      write({ op: 30, seen: 10, valid: span("11-12", "11-15"), fields: { f2: "3000" } }),
    ]);
    const keep: JudgeInput = {
      kind: "keep_effective",
      op: 40,
      index: 0,
      event: 41,
      ruleset: 1,
      unit: { fields: ["f2"] },
      candidates: [31],
    };
    const after = judgeOp(state, keep).state;
    expect(after.closedCandidate(31, "f2")).toBe(true);
    expect(() => judgeOp(after, { ...keep, op: 50, event: 51 })).toThrow(JudgeError);
  });
});

describe("first creation and versions", () => {
  it("the first write giving every required field is the first creation", () => {
    const { state, js } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f3: "x" } }),
      write({ op: 20, fields: { f2: "1" } }),
      write({ op: 30, fields: { f2: "2" } }),
    ]);
    expect(js.map((j) => j.created)).toEqual([false, true, false]);
    expect(view(state).created).toBe(21);
  });

  it("an unknown ruleset version is refused, in the input and in the records", () => {
    const state = emptyState(STATE);
    expect(() =>
      judgeOp(state, { ...write({ op: 10, seen: 0, fields: { f2: "1" } }), ruleset: 2 }),
    ).toThrow(expect.objectContaining({ reason: "unknown_version" }));
    const { state: s } = run(STATE, BUDGET);
    const records = s.records.map((r) => ({ ...r, ruleset: 2 }));
    expect(() => stateFromRecord(STATE, records)).toThrow(
      expect.objectContaining({ reason: "unknown_version" }),
    );
  });
});

describe("review cases", () => {
  it("a corroboration does not make the ver stale: acknowledge after it still counts", () => {
    const { js } = run(STATE, [
      ...BUDGET,
      write({
        op: 30,
        seen: 20,
        valid: span("11-12", "11-15"),
        fields: { f2: "4000" },
        explicit: true,
      }),
      write({ op: 40, seen: 20, valid: span("11-02", "open"), fields: { f2: "3000" }, ack: true }),
    ]);
    expect(items(js[2] as Judgement)[0]?.status).toBe("corroborated");
    const j = last(js);
    expect(j.acknowledged).toBe(true);
    expect(items(j)[0]?.status).toBe("applied");
  });

  it("a conflict anywhere in a group makes every part of the write there a candidate", () => {
    const { js } = run(GROUPED, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f4: "1", f5: "1" } }),
      write({ op: 20, valid: span("11-03", "open"), fields: { f4: "2" }, ack: true }),
      write({ op: 30, valid: span("11-07", "11-09"), fields: { f5: "3" } }),
      write({ op: 40, seen: 20, valid: span("11-01", "next"), fields: { f4: "5", f5: "5" } }),
    ]);
    const j = last(js);
    expect(items(j).map((x) => [x.target, x.status])).toEqual([
      ["f4", "candidate"],
      ["f5", "candidate"],
    ]);
    expect(j.conflicts).toEqual([
      {
        unit: { fields: ["f4", "f5"] },
        with: [30],
        items: [
          { event: 41, target: "f4", k: 0 },
          { event: 41, target: "f5", k: 0 },
        ],
      },
    ]);
  });

  it("a stale write meeting a revoke in between: a candidate on existence", () => {
    const st = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      revoke(20, span("11-01", "11-10") as RevokeInput["valid"], 10),
      write({ op: 30, seen: 10, valid: span("11-03", "11-05"), fields: { f2: "2" } }),
    ]);
    expect(items(last(st.js))[0]?.status).toBe("candidate");
    expect(last(st.js).conflicts[0]?.unit).toBe("existence");
    // Event tables: a candidate too, not `revoked` (the revoked-row check is on the part taking effect).
    const ev = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      revoke(20, undefined, 10),
      write({ op: 30, seen: 10, fields: { f2: "2" } }),
    ]);
    expect(items(last(ev.js))[0]?.status).toBe("candidate");
    expect(last(ev.js).conflicts[0]?.unit).toBe("existence");
  });

  it("a default end at a value ↔ no value boundary: the required field's item is among the deps", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "10-10"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("10-05", "next"), fields: { f3: "x" } }),
    ]);
    const j = last(js);
    if (j.record.kind !== "write") throw new Error();
    expect(j.record.items[0]?.valid).toEqual(iv("10-05", "10-10"));
    expect(j.record.items[0]?.deps).toEqual([{ event: 11, target: "f2", k: 0 }]);
  });

  it("the record keeps acknowledge, the explicit fields, whether ver was explicit and the ack stretches", () => {
    const { js } = run(STATE, [
      ...BUDGET,
      write({
        op: 30,
        valid: span("11-02", "open"),
        fields: { f2: "3000" },
        ack: true,
        explicit: true,
      }),
    ]);
    const j = last(js);
    expect(j.record).toMatchObject({
      kind: "write",
      acknowledge: true,
      explicit: ["f2"],
      seenExplicit: true,
    });
    if (j.record.kind !== "write") throw new Error();
    expect(j.record.ack).toEqual(j.overwritten);
    expect(j.record.ack.map((o) => o.valid)).toEqual([iv("11-02", "11-10"), iv("11-10")]);
    // Not acknowledged: no ack stretches in the record.
    const fb = last(
      run(STATE, [
        ...BUDGET,
        write({
          op: 30,
          valid: span("11-02", "open"),
          fields: { f2: "3000" },
          ack: true,
          fallback: true,
        }),
      ]).js,
    );
    expect(fb.record).toMatchObject({ seenExplicit: false, ack: [] });
  });

  it("an interval whose end is not after its start is validation_failed", () => {
    const { state } = run(STATE, BUDGET);
    expect(() =>
      judgeOp(state, write({ op: 30, valid: span("11-05", "11-05"), fields: { f2: "1" } })),
    ).toThrow(expect.objectContaining({ reason: "validation_failed" }));
    expect(() =>
      judgeOp(state, revoke(30, span("11-05", "11-03") as RevokeInput["valid"])),
    ).toThrow(expect.objectContaining({ reason: "validation_failed" }));
  });
});

it("a confirmed default-end write counts as a default-end write for later conflicts", () => {
  // #20 [11-01, 11-05) 9; #30 from 11-03 to the next change, 3: awaiting (erases 11-05), confirmed
  // by #35. #40 saw #30 and writes 1 from 11-01 to the next change: against #35, two default ends
  // from different days, so no conflict (09-references-conflict-sync «冲突判据»).
  const { state, js } = run(STATE, [
    write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "3" } }),
    write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "9" } }),
    write({ op: 30, valid: span("11-03", "next"), fields: { f2: "3" } }),
    { kind: "confirm", op: 35, index: 0, event: 36, ruleset: 1, target: 31 },
    write({ op: 40, seen: 30, valid: span("11-01", "next"), fields: { f2: "1" }, ack: true }),
  ]);
  expect(items(js[2] as Judgement)[0]?.status).toBe("awaiting");
  expect(last(js).conflicts).toEqual([]);
  expect(stretches(state, "f2")).toEqual([
    [d("10-01"), d("11-01"), "3"],
    [d("11-01"), d("11-03"), "1"],
    [d("11-03"), null, "3"],
  ]);
});

it("a stale write meeting both a revoke and a field change in between: one candidate, on existence", () => {
  const { js } = run(STATE, [
    write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
    revoke(20, span("11-01", "11-03") as RevokeInput["valid"], 10),
    write({ op: 30, seen: 10, valid: span("11-05", "11-08"), fields: { f2: "5" } }),
    write({ op: 40, seen: 10, valid: span("11-02", "11-07"), fields: { f2: "2" } }),
  ]);
  const j = last(js);
  expect(items(j).map((x) => x.status)).toEqual(["candidate"]);
  expect(j.conflicts).toEqual([
    { unit: "existence", with: [20, 30], items: [{ event: 41, target: "f2", k: 0 }] },
  ]);
});
