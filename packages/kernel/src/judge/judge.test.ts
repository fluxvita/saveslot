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
    ...(x.content.kind === "value"
      ? { value: x.content.value }
      : x.content.kind === "revoke"
        ? { revoke: true }
        : { [x.content.kind]: true }),
    ...("carried" in x && x.carried !== undefined ? { carried: x.carried } : {}),
  }));
}

function undo(
  op: number,
  target: number,
  o: { seen?: number; ack?: boolean; later?: boolean } = {},
): JudgeInput {
  return {
    kind: "undo",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    target,
    seen: o.seen ?? op - 1,
    seenExplicit: o.seen !== undefined,
    ...(o.ack ? { acknowledge: true } : {}),
    ...(o.later ? { includeLater: true } : {}),
  };
}

const WHOLE_IV = { from: null, to: null };
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
    // As the log keeps it (09 §5.7 `ack/<j>`): the value and the op that wrote it, no giver item.
    expect(j.record.ack).toEqual(
      j.overwritten.map((o) => ({
        field: o.field,
        valid: o.valid,
        deps: o.deps,
        ...(o.was.kind === "value" ? { value: o.was.value, op: o.was.op } : { noValue: true }),
      })),
    );
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

  it("acknowledged over a stretch without a value: the ack keeps it as no value (09 §5.7 `ack/<j>`)", () => {
    // #31 runs over 1 | gap | 2: ① (11-01, 11-05 erased), acknowledged with the current ver.
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "11-01"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-05", "open"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, seen: 20, valid: span("10-20", "open"), fields: { f2: "3" }, ack: true }),
    ]);
    const j = last(js);
    expect(j.acknowledged).toBe(true);
    expect(j.record.kind === "write" ? j.record.ack : []).toEqual([
      { field: "f2", valid: iv("10-20", "11-01"), value: "1", op: 10, deps: [ref(11, "f2")] },
      {
        field: "f2",
        valid: iv("11-01", "11-05"),
        noValue: true,
        deps: [ref(11, "f2"), ref(21, "f2")],
      },
      { field: "f2", valid: iv("11-05"), value: "2", op: 20, deps: [ref(21, "f2")] },
    ]);
  });

  it("an undo writing back no value past ① by acknowledge keeps what it overwrote", () => {
    const { js } = run(STATE, [
      write({ op: 12, seen: 0, valid: span("10-01", "11-20"), fields: { f2: "5000" } }),
      write({ op: 42, valid: span("11-10", "11-25"), fields: { f2: "4800" }, ack: true }),
      undo(50, 42, { seen: 42, ack: true }),
    ]);
    const j = last(js);
    expect(j.record).toMatchObject({ kind: "undo", status: "applied" });
    expect(items(j).map((x) => [x.valid, "no_value" in x])).toEqual([
      [iv("11-10", "11-20"), false],
      [iv("11-20", "11-25"), true],
    ]);
    // One stretch per item written back: the 5000 one and the no-value one both overwrite 4800.
    const deps = [ref(13, "f2"), ref(43, "f2")];
    expect(j.record.kind === "undo" ? j.record.ack : []).toEqual([
      { field: "f2", valid: iv("11-10", "11-20"), value: "4800", op: 42, deps },
      { field: "f2", valid: iv("11-20", "11-25"), value: "4800", op: 42, deps },
    ]);
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

it("a write whose fields both meet a revoke is one candidate in one item on existence", () => {
  // 09 §5.8: one write.base is at most one candidate in an item.
  for (const table of [EVENT, STATE]) {
    const valid = table.kind === "state" ? { valid: span("10-01", "open") } : {};
    const { js } = run(table, [
      write({ op: 10, seen: 0, ...valid, fields: { f2: "1", f3: "a" } }),
      revoke(
        20,
        table.kind === "state" ? (span("11-01", "11-07") as RevokeInput["valid"]) : undefined,
        10,
      ),
      write({
        op: 30,
        seen: 10,
        ...(table.kind === "state" ? { valid: span("11-03", "11-05") } : {}),
        fields: { f2: "2", f3: "b" },
      }),
    ]);
    expect(last(js).conflicts).toEqual([
      { unit: "existence", with: [20], items: [ref(31, "f2"), ref(31, "f3")] },
    ]);
  }
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

// ---------------------------------------------------------------------------------------------
// Reverts (03-deletion «回掉的权威定义»; 04-write-and-read «撤回某次写入（undo）»).

const ref = (event: number, target: string, k = 0) => ({ event, target, k });
const depsOf = (j: Judgement) =>
  j.record.kind === "reject" || j.record.kind === "keep_effective"
    ? []
    : j.record.items.map((x) => x.deps);

describe("undo", () => {
  it("09 §5.7 example: an undo of a write over two stretches writes back two items", () => {
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } }),
      write({ op: 13, valid: span("11-10", "open"), fields: { f2: "4000" }, ack: true }),
      write({ op: 20, valid: span("11-02", "11-20"), fields: { f2: "3000" }, ack: true }),
      // Back to 5000 | 4000 erases 11-02 and 11-20 (①): acknowledged with the current ver.
      undo(30, 20, { seen: 20, ack: true }),
    ]);
    const j = last(js);
    expect(j.record).toMatchObject({
      kind: "undo",
      status: "applied",
      revert: { entries: [{ event: 21, target: "f2" }], before: 20, skipped: [] },
    });
    expect(items(j)).toEqual([
      {
        target: "f2",
        k: 0,
        status: "applied",
        valid: iv("11-02", "11-10"),
        value: "5000",
        carried: [ref(11, "f2")],
      },
      {
        target: "f2",
        k: 1,
        status: "applied",
        valid: iv("11-10", "11-20"),
        value: "4000",
        carried: [ref(14, "f2")],
      },
    ]);
    expect(j.acknowledged).toBe(true);
    expect(stretches(state, "f2")).toEqual([
      [d("10-01"), d("11-10"), "5000"],
      [d("11-10"), null, "4000"],
    ]);
  });

  it("09 §5.7 deps example: a no_value write-back depends on who gives its ends at the position", () => {
    const { js } = run(STATE, [
      write({ op: 12, seen: 0, valid: span("10-01", "11-20"), fields: { f2: "5000" } }),
      write({ op: 42, valid: span("11-10", "11-25"), fields: { f2: "4800" }, ack: true }),
      undo(50, 42, { seen: 42, ack: true }),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      {
        target: "f2",
        k: 0,
        status: "applied",
        valid: iv("11-10", "11-20"),
        value: "5000",
        carried: [ref(13, "f2")],
      },
      { target: "f2", k: 1, status: "applied", valid: iv("11-20", "11-25"), no_value: true },
    ]);
    expect(depsOf(j)[1]).toEqual([ref(13, "f2"), ref(43, "f2")]);
  });

  it("only the part still in effect is undone; the covered part is skipped, with the covering op", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-09"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-05", "11-09"), fields: { f2: "3" }, ack: true }),
      undo(40, 20, { seen: 30, ack: true }),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      {
        target: "f2",
        k: 0,
        status: "applied",
        valid: iv("11-01", "11-05"),
        value: "1",
        carried: [ref(11, "f2")],
      },
    ]);
    expect(j.record).toMatchObject({
      revert: { skipped: [{ event: 21, target: "f2", byOp: 30 }] },
    });
  });

  it("include_later taking back a later write is high impact ④; the confirmation lists the record again", () => {
    const base = [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-03", "11-09"), fields: { f2: "3" }, ack: true }),
      undo(40, 20, { seen: 30, ack: true, later: true }),
    ];
    const { state, js } = run(STATE, base);
    const j = last(js);
    expect(j.record).toMatchObject({ kind: "undo", status: "awaiting" });
    expect(j.takesBack).toEqual([30]);
    // #31 is taken back on [11-03, 11-05) only (D(x)); beyond the undone write it stays.
    expect(items(j).map((x) => [x.valid, x.status])).toEqual([[iv("11-01", "11-05"), "awaiting"]]);
    // A later write that #21 supersedes nowhere does not join the record at the confirmation;
    // one that does joins it (04-write-and-read «撤回某次写入（undo）»: listed again as of the
    // confirmation).
    const more = run(STATE, [
      ...base,
      write({ op: 50, valid: span("11-02", "11-04"), fields: { f2: "5" }, ack: true }),
      { kind: "confirm", op: 60, index: 0, event: 61, ruleset: 1, target: 41 },
    ]);
    expect(last(more.js).record).toMatchObject({
      kind: "confirm",
      revert: {
        entries: [
          { event: 21, target: "f2" },
          { event: 31, target: "f2", later: true },
          { event: 51, target: "f2", later: true },
        ],
      },
    });
    expect(stretches(more.state, "f2")).toEqual([
      [d("10-01"), d("11-05"), "1"],
      [d("11-05"), d("11-09"), "3"],
      [d("11-09"), null, "1"],
    ]);
    void state;
  });

  it("undoing a fill in a hole writes back an uncovered item: the hole is back", () => {
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      revoke(20, span("11-01", "11-07") as RevokeInput["valid"]),
      write({ op: 30, valid: span("11-03", "11-05"), fields: { f2: "5" }, ack: true }),
      undo(40, 30, { seen: 30, ack: true }),
    ]);
    expect(items(last(js))).toEqual([
      { target: "f2", k: 0, status: "applied", valid: iv("11-03", "11-05"), uncovered: true },
    ]);
    expect(view(state).gaps).toEqual([...iv(null, "10-01"), ...iv("11-01", "11-07")]);
  });

  it("undoing a revoke restores existence and is not ①", () => {
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      revoke(20, span("11-01", "11-07") as RevokeInput["valid"]),
      undo(30, 20),
    ]);
    expect(items(last(js))).toEqual([
      { target: "existence", k: 0, status: "applied", valid: iv("11-01", "11-07"), restore: true },
    ]);
    expect(view(state).gaps).toEqual(iv(null, "10-01"));
  });

  it("a write-back revoke hiding a later field write is ④; a hidden corroboration only warns", () => {
    const head = [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      revoke(20, span("11-01", "11-07") as RevokeInput["valid"]),
      undo(30, 20),
    ];
    const hides = run(STATE, [
      ...head,
      write({ op: 40, valid: span("11-02", "11-04"), fields: { f2: "6" }, ack: true }),
      undo(50, 30, { seen: 40, ack: true }),
    ]);
    expect(last(hides.js).record).toMatchObject({ status: "awaiting" });
    expect(last(hides.js).hides).toEqual([ref(41, "f2")]);
    const corroborates = run(STATE, [
      ...head,
      write({ op: 40, valid: span("11-02", "11-04"), fields: { f2: "1" }, explicit: true }),
      undo(50, 30, { seen: 40, ack: true }),
    ]);
    expect(last(corroborates.js).record).toMatchObject({ status: "applied" });
    expect(last(corroborates.js).warnings).toEqual([
      { field: "f2", valid: iv("11-02", "11-04"), corroboration: ref(41, "f2") },
    ]);
  });

  it("an undone corroboration stops giving endpoints (05-time «挡点»)", () => {
    // #21 corroborates f2 on [11-05, 11-20) and changes f3; undo 30 lists and registers both, so
    // 11-05 no longer stops #41's default end.
    const head = [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "5000" } }),
      write({
        op: 20,
        valid: span("11-05", "11-20"),
        fields: { f2: "5000", f3: "x" },
        explicit: true,
      }),
    ];
    const later = write({ op: 40, valid: span("11-03", "next"), fields: { f2: "2000" } });
    const kept = run(STATE, [...head, later]);
    expect(items(last(kept.js))[0]?.valid).toEqual(iv("11-03", "11-05"));
    const undone = run(STATE, [...head, undo(30, 20, { seen: 20, ack: true }), later]);
    // f2 is written back to 5000 (the value before #21, no endpoints); f3 to no value.
    expect(items(undone.js[2] as Judgement).map((x) => x.target)).toEqual(["f2", "f3"]);
    expect(items(last(undone.js))[0]?.valid).toEqual(iv("11-03"));
  });

  it("undoing an undo lists the undo's event on the targets of its record", () => {
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      undo(30, 20, { seen: 20, ack: true }),
      undo(40, 30, { seen: 30, ack: true }),
    ]);
    expect(last(js).record).toMatchObject({ revert: { entries: [{ event: 31, target: "f2" }] } });
    expect(stretches(state, "f2")).toEqual([
      [d("10-01"), d("11-01"), "1"],
      [d("11-01"), d("11-05"), "2"],
      [d("11-05"), null, "1"],
    ]);
  });

  it("rejected: the first creation, a write that changed no value, a candidate, another row's op", () => {
    const { state } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "1" }, explicit: true }),
      write({ op: 30, seen: 10, valid: span("11-02", "11-04"), fields: { f2: "1" } }),
      write({ op: 40, valid: span("11-06", "11-08"), fields: { f2: "2" }, ack: true }),
      write({ op: 50, seen: 30, valid: span("11-06", "11-08"), fields: { f2: "3" } }),
    ]);
    for (const target of [10, 20, 30, 50, 99]) {
      expect(() => judgeOp(state, undo(60, target))).toThrow(
        expect.objectContaining({ reason: "invalid_argument" }),
      );
    }
  });
});

describe("undo on revoked rows, of confirmed reverts; write-back deps", () => {
  const confirm = (op: number, target: number): JudgeInput => ({
    kind: "confirm",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    target,
  });

  it("event tables: an undo leaving the row revoked is `revoked`; undoing the revoke is not", () => {
    // 04-write-and-read «撤回某次写入（undo）»: judged on the row once the undo is written.
    const { state } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      write({ op: 20, fields: { f2: "2" } }),
      revoke(30),
    ]);
    expect(() => judgeOp(state, undo(40, 20))).toThrow(
      expect.objectContaining({ reason: "revoked", detail: { ops: [30] } }),
    );
    const back = judgeOp(state, undo(40, 30));
    expect(back.judgement.record).toMatchObject({ status: "applied" });
    expect(view(back.state).exists).toBe(true);
    // Taking the revoke back with include_later: the row exists once written; ④, awaiting.
    const later = judgeOp(state, undo(40, 20, { later: true })).judgement;
    expect(later.record).toMatchObject({
      status: "awaiting",
      revert: {
        entries: [
          { event: 21, target: "f2" },
          { event: 31, target: "existence", later: true },
        ],
      },
    });
    expect(later.takesBack).toEqual([30]);
  });

  it("a write-back revoke depends on the revoke giving its state (03-deletion step 8)", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      revoke(20, span("11-01", "11-07") as RevokeInput["valid"]),
      undo(30, 20),
      undo(40, 30),
    ]);
    expect(items(last(js))).toEqual([
      { target: "existence", k: 0, status: "applied", valid: iv("11-01", "11-07"), revoke: true },
    ]);
    expect(depsOf(last(js))).toEqual([[ref(21, "existence"), ref(31, "existence")]]);
  });

  it("an undo of an awaiting revert since confirmed, by the proposal's operation (09 §5.7)", () => {
    const head = [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-03", "11-09"), fields: { f2: "3" }, ack: true }),
      undo(40, 20, { later: true }),
      confirm(50, 41),
    ];
    const byProposal = run(STATE, [...head, undo(60, 40, { seen: 50, ack: true })]);
    const byConfirmation = run(STATE, [...head, undo(60, 50, { seen: 50, ack: true })]);
    expect(last(byProposal.js).record).toMatchObject({
      kind: "undo",
      status: "applied",
      revert: { entries: [{ event: 51, target: "f2" }], before: 50 },
    });
    expect(last(byProposal.js)).toEqual(last(byConfirmation.js));
    expect(stretches(byProposal.state, "f2")).toEqual([
      [d("10-01"), d("11-01"), "1"],
      [d("11-01"), d("11-03"), "2"],
      [d("11-03"), d("11-09"), "3"],
      [d("11-09"), null, "1"],
    ]);
  });

  it("an operation with a change of its own on the row: its own change is undone, not the confirmed revert", () => {
    // Op 40 writes f3 (index 0) and proposes an undo (index 1) that #51 confirms. undo(40) takes
    // back op 40's own change; the confirmed revert is undone by 50.
    const head = [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-03", "11-09"), fields: { f2: "3" }, ack: true }),
      write({ op: 40, seen: 30, valid: span("10-01", "open"), fields: { f3: "x" } }),
      { ...undo(40, 20, { later: true }), index: 1, event: 42 },
      confirm(50, 42),
    ];
    const { state } = run(STATE, head);
    const f2Before = stretches(state, "f2");
    const r = judgeOp(state, undo(60, 40, { seen: 50, ack: true }));
    expect(r.judgement.record).toMatchObject({
      kind: "undo",
      status: "applied",
      revert: { before: 40 },
    });
    const rec = r.judgement.record;
    expect(rec.kind === "undo" ? rec.revert.entries : []).toContainEqual({
      event: 41,
      target: "f3",
    });
    expect(stretches(r.state, "f3")).toEqual([[d("10-01"), null, null]]);
    expect(stretches(r.state, "f2")).toEqual(f2Before);
  });

  it("an operation with nothing applied and two confirmed reverts: nothing to undo by it", () => {
    // Two awaiting undos in one request (①, no acknowledge), each confirmed: undo(40) is
    // `invalid_argument`; each is undone by its confirming operation.
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-01", "11-05"), fields: { f3: "a" }, ack: true }),
      undo(40, 20),
      { ...undo(40, 30), index: 1, event: 42 },
      confirm(50, 41),
      confirm(55, 42),
    ]);
    expect(js[3]?.record).toMatchObject({ status: "awaiting" });
    expect(js[4]?.record).toMatchObject({ status: "awaiting" });
    expect(() => judgeOp(state, undo(60, 40))).toThrow(
      expect.objectContaining({ reason: "invalid_argument" }),
    );
    expect(judgeOp(state, undo(60, 50, { seen: 55, ack: true })).judgement.record).toMatchObject({
      revert: { before: 50 },
    });
  });

  it("an undo naming an unconfirmed proposal is not taken as another proposal's confirmation", () => {
    const { state } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-01", "11-05"), fields: { f3: "a" }, ack: true }),
      undo(40, 20),
      undo(45, 30),
      confirm(50, 41),
    ]);
    expect(() => judgeOp(state, undo(60, 45))).toThrow(
      expect.objectContaining({ reason: "invalid_argument" }),
    );
  });

  it("deps: pieces joined across adjacent revokes depend on every one, not only those at the ends", () => {
    // Three adjacent revokes taken back together by #61 (the confirmed include_later undo of #21),
    // then #61 undone: one write-back revoke over [11-01, 11-07) depends on #41 in the middle too.
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-07"), fields: { f2: "2" }, ack: true }),
      revoke(30, span("11-01", "11-03") as RevokeInput["valid"]),
      revoke(40, span("11-03", "11-05") as RevokeInput["valid"]),
      revoke(50, span("11-05", "11-07") as RevokeInput["valid"]),
      undo(55, 20, { later: true }),
      confirm(60, 56),
      undo(70, 60),
    ]);
    const j = last(js);
    const i = items(j).findIndex((x) => x.target === "existence");
    expect(items(j)[i]).toMatchObject({ valid: iv("11-01", "11-07"), revoke: true });
    expect(depsOf(j)[i]).toEqual(
      expect.arrayContaining([ref(31, "existence"), ref(41, "existence"), ref(51, "existence")]),
    );
  });

  it("deps: a write-back depends on the giver on the right of its end", () => {
    // Two adjacent revokes taken back together, then undone: f2's uncovered [11-01, 11-04) ends
    // where the second revoke's hole begins.
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-07"), fields: { f2: "2" }, ack: true }),
      revoke(30, span("11-01", "11-04") as RevokeInput["valid"]),
      revoke(40, span("11-04", "11-07") as RevokeInput["valid"]),
      undo(50, 20, { later: true }),
      confirm(60, 51),
      undo(70, 60),
    ]);
    const j = last(js);
    const i = items(j).findIndex(
      (x) => x.target === "f2" && "uncovered" in x && x.valid[0]?.to === d("11-04"),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    expect(depsOf(j)[i]).toContainEqual(ref(41, "existence"));
  });

  it("deps: on an event table, no item has deps, a write-back revoke included (09 §3.5)", () => {
    const { js } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      revoke(20),
      undo(30, 20),
      undo(40, 30),
    ]);
    expect(items(last(js))).toEqual([
      {
        target: "existence",
        k: 0,
        status: "applied",
        valid: [{ from: null, to: null }],
        revoke: true,
      },
    ]);
    // No business time, so nothing comes from other contributions' dates: no deps.
    expect(depsOf(last(js))).toEqual([[]]);
  });

  it("a write to a revoked row lists the revokes in effect, not those taken back", () => {
    const { state } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      revoke(20),
      undo(30, 20),
      undo(40, 30),
    ]);
    expect(() => judgeOp(state, write({ op: 50, fields: { f2: "2" } }))).toThrow(
      expect.objectContaining({ reason: "revoked", detail: { ops: [40] } }),
    );
  });

  it("the revoked check is for undo only: a take_previous on a revoked row takes effect", () => {
    const { state } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      write({ op: 20, fields: { f2: "2" }, ack: true }),
      write({ op: 30, seen: 10, fields: { f2: "3" } }),
      revoke(40),
    ]);
    const r = judgeOp(state, {
      kind: "take_previous",
      op: 50,
      index: 0,
      event: 51,
      ruleset: 1,
      unit: { fields: ["f2"] },
      candidates: [31],
    });
    expect(r.judgement.record).toMatchObject({ kind: "take_previous", status: "applied" });
  });

  it("an undo's acknowledge counts only with an explicit ver", () => {
    const head = [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
    ];
    const explicit = run(STATE, [...head, undo(30, 20, { seen: 20, ack: true })]);
    expect(last(explicit.js).record).toMatchObject({ status: "applied" });
    const fromLog = run(STATE, [...head, undo(30, 20, { ack: true })]);
    expect(last(fromLog.js).record).toMatchObject({ status: "awaiting" });
  });

  it("skipped lists the undone operation's own entries only, not later ones", () => {
    // #51 covers the later #31 on [11-07, 11-09) and meets nothing of #21: not in R.
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-03", "11-09"), fields: { f2: "3" }, ack: true }),
      write({ op: 50, valid: span("11-07", "11-09"), fields: { f2: "5" }, ack: true }),
      undo(60, 20, { later: true }),
    ]);
    expect(last(js).record).toMatchObject({
      status: "awaiting",
      revert: {
        entries: [
          { event: 21, target: "f2" },
          { event: 31, target: "f2", later: true },
        ],
        skipped: [],
      },
    });
    expect(last(js).takesBack).toEqual([30]);
  });

  it("a write-back revoke does not hide a later write in the record: that one is taken back", () => {
    // #51 (the confirmation of #41) wrote back f2 and a restore. Undoing it with include_later lists
    // #61, which supersedes its f2 item: the write-back revoke meets #61, but #61 is in R (④ by
    // taking it back), not hidden.
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      revoke(30, span("11-01", "11-07") as RevokeInput["valid"]),
      undo(40, 20, { later: true }),
      confirm(50, 41),
      write({ op: 60, valid: span("11-02", "11-04"), fields: { f2: "6" }, ack: true }),
      undo(70, 50, { seen: 60, ack: true, later: true }),
    ]);
    const j = last(js);
    expect(j.record).toMatchObject({
      status: "awaiting",
      revert: {
        entries: [
          { event: 51, target: "existence" },
          { event: 51, target: "f2" },
          { event: 61, target: "f2", later: true },
        ],
      },
    });
    expect(items(j).some((x) => x.target === "existence" && "revoke" in x)).toBe(true);
    expect(j.takesBack).toEqual([60]);
    expect(j.hides).toEqual([]);
  });

  it("a revoke filled since does not leave the position absent: the undo writes back a restore", () => {
    // 03-deletion «回掉的权威定义» step 6: inside a revoke in effect that has not been restored or
    // filled since. #31 fills #21's hole; undoing the second revoke #41 restores existence there.
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      revoke(20, span("11-01", "11-07") as RevokeInput["valid"]),
      write({ op: 30, valid: span("11-01", "11-07"), fields: { f2: "5" }, ack: true }),
      revoke(40, span("11-01", "11-07") as RevokeInput["valid"]),
      undo(50, 40),
    ]);
    expect(items(last(js))).toEqual([
      { target: "existence", k: 0, status: "applied", valid: iv("11-01", "11-07"), restore: true },
    ]);
    expect(stretches(state, "f2")).toEqual([
      [d("10-01"), d("11-01"), "1"],
      [d("11-01"), d("11-07"), "5"],
      [d("11-07"), null, "1"],
    ]);
  });

  it("where a write fills a hole, an optional field it does not give is empty, not the hole", () => {
    // 05-time «无值区间»: 可选字段不带就是空. f3 is empty on both sides of 11-01 and 11-07, so
    // writing it over everything erases no change point of it: not ①.
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      revoke(20, span("11-01", "11-07") as RevokeInput["valid"]),
      write({ op: 30, valid: span("11-01", "11-07"), fields: { f2: "5" }, ack: true }),
      write({ op: 40, valid: span("10-01", "open"), fields: { f3: "y" } }),
    ]);
    expect(last(js).erased).toEqual([]);
    expect(items(last(js))).toEqual([
      { target: "f3", k: 0, status: "applied", valid: iv("10-01"), value: "y" },
    ]);
  });
});

describe("take_previous", () => {
  it("goes back to the merge base on the item's stretch and closes the candidates", () => {
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "open"), fields: { f2: "5" }, ack: true }),
      write({ op: 30, seen: 10, valid: span("11-05", "11-09"), fields: { f2: "4" } }),
      {
        kind: "take_previous",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        unit: { fields: ["f2"] },
        candidates: [31],
      },
    ]);
    const j = last(js);
    expect(j.record).toMatchObject({
      kind: "take_previous",
      status: "applied",
      revert: { entries: [{ event: 21, target: "f2" }], mergeBase: 10, candidates: [31] },
    });
    expect(items(j)).toEqual([
      {
        target: "f2",
        k: 0,
        status: "applied",
        valid: iv("11-05", "11-09"),
        value: "1",
        carried: [ref(11, "f2")],
      },
    ]);
    expect(state.closedCandidate(31, "f2")).toBe(true);
    expect(stretches(state, "f2")).toEqual([
      [d("10-01"), d("11-01"), "1"],
      [d("11-01"), d("11-05"), "5"],
      [d("11-05"), d("11-09"), "1"],
      [d("11-09"), null, "5"],
    ]);
  });
});

describe("take_candidate", () => {
  const take = (
    op: number,
    unit: "existence" | readonly FieldId[],
    candidates: readonly number[],
    taken: number,
  ): JudgeInput => ({
    kind: "take_candidate",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    unit: unit === "existence" ? "existence" : { fields: unit },
    candidates,
    take: taken,
  });

  it("takes every candidate item of the write, one item per stretch; records merge base and cover", () => {
    // #41 is cut around a corroboration into two candidate stretches; both take effect.
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-03"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-07", "11-09"), fields: { f2: "2" }, ack: true }),
      write({
        op: 40,
        seen: 10,
        valid: span("11-01", "11-09"),
        fields: { f2: "1" },
        explicit: true,
      }),
      take(50, ["f2"], [41], 41),
    ]);
    const j = last(js);
    expect(items(j)).toEqual([
      {
        target: "f2",
        k: 0,
        status: "applied",
        valid: iv("11-01", "11-03"),
        value: "1",
        carried: [ref(41, "f2", 0), ref(41, "f2", 2)],
      },
      {
        target: "f2",
        k: 1,
        status: "applied",
        valid: iv("11-07", "11-09"),
        value: "1",
        carried: [ref(41, "f2", 0), ref(41, "f2", 2)],
      },
    ]);
    expect(j.record).toMatchObject({
      kind: "take_candidate",
      take: 41,
      mergeBase: 10,
      cover: [
        { event: 21, target: "f2" },
        { event: 31, target: "f2" },
      ],
    });
    expect(stretches(state, "f2")).toEqual([[d("10-01"), null, "1"]]);
    // The item is closed: no other decision on it.
    expect(() =>
      judgeOp(state, {
        kind: "keep_effective",
        op: 60,
        index: 0,
        event: 61,
        ruleset: 1,
        unit: { fields: ["f2"] },
        candidates: [41],
      }),
    ).toThrow(expect.objectContaining({ reason: "invalid" }));
  });

  it("same-valued candidates of the item are value sources too", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-09"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, seen: 10, valid: span("11-01", "11-05"), fields: { f2: "3" } }),
      write({ op: 40, seen: 10, valid: span("11-03", "11-07"), fields: { f2: "3" } }),
      take(50, ["f2"], [31, 41], 31),
    ]);
    expect(items(last(js))).toEqual([
      {
        target: "f2",
        k: 0,
        status: "applied",
        valid: iv("11-01", "11-05"),
        value: "3",
        carried: [ref(31, "f2"), ref(41, "f2")],
      },
    ]);
  });

  it("a stretch without a value is not the same value: the candidate is written there", () => {
    // f3 is x on #31's whole interval underneath, but undoing #16 left [11-01, 11-03) without a
    // value (f2 none): taking #31 on existence writes f3 there too, with f2 carried.
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("11-03", "open"), fields: { f2: "1" } }),
      write({ op: 15, valid: span("11-01", "11-03"), fields: { f2: "2" }, ack: true }),
      write({ op: 18, valid: span("11-01", "open"), fields: { f3: "x" }, ack: true }),
      undo(22, 15, { seen: 18, ack: true }),
      revoke(25, span("11-05", "11-07") as RevokeInput["valid"], 22),
      write({
        op: 30,
        seen: 18,
        valid: span("11-01", "11-07"),
        fields: { f3: "x" },
        explicit: true,
      }),
      undo(35, 25),
      take(40, "existence", [31], 31),
    ]);
    expect(items(js[5] as Judgement).map((x) => [x.status, x.valid])).toEqual([
      ["candidate", iv("11-01", "11-03")],
      ["corroborated", iv("11-03", "11-05")],
      ["candidate", iv("11-05", "11-07")],
    ]);
    expect(items(last(js)).map((x) => [x.target, x.valid])).toEqual([
      ["f2", iv("11-01", "11-03")],
      ["f3", iv("11-01", "11-03")],
      ["f3", iv("11-05", "11-07")],
    ]);
  });

  it("a field unit passes the checks on the current state an ordinary write passes", () => {
    // 04-write-and-read «判定顺序» step 5. Event table: the row revoked since → `revoked`.
    const event = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1", f3: "a" } }),
      write({ op: 20, fields: { f2: "2" } }),
      write({ op: 30, seen: 10, fields: { f2: "3" } }),
      revoke(35, undefined, 30),
    ]);
    expect(() => judgeOp(event.state, take(40, ["f2"], [31], 31))).toThrow(
      expect.objectContaining({ reason: "revoked", detail: { ops: [35] } }),
    );
    // State table: f3 into [11-01, 11-05), where there is no value, without f2.
    const state = run(STATE, [
      write({ op: 10, seen: 0, valid: span("11-05", "open"), fields: { f2: "1", f3: "a" } }),
      write({ op: 20, valid: span("11-05", "11-09"), fields: { f3: "b" }, ack: true }),
      write({ op: 30, seen: 10, valid: span("11-01", "11-07"), fields: { f3: "c" } }),
    ]);
    expect(() => judgeOp(state.state, take(40, ["f3"], [31], 31))).toThrow(
      expect.objectContaining({
        reason: "validation_failed",
        detail: { missing: ["f2"], valid: iv("11-01", "11-05") },
      }),
    );
  });

  it("a field group: every field of the candidate in the unit takes effect", () => {
    const { js } = run(GROUPED, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f4: "1", f5: "a" } }),
      write({ op: 20, valid: span("11-01", "open"), fields: { f4: "2" }, ack: true }),
      write({ op: 30, seen: 10, valid: span("11-03", "11-07"), fields: { f4: "3", f5: "b" } }),
      take(40, ["f4", "f5"], [31], 31),
    ]);
    expect(items(last(js)).map((x) => [x.target, x.valid, "value" in x ? x.value : null])).toEqual([
      ["f4", iv("11-03", "11-07"), "3"],
      ["f5", iv("11-03", "11-07"), "b"],
    ]);
  });

  it("nothing to write when the value is already in effect: the item is resolved, ver unchanged", () => {
    // #41 conflicts with #21; #51 then writes the same value: taking #41 writes nothing.
    const { state, js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-05"), fields: { f2: "2" }, ack: true }),
      write({ op: 40, seen: 10, valid: span("11-01", "11-05"), fields: { f2: "3" } }),
      write({ op: 50, valid: span("11-01", "11-05"), fields: { f2: "3" }, ack: true }),
      take(60, ["f2"], [41], 41),
    ]);
    expect(items(last(js))).toEqual([]);
    expect(state.closedCandidate(41, "f2")).toBe(true);
    expect(state.opsBetween(50, 61)).toEqual([]);
  });

  it("refused: a candidate not in the item, a unit the candidate is not on", () => {
    const { state } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      revoke(20, undefined, 10),
      write({ op: 30, seen: 10, fields: { f2: "2" } }),
    ]);
    expect(() => judgeOp(state, take(40, "existence", [31], 11))).toThrow(
      expect.objectContaining({ reason: "invalid" }),
    );
    // #31 met a revoke: its candidate is on existence, not on f2.
    expect(() => judgeOp(state, take(40, ["f2"], [31], 31))).toThrow(
      expect.objectContaining({ reason: "invalid" }),
    );
  });

  const resolveAs = (
    kind: "keep_effective" | "take_previous",
    op: number,
    unit: "existence" | readonly FieldId[],
    candidates: readonly number[],
  ): JudgeInput => ({
    kind,
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    unit: unit === "existence" ? "existence" : { fields: unit },
    candidates,
  });

  it("every resolution checks the unit it names: a write that met a revoke is on existence", () => {
    const { state } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      revoke(20, undefined, 10),
      write({ op: 30, seen: 10, fields: { f2: "2" } }),
    ]);
    for (const kind of ["keep_effective", "take_previous"] as const) {
      expect(() => judgeOp(state, resolveAs(kind, 40, ["f2"], [31]))).toThrow(
        expect.objectContaining({ reason: "invalid" }),
      );
      expect(judgeOp(state, resolveAs(kind, 40, "existence", [31])).judgement.record.kind).toBe(
        kind,
      );
    }
  });

  it("one write in a field item and an existence item: taking one leaves the other open", () => {
    // #31 from 11-01 to its next change, as of ver 12: f2 stops at #13's 11-03 and meets only #21
    // (a field item); f3 runs on and meets the revoke #26 (an existence item).
    const { state } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1", f3: "a" } }),
      write({ op: 12, valid: span("11-03", "open"), fields: { f2: "5" }, ack: true }),
      write({ op: 20, seen: 12, valid: span("11-01", "11-03"), fields: { f2: "2" }, ack: true }),
      revoke(25, span("11-05", "11-07") as RevokeInput["valid"], 20),
      write({ op: 30, seen: 12, valid: span("11-01", "next"), fields: { f2: "9", f3: "b" } }),
    ]);
    const mine = state.items.filter((x) => x.event === 31);
    expect(mine.map((x) => [x.target, x.status, x.onExistence === true])).toEqual([
      ["f2", "candidate", false],
      ["f3", "candidate", true],
    ]);
    const tookExistence = judgeOp(state, take(40, "existence", [31], 31)).state;
    expect(tookExistence.closedCandidate(31, "f3")).toBe(true);
    expect(tookExistence.closedCandidate(31, "f2")).toBe(false);
    const tookField = judgeOp(state, take(40, ["f2"], [31], 31)).state;
    expect(tookField.closedCandidate(31, "f2")).toBe(true);
    expect(tookField.closedCandidate(31, "f3")).toBe(false);
  });

  it("the merge base is the earliest version the candidates carried, whichever is taken", () => {
    const { js } = run(EVENT, [
      write({ op: 10, seen: 0, fields: { f2: "1" } }),
      write({ op: 20, fields: { f2: "2" }, ack: true }),
      write({ op: 30, fields: { f2: "3" }, ack: true }),
      write({ op: 40, seen: 10, fields: { f2: "4" } }),
      write({ op: 50, seen: 20, fields: { f2: "5" } }),
      take(60, ["f2"], [41, 51], 51),
    ]);
    expect(last(js).record).toMatchObject({ mergeBase: 10 });
  });

  it("the cover lists every write over the item's stretch, as take_previous's record would", () => {
    // Two candidates on disjoint stretches, each under a write in effect: both writes covered.
    const { state } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-01", "11-03"), fields: { f2: "2" }, ack: true }),
      write({ op: 30, valid: span("11-07", "11-09"), fields: { f2: "3" }, ack: true }),
      write({ op: 40, seen: 10, valid: span("11-01", "11-03"), fields: { f2: "4" } }),
      write({ op: 50, seen: 10, valid: span("11-07", "11-09"), fields: { f2: "5" } }),
    ]);
    const took = judgeOp(state, take(60, ["f2"], [41, 51], 41)).judgement.record;
    const previous = judgeOp(state, resolveAs("take_previous", 60, ["f2"], [41, 51])).judgement
      .record;
    expect(took).toMatchObject({
      cover: [
        { event: 21, target: "f2" },
        { event: 31, target: "f2" },
      ],
    });
    expect(took.kind === "take_candidate" ? took.cover : []).toEqual(
      previous.kind === "take_previous" ? previous.revert.entries : null,
    );
  });

  it("a state table revoke taken where part of its stretch already has no value: written whole", () => {
    const { js } = run(STATE, [
      write({ op: 10, seen: 0, valid: span("11-03", "open"), fields: { f2: "1" } }),
      write({ op: 20, valid: span("11-05", "open"), fields: { f2: "2" }, ack: true }),
      revoke(30, span("11-01", "11-07") as RevokeInput["valid"], 10),
      take(40, "existence", [31], 31),
    ]);
    expect(items(js[2] as Judgement)).toEqual([
      { target: "existence", k: 0, status: "candidate", valid: iv("11-01", "11-07"), revoke: true },
    ]);
    expect(items(last(js))).toEqual([
      { target: "existence", k: 0, status: "applied", valid: iv("11-01", "11-07"), revoke: true },
    ]);
    expect(depsOf(last(js))).toEqual([[ref(31, "existence")]]);
  });

  describe("on existence", () => {
    it("state table: a modification fills the gap, required fields carried from the merge base", () => {
      // 09-references-conflict-sync «撤销与并发修改»: no existence item; f2 carried from #11 where
      // there is no value; [11-01, 11-03) stays without a value.
      const { state, js } = run(STATE, [
        write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1", f3: "a" } }),
        revoke(20, span("11-01", "11-07") as RevokeInput["valid"], 10),
        write({ op: 30, seen: 10, valid: span("11-03", "11-09"), fields: { f3: "2" } }),
        take(40, "existence", [31], 31),
      ]);
      expect(items(last(js))).toEqual([
        {
          target: "f2",
          k: 0,
          status: "applied",
          valid: iv("11-03", "11-07"),
          value: "1",
          carried: [ref(11, "f2")],
        },
        {
          target: "f3",
          k: 0,
          status: "applied",
          valid: iv("11-03", "11-09"),
          value: "2",
          carried: [ref(31, "f3")],
        },
      ]);
      expect(view(state).gaps).toEqual([...iv(null, "10-01"), ...iv("11-01", "11-03")]);
      // f2's deps: what it carries, the candidate taken, the revoke leaving the stretch without a
      // value (11-07 is its end), and the givers of the value ↔ no value boundary at 11-03.
      expect(depsOf(last(js))).toEqual([
        [ref(11, "f2"), ref(21, "existence"), ref(31, "f3")],
        [ref(31, "f3")],
      ]);
    });

    it("carried required deps: the revoke over the stretch, a boundary giver, merge base sides", () => {
      const takeOn = (head: JudgeInput[]) =>
        last(run(STATE, [...head, take(40, "existence", [31], 31)]).js);
      const carriedF2 = (j: Judgement) =>
        items(j)
          .map((x, i) => ({ x, deps: depsOf(j)[i] }))
          .filter((y) => y.x.target === "f2");
      // The revoke covers the stretch inside: its ends are no boundary, only the revoke gives it.
      const inside = takeOn([
        write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
        revoke(20, span("11-01", "11-09") as RevokeInput["valid"], 10),
        write({ op: 30, seen: 10, valid: span("11-03", "11-07"), fields: { f3: "x" } }),
      ]);
      expect(carriedF2(inside).map((y) => [y.x.valid, y.deps])).toEqual([
        [iv("11-03", "11-07"), [ref(11, "f2"), ref(21, "existence"), ref(31, "f3")]],
      ]);
      // 11-05 is a value ↔ no value boundary; #26 (after the merge base) gives the value side.
      const boundary = takeOn([
        write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
        revoke(20, span("11-01", "11-05") as RevokeInput["valid"], 10),
        write({ op: 25, seen: 20, valid: span("11-05", "open"), fields: { f2: "3" }, ack: true }),
        write({ op: 30, seen: 10, valid: span("11-03", "11-09"), fields: { f3: "x" } }),
      ]);
      expect(carriedF2(boundary).map((y) => [y.x.valid, y.deps])).toEqual([
        [iv("11-03", "11-05"), [ref(11, "f2"), ref(21, "existence"), ref(26, "f2"), ref(31, "f3")]],
      ]);
      // At the merge base f2 changes at 11-04 (#11 | #14): both stretches depend on both sides.
      const sides = takeOn([
        write({ op: 10, seen: 0, valid: span("10-01", "open"), fields: { f2: "1" } }),
        write({ op: 13, valid: span("11-04", "open"), fields: { f2: "2" }, ack: true }),
        revoke(20, span("11-01", "11-07") as RevokeInput["valid"], 13),
        write({ op: 30, seen: 13, valid: span("11-01", "11-07"), fields: { f3: "x" } }),
      ]);
      expect(carriedF2(sides).map((y) => [y.x.valid, y.deps])).toEqual([
        [iv("11-01", "11-04"), [ref(11, "f2"), ref(14, "f2"), ref(21, "existence"), ref(31, "f3")]],
        [iv("11-04", "11-07"), [ref(11, "f2"), ref(14, "f2"), ref(21, "existence"), ref(31, "f3")]],
      ]);
    });

    it("state table: a required field the merge base does not give either is required_in_gap", () => {
      const { state } = run(STATE, [
        write({ op: 10, seen: 0, valid: span("11-05", "open"), fields: { f2: "1" } }),
        revoke(20, span("11-05", "11-09") as RevokeInput["valid"], 10),
        write({ op: 30, seen: 10, valid: span("11-01", "11-07"), fields: { f3: "x" } }),
      ]);
      expect(() => judgeOp(state, take(40, "existence", [31], 31))).toThrow(
        expect.objectContaining({
          reason: "validation_failed",
          detail: expect.objectContaining({ reason: "required_in_gap" }),
        }),
      );
    });

    it("event table: a modification restores the row; writes are accepted; undoing the take revokes it again", () => {
      const head = [
        write({ op: 10, seen: 0, fields: { f2: "1" } }),
        revoke(20, undefined, 10),
        write({ op: 30, seen: 10, fields: { f2: "2" } }),
        take(40, "existence", [31], 31),
      ];
      const { state, js } = run(EVENT, head);
      expect(items(last(js))).toEqual([
        { target: "existence", k: 0, status: "applied", valid: [WHOLE_IV], restore: true },
        {
          target: "f2",
          k: 0,
          status: "applied",
          valid: [WHOLE_IV],
          value: "2",
          carried: [ref(31, "f2")],
        },
      ]);
      expect(view(state).exists).toBe(true);
      expect(depsOf(last(js))).toEqual([[], []]);
      expect(judgeOp(state, write({ op: 50, fields: { f2: "3" } })).judgement.record).toMatchObject(
        {
          kind: "write",
        },
      );
      const undone = run(EVENT, [...head, undo(50, 40)]);
      expect(view(undone.state).exists).toBe(false);
      // The original revoke counts again (the restore is registered as reverted), and so does
      // the revoke written back.
      expect(() => judgeOp(undone.state, write({ op: 60, fields: { f2: "3" } }))).toThrow(
        expect.objectContaining({ reason: "revoked", detail: { ops: [20, 50] } }),
      );
    });

    it("a revoke taken takes effect", () => {
      const { state, js } = run(EVENT, [
        write({ op: 10, seen: 0, fields: { f2: "1" } }),
        write({ op: 20, fields: { f2: "2" }, ack: true }),
        revoke(30, undefined, 10),
        take(40, "existence", [31], 31),
      ]);
      expect(items(last(js))).toEqual([
        { target: "existence", k: 0, status: "applied", valid: [WHOLE_IV], revoke: true },
      ]);
      expect(depsOf(last(js))).toEqual([[]]);
      expect(view(state).exists).toBe(false);
    });
  });
});
