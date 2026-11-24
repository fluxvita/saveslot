// A deletion's cancellation with no write in its grace period (replay-deletion.ts
// `cancellationResult`; 03-deletion «撤回与宽限期»; 09 §5.9 `deletion.cancelled`), on judged logs.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import type { Op } from "@fluxvita/saveslot-reference";
import { evaluateLog } from "@fluxvita/saveslot-reference";
import { STATE } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { cancelBoth, laid, PART_BACK_OPS } from "./cancel.fixture.ts";
import { advance, openItems } from "./fates.fixture.ts";
import { type ItemStanding, type ItemsGiven, itemsByRecords } from "./fates.ts";
import { view } from "./judge.ts";
import type { OpRecord, Restatement } from "./model.ts";
import { cancellationResult, deletionResult, replayDeletion } from "./replay-deletion.ts";
import { givenByRecords } from "./restate.ts";
import { deletedContributions, judged } from "./scenarios.fixture.ts";
import { RowState } from "./state.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const w = (
  op: number,
  seen: number,
  fields: Record<string, string>,
  o: { from?: string; to?: string; ack?: boolean } = {},
): Op => ({
  kind: "write",
  op,
  event: op + 1,
  seen,
  now: d("11-05"),
  valid: {
    from: { mode: "given", value: d(o.from ?? "10-01") },
    to: o.to === undefined ? { mode: "open" } : { mode: "given", value: d(o.to) },
  },
  fields: Object.fromEntries(
    Object.entries(fields).map(([f, value]) => [f, { value, sources: [`S${op}${f}`] }]),
  ) as never,
  ...(o.ack ? { acknowledge: ["overwrite"] as const } : {}),
});

/**
 * The log judged; deletion A (its sources) confirmed, then B (pending before it is A), then A
 * cancelled. The kernel's three events, each given what the log says before it.
 */
function inTurn(ops: Op[], a: string[], b: string[] = []) {
  const { table, steps } = judged(STATE, ops, []);
  expect(steps).toHaveLength(ops.length);
  const kept = steps.map((x) => x.op);
  const records: OpRecord[] = steps.map((x) => x.judgement.record);
  const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
  const [ga, gb] = [gone(a), gone(b)];
  const base = givenByRecords(records);
  const g0 = itemsByRecords(new RowState(table, records));
  const delA = deletionResult(table, records, ga, new Set(), g0, [], base);
  const afterA = laid(base, delA.replay.restated);
  const g1 = advance(g0, delA.items);
  const both = new Set([...ga, ...gb]);
  const delB = b.length > 0 ? deletionResult(table, records, both, ga, g1, [], afterA) : undefined;
  const g2 = delB === undefined ? g1 : advance(g1, delB.items);
  // Without A's blocks (09 §5.7): B's restatements over the records; the items whose last block
  // came from A: restated by A and not since by B.
  const withoutA = laid(base, delB?.replay.restated ?? []);
  const byB = new Set(
    (delB?.replay.restated ?? []).map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
  );
  // The items whose last interval block came from A: restated by A (not as dropped), not since by B.
  const fromA = new Set(
    delA.replay.restated
      .filter((r) => r.status !== "dropped")
      .map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`)
      .filter((k) => !byB.has(k)),
  );
  const cancel = cancellationResult(table, records, gb, ga, g2, withoutA, fromA, []);
  return { table, records, kept, delA, delB, g0, g2, cancel, end: advance(g2, cancel.items), gb };
}

const keys = (r: readonly Restatement[]) =>
  r.map((x) => [`${x.item.event}/${x.item.target}/${x.item.k}`, x.status]);

// #10 f2=1; #20, having seen #10, writes 2; #30, having seen #10 only, writes 3: a candidate.
const conflict = [w(10, 0, { f2: "1" }), w(20, 10, { f2: "2" }), w(30, 10, { f2: "3" })];

describe("a cancellation puts back what the deletion took (no write in the grace period)", () => {
  it("the value in effect deleted and the deletion cancelled: the candidate pending again, its item restored", () => {
    const r = inTurn(conflict, ["S20f2"]);
    expect(keys(r.delA.replay.restated)).toContainEqual(["31/f2/0", "applied"]);
    expect(r.delA.items.superseded).toEqual(["31:f2"]);
    // The state is the records' again.
    expect(view(r.cancel.replay.state)).toEqual(view(new RowState(r.table, r.records)));
    // Rule 3: #31's last block was the deletion's (applied); as the records give it again
    // (candidate) it is restated as it is, though rule 1 against the records finds nothing.
    expect(keys(r.cancel.replay.restated)).toContainEqual(["31/f2/0", "candidate"]);
    expect(Object.fromEntries(r.cancel.items.fates)).toEqual({
      "31/f2": { kind: "restored", item: "31:f2", restores: "31:f2" },
    });
    expect(r.cancel.items.restored).toEqual(["31:f2"]);
    // #21 back: its stretch listed with its value.
    expect(r.cancel.result.stretches.map((x) => [x.field, x.value])).toContainEqual(["f2", "2"]);
    expect(openItems(r.end, r.cancel.replay.state)).toEqual(
      openItems(r.g0, new RowState(r.table, r.records)),
    );
  });

  it("a candidate turned awaiting by the deletion: the successor superseded, the original restored", () => {
    // As fates.test.ts: #30 a candidate against #25 and of high impact; #25's value deleted.
    const log = [
      w(10, 0, { f2: "5000" }),
      w(20, 10, { f2: "4000" }, { from: "11-10" }),
      w(25, 20, { f2: "6000" }, { from: "11-06", to: "11-10" }),
      w(30, 20, { f2: "7000" }, { from: "11-02" }),
    ];
    const r = inTurn(log, ["S25f2"]);
    expect(r.delA.items.opened.map((x) => [x.succeeds, x.kind])).toEqual([["31:f2", "awaiting"]]);
    expect(Object.fromEntries(r.cancel.items.fates)).toEqual({
      "31/f2": { kind: "restored", item: "31:f2>awaiting", restores: "31:f2" },
    });
    expect(r.cancel.items.superseded).toEqual(["31:f2>awaiting"]);
    expect(r.cancel.items.restored).toEqual(["31:f2"]);
    expect(openItems(r.end, r.cancel.replay.state)).toEqual(
      openItems(r.g0, new RowState(r.table, r.records)),
    );
  });

  it("another deletion still pending: the state is that deletion's alone, and so are the open items", () => {
    const r = inTurn(conflict, ["S20f2"], ["S30f2"]);
    const onlyB = replayDeletion(r.table, r.records, r.gb).state;
    expect(view(r.cancel.replay.state)).toEqual(view(onlyB));
    const once = deletionResult(
      r.table,
      r.records,
      r.gb,
      new Set(),
      r.g0,
      [],
      givenByRecords(r.records),
    );
    expect(openItems(r.end, r.cancel.replay.state)).toEqual(
      openItems(advance(r.g0, once.items), onlyB),
    );
  });

  it("the reference evaluator gives the same values and items after the cancellation", () => {
    const r = inTurn(conflict, ["S20f2"], ["S30f2"]);
    const last = Math.max(...r.kept.map((o) => Math.max(o.op, o.event)));
    const ref = evaluateLog(STATE, [
      ...r.kept,
      { kind: "deletion", op: last + 1, id: "pi_a", sources: ["S20f2"] },
      { kind: "deletion", op: last + 2, id: "pi_b", sources: ["S30f2"] },
      { kind: "cancel", op: last + 3, id: "pi_a" },
    ]).final;
    const kernel = view(r.cancel.replay.state);
    expect((kernel.fields["f2" as never] ?? []).map((x) => [x.valid, x.value])).toEqual(
      ((ref.fields as Record<string, { valid: unknown; value: unknown }[]>)["f2"] ?? []).map(
        (x) => [x.valid, x.value],
      ),
    );
  });
});

describe("rule 3 (09 §5.9): an item whose last block came from the deletion cancelled", () => {
  it("is restated as it is, also where the records give it the same", () => {
    // Deleting S20f2 restates #31 (rule 1, now applied). After the cancellation #31 is as the
    // records give it: without rule 3 nothing would restate it (a reader skips the deletion's blocks
    // anyway; rule 3 is the format's as-is restatement, kept by this case).
    const r = inTurn(conflict, ["S20f2"]);
    const without = replayDeletion(
      r.table,
      r.records,
      new Set(),
      [],
      givenByRecords(r.records),
    ).restated;
    expect(without).toEqual([]);
    expect(keys(r.cancel.replay.restated)).toEqual([["31/f2/0", "candidate"]]);
  });

  it("one another pending deletion takes away is not restated", () => {
    // B takes #31 away too: after cancelling A it is deleted still, so nothing is said of it.
    const r = inTurn(conflict, ["S20f2"], ["S30f2"]);
    expect(keys(r.cancel.replay.restated).filter(([k]) => String(k).startsWith("31/"))).toEqual([]);
  });
});

describe("rule 3 feeds rule 2 (09 §5.9): a block resting on an item restated as it is", () => {
  it("is restated too", () => {
    // #10 f2=2 from 11-01; #20 f2=1 from 10-01 to the next change: its end rests on #10's start.
    // #10's last block came from the deletion cancelled: restated as it is, and so #20, whose
    // block rests on it.
    const ops: Op[] = [
      w(10, 0, { f2: "2" }, { from: "11-01" }),
      {
        ...w(20, 10, { f2: "1" }),
        valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "next_change" } },
      } as Op,
    ];
    const { table, steps } = judged(STATE, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect((records[1] as unknown as { items: { deps: unknown[] }[] }).items[0]?.deps).toEqual([
      { event: 11, target: "f2", k: 0 },
    ]);
    const r = cancellationResult(
      table,
      records,
      new Set(),
      new Set(),
      itemsByRecords(new RowState(table, records)),
      givenByRecords(records),
      new Set(["11/f2/0"]),
      [],
    );
    expect(keys(r.replay.restated)).toEqual([
      ["11/f2/0", "applied"],
      ["21/f2/0", "applied"],
    ]);
  });
});

describe("existence items put back touch the row (09 §5.9 «列哪些»)", () => {
  // #10 f2=1 on [10-01, 10-10); #20 revokes [11-01, 11-05), where there is no value, its interval
  // from R20. Deleting R20 takes the revoke away; the row's values are the same either way.
  const rv = {
    kind: "revoke",
    op: 20,
    event: 21,
    seen: 10,
    valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "given", value: d("11-05") } },
    validSources: ["R20"],
  } as Op;
  const ops = [w(10, 0, { f2: "1" }, { to: "10-10" }), rv];

  it("the deletion cancelled took a revoke away: the row is listed, with its gaps", () => {
    const r = inTurn(ops, ["R20"]);
    expect(r.delA.result.listed).toBe(true);
    expect(r.cancel.result.listed).toBe(true);
    expect(r.cancel.result.gaps?.deps).toContainEqual({ event: 21, target: "existence", k: 0 });
  });

  it("another pending deletion took it away, the one cancelled nothing of the row: not listed", () => {
    const { table, steps } = judged(STATE, ops, []);
    const records = steps.map((x) => x.judgement.record);
    const kept = steps.map((x) => x.op);
    const other = deletedContributions(kept, new Set(["R20"]), true);
    const g = itemsByRecords(new RowState(table, records));
    const r = cancellationResult(
      table,
      records,
      other,
      new Set(),
      g,
      givenByRecords(records),
      new Set(),
      [],
    );
    expect(r.result.listed).toBe(false);
  });
});

describe("an operation after a deletion event (a write in the grace period): not in this version", () => {
  // #10 f2=1; #20 (seen #10) f2=2; #30 (seen #10) f2=3: a candidate. A deletion of S20f2 at
  // operation 35 puts #30 in effect; #40, written in its grace period having seen 35, writes f3.
  // Its cancellation would have to keep #30 in effect (kept_effective): refused, as the deletion's
  // own result of a log with an operation after it.
  const ops = [...conflict, w(40, 35, { f3: "x" })];
  const { table, steps } = judged(STATE, ops, []);
  const records = steps.map((x) => x.judgement.record);
  const kept = steps.map((x) => x.op);
  const ga = deletedContributions(kept, new Set(["S20f2"]), true);
  const g = itemsByRecords(new RowState(table, records));
  const refusal = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it("the cancellation is refused", () => {
    expect(
      refusal(() =>
        cancellationResult(
          table,
          records,
          new Set(),
          ga,
          g,
          givenByRecords(records),
          new Set(),
          [35],
        ),
      ),
    ).toMatchObject({ reason: "not_implemented" });
  });

  it("so is the deletion's result with an operation after it", () => {
    expect(
      refusal(() =>
        deletionResult(table, records, ga, new Set(), g, [35], givenByRecords(records)),
      ),
    ).toMatchObject({ reason: "not_implemented" });
  });
});

describe("an item's interval as written, once what gives its end is deleted, is read as the log last gave it", () => {
  // f2 and f3 one group. #10 f2=1, f3=a from 10-01; #20 revokes [11-01, 11-07) (S20); #30 writes
  // f2=2, f3=b on [11-03, 11-05); #40 (seen 0) f2=9 on [11-01, 11-03): a candidate; #50 (seen
  // #10) f2=1 from 11-01, pointing at its evidence: a candidate on [11-01, 11-07) (its end the
  // revoke's), a corroboration from 11-07. #53 takes #50. A deletes S20, then B deletes S10, then
  // B is cancelled: as A alone, with #51's blocks as A restated them. Its candidate's end 11-07
  // came from the revoke, which is deleted: its interval is A's restatement [11-01, 11-03), so
  // from 11-05 #51 was a corroboration when written and the take does not land there.
  const ops: Op[] = [
    {
      ...w(10, 0, { f2: "1", f3: "a" }, { ack: true }),
      fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
    } as Op,
    {
      kind: "revoke",
      op: 20,
      event: 21,
      seen: 10,
      valid: {
        from: { mode: "given", value: d("11-01") },
        to: { mode: "given", value: d("11-07") },
      },
      validSources: ["S20"],
    } as Op,
    {
      ...w(30, 0, { f2: "2", f3: "b" }, { from: "11-03", to: "11-05" }),
      seen: undefined,
      fields: { f2: { value: "2", sources: ["S30"] }, f3: { value: "b", sources: ["S30"] } },
    } as never as Op,
    w(40, 0, { f2: "9" }, { from: "11-01", to: "11-03" }),
    {
      ...w(50, 10, { f2: "1" }, { from: "11-01", ack: true }),
      fields: { f2: { value: "1", sources: ["S50"], explicit: true } },
    } as Op,
    {
      kind: "resolve",
      op: 53,
      event: 54,
      decision: "take_candidate",
      candidates: [41, 51],
      unit: "existence",
      take: 51,
    } as Op,
  ];
  const schema = { ...STATE, groups: [["f2", "f3"]] } as typeof STATE;
  it("the take lands on [11-01, 11-05), as the reference evaluator gives it", () => {
    const { table, steps } = judged(schema, ops, []);
    expect(steps).toHaveLength(ops.length);
    const records = steps.map((x) => x.judgement.record);
    const kept = steps.map((x) => x.op);
    const gA = deletedContributions(kept, new Set(["S20"]), true);
    const gB = deletedContributions(kept, new Set(["S10"]), true);
    const at54 = (items: readonly { event: number; status: string; valid: unknown }[]) =>
      items.filter((x) => x.event === 54).map((x) => [x.status, x.valid]);
    // A alone: the blocks as written are the latest; the candidate's interval read from them.
    const alone = replayDeletion(table, records, gA);
    const refAlone = evaluateLog(schema, [
      ...kept,
      { kind: "deletion", op: 61, id: "pi_a", sources: ["S20"] },
    ]).final;
    expect(at54(alone.state.items)).toEqual(at54(refAlone.items));
    // A, B, B cancelled: A's restatements are the latest.
    const afterA = laid(givenByRecords(records), alone.restated);
    const both = replayDeletion(table, records, new Set([...gA, ...gB]), [], afterA);
    const fromB = new Set(
      both.restated
        .filter((r) => r.status !== "dropped")
        .map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
    );
    const cB = cancellationResult(
      table,
      records,
      gA,
      gB,
      itemsByRecords(new RowState(table, records)),
      afterA,
      fromB,
      [],
    );
    const ref = evaluateLog(schema, [
      ...kept,
      { kind: "deletion", op: 61, id: "pi_a", sources: ["S20"] },
      { kind: "deletion", op: 62, id: "pi_b", sources: ["S10"] },
      { kind: "cancel", op: 63, id: "pi_b" },
    ]).final;
    expect(at54(cB.replay.state.items)).toEqual([
      ["applied", [{ from: d("11-01"), to: d("11-05") }]],
    ]);
    expect(at54(cB.replay.state.items)).toEqual(at54(ref.items));
  });
});

describe("an item a deletion restated as dropped: its interval is the last one given", () => {
  // #10 f2=1; #20 f2=2 on [11-01, 11-03); #30 f2=2 on [11-07, 11-09); #40 (seen #10) f2=1 on
  // [11-01, 11-09), pointing at its evidence: candidates on [11-01, 11-03) and [11-07, 11-09), a
  // corroboration between; #50 takes it. A deletes S30: the candidate on [11-07, 11-09) is the
  // same as the value now, restated as dropped. B deletes S20, then is cancelled: as A alone.
  // The dropped block gives no interval; the last one that did is the write's own, so the take
  // still lands on [11-01, 11-09).
  const ops: Op[] = [
    w(10, 0, { f2: "1" }, { ack: true }),
    w(20, 10, { f2: "2" }, { from: "11-01", to: "11-03", ack: true }),
    w(30, 20, { f2: "2" }, { from: "11-07", to: "11-09", ack: true }),
    {
      ...w(40, 10, { f2: "1" }, { from: "11-01", to: "11-09" }),
      fields: { f2: { value: "1", sources: ["S40f2"], explicit: true } },
    } as Op,
    {
      kind: "resolve",
      op: 50,
      event: 51,
      decision: "take_candidate",
      candidates: [41],
      unit: "f2",
      take: 41,
    } as Op,
  ];
  it("the take on [11-01, 11-09), as the reference evaluator gives it", () => {
    const { table, steps } = judged(STATE, ops, []);
    const records = steps.map((x) => x.judgement.record);
    const kept = steps.map((x) => x.op);
    const gA = deletedContributions(kept, new Set(["S30f2"]), true);
    const alone = replayDeletion(table, records, gA);
    const afterA = laid(givenByRecords(records), alone.restated);
    const replay = replayDeletion(table, records, gA, [], afterA);
    // The reference's view lists dropped items too: no contribution, not compared.
    const at51 = (items: readonly { event: number; status: string; valid: unknown }[]) =>
      items.filter((x) => x.event === 51 && x.status !== "dropped").map((x) => [x.status, x.valid]);
    const ref = evaluateLog(STATE, [
      ...kept,
      { kind: "deletion", op: 61, id: "pi_a", sources: ["S30f2"] },
      { kind: "deletion", op: 62, id: "pi_b", sources: ["S20f2"] },
      { kind: "cancel", op: 63, id: "pi_b" },
    ]).final;
    expect(at51(replay.state.items)).toEqual([["applied", [{ from: d("11-01"), to: d("11-09") }]]]);
    expect(at51(replay.state.items)).toEqual(at51(ref.items));
  });
});

describe("a part going back pending as its original item's kind goes back to its original item, not the successor it is in", () => {
  // #10 f2=9 from 10-01 (S5); #20 f2=9 on [11-01, 11-03); #40 revokes [11-01, 11-03) (S1); #60
  // (seen #20) f2=9 from 11-01 pointing at its evidence: a candidate on [11-01, 11-03) on the
  // existence item 61:existence (it met the revoke), a corroboration from 11-03; #70 revokes
  // [11-01, 11-03) again (S1). A deletes S1, B deletes S5: #61 awaiting, 61:existence>awaiting
  // succeeding the conflict item. B cancelled: #61 a corroboration, not pending. A cancelled: its
  // part in effect goes back, a candidate again: of the original item's kind, so back in
  // 61:existence, restored (03-deletion «因先前的删除才生效、本次将回到未决的写入»: «种类与原事项
  // 相同的给出它回到的原事项（已被取代的恢复…）», kinds compared with the original item's).
  const ops = PART_BACK_OPS;
  const run = (a: string[], b: string[]) => {
    const { table, steps } = judged(STATE, ops, []);
    return cancelBoth(
      table,
      steps.map((x) => x.judgement.record),
      steps.map((x) => x.op),
      a,
      b,
    );
  };
  it("of the kind of neither its original item nor the one it is in: a new item succeeds the original", () => {
    // A deletes S1: #61 a corroboration, not pending. B deletes S5 too: its part in effect goes
    // back, pending as awaiting; its original item and the one it is in are both 61:existence, a
    // conflict item: succeeded, an awaiting item opened.
    const { table, steps } = judged(STATE, ops, []);
    const kept = steps.map((x) => x.op);
    const records = steps.map((x) => x.judgement.record);
    const ga = deletedContributions(kept, new Set(["S1"]), true);
    const gab = deletedContributions(kept, new Set(["S1", "S5"]), true);
    const base = givenByRecords(records);
    const g0 = itemsByRecords(new RowState(table, records));
    const delA = deletionResult(table, records, ga, new Set(), g0, [], base);
    const delB = deletionResult(
      table,
      records,
      gab,
      ga,
      advance(g0, delA.items),
      [],
      laid(base, delA.replay.restated),
    );
    expect(delB.items.fates.get("61/f2")).toMatchObject({
      kind: "succeeded",
      succeeds: "61:existence",
      as: "awaiting",
    });
    expect(delB.items.opened).toMatchObject([
      { succeeds: "61:existence", kind: "awaiting", members: ["61/f2"] },
    ]);
  });

  it("of the kind of the successor it is in, not its original item's: back in that successor, restored", () => {
    // As above, then B cancelled (the successor superseded, #61 not pending), then S5 deleted again
    // (another deletion): its part in effect goes back pending as awaiting, the kind of the
    // successor it is in, not of 61:existence: back in 61:existence>awaiting, restored.
    const r = run(["S1"], ["S5"]);
    const base = givenByRecords(r.records);
    const { steps } = judged(STATE, ops, []);
    const kept = steps.map((x) => x.op);
    const ga = deletedContributions(kept, new Set(["S1"]), true);
    const gab = deletedContributions(kept, new Set(["S1", "S5"]), true);
    expect(r.g3.of.get("61/f2")).toBe("61:existence>awaiting");
    const again = deletionResult(
      r.table,
      r.records,
      gab,
      ga,
      r.g3,
      [],
      laid(base, r.cB.replay.restated),
    );
    expect(again.items.fates.get("61/f2")).toMatchObject({ kind: "returned", into: "merged" });
    expect(again.items.fates.get("61/f2")).not.toHaveProperty("to");
    expect(again.items.restored).toEqual(["61:existence>awaiting"]);
    expect(openItems(advance(r.g3, again.items), again.replay.state)).toEqual([
      "61:existence awaiting: 61/f2",
    ]);
  });
  it("61:existence restored, the open items as written", () => {
    const r = run(["S1"], ["S5"]);
    expect(r.g0.items.get("61:existence")?.kind).toBe("conflict");
    // After both deletions, #61 awaiting in the item succeeding 61:existence.
    expect(r.g2.of.get("61/f2")).toBe("61:existence>awaiting");
    expect(r.cA.items.restored).toEqual(["61:existence"]);
    expect(r.cA.items.fates.get("61/f2")).toMatchObject({ kind: "returned", to: "61:existence" });
    expect(openItems(r.end, r.cA.replay.state)).toEqual(openItems(r.g0, r.cA.replay.state));
    expect(openItems(r.end, r.cA.replay.state)).toEqual(["61:existence conflict: 61/f2"]);
  });
});

describe("a part going back whose item is closed, or that is a member of a successor before", () => {
  const { table, steps } = judged(STATE, PART_BACK_OPS, []);
  const records = steps.map((x) => x.judgement.record);
  const kept = steps.map((x) => x.op);
  const base = givenByRecords(records);
  const withStanding = (g: ItemsGiven, id: string, standing: ItemStanding): ItemsGiven => {
    const items = new Map(g.items);
    const x = items.get(id);
    if (x !== undefined) items.set(id, { ...x, standing });
    return { ...g, items };
  };

  // After deleting S1 and S5 and cancelling S5 (61:existence and its awaiting successor both
  // superseded by deletion), the successor is closed for another reason before S1 is cancelled.
  // Its candidate closes with it (03-deletion «撤回与宽限期»: «事项已关闭的（…被普通写入…或被别的
  // 删除、schema 切换）不放回，候选随它关闭»): 61:existence is not restored.
  for (const reason of ["schema_changed", "overwritten"]) {
    it(`the successor superseded (${reason}): closes with it, the original not restored`, () => {
      const r = cancelBoth(table, records, kept, ["S1"], ["S5"]);
      const ga = deletedContributions(kept, new Set(["S1"]), true);
      const delA = deletionResult(
        table,
        records,
        ga,
        new Set(),
        itemsByRecords(new RowState(table, records)),
        [],
        base,
      );
      const byCB = new Set(
        r.cB.replay.restated.map((x) => `${x.item.event}/${x.item.target}/${x.item.k}`),
      );
      const g = withStanding(r.g3, "61:existence>awaiting", { kind: "superseded", reason });
      const cA = cancellationResult(
        table,
        records,
        new Set(),
        ga,
        g,
        laid(base, r.cB.replay.restated),
        new Set(
          delA.replay.restated
            .filter((x) => x.status !== "dropped")
            .map((x) => `${x.item.event}/${x.item.target}/${x.item.k}`)
            .filter((k) => !byCB.has(k)),
        ),
        [],
      );
      expect(cA.items.fates.get("61/f2")).toEqual({
        kind: "returned",
        item: "61:existence>awaiting",
        into: "closed_with_supersession",
      });
      expect(cA.items.restored).toEqual([]);
      expect(openItems(advance(g, cA.items), cA.replay.state)).toEqual([]);
    });
  }

  // As written, a member of an open awaiting item succeeding 61:existence (the item layer given so,
  // deterministically). Deleting S5: #61's part in effect (from 11-03) goes back, a candidate on
  // the whole: of the original item's kind, so it goes to 61:existence and leaves the successor.
  const successor = (original: ItemStanding): ItemsGiven => {
    const g0 = itemsByRecords(new RowState(table, records));
    const items = new Map(g0.items);
    items.set("61:existence", { kind: "conflict", unit: "existence", standing: original });
    items.set("61:existence>awaiting", {
      kind: "awaiting",
      unit: "existence",
      standing: { kind: "open" },
    });
    return { original: g0.original, of: new Map([["61/f2", "61:existence>awaiting"]]), items };
  };
  const deleteS5 = (g: ItemsGiven) =>
    deletionResult(
      table,
      records,
      deletedContributions(kept, new Set(["S5"]), true),
      new Set(),
      g,
      [],
      base,
    );

  it("a member of the successor, the original superseded by a deletion: back in the original, restored; the successor superseded", () => {
    const g = successor({ kind: "superseded", reason: "deleted" });
    const r = deleteS5(g);
    expect(r.replay.state.items.filter((x) => x.event === 61).map((x) => x.status)).toEqual([
      "candidate",
    ]);
    expect(r.items.fates.get("61/f2")).toEqual({
      kind: "returned",
      item: "61:existence>awaiting",
      into: "merged",
      to: "61:existence",
    });
    expect(r.items.restored).toEqual(["61:existence"]);
    expect(r.items.superseded).toEqual(["61:existence>awaiting"]);
    expect(openItems(advance(g, r.items), r.replay.state)).toEqual([
      "61:existence conflict: 61/f2",
    ]);
  });

  it("a member of the successor, the original closed by a decision: closes with the original, named; the successor left", () => {
    const g = successor({ kind: "resolved" });
    const r = deleteS5(g);
    expect(r.items.fates.get("61/f2")).toEqual({
      kind: "returned",
      item: "61:existence>awaiting",
      into: "closed_by_decision",
      to: "61:existence",
    });
    expect(r.items.restored).toEqual([]);
    expect(r.items.superseded).toEqual(["61:existence>awaiting"]);
  });
});
