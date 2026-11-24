// Fixed cases of a write by external key (docs/zh-CN/spec/03-data-model/04-write-and-read.md
// «按来源键写入 · 三方比较»; 09-references-conflict-sync.md «冲突判据», the paragraph on writes by
// external key): each line of the three-way table, a key added to a row by hand, a revoke undone,
// every field a corroboration, and a conflict group whose fields have different baseline
// positions. Expected values written by hand from the spec.

import type { BizPoint, FieldId, FieldValue, Seq } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { JudgeError } from "./errors.ts";
import { emptyState, judgeOp, stateFromRecord } from "./judge.ts";
import type { JudgeInput, Judgement, TableShape, Unit, WriteInput, WriteRecord } from "./model.ts";
import { replayDeletion } from "./replay-deletion.ts";
import { undoneOp } from "./revert.ts";
import type { RowState } from "./state.ts";
import { syncOutcome } from "./sync.ts";
import { judgeWrite } from "./write.ts";

/** A timeless table: f2, f3, f4 and the key field f9. */
const T: TableShape = {
  kind: "timeless",
  fields: ["f2", "f3", "f4", "f9"],
  valued: ["f2", "f3", "f4", "f9"],
  required: [],
  groups: [],
};
/** The same with the conflict group {f2, f3}. */
const GROUPED: TableShape = { ...T, groups: [["f2", "f3"]] };
const KEY: FieldId[] = ["f9"];
const NOW = "2026-11-05" as BizPoint;

const base = (op: number) => ({ op, index: 0, event: op + 1, ruleset: 1 });
const fieldsOf = (v: Record<string, FieldValue>, explicit = false) =>
  Object.fromEntries(
    Object.entries(v).map(([f, x]) => [f, { value: x, ...(explicit ? { explicit: true } : {}) }]),
  ) as WriteInput["fields"];

/** A write by key creating the row: its key and values. */
const created = (op: number, v: Record<string, FieldValue>): WriteInput => ({
  ...base(op),
  kind: "write",
  seen: op - 1,
  seenExplicit: false,
  now: NOW,
  fields: fieldsOf({ f9: "K", ...v }),
  sync: { keyFields: KEY, creates: true },
});
/** A write by key hitting the row: no ver, key fields left out. */
const synced = (op: number, v: Record<string, FieldValue>, explicit = false): WriteInput => ({
  ...base(op),
  kind: "write",
  seen: 0,
  seenExplicit: false,
  now: NOW,
  fields: fieldsOf(v, explicit),
  sync: { keyFields: KEY },
});
/** An ordinary write with an explicit ver. */
const user = (op: number, seen: number, v: Record<string, FieldValue>): WriteInput => ({
  ...base(op),
  kind: "write",
  seen,
  seenExplicit: true,
  now: NOW,
  fields: fieldsOf(v),
});
const decide = (
  op: number,
  kind: "keep_effective" | "take_previous" | "take_candidate",
  candidates: Seq[],
  unit: Unit = { fields: ["f2"] },
): JudgeInput =>
  kind === "take_candidate"
    ? { ...base(op), kind, unit, candidates, take: candidates[0] as Seq }
    : { ...base(op), kind, unit, candidates };
const undo = (op: number, target: number): JudgeInput => ({
  ...base(op),
  kind: "undo",
  target,
  seen: op - 1,
  seenExplicit: true,
});
const revoke = (op: number, seen: number): JudgeInput => ({
  ...base(op),
  kind: "revoke",
  seen,
  seenExplicit: true,
  now: NOW,
});

function run(table: TableShape, inputs: readonly JudgeInput[]) {
  let state: RowState = emptyState(table);
  const js: Judgement[] = [];
  for (const i of inputs) {
    const r = judgeOp(state, i);
    js.push(r.judgement);
    state = r.state;
  }
  return { state, js, last: js[js.length - 1] as Judgement };
}
/**
 * Each field's result in a write's judgement: its items' status, or `noop`. The key field is left
 * out: hitting a row, the record lists it among the no-ops (09 §5.7), never judged.
 */
function results(j: Judgement): Record<string, string> {
  const r = j.record as WriteRecord;
  const out: Record<string, string> = {};
  for (const f of r.noop) if (!KEY.includes(f)) out[f] = "noop";
  for (const x of r.items) out[x.target] = x.status;
  return out;
}
const outcome = (j: Judgement) => syncOutcome(Object.values(results(j)) as never);
/** What a write's record says of its sync baseline, exactly: a key too many shows. */
function byKeyOf(j: Judgement) {
  const r = j.record as WriteRecord;
  return {
    byKey: r.byKey,
    seen: r.seen,
    ...(r.baseline !== undefined ? { baseline: r.baseline } : {}),
  };
}
/** f2's value in effect after the operations. */
const f2Now = (state: RowState) =>
  state.items
    .filter((x) => x.target === "f2" && x.status === "applied")
    .filter((x) => state.registrations(x, { upTo: 1e9 }).length === 0)
    .sort((a, b) => b.op - a.op)[0]?.content;

// The table's setting: a sync created the row at #10 with 600.
const SYNCED_600 = created(10, { f2: "600" });

describe("the three-way comparison, line by line (a field last synced as 600)", () => {
  it("600 in effect, 600 again: a no-op, unchanged", () => {
    const { last } = run(T, [SYNCED_600, synced(20, { f2: "600" })]);
    expect(results(last)).toEqual({ f2: "noop" });
    expect(outcome(last)).toBe("unchanged");
  });

  it("600 in effect, 650: applied, updated; judged on #10", () => {
    const { last } = run(T, [SYNCED_600, synced(20, { f2: "650" })]);
    expect(results(last)).toEqual({ f2: "applied" });
    expect(outcome(last)).toBe("updated");
    expect(byKeyOf(last)).toEqual({ byKey: true, baseline: { f2: 10 }, seen: 10 });
  });

  it("500 the user's, 600 again: a no-op; with evidence pointed at, still a no-op", () => {
    const pre = [SYNCED_600, user(20, 10, { f2: "500" })];
    expect(results(run(T, [...pre, synced(30, { f2: "600" })]).last)).toEqual({ f2: "noop" });
    expect(results(run(T, [...pre, synced(30, { f2: "600" }, true)]).last)).toEqual({
      f2: "noop",
    });
  });

  it("600 in effect, 600 with evidence pointed at: a corroboration, updated", () => {
    const { last } = run(T, [SYNCED_600, synced(20, { f2: "600" }, true)]);
    expect(results(last)).toEqual({ f2: "corroborated" });
    expect(outcome(last)).toBe("updated");
  });

  it("500 the user's, 650: a candidate, pending", () => {
    const { last } = run(T, [SYNCED_600, user(20, 10, { f2: "500" }), synced(30, { f2: "650" })]);
    expect(results(last)).toEqual({ f2: "candidate" });
    expect(outcome(last)).toBe("pending");
    expect(last.conflicts).toMatchObject([{ unit: { fields: ["f2"] }, with: [20] }]);
  });

  const conflicted = [SYNCED_600, user(20, 10, { f2: "500" }), synced(30, { f2: "650" })];

  it("500, the 650 candidate still open, 650 again: a no-op (the candidate is a sync contribution)", () => {
    const { last } = run(T, [...conflicted, synced(40, { f2: "650" })]);
    expect(results(last)).toEqual({ f2: "noop" });
  });

  it("500, the 650 conflict kept effective, 650 again: a no-op; 700: a candidate", () => {
    const kept = [...conflicted, decide(40, "keep_effective", [31])];
    expect(results(run(T, [...kept, synced(50, { f2: "650" })]).last)).toEqual({ f2: "noop" });
    expect(results(run(T, [...kept, synced(50, { f2: "700" })]).last)).toEqual({
      f2: "candidate",
    });
  });

  it("650 taken from the candidate, 700: applied (the baseline position moved to the taking)", () => {
    const { last } = run(T, [
      ...conflicted,
      decide(40, "take_candidate", [31]),
      synced(50, { f2: "700" }),
    ]);
    expect(results(last)).toEqual({ f2: "applied" });
    expect(byKeyOf(last)).toEqual({ byKey: true, baseline: { f2: 40 }, seen: 40 });
  });

  it("the 650 conflict taken back: 600 written back (the merge base), then 650 a no-op and 700 a candidate", () => {
    const back = run(T, [...conflicted, decide(40, "take_previous", [31])]);
    expect(back.last.record).toMatchObject({ kind: "take_previous", revert: { mergeBase: 10 } });
    expect(f2Now(back.state)).toEqual({ kind: "value", value: "600" });
    const tp = [...conflicted, decide(40, "take_previous", [31])];
    expect(results(run(T, [...tp, synced(50, { f2: "650" })]).last)).toEqual({ f2: "noop" });
    const again = run(T, [...tp, synced(50, { f2: "700" })]).last;
    expect(results(again)).toEqual({ f2: "candidate" });
    // The write-back is not a sync contribution: the baseline position stays at #10.
    expect(byKeyOf(again)).toEqual({ byKey: true, baseline: { f2: 10 }, seen: 10 });
  });

  it("a synced 650 undone (600 in effect), 650 again: a no-op; 700: a candidate, judged on #10", () => {
    const undone = [SYNCED_600, synced(20, { f2: "650" }), undo(30, 20)];
    expect(results(run(T, [...undone, synced(40, { f2: "650" })]).last)).toEqual({ f2: "noop" });
    const again = run(T, [...undone, synced(40, { f2: "700" })]).last;
    expect(results(again)).toEqual({ f2: "candidate" });
    expect(byKeyOf(again)).toEqual({ byKey: true, baseline: { f2: 10 }, seen: 10 });
  });
});

describe("with a baseline value, the same-value step compares with it alone", () => {
  // Found by the comparison with the reference evaluator: #10 created with f2 "a", #20 synced "b",
  // #30 undoes #20 (f2 back to "a"), #40 sends "a". The baseline value is "b" (an undone sync
  // contribution still counts), so "a" is the source changed: judged for conflicts on the baseline
  // position #10, after which #30 changed f2 — a candidate, not a no-op against the value "a" at #10.
  it("a value other than the baseline value, equal to the value at the baseline position: a candidate", () => {
    const { last } = run(T, [
      created(10, { f2: "a" }),
      synced(20, { f2: "b" }),
      undo(30, 20),
      synced(40, { f2: "a" }),
    ]);
    expect(results(last)).toEqual({ f2: "candidate" });
    expect(byKeyOf(last)).toEqual({ byKey: true, baseline: { f2: 10 }, seen: 10 });
  });
});

describe("the baseline the record keeps", () => {
  it("only the fields given a value: a no-op field has none (09 §5.7 ops/<i>/baseline)", () => {
    const { last } = run(T, [
      created(10, { f2: "600", f3: "x" }),
      synced(20, { f2: "650", f3: "x" }),
    ]);
    expect(results(last)).toEqual({ f2: "applied", f3: "noop" });
    expect(byKeyOf(last)).toEqual({ byKey: true, baseline: { f2: 10 }, seen: 10 });
  });
});

describe("a key added to a row written by hand", () => {
  // #10 written by hand (500), #20 the key added (an ordinary write giving the key field).
  const pre = [user(10, 9, { f2: "500" }), user(20, 10, { f9: "K" })];

  it("the first sync compares with the value at the key's operation: 600 applied, 500 a no-op", () => {
    const changed = run(T, [...pre, synced(30, { f2: "600" })]).last;
    expect(results(changed)).toEqual({ f2: "applied" });
    expect(byKeyOf(changed)).toEqual({ byKey: true, baseline: { f2: 20 }, seen: 20 });
    expect(results(run(T, [...pre, synced(30, { f2: "500" })]).last)).toEqual({ f2: "noop" });
  });

  it("changed by hand after the key: the first sync of another value is a candidate", () => {
    const { last } = run(T, [...pre, user(25, 20, { f2: "550" }), synced(30, { f2: "600" })]);
    expect(results(last)).toEqual({ f2: "candidate" });
  });
});

describe("a revoke undone", () => {
  it("after the undo, a change of the source is a candidate the first time", () => {
    const { last } = run(T, [SYNCED_600, revoke(20, 10), undo(30, 20), synced(40, { f2: "650" })]);
    expect(results(last)).toEqual({ f2: "candidate" });
    expect(last.conflicts).toMatchObject([{ unit: "existence" }]);
  });
});

describe("a conflict group whose fields have different baseline positions", () => {
  // #10 created with f2, f3, f4; #20 a sync of f2 and f3; #30 the user's f3; #40 a sync of all
  // three: f2 and f3 (one unit, positions #20) a candidate, f4 (position #10) applied.
  const steps = [
    created(10, { f2: "a", f3: "b", f4: "c" }),
    synced(20, { f2: "a2", f3: "b2" }),
    user(30, 20, { f3: "x" }),
    synced(40, { f2: "a3", f3: "b3", f4: "c2" }),
  ];

  it("each field on its own position; seen the earliest; the candidate in the group's unit", () => {
    const { last } = run(GROUPED, steps);
    expect(results(last)).toEqual({ f2: "candidate", f3: "candidate", f4: "applied" });
    expect(byKeyOf(last)).toEqual({
      byKey: true,
      baseline: { f2: 20, f3: 20, f4: 10 },
      seen: 10,
    });
  });

  it("taken back, the merge base is the unit's earliest position (#20), not the write's seen (#10)", () => {
    const { last, state } = run(GROUPED, [
      ...steps,
      decide(50, "take_previous", [41], { fields: ["f2", "f3"] }),
    ]);
    expect(last.record).toMatchObject({ revert: { mergeBase: 20 } });
    const f3 = state.items.filter((x) => x.target === "f3" && x.op === 50).map((x) => x.content);
    expect(f3).toEqual([{ kind: "value", value: "b2" }]);
  });
});

describe("a conflict group whose two fields have different baseline positions", () => {
  // #10 created with f2, f3; #20 a sync of f2 only (f2's position #20, f3's still #10); #30 the
  // user's f3; #40 a sync of both: a candidate in the unit {f2, f3}, which changed after #10 and
  // after #20 (the connector's own #20 in it too: 09 §5.8 takes the earliest, as written).
  const steps = [
    created(10, { f2: "a", f3: "b" }),
    synced(20, { f2: "a2" }),
    user(30, 20, { f3: "x" }),
    synced(40, { f2: "a3", f3: "b3" }),
  ];

  it("each field on its own position; the conflict with every operation after the earlier one", () => {
    const { last } = run(GROUPED, steps);
    expect(results(last)).toEqual({ f2: "candidate", f3: "candidate" });
    expect(byKeyOf(last)).toEqual({ byKey: true, baseline: { f2: 20, f3: 10 }, seen: 10 });
    expect(last.conflicts).toMatchObject([{ unit: { fields: ["f2", "f3"] }, with: [20, 30] }]);
  });

  it("taken back, the merge base is the earliest of the unit's positions (#10): a and b written back", () => {
    const { last, state } = run(GROUPED, [
      ...steps,
      decide(50, "take_previous", [41], { fields: ["f2", "f3"] }),
    ]);
    expect(last.record).toMatchObject({ revert: { mergeBase: 10 } });
    const back = state.items
      .filter((x) => x.op === 50)
      .map((x) => [x.target, x.content])
      .sort();
    expect(back).toEqual([
      ["f2", { kind: "value", value: "a" }],
      ["f3", { kind: "value", value: "b" }],
    ]);
  });
});

describe("the writes that changed a field since its baseline position, among a part's deps", () => {
  // Event and timeless tables keep no deps in their records (judge.ts), so this is judgeWrite's own
  // output. A row written by hand at #10 (500), its key added at #20, the user's 550 at #30, then
  // 500 sent by key with evidence pointed at: no baseline value, so compared with the value at the
  // position #20 (500), a corroboration there; changed since (#30), the changed part is an ordinary
  // write whose deps are the writes after the field's position that changed it — #30, not #10.
  it("are the ones after the field's own position, not after the op's given seen", () => {
    const { state } = run(T, [
      user(10, 9, { f2: "500" }),
      user(20, 10, { f9: "K" }),
      user(30, 20, { f2: "550" }),
    ]);
    const out = judgeWrite(state, synced(40, { f2: "500" }, true));
    expect(out.items.map((x) => ({ target: x.target, status: x.status, deps: x.deps }))).toEqual([
      { target: "f2", status: "candidate", deps: [{ event: 31, target: "f2", k: 0 }] },
    ]);
  });
});

describe("a revert never takes a row's key back (04-write-and-read «给没有来源键的行补键»)", () => {
  // The key fields known to the table (`keyFields`): no revert record has them.
  const KEYED: TableShape = { ...T, keyFields: ["f9"] };
  // #10 written by hand; #20 its key added, alone or with another field.
  const handRow = user(10, 9, { f2: "500" });

  it("undoing a write that only added the key: no change to undo", () => {
    let caught: unknown;
    try {
      run(KEYED, [handRow, user(20, 10, { f9: "K" }), undo(30, 20)]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ reason: "invalid_argument", detail: { reason: "undo_target" } });
  });

  it("undoing a write that added the key and changed a field: the field goes back, the key stays", () => {
    const { last, state } = run(KEYED, [
      handRow,
      user(20, 10, { f9: "K", f2: "550" }),
      undo(30, 20),
    ]);
    const entries = (last.record as unknown as { revert: { entries: { target: string }[] } }).revert
      .entries;
    expect(entries.map((e) => e.target)).toEqual(["f2"]);
    const live = (f: string) =>
      state.items
        .filter((x) => x.target === f && x.status === "applied")
        .filter((x) => state.registrations(x, { upTo: 1e9 }).length === 0)
        .map((x) => [x.op, x.content]);
    expect(live("f9")).toEqual([[20, { kind: "value", value: "K" }]]);
    expect(live("f2")).toContainEqual([30, { kind: "value", value: "500" }]);
  });

  it("without keyFields the key field is reverted like any field (the shape decides)", () => {
    const { last } = run(T, [handRow, user(20, 10, { f9: "K", f2: "550" }), undo(30, 20)]);
    const entries = (last.record as unknown as { revert: { entries: { target: string }[] } }).revert
      .entries;
    expect(entries.map((e) => e.target).sort()).toEqual(["f2", "f9"]);
  });
});

describe("a deletion's replay of a write that added a key: not implemented in this version", () => {
  it("refused, naming the kind; without the key fields known, replayed as any write", () => {
    const keyed: TableShape = { ...T, keyFields: ["f9"] };
    const { state } = run(keyed, [user(10, 9, { f2: "500" }), user(20, 10, { f9: "K" })]);
    let caught: unknown;
    try {
      replayDeletion(keyed, state.records, new Set());
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      reason: "not_implemented",
      detail: { kind: "write_adding_external_key", op: 20 },
    });
    expect(() => replayDeletion(T, state.records, new Set())).not.toThrow();
  });
});

describe("a deletion's replay of a write by key: not implemented in this version", () => {
  it("refused at the first write by key, naming the kind, before the write adding a key's check", () => {
    const keyed: TableShape = { ...T, keyFields: KEY };
    const { state } = run(keyed, [created(10, { f2: "600" }), synced(20, { f2: "700" })]);
    let caught: unknown;
    try {
      replayDeletion(keyed, state.records, new Set());
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      reason: "not_implemented",
      detail: { kind: "write_by_external_key", op: 10 },
    });
  });
});

describe("undoneOp: a key field's item is not one of an operation's changes", () => {
  // Hand-written records (an awaiting undo is not reachable on a table with a key: no high impact
  // there): op 20 added the key and proposed an undo, confirmed by op 30. Undoing op 20 is undoing
  // what the confirmation wrote; the key item alone does not make op 20 its own target.
  it("an op that only added the key and proposed an undo: the confirmation's op is undone", () => {
    const item = (target: string, value: string) => ({
      target,
      k: 0,
      status: "applied" as const,
      valid: [{}],
      content: { kind: "value" as const, value },
      deps: [],
    });
    const w = (op: number, items: unknown[]) => ({
      ...base(op),
      kind: "write",
      seen: op - 1,
      seenExplicit: true,
      now: NOW,
      explicit: [],
      items,
      noop: [],
      ack: [],
    });
    const revert = { entries: [], before: 10, skipped: [] };
    const records = [
      w(10, [item("f2", "1")]),
      w(20, [item("f9", "K")]),
      {
        ...base(20),
        index: 1,
        event: 22,
        kind: "undo",
        status: "awaiting",
        revert,
        items: [],
        seen: 19,
        seenExplicit: true,
        ack: [],
      },
      { ...base(30), kind: "confirm", target: 22, items: [], revert },
    ];
    const keyed = stateFromRecord({ ...T, keyFields: ["f9"] }, records as never);
    expect(undoneOp(keyed, 20 as never)).toBe(30);
    // Without the key fields known, the key item counts: op 20 is its own target.
    expect(undoneOp(stateFromRecord(T, records as never), 20 as never)).toBe(20);
  });
});

describe("what a write by key is not", () => {
  it("a key field among the fields of a write by key hitting the row is the caller's mistake", () => {
    expect(() => run(T, [SYNCED_600, synced(20, { f2: "650", f9: "K" })])).toThrow(JudgeError);
  });

  it("no key on the row and no sync contribution: the caller's mistake", () => {
    expect(() => run(T, [user(10, 9, { f2: "500" }), synced(20, { f2: "600" })])).toThrow(
      JudgeError,
    );
  });

  it("hitting a row, the record lists the key fields among the no-ops (09 §5.7 ops/<i>/noop)", () => {
    const { last } = run(T, [SYNCED_600, synced(20, { f2: "650" })]);
    expect((last.record as WriteRecord).noop).toEqual(["f9"]);
  });

  it("a write by key creating its row: items marked as sync contributions, no baseline", () => {
    const { last, state } = run(T, [SYNCED_600]);
    expect(byKeyOf(last)).toEqual({ byKey: true, seen: 9 });
    expect(state.items.every((x) => x.sync === true)).toBe(true);
  });

  it("an ordinary write: no byKey, no baseline, seen as given", () => {
    const { last } = run(T, [SYNCED_600, user(20, 10, { f2: "650" })]);
    expect(last.record).toMatchObject({ seenExplicit: true });
    expect(byKeyOf(last)).toEqual({ byKey: undefined, seen: 10 });
  });

  it("a deletion's replay of a log with a write by key: not implemented in this version", () => {
    const { state } = run(T, [SYNCED_600, synced(20, { f2: "650" })]);
    let caught: unknown;
    try {
      replayDeletion(T, state.records, new Set());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JudgeError);
    expect(caught).toMatchObject({ reason: "not_implemented" });
  });
});

describe("syncOutcome", () => {
  it.each([
    [["noop", "noop"], "unchanged"],
    [["corroborated"], "updated"],
    [["corroborated", "corroborated"], "updated"],
    [["applied", "candidate"], "updated"],
    [["candidate", "noop"], "pending"],
    [["awaiting"], "pending"],
  ])("%j → %s", (r, o) => {
    expect(syncOutcome(r as never)).toBe(o);
  });
});
