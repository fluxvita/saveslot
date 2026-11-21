// Fixed cases of the deletion replay (D1-b2a): what it refuses in this version, and the two things
// it keeps from the records as judged when written (a write in effect stays in effect; a no-op
// stays a no-op). The comparison with the reference evaluator is replay-deletion.prop.test.ts.

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type Op } from "@fluxvita/saveslot-reference";
import { EVENT as EVENT_SCHEMA, STATE as STATE_SCHEMA } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp, stateFromRecord, view } from "./judge.ts";
import type { JudgeInput, OpRecord, TableShape, WriteInput } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import { judged } from "./scenarios.fixture.ts";
import type { RowState } from "./state.ts";
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

describe("what this version refuses", () => {
  it("a confirmation of an awaiting undo: not_implemented, naming it", () => {
    const { records } = run([...awaiting, decision("confirm")]);
    const withRevert = records.map((r) =>
      r.kind === "confirm" ? { ...r, revert: { entries: [], before: 20, skipped: [] } } : r,
    );
    const e = refusal(() => replayDeletion(STATE, withRevert, new Set()));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ kind: "confirm of an undo", op: 40 });
  });

  it("an undo in the log: not_implemented, naming it", () => {
    const { records } = run([
      ...awaiting.slice(0, 2),
      {
        kind: "undo",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        target: 20,
        seen: 39,
        seenExplicit: true,
      },
    ]);
    const e = refusal(() => replayDeletion(STATE, records, new Set()));
    expect(e.reason).toBe("not_implemented");
    expect(e.detail).toMatchObject({ kind: "undo", op: 40 });
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
