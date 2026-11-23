// Fixed cases of the deletion replay (D1-b2a–c): what it refuses in this version, the two things
// it keeps from the records as judged when written (a write in effect stays in effect; a no-op
// stays a no-op), people's decisions as recorded, and reverts (R and the value position as
// recorded, the write-backs worked out again). The comparison with the reference evaluator is
// replay-deletion.prop.test.ts.

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type Op } from "@fluxvita/saveslot-reference";
import { EVENT as EVENT_SCHEMA, STATE as STATE_SCHEMA } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp, stateFromRecord, view } from "./judge.ts";
import type { JudgeInput, OpRecord, TableShape, WriteInput } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import { givenByRecords } from "./restate.ts";
import { deletedContributions, judged } from "./scenarios.fixture.ts";
import { EVERYTHING, type RowState } from "./state.ts";
import { judgeWrite } from "./write.ts";

const STATE: TableShape = {
  kind: "state",
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
};

const d = (md: string) => `2026-${md}` as BizPoint;

function write(
  op: number,
  fields: Record<string, FieldValue>,
  o: { seen?: number; from?: string } = {},
): WriteInput {
  const fs: Partial<Record<FieldId, { value: FieldValue }>> = {};
  for (const [f, v] of Object.entries(fields)) fs[f as FieldId] = { value: v };
  return {
    kind: "write",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    seen: o.seen ?? op - 1,
    seenExplicit: true,
    valid: {
      from: { mode: "given", value: d(o.from ?? "10-01") },
      to: { mode: "open" },
    },
    now: d("11-05"),
    fields: fs,
  };
}

function run(inputs: readonly JudgeInput[]): { state: RowState; records: OpRecord[] } {
  let state = emptyState(STATE);
  const records: OpRecord[] = [];
  for (const i of inputs) {
    const r = judgeOp(state, i);
    records.push(r.judgement.record);
    state = r.state;
  }
  return { state, records };
}

function refusal(f: () => unknown): JudgeError {
  try {
    f();
  } catch (e) {
    if (e instanceof JudgeError) return e;
    throw e;
  }
  throw new Error("not refused");
}

const values = (state: RowState, f: FieldId) =>
  (view(state).fields[f] ?? []).map((s) => [s.valid[0]?.from ?? null, s.value]);

// 05-time «写状态» example: 10-01 起 5000 (#10), 11-10 起 4000 (#20); #30 from 11-02 open erases
// the change point and awaits.
const awaiting = [
  write(10, { f2: "5000" }, { seen: 0 }),
  { ...write(20, { f2: "4000" }, { from: "11-10" }), acknowledge: true as const },
  write(30, { f2: "3000" }, { from: "11-02" }),
];
const decision = (kind: "confirm" | "reject"): JudgeInput => ({
  kind,
  op: 40,
  index: 0,
  event: 41,
  ruleset: 1,
  target: 31,
});

/** A reference-evaluator write on f2, its value with a source of its own (`S<op>`). */
function refWrite(
  op: number,
  seen: number,
  from: string,
  to: string | null,
  v: string,
  o: { explicit?: true; ack?: true } = {},
): Op {
  return {
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: {
      from: { mode: "given", value: d(from) },
      to: to === null ? { mode: "open" } : { mode: "given", value: d(to) },
    },
    fields: { f2: { value: v, sources: [`S${op}`], ...(o.explicit ? { explicit: true } : {}) } },
    ...(o.ack ? { acknowledge: ["overwrite"] as const } : {}),
  };
}

/**
 * The log judged op by op, then the given source data deleted: the kernel's replay (given the
 * (event, target) those sources take away) and the reference evaluator's, the f2 values of each.
 */
function sideBySide(
  ops: readonly Op[],
  sources: readonly string[],
  contributions: readonly string[],
  schema = STATE_SCHEMA,
) {
  const { table, steps } = judged(schema, ops, []);
  expect(steps).toHaveLength(ops.length);
  const records = steps.map((x) => x.judgement.record);
  // The (event, target) the case lists must be what the deleted sources take away by the rule
  // (`base_sources`): a write on a state table mapping no evidence to its interval loses every
  // target with any of its evidence.
  const kept = steps.map((x) => x.op);
  expect(new Set(contributions)).toEqual(
    deletedContributions(kept, new Set(sources), schema.kind === "state"),
  );
  const after = replayDeletion(table, records, new Set(contributions));
  // The reference evaluates the ops as judged (`judged` gives a resolution the item's open
  // candidates), so both sides read the same log.
  // After every operation and event of the log: a deletion event has a number of its own.
  const last = Math.max(...kept.map((o) => Math.max(o.op, o.event)));
  const ref = evaluateLog(schema, [
    ...kept,
    { kind: "deletion", op: last + 1, id: "pi_x", sources: [...sources] },
  ]).final;
  // Each change of value, from where it starts: stretches of one value given by different
  // items (a write-back carrying the value of the item below) are one stretch here.
  const vals = (fields: Readonly<Record<string, unknown>>) => {
    const out: [string | null, unknown][] = [];
    for (const x of (fields["f2"] ?? []) as {
      valid: { from: string | null; to: string | null }[];
      value: unknown;
    }[]) {
      const prev = out.at(-1);
      if (x.value === null) {
        out.push([x.valid[0]?.from ?? null, null]);
      } else if (prev === undefined || prev[1] !== x.value) {
        out.push([x.valid[0]?.from ?? null, x.value]);
      }
    }
    return out.filter(([, v]) => v !== null);
  };
  return {
    records,
    after,
    kernel: vals(view(after.state).fields),
    ref: vals(ref.fields),
    refFinal: ref,
  };
}

describe("what this version refuses", () => {
  it("an undecided awaiting undo no longer of high impact: not_implemented (high impact ④ again)", () => {
    // #40 undoes #20 with include_later (acknowledging what it erases, so not ①): #30 overlaps it,
    // so ④ makes it await. #30's value deleted: nothing later to take back, the undo would take
    // effect at its own number.
    const ops: Op[] = [
      refWrite(10, 0, "10-01", null, "1"),
      refWrite(20, 10, "11-01", "11-05", "2"),
      // Acknowledging the change point at 11-05 it erases: applied, not awaiting.
      refWrite(30, 20, "11-03", "11-09", "3", { ack: true }),
      {
        kind: "undo",
        op: 40,
        event: 41,
        target: 20,
        includeLater: true,
        seen: 39,
        acknowledge: ["overwrite"],
      },
    ];
    const { table, steps } = judged(STATE_SCHEMA, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(records[3]).toMatchObject({ kind: "undo", status: "awaiting" });
    const e = refusal(() => replayDeletion(table, records, new Set([contributionKey(31, "f2")])));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ kind: "undo no longer of high impact", op: 40 });
    // Still of high impact (#20's value deleted instead): the proposal awaits, nothing refused.
    const kept = replayDeletion(table, records, new Set([contributionKey(11, "f2")]));
    expect(kept.records.find((r) => r.op === 40)).toMatchObject({ status: "awaiting" });
  });

  it("a write whose interval block is gone, with a target left: not_implemented", () => {
    const { records } = run([write(10, { f2: "1" })]);
    const gone = records.map((r) => ({ ...r, validGone: true as const }));
    const e = refusal(() => replayDeletion(STATE, gone, new Set()));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ op: 10 });
    // Every target of it deleted: nothing of it is left, nothing to refuse.
    expect(replayDeletion(STATE, gone, new Set([contributionKey(11, "f2")])).records).toEqual([]);
  });

  it("an operation after a deletion event: not_implemented", () => {
    const { records } = run(awaiting.slice(0, 2));
    expect(replayDeletion(STATE, records, new Set(), [25]).records).toHaveLength(2);
    const e = refusal(() => replayDeletion(STATE, records, new Set(), [15]));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ op: 20 });
  });
});

describe("people's confirmations and rejections, as recorded (deviation one)", () => {
  // #20's value deleted: #30 erases no recorded change point any more.
  const gone20 = new Set([contributionKey(21, "f2")]);

  it("a confirmed write no longer of high impact still awaits, and takes effect at the confirmation", () => {
    const { records } = run([...awaiting, decision("confirm")]);
    const after = replayDeletion(STATE, records, gone20);
    expect(after.records.map((r) => [r.op, r.kind])).toEqual([
      [10, "write"],
      [30, "write"],
      [40, "confirm"],
    ]);
    expect(after.records[1]).toMatchObject({ items: [{ target: "f2", status: "awaiting" }] });
    expect(after.records[2]).toMatchObject({
      items: [{ target: "f2", status: "applied", carried: [{ event: 31, target: "f2", k: 0 }] }],
    });
    expect(values(after.state, "f2")).toEqual([
      [d("10-01"), "5000"],
      [d("11-02"), "3000"],
    ]);
  });

  it("a rejected write takes effect in no replay, though nothing makes it await now", () => {
    const { records } = run([...awaiting, decision("reject")]);
    const after = replayDeletion(STATE, records, gone20);
    expect(after.records[1]).toMatchObject({ items: [{ target: "f2", status: "awaiting" }] });
    expect(after.records[2]).toMatchObject({ kind: "reject", target: 31 });
    expect(values(after.state, "f2")).toEqual([[d("10-01"), "5000"]]);
  });

  it.each(["confirm", "reject"] as const)(
    "a %s of a write nothing of which is left leaves nothing",
    (kind) => {
      const { records } = run([...awaiting, decision(kind)]);
      const after = replayDeletion(STATE, records, new Set([contributionKey(31, "f2")]));
      expect(after.records.map((r) => r.op)).toEqual([10, 20]);
      expect(values(after.state, "f2")).toEqual([
        [d("10-01"), "5000"],
        [d("11-10"), "4000"],
      ]);
    },
  );
});

describe("a rejection of a write with a target in a conflict item when rejected", () => {
  // #30 did not see #25: on f2 a candidate (conflict with #25); on f3 it erases #20's change point
  // at 11-10 and awaits. #40 rejects it: the awaiting item; f2 is in the conflict item.
  const log = [
    write(10, { f2: "5000", f3: "a" }, { seen: 0 }),
    { ...write(20, { f3: "b" }, { from: "11-10" }), acknowledge: true as const },
    write(25, { f2: "6000" }, { from: "10-20" }),
    write(30, { f2: "7000", f3: "c" }, { seen: 20, from: "11-02" }),
    { ...decision("reject"), target: 31 },
  ];
  // The same log for the reference evaluator, each field's value with a source of its own.
  const refWrite = (
    op: number,
    seen: number,
    from: string,
    fields: Record<string, string>,
    ack = false,
  ): Op => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    now: d("11-05"),
    valid: { from: { mode: "given", value: d(from) }, to: { mode: "open" } },
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, value]) => [f, { value, sources: [`S${op}${f}`] }]),
    ),
    ...(ack ? { acknowledge: ["overwrite"] as const } : {}),
  });
  const refLog: Op[] = [
    refWrite(10, 0, "10-01", { f2: "5000", f3: "a" }),
    refWrite(20, 19, "11-10", { f3: "b" }, true),
    refWrite(25, 24, "10-20", { f2: "6000" }),
    refWrite(30, 20, "11-02", { f2: "7000", f3: "c" }),
    { kind: "reject", op: 40, event: 41, target: 31 },
  ];
  /** The kernel's replay and the reference evaluator's, side by side: #30's items, the values. */
  const both = (sources: string[], contributions: string[]) => {
    const after = replayDeletion(STATE, run(log).records, new Set(contributions));
    const ref = evaluateLog(STATE_SCHEMA, [
      ...refLog,
      { kind: "deletion", op: 50, id: "pi_x", sources },
    ]).final;
    const of = (items: readonly { event: number; target: string; status: string }[]) =>
      items
        .filter((x) => x.event === 31)
        .map((x) => [x.target, x.status])
        .sort();
    const vals = (fields: Readonly<Record<string, unknown>>) =>
      ["f2", "f3"].map((f) =>
        ((fields[f] ?? []) as { valid: { from: string | null }[]; value: unknown }[])
          .filter((x) => x.value !== null)
          .map((x) => [x.valid[0]?.from ?? null, x.value]),
      );
    return {
      kernel: { items: of(after.state.items), values: vals(view(after.state).fields) },
      ref: { items: of(ref.items), values: vals(ref.fields) },
    };
  };

  it("as judged: f2 a candidate, f3 awaiting and rejected", () => {
    const { records } = run(log);
    expect(records[3]).toMatchObject({
      items: [
        { target: "f2", status: "candidate" },
        { target: "f3", status: "awaiting" },
      ],
    });
  });

  it("the conflict and the high impact gone: f2 takes no effect, it awaits and the rejection closes it", () => {
    const { records } = run(log);
    // #25's value and #20's change point deleted: nothing makes #30 a candidate or await now.
    const after = replayDeletion(
      STATE,
      records,
      new Set([contributionKey(26, "f2"), contributionKey(21, "f3")]),
    );
    const w = after.records.find((r) => r.op === 30);
    expect(w).toMatchObject({
      items: [
        { target: "f2", status: "awaiting" },
        { target: "f3", status: "awaiting" },
      ],
    });
    expect(after.records.find((r) => r.op === 40)).toMatchObject({ kind: "reject", target: 31 });
    expect(after.state.resolvedAwaiting(31)).toBe(true);
    expect(after.state.items.filter((x) => x.status === "candidate")).toEqual([]);
    expect(values(after.state, "f2")).toEqual([[d("10-01"), "5000"]]);
    expect(values(after.state, "f3")).toEqual([[d("10-01"), "a"]]);
    const b = both(["S25f2", "S20f3"], [contributionKey(26, "f2"), contributionKey(21, "f3")]);
    expect(b.kernel).toEqual(b.ref);
  });

  it("the conflict still there: f2 stays the candidate it was, in its conflict item", () => {
    const { records } = run(log);
    const after = replayDeletion(STATE, records, new Set([contributionKey(21, "f3")]));
    expect(after.records.find((r) => r.op === 30)).toMatchObject({
      items: [
        { target: "f2", status: "candidate" },
        { target: "f3", status: "awaiting" },
      ],
    });
    expect(values(after.state, "f2")).toEqual([
      [d("10-01"), "5000"],
      [d("10-20"), "6000"],
    ]);
    const b = both(["S20f3"], [contributionKey(21, "f3")]);
    expect(b.kernel).toEqual(b.ref);
  });
});

describe("what the replay keeps from the records", () => {
  it("a target protected by deviation two is judged without the conflict step", () => {
    // #20 did not see #10 and writes another value over it: a conflict when judged now.
    const { state } = run([write(10, { f2: "1" })]);
    const stale = write(20, { f2: "2" }, { seen: 0 });
    expect(judgeWrite(state, stale).items.map((x) => x.status)).toEqual(["candidate"]);
    const kept = judgeWrite(state, stale, {
      noop: new Set(),
      protect: new Set(["f2"]),
      decided: new Set(),
      rejected: false,
    });
    expect(kept.items.map((x) => x.status)).toEqual(["applied"]);
  });

  it("a field judged a no-op when written stays a no-op once what it agreed with is gone", () => {
    const { state, records } = run([write(10, { f2: "1" }), write(20, { f2: "1", f3: "x" })]);
    expect(records[1]).toMatchObject({ noop: ["f2"] });
    expect(values(state, "f2")).toEqual([[d("10-01"), "1"]]);
    const after = replayDeletion(STATE, records, new Set([contributionKey(11, "f2")]));
    // f2 is not written again: the row lacks its required field (a gap), f3 is still applied.
    expect(view(after.state).gaps).toEqual([{ from: null, to: null }]);
    expect(after.records).toHaveLength(1);
    expect(after.records[0]).toMatchObject({
      op: 20,
      noop: ["f2"],
      items: [{ target: "f3", status: "applied", content: { kind: "value", value: "x" } }],
    });
  });

  it("an operation nothing of which is left has no record", () => {
    const { records } = run([write(10, { f2: "1" }), write(20, { f3: "x" })]);
    const after = replayDeletion(STATE, records, new Set([contributionKey(21, "f3")]));
    expect(after.records.map((r) => r.op)).toEqual([10]);
  });
});

describe("deviation two on an event table", () => {
  // #10 f2=1 (S10); #20 points at evidence for the same value, having seen #10: a corroboration;
  // #25 changes f3; #30 writes f2=5 having seen #10: applied when written (#20 changed nothing).
  // S10 deleted: #20 is now a change between #30's `ver` and #30. Protected, #30 stays applied.
  const ops: Op[] = [
    { kind: "write", op: 10, event: 11, seen: 0, fields: { f2: { value: "1", sources: ["S10"] } } },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      fields: { f2: { value: "1", sources: ["S20"], explicit: true } },
    },
    {
      kind: "write",
      op: 25,
      event: 26,
      seen: 20,
      fields: { f3: { value: "y", sources: ["S25"] } },
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 10,
      fields: { f2: { value: "5", sources: ["S30"] } },
    },
  ];
  const status = (st: RowState, event: number, target: string) =>
    st.items.filter((x) => x.event === event && x.target === target).map((x) => x.status);

  it("a write in effect when written stays in effect, as the reference evaluator gives", () => {
    const { table, steps } = judged(EVENT_SCHEMA, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(status(steps.at(-1)?.state as RowState, 21, "f2")).toEqual(["corroborated"]);
    expect(status(steps.at(-1)?.state as RowState, 31, "f2")).toEqual(["applied"]);
    const after = replayDeletion(table, records, new Set([contributionKey(11, "f2")]));
    expect(status(after.state, 21, "f2")).toEqual(["applied"]);
    expect(status(after.state, 31, "f2")).toEqual(["applied"]);
    const ref = evaluateLog(EVENT_SCHEMA, [
      ...ops,
      { kind: "deletion", op: 40, id: "pi_x", sources: ["S10"] },
    ]).final;
    expect(ref.items.filter((x) => x.event === 31).map((x) => x.status)).toEqual(["applied"]);
    // Not protected (a candidate when written): judged again, the same write is a candidate.
    const unprotected = records.map((r) =>
      r.kind === "write" && r.op === 30
        ? { ...r, items: r.items.map((x) => ({ ...x, status: "candidate" as const })) }
        : r,
    );
    const naive = replayDeletion(table, unprotected, new Set([contributionKey(11, "f2")]));
    expect(status(naive.state, 31, "f2")).toEqual(["candidate"]);
  });
});

describe("an interval block not there to read: judged as an explicit interval", () => {
  // #20 gave an explicit open interval from 11-01; #30, not having seen #20, writes another value
  // with a default end from 11-03. Two default ends starting apart would not conflict; an explicit
  // interval met by the seen interval does.
  const next = (op: number, seen: number, v: string, from: string): WriteInput => ({
    ...write(op, { f2: v }, { seen, from }),
    valid: { from: { mode: "given", value: d(from) }, to: { mode: "next_change" } },
  });

  it("the block there: a candidate; the block gone (validGone): still a candidate, not a default end", () => {
    const { records } = run([write(10, { f2: "1" }), write(20, { f2: "2" }, { from: "11-01" })]);
    const gone = records.map((r) =>
      r.op === 20 && r.kind === "write"
        ? (() => {
            const { valid: _, ...rest } = r;
            return { ...rest, validGone: true as const };
          })()
        : r,
    );
    const statusOf = (rs: readonly OpRecord[]) => {
      const r = judgeOp(stateFromRecord(STATE, rs), next(30, 10, "3", "11-03")).judgement.record;
      return r.kind === "write" ? r.items.map((x) => x.status) : [];
    };
    expect(statusOf(records)).toEqual(["candidate"]);
    expect(statusOf(gone)).toEqual(["candidate"]);
  });
});

describe("reverts, R and the value position as recorded (03-deletion «回掉的权威定义»)", () => {
  // 03-deletion «例（回退）»: #101 [10-01, ∞) 5000; #103 [11-10, ∞) 4000 (S103); #109 changes
  // [11-10, 11-20) to 4500; #111 undoes #109, writing #103's 4000 back there. S103 deleted: the
  // undo is as recorded, the value it goes back to is the one before #109 in the replay, #101's
  // 5000, not 4500. 5000 throughout; the change points at 11-10 and 11-20 are gone.
  const ops: Op[] = [
    refWrite(100, 0, "10-01", null, "5000"),
    refWrite(102, 100, "11-10", null, "4000"),
    refWrite(108, 102, "11-10", "11-20", "4500"),
    // Acknowledging the change point at 11-20 it erases (05-time «高影响写入» ①): applied.
    { kind: "undo", op: 110, event: 111, target: 108, seen: 109, acknowledge: ["overwrite"] },
  ];

  it("the example: back to 5000, not 4500", () => {
    const b = sideBySide(ops, ["S102"], [contributionKey(103, "f2")]);
    expect(b.records[3]).toMatchObject({
      kind: "undo",
      status: "applied",
      items: [{ target: "f2", content: { kind: "value", value: "4000" } }],
    });
    expect(b.kernel).toEqual([[d("10-01"), "5000"]]);
    expect(b.ref).toEqual(b.kernel);
    const undo = b.after.records.find((r) => r.op === 110);
    expect(undo).toMatchObject({
      kind: "undo",
      status: "applied",
      revert: { entries: [{ event: 109, target: "f2" }], before: 108 },
      items: [
        {
          target: "f2",
          status: "applied",
          valid: [{ from: d("11-10"), to: d("11-20") }],
          content: { kind: "value", value: "5000" },
          carried: [{ event: 101, target: "f2", k: 0 }],
        },
      ],
    });
  });

  it("an undo of the undo: #109's 4500 back, by the write-back", () => {
    const again: Op[] = [
      ...ops,
      { kind: "undo", op: 112, event: 113, target: 110, seen: 111, acknowledge: ["overwrite"] },
    ];
    const b = sideBySide(again, ["S102"], [contributionKey(103, "f2")]);
    expect(b.kernel).toEqual([
      [d("10-01"), "5000"],
      [d("11-10"), "4500"],
      [d("11-20"), "5000"],
    ]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("the undone write's own value deleted: R' is empty, no write-back, the undo gives nothing", () => {
    const b = sideBySide(ops, ["S108"], [contributionKey(109, "f2")]);
    expect(b.after.records.find((r) => r.op === 110)).toMatchObject({ items: [] });
    expect(b.kernel).toEqual([
      [d("10-01"), "5000"],
      [d("11-10"), "4000"],
    ]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("a confirmed undo: executed at the confirmation, with the record listed then", () => {
    // #20's change point at 11-10 erased by undoing it: ①, the undo awaits; #50 confirms it.
    const confirmed: Op[] = [
      refWrite(10, 0, "10-01", null, "1"),
      refWrite(20, 10, "11-10", null, "2"),
      refWrite(30, 20, "11-20", null, "3"),
      { kind: "undo", op: 40, event: 41, target: 20, seen: 39 },
      { kind: "confirm", op: 50, event: 51, target: 41 },
    ];
    const plain = judged(STATE_SCHEMA, confirmed, []);
    expect(plain.steps.map((x) => x.judgement.record.kind)).toEqual([
      "write",
      "write",
      "write",
      "undo",
      "confirm",
    ]);
    expect(plain.steps[3]?.judgement.record).toMatchObject({ status: "awaiting" });
    // #10's value deleted: before #20 there is no value; the write-back on [11-10, 11-20) is
    // "no value at all".
    const b = sideBySide(confirmed, ["S10"], [contributionKey(11, "f2")]);
    expect(b.after.records.find((r) => r.op === 50)).toMatchObject({
      kind: "confirm",
      items: [{ target: "f2", status: "applied", content: { kind: "no_value" } }],
    });
    expect(b.kernel).toEqual([[d("11-20"), "3"]]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("a whole revoke whose evidence is deleted: the row stays revoked (its evidence is the operation's, not the interval's)", () => {
    // Event table: #10 creates the row; #20 revokes it, citing S20 as the operation's evidence
    // (not as interval sources: a whole revoke has no interval). Deleting S20 takes away no
    // (event, target) of the revoke.
    const ev: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] } },
      },
      { kind: "revoke", op: 20, event: 21, seen: 10 },
    ];
    const b = sideBySide(ev, ["S20"], [], EVENT_SCHEMA);
    expect(view(b.after.state).exists).toBe(false);
    expect(b.refFinal.exists).toBe(false);
  });
});

describe("take_previous: R and the merge base as recorded, K the recorded candidates still candidates", () => {
  // #5 f2=0; #10 and #20 both saw #5 and write 1 and 2: #20 is a candidate against #10. #40 takes
  // the previous value for the item: back to 0 at the merge base (#5), where #20's candidate lies.
  const ops: Op[] = [
    refWrite(5, 0, "10-01", null, "0"),
    refWrite(10, 5, "10-01", null, "1"),
    refWrite(20, 5, "10-01", null, "2"),
    { kind: "resolve", op: 40, event: 41, decision: "take_previous", candidates: [21], unit: "f2" },
  ];

  it("a deletion elsewhere: the write-back as recorded, back to 0", () => {
    const b = sideBySide(ops, [], []);
    expect(b.records[3]).toMatchObject({ kind: "take_previous", status: "applied" });
    expect(b.after.records.find((r) => r.op === 40)).toMatchObject({
      kind: "take_previous",
      items: [{ target: "f2", status: "applied", content: { kind: "value", value: "0" } }],
    });
    expect(b.kernel).toEqual([[d("10-01"), "0"]]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("the candidate's value deleted: K is empty, the domain too; no write-back, #10 in effect", () => {
    const b = sideBySide(ops, ["S20"], [contributionKey(21, "f2")]);
    expect(b.after.records.find((r) => r.op === 40)).toMatchObject({ items: [] });
    expect(b.kernel).toEqual([[d("10-01"), "1"]]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("the candidate's conflict gone (#10's value deleted): still the candidate it closed, the write-back as recorded", () => {
    // Deviation one: the resolution decided #20's candidate; it stays that candidate whether or
    // not the conflict is still there, and the take_previous still goes back to the merge base.
    const b = sideBySide(ops, ["S10"], [contributionKey(11, "f2")]);
    const twenty = b.after.state.items.filter((x) => x.event === 21);
    expect(twenty.map((x) => x.status)).toEqual(["candidate"]);
    expect(b.after.state.closedCandidate(21, "f2")).toBe(true);
    expect(b.kernel).toEqual([[d("10-01"), "0"]]);
    expect(b.ref).toEqual(b.kernel);
    expect(b.refFinal.items.filter((x) => x.event === 21).map((x) => [x.status, x.closed])).toEqual(
      [["candidate", true]],
    );
  });
});

describe("take_previous: a candidate the same as the value before it in the replay still counts in K", () => {
  // Found by the comparison (seed -2129645392). #40 (1, evidence pointed at) did not see #20 and
  // #30: a candidate on [11-01, 11-03) and [11-07, 11-09), a corroboration of #10 between. #60 (9)
  // is a candidate too; #63 takes the previous value for both. S20 and S60 deleted (#20 and #60):
  // #40 on [11-01, 11-07) is the same as #10 now, a corroboration, still in K (03-deletion
  // «回掉的权威定义» step 2: only being deleted takes a candidate out), so the domain stays
  // [11-01, 11-09).
  const ops: Op[] = [
    refWrite(10, 0, "10-01", null, "1", { ack: true }),
    refWrite(20, 10, "11-01", "11-03", "2", { ack: true }),
    refWrite(30, 20, "11-07", "11-09", "2", { ack: true }),
    refWrite(40, 10, "11-01", "11-09", "1", { explicit: true }),
    refWrite(60, 20, "11-01", "11-09", "9"),
    {
      kind: "resolve",
      op: 63,
      event: 64,
      decision: "take_previous",
      candidates: [41, 61],
      unit: "f2",
    },
  ];

  it("the write-back over the whole domain, as the reference evaluator gives", () => {
    const b = sideBySide(
      ops,
      ["S20", "S60"],
      [contributionKey(21, "f2"), contributionKey(61, "f2")],
    );
    const taken = b.after.records.find((r) => r.op === 63);
    expect(taken).toMatchObject({
      items: [{ target: "f2", status: "applied", valid: [{ from: d("11-01"), to: d("11-09") }] }],
    });
    const refTaken = b.refFinal.items.filter((x) => x.event === 64).map((x) => x.valid);
    expect(refTaken).toEqual([[{ from: d("11-01"), to: d("11-09") }]]);
    expect(b.ref).toEqual(b.kernel);
  });
});

describe("review cases (an awaiting undo on a revoked row; event-table deps; K's filter; an applied undo)", () => {
  it("an undecided awaiting undo that would take effect on a revoked row: its own not_implemented kind", () => {
    // Event table: #10 creates f2 and f3; #20 writes f3; #30 revokes the row; #40 undoes #20 with
    // include_later (the revoke over it, ④): awaiting. S20 deleted: nothing later to take back, it
    // would take effect, and once written the row is still revoked (03-deletion «回掉的权威定义»
    // step 4): the reference has it rejected, revoked.
    const ops: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f3: { value: "b", sources: ["S20"] } },
      },
      { kind: "revoke", op: 30, event: 31, seen: 20 },
      { kind: "undo", op: 40, event: 41, target: 20, includeLater: true },
    ];
    const { table, steps } = judged(EVENT_SCHEMA, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(records[3]).toMatchObject({ kind: "undo", status: "awaiting" });
    const e = refusal(() => replayDeletion(table, records, new Set([contributionKey(21, "f3")])));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ kind: "undo on a revoked row", op: 40 });
    const ref = evaluateLog(EVENT_SCHEMA, [
      ...steps.map((x) => x.op),
      { kind: "deletion", op: 50, id: "pi_x", sources: ["S20"] },
    ]).final;
    expect(ref.reverts).toMatchObject([{ op: 40, status: "rejected", reason: "revoked" }]);
  });

  it.each([
    ["state", STATE_SCHEMA],
    ["event", EVENT_SCHEMA],
  ] as const)(
    "%s table: with nothing deleted, every replayed record is the logged one, deps included",
    (_, schema) => {
      // An undo, a confirmed undo and a take_previous; nothing deleted: the replay gives back the
      // records as logged (an event table keeps no deps, as every judged record).
      const ops: Op[] = [
        refWrite(5, 0, "10-01", null, "0"),
        refWrite(10, 5, "10-01", null, "1"),
        refWrite(20, 5, "10-01", null, "2"),
        {
          kind: "resolve",
          op: 25,
          event: 26,
          decision: "take_previous",
          candidates: [21],
          unit: "f2",
        },
        refWrite(30, 26, "11-10", null, "3", { ack: true }),
        { kind: "undo", op: 40, event: 41, target: 30, seen: 39, acknowledge: ["overwrite"] },
        refWrite(50, 41, "11-12", null, "4", { ack: true }),
        { kind: "undo", op: 60, event: 61, target: 50, seen: 59 },
        { kind: "confirm", op: 70, event: 71, target: 61 },
      ];
      const { table, steps } = judged(schema, ops, []);
      const records = steps.map((x) => x.judgement.record);
      const kinds = records.map((r) => r.kind);
      expect(kinds).toContain("take_previous");
      expect(kinds).toContain("undo");
      // On a state table #60 erases a change point and awaits: the confirmation executes it.
      if (schema === STATE_SCHEMA) expect(kinds).toContain("confirm");
      expect(replayDeletion(table, records, new Set()).records).toEqual(records);
    },
  );
});

describe("K's filter (03-deletion «回掉的权威定义» step 2), against the reference", () => {
  // #20, having seen #10, writes f2 = 1 (evidence pointed at: a corroboration of #10) and f3 = b
  // over [11-01, 11-05); #25 writes f2 = 7 over [11-01, 11-03); #40, having seen only #10, writes
  // f2 = 1 (evidence pointed at) and f3 = c over [11-01, 11-05): f2 is a candidate on
  // [11-01, 11-03) (7 there now) and a corroboration on [11-03, 11-05); f3 a candidate on the
  // whole. #50 takes the previous value for the item on f2 alone: K is #41's f2 candidate, its
  // domain [11-01, 11-03); #21's corroboration, in R, is taken back there only.
  const span2 = (from: string, to: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: { mode: "given" as const, value: d(to) },
  });
  const ops: Op[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
      fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10f3"] } },
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: span2("11-01", "11-05"),
      fields: {
        f2: { value: "1", sources: ["S20"], explicit: true },
        f3: { value: "b", sources: ["S20f3"] },
      },
      acknowledge: ["overwrite"],
    },
    refWrite(25, 20, "11-01", "11-03", "7", { ack: true }),
    {
      kind: "write",
      op: 40,
      event: 41,
      seen: 10,
      valid: span2("11-01", "11-05"),
      fields: {
        f2: { value: "1", sources: ["S40"], explicit: true },
        f3: { value: "c", sources: ["S40f3"] },
      },
    },
    { kind: "resolve", op: 50, event: 51, decision: "take_previous", candidates: [41], unit: "f2" },
  ];
  /** The take_previous's write-backs on f2, kernel and reference, by interval. */
  const writeBacks = (b: ReturnType<typeof sideBySide>) => ({
    kernel: b.after.state.items
      .filter((x) => x.event === 51 && x.target === "f2")
      .map((x) => x.valid),
    ref: b.refFinal.items.filter((x) => x.event === 51 && x.target === "f2").map((x) => x.valid),
  });

  it("as judged: f2 a candidate and a corroboration, f3 a candidate; the take_previous decided (41, f2) only", () => {
    const { steps } = judged(STATE_SCHEMA, ops, []);
    const forty = steps[3]?.judgement.record;
    expect(forty?.kind === "write" ? forty.items.map((x) => [x.target, x.status]) : []).toEqual([
      ["f2", "candidate"],
      ["f2", "corroborated"],
      ["f3", "candidate"],
    ]);
    expect(steps[4]?.judgement.record).toMatchObject({
      kind: "take_previous",
      decided: [{ event: 41, target: "f2" }],
    });
  });

  it("a corroboration when written is not in K, and a target the resolution did not decide is not either", () => {
    // Nothing deleted: the write-back stays on [11-01, 11-03). Counting #41's f2 corroboration
    // (effective when written) or its f3 candidate in K would widen it to [11-01, 11-05)
    // (03-deletion deviation one: only the decided candidate's stretches; the corroborated part
    // is judged again by the same-value rule and is still one).
    const b = sideBySide(ops, [], []);
    expect(
      b.after.state.items.filter((x) => x.event === 41 && x.target === "f2").map((x) => x.status),
    ).toEqual(["candidate", "corroborated"]);
    const w = writeBacks(b);
    expect(w.kernel).toEqual([[{ from: d("11-01"), to: d("11-03") }]]);
    expect(w.ref).toEqual(w.kernel);
    expect(b.ref).toEqual(b.kernel);
  });

  it("a candidate turned the same as the value before it (S25 deleted) stays in K", () => {
    // #25 deleted: #41's f2 is the same as the value before it on the whole stretch, a
    // corroboration now; its candidate part still counts, so the take_previous still writes back.
    const b = sideBySide(ops, ["S25"], [contributionKey(26, "f2")]);
    const w = writeBacks(b);
    expect(w.kernel.length).toBeGreaterThan(0);
    expect(w.ref).toEqual(w.kernel);
    expect(b.ref).toEqual(b.kernel);
  });
});

describe("an undo applied when written stays applied (03-deletion «高影响»: 按偏离二保持生效)", () => {
  it("its write-backs, empty when written, erase change points once a deletion uncovers what it takes back", () => {
    // #20 writes 2 on [11-03, 11-05); #30 covers it whole with 5 on [11-01, 11-09); #40 undoes
    // #20: #21 is covered, no write-back, nothing erased, applied without acknowledge. S30 deleted:
    // #21 is uncovered, the undo writes 1 back over it, erasing two change points; it stays
    // applied, not awaiting.
    const ops: Op[] = [
      refWrite(10, 0, "10-01", null, "1"),
      refWrite(20, 10, "11-03", "11-05", "2", { ack: true }),
      refWrite(30, 20, "11-01", "11-09", "5", { ack: true }),
      { kind: "undo", op: 40, event: 41, target: 20, seen: 39 },
    ];
    const b = sideBySide(ops, ["S30"], [contributionKey(31, "f2")]);
    expect(b.records[3]).toMatchObject({ kind: "undo", status: "applied", items: [] });
    expect(b.after.records.find((r) => r.op === 40)).toMatchObject({
      status: "applied",
      items: [{ target: "f2", status: "applied", content: { kind: "value", value: "1" } }],
    });
    expect(b.kernel).toEqual([[d("10-01"), "1"]]);
    expect(b.ref).toEqual(b.kernel);
  });
});

describe("keep_effective, as recorded: the candidates it decided take effect in no replay", () => {
  // #5 f2=0; #10 and #20 both saw #5 and write 1 and 2: #20 is a candidate against #10; #40 keeps
  // the value in effect (03-deletion «人已经解决的冲突，照记录»).
  const ops: Op[] = [
    refWrite(5, 0, "10-01", null, "0"),
    refWrite(10, 5, "10-01", null, "1"),
    refWrite(20, 5, "10-01", null, "2"),
    {
      kind: "resolve",
      op: 40,
      event: 41,
      decision: "keep_effective",
      candidates: [21],
      unit: "f2",
    },
  ];

  it("the value in effect deleted: the candidate does not take effect, the value falls back to #5's", () => {
    const b = sideBySide(ops, ["S10"], [contributionKey(11, "f2")]);
    expect(b.records[3]).toMatchObject({ kind: "keep_effective" });
    expect(b.after.records.map((r) => [r.op, r.kind])).toEqual([
      [5, "write"],
      [20, "write"],
      [40, "keep_effective"],
    ]);
    expect(b.after.state.items.filter((x) => x.event === 21).map((x) => x.status)).toEqual([
      "candidate",
    ]);
    expect(b.after.state.closedCandidate(21, "f2")).toBe(true);
    expect(b.kernel).toEqual([[d("10-01"), "0"]]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("the candidate's value deleted: nothing of it is left; #10 stays in effect", () => {
    const b = sideBySide(ops, ["S20"], [contributionKey(21, "f2")]);
    expect(b.kernel).toEqual([[d("10-01"), "1"]]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("without the resolution the same deletion lets the candidate take effect (the record is what keeps it closed)", () => {
    const b = sideBySide(ops.slice(0, 3), ["S10"], [contributionKey(11, "f2")]);
    expect(b.kernel).toEqual([[d("10-01"), "2"]]);
    expect(b.ref).toEqual(b.kernel);
  });
});

describe("the candidate level of two cases whose item level is D1-b2e", () => {
  it("a candidate an undo's record covers, put in effect by a deletion, is taken back with it", () => {
    // #20 did not see #10: its f2 is a candidate, its f3 in effect. #30 undoes #20: R lists both
    // (21, f2) and (21, f3), the candidate too. S10 deleted (#10's value): #20's f2 is no longer
    // a candidate, it takes effect, and the undo takes it back (03-deletion «回掉的权威定义» step
    // 1); f2 falls back to #5's 0. The item level (not a pending item) is b2e's.
    const ops: Op[] = [
      refWrite(5, 0, "10-01", null, "0"),
      refWrite(10, 5, "10-01", null, "1"),
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 5,
        valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
        fields: { f2: { value: "2", sources: ["S20"] }, f3: { value: "x", sources: ["S20f3"] } },
      },
      { kind: "undo", op: 30, event: 31, target: 20, seen: 29, acknowledge: ["overwrite"] },
    ];
    const b = sideBySide(ops, ["S10"], [contributionKey(11, "f2")]);
    expect(b.records[2]).toMatchObject({
      items: [
        { target: "f2", status: "candidate" },
        { target: "f3", status: "applied" },
      ],
    });
    expect(b.records[3]).toMatchObject({
      kind: "undo",
      revert: {
        entries: [
          { event: 21, target: "f2" },
          { event: 21, target: "f3" },
        ],
      },
    });
    const f2 = b.after.state.items.filter((x) => x.event === 21 && x.target === "f2");
    expect(f2.map((x) => x.status)).toEqual(["applied"]);
    expect(
      b.after.state.registeredOn(f2[0] as never, { from: d("10-01"), to: null }, EVERYTHING),
    ).toBe(true);
    expect(b.kernel).toEqual([[d("10-01"), "0"]]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("a candidate whose item a later write overwrote stays a candidate, not in effect, when that write is deleted", () => {
    // #20 is a candidate against #10; #30, having seen #20, writes 3 over the same stretch (the
    // item superseded, overwritten). S30 deleted: #20's part goes back to its item, which stays
    // superseded; at the candidate level it is a candidate and #10's value is in effect. The item
    // level (closed with the item) is b2e's.
    const ops: Op[] = [
      refWrite(5, 0, "10-01", null, "0"),
      refWrite(10, 5, "10-01", null, "1"),
      refWrite(20, 5, "10-01", null, "2"),
      refWrite(30, 20, "10-01", null, "3"),
    ];
    const b = sideBySide(ops, ["S30"], [contributionKey(31, "f2")]);
    expect(b.records[2]).toMatchObject({ items: [{ target: "f2", status: "candidate" }] });
    expect(b.after.state.items.filter((x) => x.event === 21).map((x) => x.status)).toEqual([
      "candidate",
    ]);
    expect(b.kernel).toEqual([[d("10-01"), "1"]]);
    expect(b.ref).toEqual(b.kernel);
  });
});

describe("a resolved candidate stays closed whichever unit it meets in the replay (closed by the recorded decided list)", () => {
  const open10 = {
    from: { mode: "given" as const, value: d("10-01") },
    to: { mode: "open" as const },
  };
  const w = (op: number, seen: number, fields: Record<string, [string, string[]]>): Op => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: open10,
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, [v, s]]) => [f, { value: v, sources: s }]),
    ),
  });
  const keep = (op: number, candidates: number[], unit: "existence" | "f2" | "f3"): Op => ({
    kind: "resolve",
    op,
    event: op + 1,
    decision: "keep_effective",
    candidates,
    unit,
  });
  /** Kernel and reference side by side: f2, f3 and every candidate with whether it is closed. */
  function closedness(ops: Op[], sources: string[], contributions: string[]) {
    const { table, steps } = judged(STATE_SCHEMA, ops, []);
    expect(steps).toHaveLength(ops.length);
    const kept = steps.map((x) => x.op);
    const after = replayDeletion(
      table,
      steps.map((x) => x.judgement.record),
      new Set(contributions),
    );
    const last = Math.max(...kept.map((o) => Math.max(o.op, o.event)));
    const ref = evaluateLog(STATE_SCHEMA, [
      ...kept,
      { kind: "deletion", op: last + 1, id: "pi_x", sources },
    ]).final;
    const vals = (fs: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(
        ["f2", "f3"].map((f) => [
          f,
          ((fs[f] ?? []) as { valid: { from: string | null }[]; value: unknown }[])
            .filter((s) => s.value !== null)
            .map((s) => [s.valid[0]?.from ?? null, s.value]),
        ]),
      );
    return {
      kernel: {
        fields: vals(view(after.state).fields),
        cands: after.state.items
          .filter((x) => x.status === "candidate")
          .map((x) => `${x.event}/${x.target} ${after.state.closedCandidate(x.event, x.target)}`)
          .sort(),
      },
      ref: {
        fields: vals(ref.fields),
        cands: ref.items
          .filter((x) => x.status === "candidate")
          .map((x) => `${x.event}/${x.target} ${x.closed === true}`)
          .sort(),
      },
    };
  }

  it("A: a candidate on existence (it met a revoke and a write); the revoke deleted, the write conflict left: still closed", () => {
    const ops: Op[] = [
      w(5, 0, { f2: ["0", ["S5"]] }),
      w(10, 5, { f2: ["1", ["S10"]] }),
      { kind: "revoke", op: 12, event: 13, seen: 10, valid: open10, validSources: ["R12"] },
      w(20, 5, { f2: ["2", ["S20"]] }),
      keep(40, [21], "existence"),
    ];
    const r = closedness(ops, ["R12"], [contributionKey(13, "existence")]);
    expect(r.kernel.cands).toEqual(["21/f2 true"]);
    expect(r.kernel).toEqual(r.ref);
  });

  it("B: a field candidate; a revoke candidate takes effect after the deletion and it now meets a revoke: still closed", () => {
    const ops: Op[] = [
      w(5, 0, { f2: ["0", ["S5"]] }),
      w(10, 5, { f2: ["1", ["S10"]] }),
      { kind: "revoke", op: 12, event: 13, seen: 5, valid: open10, validSources: ["R12"] },
      w(20, 10, { f2: ["2", ["S20"]] }),
      w(25, 5, { f2: ["3", ["S25"]] }),
      keep(40, [26], "f2"),
    ];
    const r = closedness(ops, ["S10"], [contributionKey(11, "f2")]);
    expect(r.kernel.cands).toContain("26/f2 true");
    expect(r.kernel).toEqual(r.ref);
  });

  it("only f3 listed: f2 of the same write takes effect once its conflict is gone; f3 stays closed", () => {
    const ops: Op[] = [
      w(5, 0, { f2: ["0", ["S5"]], f3: ["a", ["S5"]] }),
      w(10, 5, { f2: ["1", ["S10"]], f3: ["b", ["S10"]] }),
      w(20, 5, { f2: ["2", ["S20a"]], f3: ["c", ["S20b"]] }),
      keep(40, [21], "f3"),
    ];
    const r = closedness(ops, ["S10"], [contributionKey(11, "f2"), contributionKey(11, "f3")]);
    expect(r.kernel.cands).toEqual(["21/f3 true"]);
    expect(r.kernel.fields).toEqual({ f2: [[d("10-01"), "2"]], f3: [[d("10-01"), "a"]] });
    expect(r.kernel).toEqual(r.ref);
  });

  it("a revoke kept out (existence), the write in effect deleted: the revoke stays a closed candidate", () => {
    const ops: Op[] = [
      w(5, 0, { f2: ["0", ["S5"]] }),
      w(10, 5, { f2: ["1", ["S10"]] }),
      { kind: "revoke", op: 20, event: 21, seen: 5, valid: open10, validSources: ["R20"] },
      keep(40, [21], "existence"),
    ];
    const r = closedness(ops, ["S10"], [contributionKey(11, "f2")]);
    expect(r.kernel.cands).toEqual(["21/existence true"]);
    expect(r.kernel.fields["f2"]).toEqual([[d("10-01"), "0"]]);
    expect(r.kernel).toEqual(r.ref);
  });

  it("a field candidate that met only a revoke (an item on existence), the revoke deleted: still closed", () => {
    const ops: Op[] = [
      w(5, 0, { f2: ["0", ["S5"]] }),
      { kind: "revoke", op: 10, event: 11, seen: 5, valid: open10, validSources: ["R10"] },
      w(20, 5, { f2: ["2", ["S20"]] }),
      keep(40, [21], "existence"),
    ];
    const r = closedness(ops, ["R10"], [contributionKey(11, "existence")]);
    expect(r.kernel.cands).toEqual(["21/f2 true"]);
    expect(r.kernel.fields["f2"]).toEqual([[d("10-01"), "0"]]);
    expect(r.kernel).toEqual(r.ref);
  });
});

describe("take_candidate, as recorded: merge base, O and filled from the record, where it lands again", () => {
  const revokeOp = (op: number, seen: number, from: string, to: string): Op => ({
    kind: "revoke",
    op,
    event: op + 1,
    seen,
    valid: {
      from: { mode: "given", value: d(from) },
      to: { mode: "given", value: d(to) },
    },
  });
  const takeOp = (op: number, take: number, unit: "f2" | "existence" = "f2"): Op => ({
    kind: "resolve",
    op,
    event: op + 1,
    decision: "take_candidate",
    candidates: [take],
    unit,
    take,
  });
  const takeItems = (st: RowState, event: number) =>
    st.items
      .filter((x) => x.event === event)
      .map((x) => [x.target, x.status, x.valid, x.content.kind]);

  // State table. #26 revokes [11-05, 11-07) and #28 writes 5 over [11-01, 11-09), filling it.
  // #30 (seen #10) and #35 (seen #26) write 3: candidates in one item (#20 and #28 changed what
  // they saw). #33 revokes [11-07, 11-09) having seen only #10: a candidate (#28 changed there).
  // #40 takes #35: merge base #10, O = {(21, f2), (29, f2)}, filled = [#27].
  const stateOps: Op[] = [
    refWrite(10, 0, "10-01", null, "1", { ack: true }),
    refWrite(20, 10, "11-01", "11-03", "2", { ack: true }),
    revokeOp(26, 20, "11-05", "11-07"),
    refWrite(28, 26, "11-01", "11-09", "5", { ack: true }),
    refWrite(30, 10, "11-01", "11-03", "3"),
    revokeOp(33, 10, "11-07", "11-09"),
    refWrite(35, 26, "11-01", "11-09", "3"),
    takeOp(40, 36),
  ];

  it("as judged: the take records filled = [#27], its item over [11-01, 11-09)", () => {
    const { steps } = judged(STATE_SCHEMA, stateOps, []);
    expect(steps.map((x) => x.judgement.record.kind)).toContain("take_candidate");
    const take = steps.find((x) => x.judgement.record.kind === "take_candidate")?.judgement.record;
    expect(take).toMatchObject({ mergeBase: 10, filled: [27] });
    expect(take?.kind === "take_candidate" ? take.items.map((x) => x.valid) : []).toEqual([
      [{ from: d("11-01"), to: d("11-09") }],
    ]);
  });

  it("with nothing deleted the replayed records are the logged ones", () => {
    const { table, steps } = judged(STATE_SCHEMA, stateOps, []);
    const records = steps.map((x) => x.judgement.record);
    expect(replayDeletion(table, records, new Set()).records).toEqual(records);
  });

  it("① state table: a revoke in filled does not cover the take; one not in filled (in effect only after the deletion) covers it wholly", () => {
    // S28 deleted: #33's conflict is gone, it takes effect (no one resolved it); it was not in
    // effect when the take was judged, so it is not in filled: it covers the taken item where it
    // lies, as a whole. #26 is in filled: it covers nothing. (03-deletion «搬运的值»)
    const b = sideBySide(stateOps, ["S28"], [contributionKey(29, "f2")]);
    expect(takeItems(b.after.state, 41)).toEqual([
      ["f2", "applied", [{ from: d("11-01"), to: d("11-07") }], "value"],
    ]);
    expect(b.kernel).toEqual([
      [d("10-01"), "1"],
      [d("11-01"), "3"],
      [d("11-09"), "1"],
    ]);
    expect(b.ref).toEqual(b.kernel);
    // The stretch #33 revokes has no value on either side.
    expect(b.refFinal.gaps).toEqual(view(b.after.state).gaps);
  });

  it("② event table: a revoke covers no taken field item, and a field write outside O no taken revoke", () => {
    // #35 revokes having seen #10: a candidate on existence (#20 changed what it saw). S20 deleted:
    // #35 takes effect, the row is revoked; the taken field item stays, on a revoked row.
    const fieldTaken: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: "2", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        fields: { f2: { value: "3", sources: ["S30"] } },
      },
      { kind: "revoke", op: 35, event: 36, seen: 10 },
      takeOp(40, 31),
    ];
    const a = sideBySide(fieldTaken, ["S20"], [contributionKey(21, "f2")], EVENT_SCHEMA);
    expect(takeItems(a.after.state, 41)).toEqual([
      ["f2", "applied", [{ from: null, to: null }], "value"],
    ]);
    expect(view(a.after.state).exists).toBe(false);
    expect(a.refFinal.exists).toBe(false);
    expect(a.ref).toEqual(a.kernel);
    // #30 revokes having seen #10: a candidate on existence; #25 writes 5 having seen #10: a
    // candidate on f2. #40 takes the revoke (O = {(21, f2)}). S20 deleted: #25 takes effect, not
    // in O, after the merge base: on an event table it does not cover the taken revoke.
    const revokeTaken: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: "2", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 25,
        event: 26,
        seen: 10,
        fields: { f2: { value: "5", sources: ["S25"] } },
      },
      { kind: "revoke", op: 30, event: 31, seen: 10 },
      takeOp(40, 31, "existence"),
    ];
    const r = sideBySide(revokeTaken, ["S20"], [contributionKey(21, "f2")], EVENT_SCHEMA);
    expect(r.records.at(-1)).toMatchObject({ kind: "take_candidate" });
    expect(takeItems(r.after.state, 41)).toEqual([
      ["existence", "applied", [{ from: null, to: null }], "revoke"],
    ]);
    expect(view(r.after.state).exists).toBe(false);
    expect(r.refFinal.exists).toBe(false);
  });

  it("③ on existence (event table): the taken write's field deleted, it lands on the same-valued candidate and restores the row", () => {
    // Found by review (seed -2091758890, shrunk). #20 revokes the row; #30 and #40, neither
    // having seen it, write f2 = 2: candidates on existence. #45 takes #40 (a restore and f2 = 2).
    // S6 (#40's f2) deleted: #30's f2 is the same value, in K: the take lands on it (03-deletion
    // «搬运的值»), the row restored.
    const ops: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
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
        kind: "write",
        op: 40,
        event: 41,
        seen: 0,
        fields: { f2: { value: "2", sources: ["S6"] } },
        acknowledge: ["overwrite"],
      },
      takeOp(45, 41, "existence"),
    ];
    const b = sideBySide(ops, ["S6"], [contributionKey(41, "f2")], EVENT_SCHEMA);
    expect(b.records.at(-1)).toMatchObject({ kind: "take_candidate", unit: "existence" });
    expect(takeItems(b.after.state, 46)).toEqual([
      ["existence", "applied", [{ from: null, to: null }], "restore"],
      ["f2", "applied", [{ from: null, to: null }], "value"],
    ]);
    expect(view(b.after.state).exists).toBe(true);
    expect(b.refFinal.exists).toBe(true);
    expect(b.ref).toEqual(b.kernel);
  });

  it("③ on existence (state table): the taken write deleted, it lands on the same-valued candidate", () => {
    // #20 revokes [11-01, 11-05); #30 and #35, neither having seen it, write f2 = 3 from 11-01:
    // candidates on existence. #40 takes #30. S30 deleted: #35's f2 is the same value, in K: the
    // take lands on it.
    const ops: Op[] = [
      refWrite(10, 0, "10-01", null, "1", { ack: true }),
      revokeOp(20, 10, "11-01", "11-05"),
      refWrite(30, 10, "11-01", null, "3"),
      refWrite(35, 10, "11-01", null, "3"),
      takeOp(40, 31, "existence"),
    ];
    const b = sideBySide(ops, ["S30"], [contributionKey(31, "f2")]);
    expect(b.records.at(-1)).toMatchObject({ kind: "take_candidate", unit: "existence" });
    expect(takeItems(b.after.state, 41).map((x) => x[0])).toContain("f2");
    expect(b.kernel).toEqual([
      [d("10-01"), "1"],
      [d("11-01"), "3"],
    ]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("a candidate's part a deletion extended stays in K: the take lands on it too", () => {
    // Found by the comparison (3000 runs). #70 writes 1 from 11-03 to the next change: when
    // written it ends at 11-09 (#30's end) and is a candidate; #73 takes it. S20 and S30 deleted:
    // #70's default end runs on past 11-09; the part beyond (the same as the value before it now,
    // a corroboration) meets no block written, and takes the write's status there, a candidate:
    // in K (03-deletion «回掉的权威定义» step 2). The take lands on [11-03, ∞).
    const ops: Op[] = [
      refWrite(10, 0, "10-01", null, "1", { ack: true }),
      refWrite(20, 10, "11-01", "11-05", "2", { ack: true }),
      refWrite(30, 20, "11-03", "11-09", "3", { ack: true }),
      { kind: "undo", op: 40, event: 41, target: 20, includeLater: true },
      { kind: "reject", op: 50, event: 50, target: 41 },
      refWrite(60, 59, "11-07", "11-09", "9"),
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 50,
        valid: { from: { mode: "given", value: d("11-03") }, to: { mode: "next_change" } },
        fields: { f2: { value: "1", sources: ["S70"], explicit: true } },
        acknowledge: ["overwrite"],
      },
      takeOp(73, 71),
    ];
    const b = sideBySide(
      ops,
      ["S20", "S30"],
      [contributionKey(21, "f2"), contributionKey(31, "f2")],
    );
    expect(b.records.at(-1)).toMatchObject({ kind: "take_candidate" });
    expect(takeItems(b.after.state, 74)).toEqual([
      ["f2", "applied", [{ from: d("11-03"), to: null }], "value"],
    ]);
    expect(b.refFinal.items.filter((x) => x.event === 74).map((x) => x.valid)).toEqual([
      [{ from: d("11-03"), to: null }],
    ]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("a revoke outside O that a later write in O covers in turn does not cover the take", () => {
    // #25 (seen #10) revokes [11-03, 11-05): a candidate against #20 (an item on existence), so
    // not in O and not filled. #30 writes 6 over [11-01, 11-09), in effect: in O. #40 (seen #10)
    // writes 3: a candidate on f2; #50 takes it. S20 deleted: #25 takes effect after the merge
    // base, outside O, not filled, so it would cover the take wholly where it lies; but #30 (in O)
    // supersedes it there, so it covers nothing (03-deletion «搬运的值»): 3 on the whole stretch.
    const ops: Op[] = [
      refWrite(10, 0, "10-01", null, "1", { ack: true }),
      refWrite(20, 10, "11-01", "11-09", "2", { ack: true }),
      revokeOp(25, 10, "11-03", "11-05"),
      refWrite(30, 25, "11-01", "11-09", "6", { ack: true }),
      refWrite(40, 10, "11-01", "11-09", "3"),
      takeOp(50, 41),
    ];
    const b = sideBySide(ops, ["S20"], [contributionKey(21, "f2")]);
    expect(b.after.state.items.filter((x) => x.event === 26).map((x) => x.status)).toEqual([
      "applied",
    ]);
    expect(takeItems(b.after.state, 51)).toEqual([
      ["f2", "applied", [{ from: d("11-01"), to: d("11-09") }], "value"],
    ]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("a candidate turned the same as the value before it stays in K: the take lands on it too", () => {
    // #40 (seen #10) writes 1 over [11-01, 11-05), a candidate (#20 and #25 wrote 2 there). S25
    // deleted: on [11-03, 11-05) #41 is the same as the value before it now, a corroboration,
    // still in K (03-deletion «回掉的权威定义» step 2); the take lands on [11-01, 11-05).
    const ops: Op[] = [
      refWrite(10, 0, "10-01", null, "1", { ack: true }),
      refWrite(20, 10, "11-01", "11-03", "2", { ack: true }),
      refWrite(25, 20, "11-03", "11-05", "2", { ack: true }),
      refWrite(40, 10, "11-01", "11-05", "1", { explicit: true }),
      takeOp(50, 41),
    ];
    const b = sideBySide(ops, ["S25"], [contributionKey(26, "f2")]);
    expect(
      b.after.state.items.filter((x) => x.event === 41).map((x) => [x.status, x.valid]),
    ).toEqual([
      ["candidate", [{ from: d("11-01"), to: d("11-03") }]],
      ["corroborated", [{ from: d("11-03"), to: d("11-05") }]],
    ]);
    expect(takeItems(b.after.state, 51)).toEqual([
      ["f2", "applied", [{ from: d("11-01"), to: d("11-05") }], "value"],
    ]);
    const refTake = b.refFinal.items.filter((x) => x.event === 51).map((x) => x.valid);
    expect(refTake).toEqual([[{ from: d("11-01"), to: d("11-05") }]]);
    expect(b.ref).toEqual(b.kernel);
  });

  // #20 writes 2; #30 and #35, both seen only #10, write 3: candidates in one item. #40 takes #30.
  const twoSame: Op[] = [
    refWrite(10, 0, "10-01", null, "1", { ack: true }),
    refWrite(20, 10, "10-01", null, "2", { ack: true }),
    refWrite(30, 10, "10-01", null, "3"),
    refWrite(35, 10, "10-01", null, "3"),
    takeOp(40, 31),
  ];

  it("③ the taken candidate's contributions all deleted: with no same-valued candidate the take gives nothing there", () => {
    const one = [...twoSame.slice(0, 3), takeOp(40, 31)];
    const b = sideBySide(one, ["S30"], [contributionKey(31, "f2")]);
    expect(takeItems(b.after.state, 41)).toEqual([]);
    expect(b.kernel).toEqual([[d("10-01"), "2"]]);
    expect(b.ref).toEqual(b.kernel);
  });

  it("③ the taken candidate's contributions all deleted: it lands on a same-valued candidate's items", () => {
    const b = sideBySide(twoSame, ["S30"], [contributionKey(31, "f2")]);
    expect(takeItems(b.after.state, 41)).toEqual([
      ["f2", "applied", [{ from: d("10-01"), to: null }], "value"],
    ]);
    expect(b.kernel).toEqual([[d("10-01"), "3"]]);
    expect(b.ref).toEqual(b.kernel);
  });
});

describe("a recorded candidate the same as its seen version in the replay, no evidence: its shadow counts in K", () => {
  // #5 f2=2; #10, having seen #5, writes 0 over it; #20, having seen #10, writes 1; #30, having
  // seen #10 too, writes 2: a candidate against #20. A resolution of the item. S10 deleted: #30's
  // seen version is #5's 2, the same as #30's value, no evidence pointed at: no item, a shadow; the
  // resolution's K still holds it (03-deletion «回掉的权威定义» step 2).
  const head: Op[] = [
    refWrite(5, 0, "10-01", null, "2"),
    refWrite(10, 5, "10-01", null, "0", { ack: true }),
    refWrite(20, 10, "10-01", null, "1"),
    refWrite(30, 10, "10-01", null, "2"),
  ];
  const resolve = (decision: "take_previous" | "take_candidate"): Op =>
    ({
      kind: "resolve",
      op: 40,
      event: 41,
      decision,
      candidates: [31],
      unit: "f2",
      ...(decision === "take_candidate" ? { take: 31 } : {}),
    }) as Op;

  it.each(["take_previous", "take_candidate"] as const)(
    "%s: replayed as the reference does",
    (decision) => {
      const b = sideBySide([...head, resolve(decision)], ["S10"], [contributionKey(11, "f2")]);
      expect(b.records[3]).toMatchObject({ items: [{ target: "f2", status: "candidate" }] });
      // #30 has no item in the replay: the same as its seen version, no evidence pointed at.
      expect(b.after.state.items.filter((x) => x.event === 31)).toEqual([]);
      expect(b.after.records.map((r) => r.kind)).toContain(decision);
      expect(b.kernel).toEqual(b.ref);
    },
  );
  it("take_candidate lands on the shadow: #30's 2, as the person chose, carried from #30's item", () => {
    const b = sideBySide(
      [...head, resolve("take_candidate")],
      ["S10"],
      [contributionKey(11, "f2")],
    );
    expect(b.kernel).toEqual([[d("10-01"), "2"]]);
    const take = b.after.records.find((r) => r.kind === "take_candidate");
    expect(take).toMatchObject({
      items: [{ target: "f2", content: { kind: "value", value: "2" } }],
    });
    expect(
      (take as unknown as { items: { carried: unknown[] }[] }).items[0]?.carried,
    ).toContainEqual({
      event: 31,
      target: "f2",
      k: 0,
    });
  });

  it("then #30's source deleted too: no item of #30 left in K, as deleting both at once", () => {
    const both = sideBySide(
      [...head, resolve("take_candidate")],
      ["S10", "S30"],
      [contributionKey(11, "f2"), contributionKey(31, "f2")],
    );
    expect(both.kernel).toEqual([[d("10-01"), "1"]]);
    expect(both.kernel).toEqual(both.ref);
  });
});

describe("a take_previous's write-back over a shadow rests on what cuts the shadow", () => {
  // #5 f2=2; #10 writes 0 over it; #15 a change at 11-10; #20, having seen #15, writes 1 on
  // [10-01, 11-10); #30, having seen #15, writes 2 from 10-01 to the next change: [10-01, 11-10),
  // its end #15's start, a candidate against #20. take_previous. S10 deleted: #30's shadow on
  // [10-01, 11-10), cut by #16; the write-back over it rests on #16 too (09 §3.5), though #25
  // covers #16's start in the state.
  const ops: Op[] = [
    refWrite(5, 0, "10-01", null, "2"),
    refWrite(10, 5, "10-01", null, "0", { ack: true }),
    refWrite(15, 10, "11-10", null, "7", { ack: true }),
    refWrite(20, 15, "10-01", "11-10", "1", { ack: true }),
    // #25 covers [11-05, 11-20): at 11-10 the replay's state has no boundary, so #16 cuts the
    // write-back only through the shadow's end.
    refWrite(25, 20, "11-05", "11-20", "5", { ack: true }),
    {
      ...refWrite(30, 15, "10-01", null, "2"),
      valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "next_change" } },
    } as Op,
    // #35, having seen #10 only, writes 8 on [10-01, 10-20): a candidate in the same item, so the
    // merge base is #10, before #15: at the value position 11-10 is no boundary.
    refWrite(35, 10, "10-01", "10-20", "8"),
    {
      kind: "resolve",
      op: 50,
      event: 51,
      decision: "take_previous",
      candidates: [31, 36],
      unit: "f2",
    } as Op,
  ];

  it("its deps hold #16; a later deletion of S15 restates it (rule 2)", () => {
    const b = sideBySide(ops, ["S10"], [contributionKey(11, "f2")]);
    expect(b.kernel).toEqual(b.ref);
    expect(b.after.state.items.filter((x) => x.event === 31)).toEqual([]);
    expect(b.records.at(-1)).toMatchObject({ kind: "take_previous" });
    const back = b.after.records.find((r) => r.kind === "take_previous");
    const items = (back as unknown as { items: { deps: { event: number }[] }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((x) => x.deps.some((y) => y.event === 16))).toBe(true);
    // The second deletion, S10 pending before it: the blocks after the first are the latest.
    const latest = new Map(givenByRecords(b.records));
    for (const r of b.after.restated) {
      const et = `${r.item.event}/${r.item.target}`;
      const was = latest.get(et) ?? [];
      latest.set(et, [
        ...was.filter((x) => x.k !== r.item.k),
        {
          k: r.item.k,
          status: r.status,
          valid: r.valid ?? [],
          deps: r.deps,
          content: r.content ?? was[0]?.content ?? { kind: "value", value: null },
        },
      ]);
    }
    const table = judged(STATE_SCHEMA, ops, []).table;
    const second = replayDeletion(
      table,
      b.records,
      new Set([contributionKey(11, "f2"), contributionKey(16, "f2")]),
      [],
      latest,
    );
    expect(second.restated.map((r) => r.item.event)).toContain(51);
  });
});
