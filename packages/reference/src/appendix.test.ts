// Fixed cases: the scenarios worked through by hand during design (pre-dev-w6-final-fixes
// appendices A–I), one case per scenario, named after the appendix section. Expected results are
// derived from the spec as it stands: 03-deletion «删除结果的定义», «重放规则» and «回掉的权威定义»;
// 05-time; 09 §5.7 and §5.9. Where an appendix's stated result predates a later rule, the case
// follows the spec and says so in a comment.
//
// Modelling note: the appendices treat several writes and `undo`s as taking effect directly
// although they erase recorded change points (high impact ①, 05-time «高影响写入»; for `undo`,
// 04-write-and-read «回退到某个版本»): the appendices leave out the confirmation step. Those ops
// carry `acknowledge: ["overwrite"]` with an explicit current `ver` here (`ack(<current op>)`),
// which is how such a write takes effect directly.
//
// Fictional data: table `budgets` (state, `amount` = f2, date granularity) and a fictional run
// log (event table).

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateLog } from "./evaluate.ts";
import type {
  ConfirmOp,
  Evaluation,
  LogEntry,
  Op,
  ResolveOp,
  RevokeOp,
  TableSchema,
  ToParam,
  UndoOp,
  WriteOp,
} from "./model.ts";
import { itemsOf, segments, showIv, timeline } from "./views.ts";

const BUDGETS: TableSchema = { kind: "state", required: ["f2"] };
const d = (md: string) => `2026-${md}` as BizPoint;
/** `acknowledge: ["overwrite"]` with the explicit current `ver` (the last operation that changed the row). */
const ack = (seen: number) => ({ acknowledge: ["overwrite"] as const, seen });
const short = (xs: string[]) => xs.map((s) => s.replaceAll("2026-", ""));
const tl = (ev: Evaluation, f: FieldId = "f2") => short(timeline(ev, f));
const segs = (ev: Evaluation, f: FieldId = "f2") => short(segments(ev, f));
const items = (ev: Evaluation, event: number) => short(itemsOf(ev, event));
/** Like `items`, marking candidates and awaiting items whose pending item is closed. */
const itemsClosed = (ev: Evaluation, event: number) =>
  items(ev, event).map((s) => {
    const x = ev.items.find((i) => i.event === event && s.startsWith(`${i.target}/${i.k} `));
    return x?.closed ? `${s} (closed)` : s;
  });
const gaps = (ev: Evaluation) => showIv(ev.gaps).replaceAll("2026-", "");

function to(x: string): ToParam {
  if (x === "open") return { mode: "open" };
  if (x === "next") return { mode: "next_change" };
  return { mode: "given", value: d(x) };
}

/** A state-table write of `amount` from `from` to `end` ("open", "next" or a date). */
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
  return {
    kind: "write",
    op,
    event,
    valid: { from: { mode: "given", value: d(from) }, to: to(end) },
    fields: { f2: { value, sources, ...(explicit ? { explicit } : {}) } },
    ...rest,
  };
}

function revoke(
  op: number,
  event: number,
  sources: string[],
  from?: string,
  end?: string,
  seen?: number,
): RevokeOp {
  return {
    kind: "revoke",
    op,
    event,
    ...(from !== undefined && end !== undefined
      ? {
          valid: { from: { mode: "given" as const, value: d(from) }, to: to(end) },
          validSources: sources,
        }
      : {}),
    ...(seen !== undefined ? { seen } : {}),
  };
}

function undo(op: number, event: number, target: number, opts: Partial<UndoOp> = {}): UndoOp {
  return { kind: "undo", op, event, target, ...opts };
}

function takePrevious(
  op: number,
  event: number,
  candidates: number[],
  unit: FieldId | "existence" = "f2",
): ResolveOp {
  return { kind: "resolve", op, event, decision: "take_previous", candidates, unit };
}

function del(op: number, id: string, sources: string[]): LogEntry {
  return { kind: "deletion", op, id, sources };
}

function cancel(op: number, id: string): LogEntry {
  return { kind: "cancel", op, id };
}

function confirm(op: number, event: number, target: number): ConfirmOp {
  return { kind: "confirm", op, event, target };
}

/** An event-table write: fields → [value, sources]. */
function row(
  op: number,
  event: number,
  fields: Partial<Record<FieldId, [FieldValue, string[]]>>,
  opts: Partial<Omit<WriteOp, "kind" | "op" | "event" | "fields">> = {},
): WriteOp {
  const fs: WriteOp["fields"] = Object.fromEntries(
    Object.entries(fields).map(([f, x]) => [f, { value: x?.[0] ?? null, sources: x?.[1] ?? [] }]),
  );
  return { kind: "write", op, event, fields: fs, ...opts };
}

// Base write of the budget appendices: #12 (operation 10) [10-01, ∞) 5000.
const base = put(10, 12, "5000", ["S12"], "10-01", "open");

// ---------------------------------------------------------------------------------------------

describe("appendix A", () => {
  it("A.1 scenario 1: undo of a write that covered two segments", () => {
    const ops: Op[] = [
      base,
      put(13, 15, "4000", ["S15"], "11-10", "open"),
      put(20, 22, "3000", ["S22"], "11-02", "11-20", ack(13)),
      undo(30, 32, 20, ack(20)),
    ];
    const ev = evaluate(BUDGETS, ops);
    expect(items(ev, 32)).toEqual([
      'f2/0 applied [11-02, 11-10) "5000" carried #12/f2/0',
      'f2/1 applied [11-10, 11-20) "4000" carried #15/f2/0',
    ]);
    expect(ev.reverts).toMatchObject([
      { op: 30, status: "applied", record: [{ event: 22, target: "f2" }] },
    ]);
    expect(tl(ev)).toEqual(['[10-01, 11-10) "5000"', '[11-10, inf) "4000"']);
  });

  it("A.1 scenario 2: a corroboration partly changed since the seen version", () => {
    const ops: Op[] = [
      base,
      put(20, 22, "3000", ["S_B"], "11-02", "11-10"),
      put(24, 26, "5000", ["S_A"], "11-05", "11-20", { seen: 10, explicit: true }),
    ];
    const ev = evaluate(BUDGETS, ops);
    expect(items(ev, 26)).toEqual([
      'f2/0 candidate [11-05, 11-10) "5000"',
      'f2/1 corroborated [11-10, 11-20) "5000"',
    ]);
    // 11-20 is a corroboration endpoint, 11-05 (inside the candidate) is not: a later write
    // "11-12 onwards" with a default end stops at 11-20.
    const later = evaluate(BUDGETS, [...ops, put(30, 31, "2000", ["S_C"], "11-12", "next")]);
    expect(items(later, 31)).toEqual(['f2/0 applied [11-12, 11-20) "2000"']);
  });

  describe("A.2 no-op fields keep no value and stay no-op", () => {
    // Event table: f1 date, f3 amount, f4 note. W2 resends the row and only changes the amount.
    const w1 = row(21, 23, { f1: ["2026-11-01", ["S1"]], f3: ["45", ["S1"]], f4: ["X", ["S1"]] });
    const w2 = row(25, 27, { f3: ["54", ["S2"]] }, { noop: ["f1", "f4"] });

    it("scenario 1, note optional: the note becomes empty", () => {
      const ev = evaluate({ kind: "event", required: ["f3"] }, [w1, w2], ["S1"]);
      expect(ev.exists).toBe(true);
      expect(segs(ev, "f3")).toEqual(['[-inf, inf) "54" by #27/f3/0']);
      expect(segs(ev, "f4")).toEqual(["[-inf, inf) null"]);
      expect(itemsOf(ev, 27)).toEqual(['f3/0 applied [-inf, inf) "54"']);
    });

    it("scenario 1, note required: the row is deleted", () => {
      const ev = evaluate({ kind: "event", required: ["f3", "f4"] }, [w1, w2], ["S1"]);
      expect(ev.exists).toBe(false);
    });

    it("scenario 2: every field no-op", () => {
      const w2noop = row(25, 27, {}, { noop: ["f1", "f3", "f4"] });
      const ev = evaluate({ kind: "event", required: ["f3"] }, [w1, w2noop], ["S1"]);
      expect(ev.exists).toBe(false);
      expect(itemsOf(ev, 27)).toEqual([]);
    });
  });

  describe("A.3 high impact ① and arrival order", () => {
    const a = (op: number) => put(op, op + 1, "3000", [`S${op}`], "11-10", "next", { seen: 10 });
    const b = (op: number) => put(op, op + 1, "3000", [`S${op}`], "11-02", "next", { seen: 10 });

    it("scenario 1: two default ends, different starts, same value", () => {
      const aFirst = evaluate(BUDGETS, [base, a(20), b(22)]);
      const bFirst = evaluate(BUDGETS, [base, b(20), a(22)]);
      expect(items(aFirst, 23)).toEqual(['f2/0 applied [11-02, 11-10) "3000"']);
      expect(items(bFirst, 23)).toEqual(['f2/0 applied [11-10, inf) "3000"']);
      for (const ev of [aFirst, bFirst]) {
        expect(tl(ev)).toEqual(['[10-01, 11-02) "5000"', '[11-02, inf) "3000"']);
      }
    });

    it("scenario 2: two explicit intervals, same value where they meet", () => {
      const A = (op: number) => put(op, op + 1, "3000", [`S${op}`], "11-01", "11-20", { seen: 10 });
      const B = (op: number) => put(op, op + 1, "3000", [`S${op}`], "11-10", "12-01", { seen: 10 });
      for (const ev of [
        evaluate(BUDGETS, [base, A(20), B(22)]),
        evaluate(BUDGETS, [base, B(20), A(22)]),
      ]) {
        expect(ev.items.filter((x) => x.event > 12).map((x) => x.status)).toEqual([
          "applied",
          "applied",
        ]);
        expect(tl(ev)).toEqual([
          '[10-01, 11-01) "5000"',
          '[11-01, 12-01) "3000"',
          '[12-01, inf) "5000"',
        ]);
      }
    });

    it("contrast: erasing a change point the writer saw awaits confirmation", () => {
      const ev = evaluate(BUDGETS, [
        base,
        put(15, 16, "4000", ["S16"], "11-10", "open"),
        put(20, 21, "3000", ["S21"], "11-02", "open"),
      ]);
      expect(items(ev, 21)).toEqual(['f2/0 awaiting [11-02, inf) "3000"']);
    });
  });

  describe("A.4 resolved results changed by a deletion", () => {
    const ops: Op[] = [
      base,
      put(13, 15, "4000", ["S_b"], "11-10", "open"),
      put(16, 18, "3000", ["S_c"], "11-02", "next"),
    ];

    it("scenario 1: the default end extends; undo afterwards reverts the extended whole", () => {
      const ev = evaluate(BUDGETS, ops, ["S_b"]);
      expect(items(ev, 18)).toEqual(['f2/0 applied [11-02, inf) "3000"']);
      expect(segs(ev)).toEqual([
        '[10-01, 11-02) "5000" by #12/f2/0',
        '[11-02, inf) "3000" by #18/f2/0',
      ]);
      const undone = evaluate(BUDGETS, [...ops, undo(40, 42, 16, ack(16))], ["S_b"]);
      expect(tl(undone)).toEqual(['[10-01, inf) "5000"']);
    });

    it("scenario 2: the first creation passes to the next write", () => {
      const w = [
        put(40, 42, "5000", ["S1"], "10-01", "open"),
        put(44, 46, "6000", ["S2"], "10-01", "open"),
      ];
      expect(evaluate(BUDGETS, w).created).toBe(42);
      expect(evaluate(BUDGETS, w, ["S1"]).created).toBe(46);
    });
  });
});

// ---------------------------------------------------------------------------------------------

/** B.1 data: #15 [11-10, ∞) 4000 (S13), #22 [11-02, 11-20) 3000, undo 20 at operation 30. */
const b1: Op[] = [
  base,
  put(13, 15, "4000", ["S13"], "11-10", "open"),
  put(20, 22, "3000", ["S20"], "11-02", "11-20", ack(13)),
  undo(30, 32, 20, ack(20)),
];

/** D.1 data: #25 "3500 from 11-10" stops at 11-20 and covers part of #22 before the undo. */
const d1: Op[] = [
  base,
  put(20, 22, "3000", ["S22"], "11-02", "11-20"),
  put(23, 25, "3500", ["S_X"], "11-10", "next"),
  undo(30, 32, 20, ack(23)),
];

/** D.2 data: two deletions with an undo in between. */
const d2: Op[] = [
  base,
  put(13, 15, "4000", ["S15"], "11-10", "open"),
  put(16, 18, "3000", ["S18"], "11-02", "next"),
  put(19, 21, "4500", ["S21"], "11-20", "open"),
  undo(40, 42, 16, ack(19)),
];

/** C.2 data: the state before the undone write has no value. */
const c2: Op[] = [base, put(20, 22, "3000", ["S22"], "11-02", "11-20"), undo(30, 32, 20, ack(20))];

/** D.3 data (event table): undo of the first time the note was filled. */
const RUNS: TableSchema = { kind: "event", required: ["f1"] };
const d3: Op[] = [
  row(21, 23, { f1: ["2026-11-01", ["S1"]], f3: ["45", ["S1"]] }),
  row(25, 27, { f4: ["X", ["S2"]] }),
  undo(30, 32, 25),
];

describe("appendix B", () => {
  it("B.1 (a): one field, two write-back items, the carried source of one deleted", () => {
    const ev = evaluate(BUDGETS, b1, ["S13"]);
    expect(items(ev, 32)).toEqual([
      'f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0',
      "f2/1 dropped",
    ]);
    expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
  });

  it("B.2 (b): no-op fields, then the old same value deleted", () => {
    // W2 resends the whole row and only changes the amount; date and category are no-op.
    const schema: TableSchema = { kind: "event", required: ["f1", "f2"] };
    const ops: Op[] = [
      row(21, 23, { f1: ["2026-11-01", ["S1"]], f2: ["lunch", ["S1"]], f3: ["45", ["S1"]] }),
      row(25, 27, { f3: ["54", ["S2"]] }, { noop: ["f1", "f2"] }),
    ];
    const ev = evaluate(schema, ops, ["S1"]);
    expect(ev.exists).toBe(false);
    // W2's own item keeps its sources; the row does not exist.
    expect(itemsOf(ev, 27)).toEqual(['f3/0 applied [-inf, inf) "54"']);
  });

  it("B.3 (c), event table: revert, then the reverted write's evidence deleted", () => {
    // Differs from the appendix (it keeps #52's item): 03-deletion «回掉的权威定义» step 7 drops it.
    const schema: TableSchema = { kind: "event", required: ["f3"] };
    const ops: Op[] = [
      row(21, 23, { f3: ["45", ["S1"]] }),
      row(25, 27, { f3: ["54", ["S2"]] }),
      undo(50, 52, 25),
    ];
    expect(items(evaluate(schema, ops), 52)).toEqual([
      'f3/0 applied [-inf, inf) "45" carried #23/f3/0',
    ]);
    const ev = evaluate(schema, ops, ["S2"]);
    expect(items(ev, 52)).toEqual(["f3/0 dropped"]);
    expect(segs(ev, "f3")).toEqual(['[-inf, inf) "45" by #23/f3/0']);
  });

  it("B.3 (c), state table: revert, then the reverted write's evidence deleted", () => {
    const ev = evaluate(BUDGETS, b1, ["S20"]);
    expect(items(ev, 32)).toEqual(["f2/0 dropped", "f2/1 dropped"]);
    expect(segs(ev)).toEqual([
      '[10-01, 11-10) "5000" by #12/f2/0',
      '[11-10, inf) "4000" by #15/f2/0',
    ]);
  });

  it("B.4 (d): evidence of the two kinds of revoke deleted", () => {
    const interval = [base, revoke(20, 22, ["S7"], "11-05", "11-15")];
    expect(gaps(evaluate(BUDGETS, interval))).toBe("[-inf, 10-01) + [11-05, 11-15)");
    const ev = evaluate(BUDGETS, interval, ["S7"]);
    expect(gaps(ev)).toBe("[-inf, 10-01)");
    expect(segs(ev)).toEqual(['[10-01, inf) "5000" by #12/f2/0']);
    // A revoke without an interval is a decision, not content: nothing to delete, still revoked.
    const whole = evaluate(BUDGETS, [base, revoke(20, 22, ["S7"])], ["S7"]);
    expect(whole.exists).toBe(false);
    expect(gaps(whole)).toBe("[-inf, inf)");
  });

  it("B.5: B3's counterexample, a partly conflicting corroboration whose cause is deleted", () => {
    const ops: Op[] = [
      base,
      put(20, 22, "3000", ["S_B"], "11-02", "11-10"),
      put(24, 26, "5000", ["S_A"], "11-05", "11-20", { seen: 10, explicit: true }),
      put(40, 41, "2000", ["S_C"], "11-03", "next"),
    ];
    const ev = evaluate(BUDGETS, ops, ["S_B"]);
    expect(items(ev, 26)).toEqual(['f2/0 corroborated [11-05, 11-20) "5000"', "f2/1 dropped"]);
    // Both corroboration endpoints count: "2000 from 11-03" stops at 11-05.
    expect(items(ev, 41)).toEqual(['f2/0 applied [11-03, 11-05) "2000"']);
  });
});

describe("appendix C", () => {
  const c1: Op[] = [
    base,
    put(13, 15, "4000", ["S13"], "11-10", "open"),
    put(16, 18, "3000", ["S18"], "11-02", "next"),
    put(19, 21, "3500", ["S19"], "11-04", "11-06"),
  ];

  it("C.1: counterexample, two deletions in turn", () => {
    const first = evaluate(BUDGETS, c1, ["S19"]);
    expect(items(first, 18)).toEqual(['f2/0 applied [11-02, 11-10) "3000"']);
    expect(segs(first)).toContain('[11-02, 11-10) "3000" by #18/f2/0');
    const second = evaluate(BUDGETS, c1, ["S19", "S13"]);
    expect(items(second, 18)).toEqual(['f2/0 applied [11-02, inf) "3000"']);
    expect(segs(second)).toEqual([
      '[10-01, 11-02) "5000" by #12/f2/0',
      '[11-02, inf) "3000" by #18/f2/0',
    ]);
  });

  it("C.2: second example, the state before the undone write has no value", () => {
    const ev = evaluate(BUDGETS, c2, ["S12"]);
    expect(items(ev, 32)).toEqual(["f2/0 applied [11-02, 11-20) no_value"]);
    expect(ev.exists).toBe(false);
    expect(gaps(ev)).toBe("[-inf, inf)");
    // #22's item is still registered as reverted by operation 30 over its whole interval.
    const r = ev.items.find((x) => x.event === 22);
    expect(r?.registrations.map((g) => [g.byOp, short([showIv(g.valid)])[0]])).toEqual([
      [30, "[11-02, 11-20)"],
    ]);
  });
});

describe("appendix D", () => {
  it("D.1: counterexample, the write covering the skipped part deleted", () => {
    expect(items(evaluate(BUDGETS, d1), 32)).toEqual([
      'f2/0 applied [11-02, 11-10) "5000" carried #12/f2/0',
    ]);
    const ev = evaluate(BUDGETS, d1, ["S_X"]);
    expect(items(ev, 32)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
    expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
  });

  it("D.2: two deletions with an undo in between", () => {
    // Differs from the appendix ([11-02, 11-20)): 05-time «给出挡点的贡献» counts only earlier contributions.
    const afterFirst = evaluate(BUDGETS, d2, ["S15"]);
    expect(items(afterFirst, 18)).toEqual(['f2/0 applied [11-02, inf) "3000"']);
    expect(items(afterFirst, 42)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
    expect(tl(afterFirst)).toEqual(['[10-01, 11-20) "5000"', '[11-20, inf) "4500"']);
    const ev = evaluate(BUDGETS, d2, ["S15", "S21"]);
    expect(items(ev, 18)).toEqual(['f2/0 applied [11-02, inf) "3000"']);
    expect(items(ev, 42)).toEqual(['f2/0 applied [11-02, inf) "5000" carried #12/f2/0']);
    expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
  });

  it("D.3: no value on an event table", () => {
    expect(items(evaluate(RUNS, d3), 32)).toEqual(["f4/0 applied [-inf, inf) no_value"]);
    const ev = evaluate(RUNS, d3, ["S2"]);
    expect(items(ev, 32)).toEqual(["f4/0 dropped"]);
    expect(segs(ev, "f4")).toEqual(["[-inf, inf) null"]);
  });

  describe("D.4: take_previous then a candidate deleted", () => {
    // Differs from the appendix's "participants" wording: 03-deletion «回掉的权威定义» steps 1–2 and 7.
    const schema: TableSchema = { kind: "event", required: ["f2"] };
    const ops: Op[] = [
      row(33, 35, { f2: ["12", ["S0"]] }),
      row(40, 42, { f2: ["15", ["S40"]] }),
      row(57, 59, { f2: ["5", ["S57"]] }),
      row(60, 61, { f2: ["6", ["S_A"]] }, { seen: 40 }),
      row(62, 63, { f2: ["5.5", ["S_C"]] }, { seen: 33 }),
      takePrevious(70, 72, [61, 63]),
    ];

    it("as written: merge base 33, value 12", () => {
      const ev = evaluate(schema, ops);
      expect(items(ev, 61)).toEqual(['f2/0 candidate [-inf, inf) "6"']);
      expect(items(ev, 63)).toEqual(['f2/0 candidate [-inf, inf) "5.5"']);
      expect(items(ev, 72)).toEqual(['f2/0 applied [-inf, inf) "12" carried #35/f2/0']);
      expect(ev.reverts[0]?.record).toEqual([
        { event: 42, target: "f2" },
        { event: 59, target: "f2" },
      ]);
    });

    it("C deleted: the merge base stays 33", () => {
      const ev = evaluate(schema, ops, ["S_C"]);
      expect(items(ev, 72)).toEqual(['f2/0 applied [-inf, inf) "12" carried #35/f2/0']);
    });

    it("every participant deleted: the write-back is dropped, 12 remains", () => {
      const ev = evaluate(schema, ops, ["S40", "S57", "S_A", "S_C"]);
      expect(items(ev, 72)).toEqual(["f2/0 dropped"]);
      expect(segs(ev, "f2")).toEqual(['[-inf, inf) "12" by #35/f2/0']);
    });

    it("the giver of 12 deleted: no value at the merge base", () => {
      const ev = evaluate(schema, ops, ["S0"]);
      expect(items(ev, 72)).toEqual(["f2/0 applied [-inf, inf) no_value"]);
    });
  });

  describe("D.5: a candidate put back after its item was resolved in the grace period", () => {
    // pre-dev-w6-final-fixes appendix D.5. L in effect; two candidates; the deletion removes
    // candidate 1; the item is resolved in the grace period; the deletion is cancelled. The
    // original item stays resolved; candidate 1 is judged on the state at the cancellation.
    // That is the rule the decision record grace-period-no-decisions.md sets aside for a later
    // version; the first version refuses the grace-period decision (03-deletion «撤回与宽限期»),
    // so these run with `graceDecisions: "allowed"`. The first version's refusal of this
    // resolution is a fixed case of log.test.ts.
    const head = (c1: string, c1Explicit: boolean): Op[] => [
      put(10, 11, "9", ["s11"], "10-01", "open"),
      put(12, 13, "9.5", ["s13"], "10-01", "open"),
      put(14, 15, c1, ["s15"], "10-01", "open", { seen: 10, explicit: c1Explicit }),
      put(16, 17, "8", ["s17"], "10-01", "open", { seen: 10 }),
    ];

    it("different from the value then in effect: a new conflict item", () => {
      const log: LogEntry[] = [
        ...head("10", false),
        del(20, "pi_a", ["s15"]),
        {
          kind: "resolve",
          op: 22,
          event: 23,
          decision: "keep_effective",
          candidates: [17],
          unit: "f2",
        },
        cancel(24, "pi_a"),
      ];
      const ev = evaluateLog(BUDGETS, log, { graceDecisions: "allowed" }).final;
      expect(itemsClosed(ev, 15)).toEqual(['f2/0 candidate [10-01, inf) "10"']);
      expect(itemsClosed(ev, 17)).toEqual(['f2/0 candidate [10-01, inf) "8" (closed)']);
      expect(tl(ev)).toEqual(['[10-01, inf) "9.5"']);
    });

    it("same as the value then in effect, evidence pointed at: a corroboration, no item", () => {
      const log: LogEntry[] = [
        ...head("8", true),
        del(20, "pi_a", ["s15"]),
        {
          kind: "resolve",
          op: 22,
          event: 23,
          decision: "take_candidate",
          candidates: [17],
          unit: "f2",
          take: 17,
        },
        cancel(24, "pi_a"),
      ];
      const ev = evaluateLog(BUDGETS, log, { graceDecisions: "allowed" }).final;
      expect(itemsClosed(ev, 15)).toEqual(['f2/0 corroborated [10-01, inf) "8"']);
      expect(tl(ev)).toEqual(['[10-01, inf) "8"']);
    });
  });
});

// ---------------------------------------------------------------------------------------------

/** E.1 data: L [11-02, 12-01) 3000 in effect, candidate A [11-10, 11-15) 4000, merge base 10. */
const e1: Op[] = [
  base,
  put(20, 22, "3000", ["S22"], "11-02", "12-01"),
  put(25, 27, "4000", ["S27"], "11-10", "11-15", { seen: 10 }),
  takePrevious(40, 41, [27]),
];

/** E.4 data: a revert between the items of a take_previous record. */
const e4: Op[] = [
  base,
  put(20, 22, "3000", ["S22"], "11-02", "11-20"),
  undo(30, 32, 20, ack(20)),
  put(35, 37, "4000", ["S37"], "11-05", "11-10", { seen: 10 }),
  takePrevious(50, 51, [37]),
];

/** E.7 data: include_later reverts a take_previous write-back (proposed at 45, confirmed at 50). */
const e7: Op[] = [
  base,
  put(20, 22, "3000", ["S22"], "11-02", "11-20"),
  put(25, 27, "3500", ["S27"], "11-05", "11-10"),
  put(30, 31, "3600", ["S31"], "11-06", "11-08", { seen: 20 }),
  takePrevious(40, 41, [31]),
  undo(45, 46, 20, { includeLater: true }),
  confirm(50, 52, 46),
];

describe("appendix E", () => {
  it("E.1: counterexample, the side in effect is wider than the item", () => {
    const ev = evaluate(BUDGETS, e1);
    expect(items(ev, 27)).toEqual(['f2/0 candidate [11-10, 11-15) "4000"']);
    expect(items(ev, 41)).toEqual(['f2/0 applied [11-10, 11-15) "5000" carried #12/f2/0']);
    expect(ev.reverts[0]?.record).toEqual([{ event: 22, target: "f2" }]);
    expect(tl(ev)).toEqual([
      '[10-01, 11-02) "5000"',
      '[11-02, 11-10) "3000"',
      '[11-10, 11-15) "5000"',
      '[11-15, 12-01) "3000"',
      '[12-01, inf) "5000"',
    ]);
  });

  it("E.2: the side in effect deleted, the candidate kept", () => {
    const ev = evaluate(BUDGETS, e1, ["S22"]);
    expect(items(ev, 41)).toEqual(["f2/0 dropped"]);
    expect(items(ev, 27)).toEqual(['f2/0 candidate [11-10, 11-15) "4000"']);
    expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
  });

  it("E.3: every candidate deleted", () => {
    const ev = evaluate(BUDGETS, e1, ["S27"]);
    expect(items(ev, 41)).toEqual(["f2/0 dropped"]);
    expect(segs(ev)).toContain('[11-02, 12-01) "3000" by #22/f2/0');
    expect(tl(ev)).toEqual([
      '[10-01, 11-02) "5000"',
      '[11-02, 12-01) "3000"',
      '[12-01, inf) "5000"',
    ]);
  });

  it("E.4: a revert between the items of the revert record", () => {
    const ev = evaluate(BUDGETS, e4);
    expect(ev.reverts.find((r) => r.op === 50)?.record).toEqual([
      { event: 22, target: "f2" },
      { event: 32, target: "f2" },
    ]);
    expect(items(ev, 51)).toEqual(['f2/0 applied [11-05, 11-10) "5000" carried #12/f2/0']);
    expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
    const deleted = evaluate(BUDGETS, e4, ["S22"]);
    expect(items(deleted, 32)).toEqual(["f2/0 dropped"]);
    expect(items(deleted, 51)).toEqual(["f2/0 dropped"]);
    expect(tl(deleted)).toEqual(['[10-01, inf) "5000"']);
  });

  it.each([
    ["B.1", b1, ["S13"], ['[10-01, inf) "5000"']],
    ["B.3", b1, ["S20"], ['[10-01, 11-10) "5000"', '[11-10, inf) "4000"']],
    ["D.1", d1, ["S_X"], ['[10-01, inf) "5000"']],
    ["D.2", d2, ["S15", "S21"], ['[10-01, inf) "5000"']],
  ] as const)("E.5: earlier revert counterexample %s still holds", (_, ops, deleted, expected) => {
    expect(tl(evaluate(BUDGETS, ops, deleted))).toEqual(expected);
  });

  it("E.5: earlier revert counterexamples C.2 and D.3 still hold", () => {
    expect(evaluate(BUDGETS, c2, ["S12"]).exists).toBe(false);
    expect(segs(evaluate(RUNS, d3), "f4")).toEqual(["[-inf, inf) null"]);
  });

  describe("E.6: take_previous on an item targeting existence", () => {
    it("the side in effect is a revoke, the candidate a change", () => {
      const ops: Op[] = [
        base,
        revoke(20, 22, ["S22"], "11-05", "11-15"),
        put(25, 27, "4000", ["S27"], "11-08", "11-12", { seen: 10 }),
        takePrevious(40, 41, [27], "existence"),
      ];
      const ev = evaluate(BUDGETS, ops);
      expect(items(ev, 27)).toEqual(['f2/0 candidate [11-08, 11-12) "4000"']);
      expect(items(ev, 41)).toEqual(["existence/0 applied [11-08, 11-12) restore"]);
      expect(gaps(ev)).toBe("[-inf, 10-01) + [11-05, 11-08) + [11-12, 11-15)");
      expect(tl(ev)).toEqual([
        '[10-01, 11-05) "5000"',
        '[11-08, 11-12) "5000"',
        '[11-15, inf) "5000"',
      ]);
      const deleted = evaluate(BUDGETS, ops, ["S22"]);
      expect(items(deleted, 41)).toEqual(["existence/0 dropped"]);
      expect(tl(deleted)).toEqual(['[10-01, inf) "5000"']);
    });

    it("the side in effect is a change, the candidate a revoke", () => {
      const ops: Op[] = [
        base,
        put(20, 22, "3000", ["S22"], "11-02", "11-20"),
        revoke(25, 27, ["S27"], "11-05", "11-15", 10),
        takePrevious(40, 41, [27], "existence"),
      ];
      const ev = evaluate(BUDGETS, ops);
      expect(items(ev, 27)).toEqual(["existence/0 candidate [11-05, 11-15) revoke"]);
      expect(ev.reverts[0]?.record).toEqual([{ event: 22, target: "f2" }]);
      expect(items(ev, 41)).toEqual(['f2/0 applied [11-05, 11-15) "5000" carried #12/f2/0']);
    });

    it("event table, whole-row revoke", () => {
      const schema: TableSchema = { kind: "event", required: ["f2"] };
      const ops: Op[] = [
        row(10, 12, { f2: ["10", ["S12"]] }),
        revoke(20, 22, ["S22"]),
        row(25, 27, { f2: ["5", ["S27"]] }, { seen: 10 }),
        takePrevious(40, 41, [27], "existence"),
      ];
      const ev = evaluate(schema, ops);
      expect(items(ev, 41)).toEqual(["existence/0 applied [-inf, inf) restore"]);
      expect(ev.exists).toBe(true);
      expect(segs(ev, "f2")).toEqual(['[-inf, inf) "10" by #12/f2/0']);
    });
  });

  it("E.7: include_later reverts a take_previous write-back", () => {
    const ev = evaluate(BUDGETS, e7);
    expect(ev.reverts.find((r) => r.op === 45)?.status).toBe("awaiting");
    expect(ev.reverts.find((r) => r.op === 50)?.record).toEqual([
      { event: 22, target: "f2" },
      { event: 27, target: "f2", later: true },
      { event: 41, target: "f2", later: true },
    ]);
    expect(items(ev, 52)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
    expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
    const deleted = evaluate(BUDGETS, e7, ["S27"]);
    expect(items(deleted, 41)).toEqual(["f2/0 dropped"]);
    expect(items(deleted, 52)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
    expect(tl(deleted)).toEqual(['[10-01, inf) "5000"']);
  });

  it("E.8: a write not in effect at resolution takes effect after a deletion", () => {
    // Z (operation 25) is the cause of Y's separate conflict; it does not touch the item's
    // interval, so the take_previous record is #22 alone, as the appendix states.
    const ops: Op[] = [
      ...e1.slice(0, 2),
      put(25, 25, "2900", ["S_Z"], "11-15", "11-20"),
      put(26, 27, "4000", ["S27"], "11-10", "11-15", { seen: 10 }),
      put(30, 30, "2800", ["S_Y"], "11-12", "11-20", { seen: 20 }),
      takePrevious(40, 41, [27]),
    ];
    const asWritten = evaluate(BUDGETS, ops);
    expect(items(asWritten, 30)).toEqual(['f2/0 candidate [11-12, 11-20) "2800"']);
    expect(asWritten.reverts[0]?.record).toEqual([{ event: 22, target: "f2" }]);
    const ev = evaluate(BUDGETS, ops, ["S_Z"]);
    expect(items(ev, 30)).toEqual(['f2/0 applied [11-12, 11-20) "2800"']);
    expect(items(ev, 41)).toEqual(['f2/0 applied [11-10, 11-12) "5000" carried #12/f2/0']);
    expect(tl(ev)).toEqual([
      '[10-01, 11-02) "5000"',
      '[11-02, 11-10) "3000"',
      '[11-10, 11-12) "5000"',
      '[11-12, 11-20) "2800"',
      '[11-20, 12-01) "3000"',
      '[12-01, inf) "5000"',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("appendix F", () => {
  describe("F.1: X covers part / all of #22, then X deleted", () => {
    const ops = (xFrom: string): Op[] => [
      base,
      put(20, 22, "3000", ["S22"], "11-02", "11-20"),
      put(23, 25, "3500", ["S_X"], xFrom, "11-20"),
      undo(30, 32, 20, ack(23)),
    ];

    it("X covers [11-10, 11-20)", () => {
      expect(items(evaluate(BUDGETS, ops("11-10")), 32)).toEqual([
        'f2/0 applied [11-02, 11-10) "5000" carried #12/f2/0',
      ]);
      const ev = evaluate(BUDGETS, ops("11-10"), ["S_X"]);
      expect(items(ev, 32)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
      expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
    });

    it("X covers all of [11-02, 11-20)", () => {
      const asWritten = evaluate(BUDGETS, ops("11-02"));
      expect(items(asWritten, 32)).toEqual([]);
      expect(asWritten.reverts[0]).toMatchObject({
        status: "applied",
        record: [{ event: 22, target: "f2" }],
      });
      const ev = evaluate(BUDGETS, ops("11-02"), ["S_X"]);
      expect(items(ev, 32)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
      expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
    });
  });

  it("F.2: event table, undo of a change already covered, then deletions on the row", () => {
    const schema: TableSchema = { kind: "event", required: ["f3"] };
    const ops: Op[] = [
      row(21, 23, { f3: ["45", ["S1"]], f4: ["note", ["S_N"]] }),
      row(25, 27, { f3: ["54", ["S2"]] }),
      row(33, 35, { f3: ["60", ["S3"]] }),
      undo(40, 42, 25),
    ];
    expect(items(evaluate(schema, ops), 42)).toEqual([]);
    const unrelated = evaluate(schema, ops, ["S_N"]);
    expect(items(unrelated, 42)).toEqual([]);
    expect(segs(unrelated, "f3")).toEqual(['[-inf, inf) "60" by #35/f3/0']);
    const ev = evaluate(schema, ops, ["S3"]);
    expect(items(ev, 42)).toEqual(['f3/0 applied [-inf, inf) "45" carried #23/f3/0']);
  });

  it("F.3: a write y taking effect later, state table (same as E.8)", () => {
    const ops: Op[] = [
      ...e1.slice(0, 2),
      put(25, 25, "2900", ["S_Z"], "11-15", "11-20"),
      put(26, 27, "4000", ["S27"], "11-10", "11-15", { seen: 10 }),
      put(30, 30, "2800", ["S_Y"], "11-12", "11-20", { seen: 20 }),
      takePrevious(40, 41, [27]),
    ];
    expect(items(evaluate(BUDGETS, ops, ["S_Z"]), 41)).toEqual([
      'f2/0 applied [11-10, 11-12) "5000" carried #12/f2/0',
    ]);
  });

  it("F.3: a write y taking effect later, event table (variant: y is a candidate)", () => {
    // The appendix's y awaits confirmation; on an event table that needs high impact ② (`ref`
    // fields), which this version does not model. Here y is a candidate whose conflict cause Z is
    // deleted; it then covers W2 and the undo writes nothing back.
    const schema: TableSchema = { kind: "event", required: ["f3"] };
    const ops: Op[] = [
      row(21, 23, { f3: ["45", ["S1"]] }),
      row(25, 27, { f3: ["54", ["S2"]] }),
      row(27, 28, { f3: ["57", ["S_Z"]] }),
      row(30, 31, { f3: ["58", ["S_Y"]] }, { seen: 25 }),
      undo(40, 42, 25),
    ];
    expect(items(evaluate(schema, ops), 31)).toEqual(['f3/0 candidate [-inf, inf) "58"']);
    const ev = evaluate(schema, ops, ["S_Z"]);
    expect(items(ev, 31)).toEqual(['f3/0 applied [-inf, inf) "58"']);
    expect(items(ev, 42)).toEqual([]);
    expect(segs(ev, "f3")).toEqual(['[-inf, inf) "58" by #31/f3/0']);
  });

  it.todo(
    "F.3: event and timeless tables exactly as written (y awaiting confirmation needs high impact ② via `ref` fields, not modelled)",
  );

  describe("F.4: two counterexamples", () => {
    it("undo of a revoke whose hole was later filled", () => {
      const ops: Op[] = [
        base,
        revoke(20, 22, ["S22"], "11-05", "11-15"),
        put(25, 27, "3000", ["S27"], "11-08", "11-10"),
        undo(40, 42, 20),
      ];
      const ev = evaluate(BUDGETS, ops);
      expect(items(ev, 42)).toEqual([
        "existence/0 applied [11-05, 11-08) restore",
        "existence/1 applied [11-10, 11-15) restore",
      ]);
      expect(tl(ev)).toEqual([
        '[10-01, 11-08) "5000"',
        '[11-08, 11-10) "3000"',
        '[11-10, inf) "5000"',
      ]);
    });

    it("take_previous with two revokes after the merge base", () => {
      const ops: Op[] = [
        base,
        revoke(20, 21, ["S21"], "11-05", "11-08"),
        revoke(22, 23, ["S23"], "11-10", "11-15"),
        put(25, 27, "4000", ["S27"], "11-06", "11-12", { seen: 10 }),
        takePrevious(40, 41, [27], "existence"),
      ];
      const ev = evaluate(BUDGETS, ops);
      expect(items(ev, 41)).toEqual([
        "existence/0 applied [11-06, 11-08) restore",
        "existence/1 applied [11-10, 11-12) restore",
      ]);
    });
  });

  it("F.5: undo of a restore", () => {
    const ops: Op[] = [
      base,
      revoke(20, 22, ["S22"], "11-05", "11-15"),
      undo(30, 32, 20),
      undo(40, 42, 30),
    ];
    const ev = evaluate(BUDGETS, ops);
    expect(items(ev, 32)).toEqual(["existence/0 applied [11-05, 11-15) restore"]);
    expect(items(ev, 42)).toEqual(["existence/0 applied [11-05, 11-15) revoke"]);
    expect(gaps(ev)).toBe("[-inf, 10-01) + [11-05, 11-15)");
    const deleted = evaluate(BUDGETS, ops, ["S22"]);
    expect(items(deleted, 32)).toEqual(["existence/0 dropped"]);
    expect(items(deleted, 42)).toEqual(["existence/0 dropped"]);
    expect(gaps(deleted)).toBe("[-inf, 10-01)");
  });

  it.each([
    ["B.1", b1, ["S13"], ['[10-01, inf) "5000"']],
    ["B.3", b1, ["S20"], ['[10-01, 11-10) "5000"', '[11-10, inf) "4000"']],
    ["D.1", d1, ["S_X"], ['[10-01, inf) "5000"']],
    ["D.2", d2, ["S15", "S21"], ['[10-01, inf) "5000"']],
    ["E.2", e1, ["S22"], ['[10-01, inf) "5000"']],
    ["E.3", e1, ["S27"], ['[10-01, 11-02) "5000"', '[11-02, 12-01) "3000"', '[12-01, inf) "5000"']],
    ["E.4", e4, [], ['[10-01, inf) "5000"']],
    ["E.7", e7, [], ['[10-01, inf) "5000"']],
  ] as const)(
    "F.6: earlier revert counterexample %s against the pseudocode",
    (_, ops, deleted, expected) => {
      expect(tl(evaluate(BUDGETS, ops, deleted))).toEqual(expected);
    },
  );
});

// ---------------------------------------------------------------------------------------------

/** H.1 / I.1 data: revoke, a fill in the hole, undo of the fill. */
const hole = (fillTo: string, extra: Op[] = [], fillFrom = "11-08"): Op[] => [
  base,
  revoke(20, 22, ["S22"], "11-05", "11-15"),
  put(25, 27, "3000", ["S27"], fillFrom, fillTo, ack(20)),
  ...extra,
  undo(40, 42, 25, ack(Math.max(25, ...extra.map((o) => o.op)))),
];

describe("appendix G", () => {
  it("G.1: undo of a write that filled a hole", () => {
    // Differs from the appendix (`no_value`): 03-deletion «回掉的权威定义» step 6 writes back `uncovered`.
    const ev = evaluate(BUDGETS, hole("11-10"));
    expect(items(ev, 42)).toEqual(["f2/0 applied [11-08, 11-10) uncovered"]);
    expect(gaps(ev)).toBe("[-inf, 10-01) + [11-05, 11-15)");
  });

  it("G.2: an item split in two by a replay, then reverted by another revert", () => {
    // y awaits confirmation because it would erase 11-25 (a change point made by #13); deleting
    // #13's evidence makes y no longer high impact, so it takes effect at its own operation 15.
    const ops: Op[] = [
      base,
      put(12, 13, "4500", ["S13"], "11-25", "open"),
      put(15, 17, "4000", ["S17"], "11-10", "open"),
      put(20, 22, "3000", ["S22"], "11-02", "11-20"),
      undo(30, 32, 20, ack(20)),
      undo(40, 42, 30),
    ];
    const asWritten = evaluate(BUDGETS, ops);
    expect(items(asWritten, 17)).toEqual(['f2/0 awaiting [11-10, inf) "4000"']);
    expect(items(asWritten, 42)).toEqual(['f2/0 applied [11-02, 11-20) "3000" carried #22/f2/0']);
    const ev = evaluate(BUDGETS, ops, ["S13"]);
    expect(items(ev, 17)).toEqual(['f2/0 applied [11-10, inf) "4000"']);
    expect(items(ev, 32)).toEqual([
      'f2/0 applied [11-02, 11-10) "5000" carried #12/f2/0',
      'f2/1 applied [11-10, 11-20) "4000" carried #17/f2/0',
    ]);
    expect(items(ev, 42)).toEqual(['f2/0 applied [11-02, 11-20) "3000" carried #22/f2/0']);
    expect(tl(ev)).toEqual([
      '[10-01, 11-02) "5000"',
      '[11-02, 11-20) "3000"',
      '[11-20, inf) "4000"',
    ]);
  });

  describe("G.3: a pending revert refreshed before confirmation", () => {
    const head: Op[] = [
      base,
      put(20, 22, "3000", ["S22"], "11-02", "11-20"),
      put(25, 27, "3200", ["S_L1"], "11-05", "11-08"),
    ];

    it("confirmation lists its record as of the confirmation", () => {
      const ops: Op[] = [
        ...head,
        undo(30, 32, 20, { includeLater: true }),
        put(33, 35, "3300", ["S_L2"], "11-10", "11-12"),
        confirm(40, 42, 32),
      ];
      const ev = evaluate(BUDGETS, ops);
      expect(ev.reverts.find((r) => r.op === 30)).toMatchObject({
        status: "awaiting",
        record: [
          { event: 22, target: "f2" },
          { event: 27, target: "f2", later: true },
        ],
      });
      expect(ev.reverts.find((r) => r.op === 40)?.record).toEqual([
        { event: 22, target: "f2" },
        { event: 27, target: "f2", later: true },
        { event: 35, target: "f2", later: true },
      ]);
      expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
    });

    it("the other timing: a deletion removes L1 and the revert takes effect at its own number", () => {
      // The undo carries `acknowledge`: without high impact ④ it would still be high impact ①.
      const ops: Op[] = [...head, undo(30, 32, 20, { includeLater: true, ...ack(25) })];
      expect(evaluate(BUDGETS, ops).reverts[0]?.status).toBe("awaiting");
      const ev = evaluate(BUDGETS, ops, ["S_L1"]);
      expect(ev.reverts[0]?.status).toBe("applied");
      expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
    });
  });
});

describe("appendix H", () => {
  it("H.1: the counterexample of this round", () => {
    // Differs from the appendix (no write-back item): 03-deletion «回掉的权威定义» steps 5–7 add `uncovered`.
    const ev = evaluate(BUDGETS, hole("11-10"));
    expect(gaps(ev)).toBe("[-inf, 10-01) + [11-05, 11-15)");
    const both = evaluate(BUDGETS, [...hole("11-10"), undo(50, 52, 20)]);
    expect(items(both, 52)).toEqual(["existence/0 applied [11-05, 11-15) restore"]);
    expect(tl(both)).toEqual(['[10-01, inf) "5000"']);
    const deleted = evaluate(BUDGETS, hole("11-10"), ["S22"]);
    expect(items(deleted, 42)).toEqual(['f2/0 applied [11-08, 11-10) "5000" carried #12/f2/0']);
    expect(tl(deleted)).toEqual(['[10-01, inf) "5000"']);
  });

  it("H.2: take_previous result unchanged (the side in effect and the candidate of E.1)", () => {
    const ev = evaluate(BUDGETS, e1);
    expect(items(ev, 41)).toEqual(['f2/0 applied [11-10, 11-15) "5000" carried #12/f2/0']);
  });

  it("H.3: spot checks", () => {
    // No contribution at all at the value position: `no_value`.
    const noBefore = evaluate(BUDGETS, [
      put(10, 12, "5000", ["S12"], "10-01", "11-01"),
      put(20, 22, "3000", ["S22"], "11-02", "11-20"),
      undo(40, 42, 20, ack(20)),
    ]);
    expect(items(noBefore, 42)).toEqual(["f2/0 applied [11-02, 11-20) no_value"]);
    expect(items(evaluate(RUNS, d3), 32)).toEqual(["f4/0 applied [-inf, inf) no_value"]);
  });
});

describe("appendix I", () => {
  it("I.1: operations 20, 25, 40, 50", () => {
    const ev = evaluate(BUDGETS, hole("11-10"));
    expect(items(ev, 42)).toEqual(["f2/0 applied [11-08, 11-10) uncovered"]);
    const fill = ev.items.find((x) => x.event === 27);
    expect(fill?.registrations.map((g) => [g.byOp, short([showIv(g.valid)])[0]])).toEqual([
      [40, "[11-08, 11-10)"],
    ]);
    const all = evaluate(BUDGETS, [...hole("11-10"), undo(50, 52, 20)]);
    expect(tl(all)).toEqual(['[10-01, inf) "5000"']);
  });

  it("I.2: a record item half inside a revoke, half outside", () => {
    const ev = evaluate(BUDGETS, hole("11-20", [], "11-10"));
    expect(items(ev, 42)).toEqual([
      "f2/0 applied [11-10, 11-15) uncovered",
      'f2/1 applied [11-15, 11-20) "5000" carried #12/f2/0',
    ]);
    expect(gaps(ev)).toBe("[-inf, 10-01) + [11-05, 11-15)");
  });

  it("I.3: a deletion replay changes the range", () => {
    const ops = hole("11-12", [put(30, 31, "2800", ["S_X"], "11-10", "11-12")]);
    expect(items(evaluate(BUDGETS, ops), 42)).toEqual(["f2/0 applied [11-08, 11-10) uncovered"]);
    const ev = evaluate(BUDGETS, ops, ["S_X"]);
    expect(items(ev, 42)).toEqual(["f2/0 applied [11-08, 11-12) uncovered"]);
    expect(gaps(ev)).toBe("[-inf, 10-01) + [11-05, 11-15)");
  });

  // No I.4: not constructible. A corroboration's candidate part takes effect only once the write
  // that split it off is deleted; the parts then land in one segment and merge (09 §5.7).
});
