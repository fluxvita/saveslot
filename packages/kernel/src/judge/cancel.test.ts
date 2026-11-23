// A deletion's cancellation with no write in its grace period (replay-deletion.ts
// `cancellationResult`; 03-deletion «撤回与宽限期»; 09 §5.9 `deletion.cancelled`), on judged logs.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import type { Op } from "@fluxvita/saveslot-reference";
import { evaluateLog } from "@fluxvita/saveslot-reference";
import { STATE } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { advance, openItems } from "./fates.fixture.ts";
import { itemsByRecords } from "./fates.ts";
import { view } from "./judge.ts";
import type { OpRecord, Restatement } from "./model.ts";
import { cancellationResult, deletionResult, replayDeletion } from "./replay-deletion.ts";
import { type GivenBlock, givenByRecords, type LatestGiven } from "./restate.ts";
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

/** The blocks after a deletion's restatements: each restated index replaced, as the log reads. */
function laid(base: LatestGiven, restated: readonly Restatement[]): Map<string, GivenBlock[]> {
  const out = new Map([...base].map(([k, bs]) => [k, [...bs]]));
  for (const r of restated) {
    const et = `${r.item.event}/${r.item.target}`;
    const was = (out.get(et) ?? []).find((b) => b.k === r.item.k) ?? (out.get(et) ?? [])[0];
    const rest = (out.get(et) ?? []).filter((b) => b.k !== r.item.k);
    out.set(et, [
      ...rest,
      {
        k: r.item.k,
        status: r.status,
        valid: r.status === "dropped" ? [] : (r.valid ?? [{ from: null, to: null }]),
        deps: r.deps,
        content: r.content ?? was?.content ?? { kind: "value", value: null },
        ...(r.carried !== undefined ? { carried: r.carried } : {}),
      },
    ]);
  }
  return out;
}

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
