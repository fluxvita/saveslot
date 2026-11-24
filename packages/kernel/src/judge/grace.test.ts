// A deletion's confirmation as L of the conflict criterion for a write in its grace period
// (09-references-conflict-sync «冲突判据», L's interval; `ExternalChange`), when written and in a
// later deletion's replay, against the reference evaluator.

import type { BizPoint, FieldId, Seq } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type LogEntry, type Op } from "@fluxvita/saveslot-reference";
import { EVENT as EVENT_SCHEMA, STATE as STATE_SCHEMA } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { itemsByRecords } from "./fates.ts";
import { judgeOp } from "./judge.ts";
import type { ExternalChange, OpRecord, RevokeInput, WriteInput } from "./model.ts";
import { contributionKey, deletionResult, replayDeletion } from "./replay-deletion.ts";
import { deletedContributions, judged, toInput } from "./scenarios.fixture.ts";
import { RowState } from "./state.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const w = (op: number, seen: number, value: string, from: string, src: string): Op => ({
  kind: "write",
  op,
  event: op + 1,
  seen,
  now: d("11-05"),
  valid: { from: { mode: "given", value: d(from) }, to: { mode: "open" } },
  fields: { f2: { value, sources: [src] } },
  acknowledge: ["overwrite"],
});

// #10 f2=1 from 10-01; #20, having seen #10, f2=2 from 11-01. D (operation 35) deletes S20: f2 is
// 1 again on [11-01, ∞). #40, written in D's grace period having seen #20 (before D), writes 3
// from 11-05: D changed f2 there after #40's version, and #40's value is not the current one.
const head = [w(10, 0, "1", "10-01", "S10"), w(20, 10, "2", "11-01", "S20")];
const { table, steps } = judged(STATE_SCHEMA, head, []);
const records: OpRecord[] = steps.map((x) => x.judgement.record);
const D: ExternalChange = {
  op: 35 as never,
  changed: new Map([["f2" as FieldId, [{ from: d("11-01"), to: null }]]]),
  changedEntity: true,
};
const write40: WriteInput = {
  kind: "write",
  op: 40 as never,
  index: 0,
  event: 41 as Seq,
  ruleset: 1,
  seen: 20 as never,
  seenExplicit: true,
  now: d("11-05"),
  valid: { from: { mode: "given", value: d("11-05") }, to: { mode: "open" } },
  fields: { ["f2" as FieldId]: { value: "3" } },
};
const afterD = replayDeletion(table, records, new Set([contributionKey(21, "f2")])).state;
const log: LogEntry[] = [
  ...head,
  { kind: "deletion", op: 35, id: "pi_d", sources: ["S20"] },
  w(40, 20, "3", "11-05", "S40"),
];
const statusOf = (items: readonly { event: number; status: string }[]) =>
  items.filter((x) => x.event === 41).map((x) => x.status);

describe("a write in a deletion's grace period, D among its L", () => {
  it("when written: a candidate against D, as the reference evaluator gives", () => {
    const j = judgeOp(afterD, { ...write40, external: [D] });
    expect(statusOf(j.state.items)).toEqual(["candidate"]);
    expect(j.judgement.conflicts.map((c) => c.with)).toEqual([[35]]);
    expect(statusOf(evaluateLog(STATE_SCHEMA, log).final.items)).toEqual(["candidate"]);
    // Without D among its L, nothing after its version changed f2 there: in effect.
    expect(statusOf(judgeOp(afterD, write40).state.items)).toEqual(["applied"]);
  });

  it("in a later deletion's replay (S10): D's record rests on #10, so D changed the whole unit; still a candidate", () => {
    const j = judgeOp(afterD, { ...write40, external: [D] });
    const all = [...records, j.judgement.record];
    const whole: ExternalChange = {
      op: 35 as never,
      changed: new Map([["f2" as FieldId, "whole"]]),
      changedEntity: true,
    };
    const replay = replayDeletion(
      table,
      all,
      new Set([contributionKey(11, "f2"), contributionKey(21, "f2")]),
      [whole],
    );
    expect(statusOf(replay.state.items)).toEqual(["candidate"]);
    const ref = evaluateLog(STATE_SCHEMA, [
      ...log,
      { kind: "deletion", op: 45, id: "pi_e", sources: ["S10"] },
    ]).final;
    expect(statusOf(ref.items)).toEqual(["candidate"]);
  });
});

describe("D among L: a revoke, an event table, the current version", () => {
  it("W's version is D itself: D is no L of it (only events after the version seen are)", () => {
    const sawD: WriteInput = { ...write40, seen: 35 as never };
    expect(statusOf(judgeOp(afterD, { ...sawD, external: [D] }).state.items)).toEqual(["applied"]);
    const ref = evaluateLog(STATE_SCHEMA, [
      ...head,
      { kind: "deletion", op: 35, id: "pi_d", sources: ["S20"] },
      w(40, 35, "3", "11-05", "S40"),
    ]).final;
    expect(statusOf(ref.items)).toEqual(["applied"]);
  });

  it("a revoke in the grace period meeting where D changed the row: a candidate against D", () => {
    const revoke40: RevokeInput = {
      kind: "revoke",
      op: 40 as never,
      index: 0,
      event: 41 as Seq,
      ruleset: 1,
      seen: 20 as never,
      seenExplicit: true,
      now: d("11-05"),
      valid: { from: { mode: "given", value: d("11-05") }, to: { mode: "open" } },
    };
    const j = judgeOp(afterD, { ...revoke40, external: [D] });
    expect(statusOf(j.state.items)).toEqual(["candidate"]);
    const ref = evaluateLog(STATE_SCHEMA, [
      ...head,
      { kind: "deletion", op: 35, id: "pi_d", sources: ["S20"] },
      {
        kind: "revoke",
        op: 40,
        event: 41,
        seen: 20,
        valid: { from: { mode: "given", value: d("11-05") }, to: { mode: "open" } },
      },
    ]).final;
    expect(statusOf(ref.items)).toEqual(["candidate"]);
    expect(statusOf(judgeOp(afterD, revoke40).state.items)).toEqual(["applied"]);
  });

  it("an event table: any change D made on the unit is L", () => {
    const ev = (op: number, seen: number, value: string, src: string): Op => ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      fields: { f2: { value, sources: [src] } },
      acknowledge: ["overwrite"],
    });
    const evHead = [ev(10, 0, "1", "S10"), ev(20, 10, "2", "S20")];
    const e = judged(EVENT_SCHEMA, evHead, []);
    const evRecords = e.steps.map((x) => x.judgement.record);
    const evAfterD = replayDeletion(e.table, evRecords, new Set([contributionKey(21, "f2")])).state;
    const evD: ExternalChange = {
      op: 35 as never,
      changed: new Map([["f2" as FieldId, [{ from: null, to: null }]]]),
      changedEntity: true,
    };
    const w40: WriteInput = {
      kind: "write",
      op: 40 as never,
      index: 0,
      event: 41 as Seq,
      ruleset: 1,
      seen: 20 as never,
      seenExplicit: true,
      now: d("11-05"),
      fields: { ["f2" as FieldId]: { value: "3" } },
    };
    expect(statusOf(judgeOp(evAfterD, { ...w40, external: [evD] }).state.items)).toEqual([
      "candidate",
    ]);
    const ref = evaluateLog(EVENT_SCHEMA, [
      ...evHead,
      { kind: "deletion", op: 35, id: "pi_d", sources: ["S20"] },
      ev(40, 20, "3", "S40"),
    ]).final;
    expect(statusOf(ref.items)).toEqual(["candidate"]);
    expect(statusOf(judgeOp(evAfterD, w40).state.items)).toEqual(["applied"]);
  });

  it("a version before D is not current: an overwrite D did not touch awaits", () => {
    // #10 f2=1 from 10-01; #15 f2=2 from 11-01; #20 f3=x. D deletes S20: it changes only f3, but
    // gives the row a new version. #40, having seen #20 with `acknowledge`, writes f2=3 from
    // 10-01: it takes away the change point 11-01 of its version (high impact ①), with no conflict
    // on f2. Its version is not current any more, so the overwrite awaits (05-time «高影响写入»).
    const ops: Op[] = [
      w(10, 0, "1", "10-01", "S10"),
      w(15, 10, "2", "11-01", "S15"),
      {
        ...w(20, 15, "x", "10-01", "S20"),
        fields: { f3: { value: "x", sources: ["S20"] } },
      } as Op,
    ];
    const h = judged(STATE_SCHEMA, ops, []);
    const recs = h.steps.map((x) => x.judgement.record);
    const after = replayDeletion(h.table, recs, new Set([contributionKey(21, "f3")])).state;
    const onlyF3: ExternalChange = {
      op: 35 as never,
      changed: new Map([["f3" as FieldId, [{ from: d("10-01"), to: null }]]]),
      changedEntity: true,
    };
    const over: WriteInput = {
      ...write40,
      valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
      acknowledge: true,
    };
    expect(statusOf(judgeOp(after, over).state.items)).toEqual(["applied"]);
    expect(statusOf(judgeOp(after, { ...over, external: [onlyF3] }).state.items)).toEqual([
      "awaiting",
    ]);
    const ref = evaluateLog(STATE_SCHEMA, [
      ...ops,
      { kind: "deletion", op: 35, id: "pi_d", sources: ["S20"] },
      w(40, 20, "3", "10-01", "S40"),
    ]).final;
    expect(statusOf(ref.items)).toEqual(["awaiting"]);
  });

  it("where D left the value W writes: no conflict with D (the values do not differ)", () => {
    // #40, having seen #20 (2 from 11-01), writes 1 from 11-05: not the same as its version, so
    // judged; D gave 1 back there, the value #40 writes, so it overwrites nothing it did not see.
    const same: WriteInput = { ...write40, fields: { ["f2" as FieldId]: { value: "1" } } };
    const kernel = statusOf(judgeOp(afterD, { ...same, external: [D] }).state.items);
    expect(kernel).not.toContain("candidate");
    const ref = evaluateLog(STATE_SCHEMA, [
      ...head,
      { kind: "deletion", op: 35, id: "pi_d", sources: ["S20"] },
      w(40, 20, "1", "11-05", "S40"),
    ]).final;
    expect(kernel).toEqual(statusOf(ref.items));
  });
});

describe("a later deletion's event: the replay before it and the one with it each take D as their deleted set has it", () => {
  // D's record counts whole only in a replay whose deleted set holds a deletion whose list of
  // positions holds it: E deletes S10, on which D's block rests; before E, D is as recorded.
  const put = (op: number, seen: number, value: string, from: string, to?: string): Op => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    now: d("11-05"),
    valid: {
      from: { mode: "given", value: d(from) },
      to: to === undefined ? { mode: "open" } : { mode: "given", value: d(to) },
    },
    fields: { f2: { value, sources: [`S${op}`] } },
  });
  const Drec: ExternalChange = {
    op: 35 as never,
    changed: new Map([["f2" as FieldId, [{ from: d("11-01"), to: d("12-01") }]]]),
    changedEntity: true,
  };
  const Dwhole: ExternalChange = { ...Drec, changed: new Map([["f2" as FieldId, "whole"]]) };
  // D as each replay's deleted set has it: whole once #10 (S10) is deleted.
  const external = (deleted: ReadonlySet<string>) =>
    deleted.has(contributionKey(11, "f2")) ? [Dwhole] : [Drec];
  const status = (items: readonly { event: number; status: string }[]) =>
    items.filter((x) => x.event === 41).map((x) => x.status);
  const run = (head: Op[], W: Op, between: string[]) => {
    const h = judged(STATE_SCHEMA, head, []);
    const records = h.steps.map((x) => x.judgement.record);
    const kept = h.steps.map((x) => x.op);
    const afterD = replayDeletion(
      h.table,
      records,
      deletedContributions(kept, new Set(["S20"]), true),
    ).state;
    const j = judgeOp(afterD, { ...(toInput(W) as WriteInput), external: [Drec] });
    const all = [...records, j.judgement.record];
    const withW = [...kept, W];
    const pending = deletedContributions(withW, new Set(["S20", ...between]), true);
    const deleted = deletedContributions(withW, new Set(["S20", ...between, "S10"]), true);
    const r = deletionResult(
      h.table,
      all,
      deleted,
      pending,
      itemsByRecords(new RowState(h.table, all)),
      external,
    );
    const log: LogEntry[] = [
      ...head,
      { kind: "deletion", op: 35, id: "pi_d", sources: ["S20"] },
      W,
      ...between.map((x, i) => ({
        kind: "deletion" as const,
        op: 45 + i,
        id: `pi_${x}`,
        sources: [x],
      })),
    ];
    return {
      written: status(j.state.items),
      before: status(r.before.items),
      after: status(r.replay.state.items),
      refBefore: status(evaluateLog(STATE_SCHEMA, log).final.items),
      refAfter: status(
        evaluateLog(STATE_SCHEMA, [
          ...log,
          { kind: "deletion", op: 55, id: "pi_e", sources: ["S10"] },
        ]).final.items,
      ),
    };
  };

  it("W awaiting for its version when written stays so before E; a candidate with E (D whole)", () => {
    // #10 f2=1; #20 f2=2 on [11-01, 12-01); #30 f2=4 from 12-10. D deletes S20. #40 (seen #30)
    // writes 9 from 12-05: D's record does not meet it; it takes away the change point 12-10
    // without `acknowledge`: awaiting.
    const o = run(
      [put(10, 0, "1", "10-01"), put(20, 10, "2", "11-01", "12-01"), put(30, 20, "4", "12-10")],
      put(40, 30, "9", "12-05"),
      [],
    );
    expect(o).toEqual({
      written: ["awaiting"],
      before: ["awaiting"],
      after: ["candidate"],
      refBefore: ["awaiting"],
      refAfter: ["candidate"],
    });
  });

  it("W in effect once D2 deleted S30 stays so before E; a candidate with E (D whole)", () => {
    // As above with #25 f2=5 from 12-01; #40 (seen #25) is a candidate against #30. D2 deletes
    // S30: no L left for #40 before E, in effect; E makes D whole, a candidate again.
    const o = run(
      [
        put(10, 0, "1", "10-01"),
        put(20, 10, "2", "11-01", "12-01"),
        put(25, 20, "5", "12-01"),
        put(30, 25, "4", "12-10"),
      ],
      put(40, 25, "9", "12-05"),
      ["S30"],
    );
    expect(o).toEqual({
      written: ["candidate"],
      before: ["applied"],
      after: ["candidate"],
      refBefore: ["applied"],
      refAfter: ["candidate"],
    });
  });
});
