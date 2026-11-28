// Fixed cases for deletions interleaved with operations: confirmation and cancellation as log
// events (03-deletion «撤回与宽限期», «结果怎么落进日志»; 09 §5.9). Fictional data.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateLog } from "./evaluate.ts";
import { covers, type Iv } from "./interval.ts";
import type { Evaluation, LogEntry, Op, TableSchema, ToParam, WriteOp } from "./model.ts";
import { itemsOf, segments, stateWithoutIndices, timeline } from "./views.ts";

const STATE: TableSchema = { kind: "state", required: ["f2"] };
/**
 * Decisions and `undo` in the grace period on a row a pending deletion affects, allowed: the rule
 * the decision record grace-period-no-decisions.md sets aside for a later version ("之后要放开时"),
 * not the first version's spec, which refuses them (03-deletion «撤回与宽限期»). The cases passing
 * it test that rule, which the evaluator keeps; none of them is compared with the kernel.
 */
const ALLOWED = { graceDecisions: "allowed" } as const;
const d = (md: string) => `2026-${md}` as BizPoint;
const short = (xs: string[]) => xs.map((s) => s.replaceAll("2026-", ""));
const tl = (ev: Evaluation, f: FieldId = "f2") => short(timeline(ev, f));
const items = (ev: Evaluation, event: number) =>
  short(itemsOf(ev, event)).map((s) => {
    const x = ev.items.find((i) => i.event === event && s.startsWith(`${i.target}/${i.k} `));
    return x?.closed ? `${s} (closed)` : s;
  });

/** The items of an event on f2: the cases given an f3 part by `withF3` assert f2 only. */
const f2Items = (ev: Evaluation, event: number) =>
  items(ev, event).filter((x) => x.startsWith("f2/"));

/**
 * Gives a write an applied part on f3 from a source no case deletes: an undo of a write with no
 * applied part is rejected (04-write-and-read «第 n 次写入是什么»), so the cases that undo a
 * write whose f2 part is a candidate or a corroboration give it this part.
 */
const withF3 = (w: WriteOp): WriteOp => ({
  ...w,
  fields: { ...w.fields, f3: { value: "x", sources: ["S_F3"] } },
});

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
const del = (op: number, id: string, sources: string[]): LogEntry => ({
  kind: "deletion",
  op,
  id,
  sources,
});
const cancel = (op: number, id: string): LogEntry => ({ kind: "cancel", op, id });

// #11 9 (s15); #13 9.5 (s16); #15 10 with the version before #13: a candidate.
const conflict: Op[] = [
  put(10, 11, "9", ["s15"], "10-01", "open"),
  put(12, 13, "9.5", ["s16"], "10-01", "open"),
  put(14, 15, "10", ["s17"], "10-01", "open", { seen: 10 }),
];

describe("operations after a deletion are judged on the state it leaves", () => {
  it("undo of a candidate that took effect through an earlier deletion goes back to 9", () => {
    // Deleting s16 removes #13, so #15's conflict is gone: it takes effect at its own number
    // (03-deletion «重放规则», «冲突消失之后»). The undo at 20 sees #15 in effect and reverts it to
    // the state before operation 14, that is #11's 9 (03-deletion «回掉的权威定义» step 6).
    const log: LogEntry[] = [
      ...conflict,
      del(16, "pi_a", ["s16"]),
      { kind: "undo", op: 20, event: 21, target: 14 },
    ];
    const ev = evaluateLog(STATE, log, ALLOWED).final;
    expect(items(ev, 15)).toEqual(['f2/0 applied [10-01, inf) "10"']);
    expect(ev.reverts).toEqual([
      { op: 20, event: 21, status: "applied", record: [{ event: 15, target: "f2" }] },
    ]);
    expect(items(ev, 21)).toEqual(['f2/0 applied [10-01, inf) "9" carried #11/f2/0']);
    expect(tl(ev)).toEqual(['[10-01, inf) "9"']);
    // The same deletion confirmed after the undo: at undo time #15 was a candidate, so the undo
    // was refused (`undo_target`), and the deletion then lets #15 take effect: 10.
    const late = evaluate(
      STATE,
      [...conflict, { kind: "undo", op: 20, event: 21, target: 14 }],
      ["s16"],
    );
    expect(late.reverts[0]?.status).toBe("rejected");
    expect(tl(late)).toEqual(['[10-01, inf) "10"']);
  });

  it("a request citing a source pending deletion is refused", () => {
    const steps = evaluateLog(STATE, [
      ...conflict,
      del(16, "pi_a", ["s16"]),
      put(18, 19, "8", ["s16"], "10-01", "open"),
    ]).steps;
    expect(steps.map((s) => s.refused)).toEqual([false, false, false, false, true]);
  });

  it("a second deletion of a source already pending deletion is refused", () => {
    const steps = evaluateLog(STATE, [
      ...conflict,
      del(16, "pi_a", ["s16"]),
      del(18, "pi_b", ["s16"]),
    ]).steps;
    expect(steps.map((s) => s.refused)).toEqual([false, false, false, false, true]);
  });
});

describe("cancellation", () => {
  it("restores the conflict item the deletion superseded", () => {
    const steps = evaluateLog(STATE, [
      ...conflict,
      del(16, "pi_a", ["s16"]),
      cancel(18, "pi_a"),
    ]).steps;
    expect(items(steps[3]?.state as Evaluation, 15)).toEqual(['f2/0 applied [10-01, inf) "10"']);
    const ev = steps[4]?.state as Evaluation;
    expect(items(ev, 15)).toEqual(['f2/0 candidate [10-01, inf) "10"']);
    expect(tl(ev)).toEqual(['[10-01, inf) "9.5"']);
  });

  it("keeps in effect a write a grace-period write took as its baseline", () => {
    // `kept_effective`: #19 was written on the version after the deletion.
    const log: LogEntry[] = [
      ...conflict,
      del(16, "pi_a", ["s16"]),
      put(18, 19, "11", ["s19"], "11-01", "open", { seen: 16 }),
      cancel(20, "pi_a"),
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(items(ev, 15)).toEqual(['f2/0 applied [10-01, inf) "10"']);
    expect(tl(ev)).toEqual(['[10-01, 11-01) "10"', '[11-01, inf) "11"']);
  });

  it("keeps superseded an item a grace-period write changed, by the conflict criterion", () => {
    // Deleting s17 removes the candidate #15 (its item is superseded); #19 then changes f2 over
    // #15's interval. After the cancellation #15 is back as a candidate of a closed item.
    const log: LogEntry[] = [
      ...conflict,
      del(16, "pi_a", ["s17"]),
      put(18, 19, "11", ["s19"], "10-01", "open", { seen: 16, acknowledge: ["overwrite"] }),
      cancel(20, "pi_a"),
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(items(ev, 15)).toEqual(['f2/0 candidate [10-01, inf) "10" (closed)']);
    expect(tl(ev)).toEqual(['[10-01, inf) "11"']);
    // Without the grace-period write, the item is restored.
    const plain = evaluateLog(STATE, [
      ...conflict,
      del(16, "pi_a", ["s17"]),
      cancel(20, "pi_a"),
    ]).final;
    expect(items(plain, 15)).toEqual(['f2/0 candidate [10-01, inf) "10"']);
  });
});

describe("successive deletions", () => {
  it("delete A then B = B then A = {A, B} at once", () => {
    const a = del(16, "pi_a", ["s16"]);
    const b = del(18, "pi_b", ["s15"]);
    const ab = evaluateLog(STATE, [...conflict, a, b]).final;
    const ba = evaluateLog(STATE, [...conflict, { ...b, op: 16 }, { ...a, op: 18 }]).final;
    const both = evaluateLog(STATE, [...conflict, del(16, "pi_ab", ["s15", "s16"])]).final;
    expect(ba).toEqual(ab);
    expect(both).toEqual(ab);
    expect(tl(ab)).toEqual(['[10-01, inf) "10"']);
  });

  it("a write that took effect through deletion A goes back to pending under deletion B", () => {
    // #13 corroborates #11's 1. #19 writes 3 on #11's version, before #15 (2): a candidate. Deleting
    // sa removes #15, so #19 takes effect — only through that deletion. Deleting s1 then removes
    // #11, and #13 becomes a change between #19's version and #19: the conflict is back, and #19,
    // not protected by deviation two (03-deletion «删除结果的定义»), returns to its original item.
    const ops: Op[] = [
      put(10, 11, "1", ["s1"], "10-01", "open"),
      put(12, 13, "1", ["s13"], "10-01", "open", { explicit: true }),
      put(14, 15, "2", ["sa"], "10-01", "open"),
      put(18, 19, "3", ["s19"], "10-01", "open", { seen: 10 }),
    ];
    const steps = evaluateLog(STATE, [
      ...ops,
      del(30, "pi_a", ["sa"]),
      del(32, "pi_b", ["s1"]),
    ]).steps;
    expect(items(steps[3]?.state as Evaluation, 19)).toEqual(['f2/0 candidate [10-01, inf) "3"']);
    expect(items(steps[4]?.state as Evaluation, 19)).toEqual(['f2/0 applied [10-01, inf) "3"']);
    const ev = steps[5]?.state as Evaluation;
    expect(items(ev, 13)).toEqual(['f2/0 applied [10-01, inf) "1"']);
    expect(items(ev, 19)).toEqual(['f2/0 candidate [10-01, inf) "3"']);
    // Order independence: the other order and both at once give the same.
    const ba = evaluateLog(STATE, [...ops, del(30, "pi_b", ["s1"]), del(32, "pi_a", ["sa"])]).final;
    const both = evaluateLog(STATE, [...ops, del(30, "pi_ab", ["sa", "s1"])]).final;
    expect(ba).toEqual(ev);
    expect(both).toEqual(ev);
  });
});

describe("deletions interleaved with writes: what the spec settles", () => {
  // #9 W (s0); #11 X (s1); s1 deleted at 12, W shows again; #15 writes with #11's version.
  const head: LogEntry[] = [
    put(8, 9, "W", ["s0"], "10-01", "open"),
    put(10, 11, "X", ["s1"], "10-01", "open"),
    del(12, "pi_a", ["s1"]),
  ];

  it("a deletion is an L for writes that did not see it, with its recorded interval, also after later deletions", () => {
    // 09-references-conflict-sync «冲突判据»: L's interval for a deletion is the one its event
    // recorded, not recomputed by later deletions.
    const log: LogEntry[] = [...head, put(14, 15, "Y", ["s15"], "10-01", "open", { seen: 10 })];
    expect(items(evaluateLog(STATE, log).final, 15)).toEqual(['f2/0 candidate [10-01, inf) "Y"']);
    const later = evaluateLog(STATE, [...log, del(16, "pi_b", ["s9"])]).final;
    expect(items(later, 15)).toEqual(['f2/0 candidate [10-01, inf) "Y"']);
  });

  it("the same-value baseline is the seen version after the deletions confirmed by then", () => {
    // 05-time «用同样的值写»: #15 brings X back without evidence; the baseline (W) no longer has
    // X, so it is a change, and it conflicts with the deletion: a candidate, not a no-op.
    const log: LogEntry[] = [...head, put(14, 15, "X", ["s15"], "10-01", "open", { seen: 10 })];
    expect(items(evaluateLog(STATE, log).final, 15)).toEqual(['f2/0 candidate [10-01, inf) "X"']);
  });

  it("a write to an entity a pending deletion removed is refused, and accepted again after cancellation", () => {
    // 03-deletion «撤回与宽限期»: `not_found` for a deleted row or entity; nothing created or revived.
    const log: LogEntry[] = [
      put(10, 11, "X", ["s1"], "10-01", "open"),
      del(12, "pi_a", ["s1"]),
      put(14, 15, "Z", ["s15"], "11-01", "open"),
      cancel(16, "pi_a"),
      put(18, 19, "Z", ["s19"], "11-01", "open"),
    ];
    const steps = evaluateLog(STATE, log).steps;
    expect(steps.map((x) => x.refused)).toEqual([false, false, true, false, false]);
    expect(steps[1]?.state.exists).toBe(false);
    expect(tl(steps[3]?.state as Evaluation)).toEqual(['[10-01, inf) "X"']);
    expect(tl(steps[4]?.state as Evaluation)).toEqual(['[10-01, 11-01) "X"', '[11-01, inf) "Z"']);
  });
});

describe("kept in effect at a cancellation", () => {
  // #15 took effect through deleting s16; #19 is written in the grace period.
  const grace = (w: WriteOp): LogEntry[] => [
    ...conflict,
    del(16, "pi_a", ["s16"]),
    w,
    cancel(20, "pi_a"),
  ];

  it("a grace-period write on another field counts", () => {
    const y: WriteOp = {
      kind: "write",
      op: 18,
      event: 19,
      seen: 16,
      valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "open" } },
      fields: { f3: { value: "note", sources: ["s19"] } },
    };
    const run = evaluateLog(STATE, grace(y));
    expect(run.steps[5]?.keptEffective).toEqual([{ event: 15, target: "f2" }]);
    expect(items(run.final, 15)).toEqual(['f2/0 applied [10-01, inf) "10"']);
  });

  it("a grace-period write of only no-ops does not count", () => {
    const run = evaluateLog(
      STATE,
      grace(put(18, 19, "10", ["s19"], "10-01", "open", { seen: 16 })),
    );
    expect(items(run.final, 19)).toEqual([]);
    expect(run.steps[5]?.keptEffective).toEqual([]);
    expect(items(run.final, 15)).toEqual(['f2/0 candidate [10-01, inf) "10"']);
  });

  it("a grace-period write with a version before the confirmation does not count", () => {
    const run = evaluateLog(
      STATE,
      grace(put(18, 19, "11", ["s19"], "11-01", "open", { seen: 14 })),
    );
    expect(run.steps[5]?.keptEffective).toEqual([]);
    expect(items(run.final, 15)).toEqual(['f2/0 candidate [10-01, inf) "10"']);
  });

  it("the protection lasts through later deletions", () => {
    // 03-deletion «删除结果的定义», deviation two: recorded as kept in effect = already in effect.
    const log = [
      ...grace(put(18, 19, "11", ["s19"], "11-01", "open", { seen: 16 })),
      del(22, "pi_b", ["s9"]),
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(items(ev, 15)).toEqual(['f2/0 applied [10-01, inf) "10"']);
    expect(tl(ev)).toEqual(['[10-01, 11-01) "10"', '[11-01, inf) "11"']);
  });

  it("a write kept in effect changes how another write is judged; the receipt lists it", () => {
    // 03-deletion «推论» «撤回还原» and «预览与回执要写明的内容». W30 awaits (high impact); W50
    // awaits too. Deleting S1 lets W30 take effect; a grace-period write on f3 with a version
    // after the confirmation keeps it in effect at the cancellation. In W50's seen version W30 is
    // then in effect, 11-03 is no change point, W50 is no longer high impact and takes effect.
    const span = (from: string, to: string | null) => ({
      from: { mode: "given" as const, value: d(from) },
      to: to === null ? { mode: "open" as const } : { mode: "given" as const, value: d(to) },
    });
    const ops: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: span("10-01", null),
        fields: { f2: { value: "2", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        valid: span("11-01", "11-03"),
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        valid: span("11-01", "11-03"),
        fields: { f2: { value: "2", sources: ["S5"] } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: span("11-01", null),
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
    ];
    const g: WriteOp = {
      kind: "write",
      op: 70,
      event: 71,
      seen: 60,
      valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "next_change" } },
      fields: { f3: { value: "1", sources: ["G0"] } },
    };
    const run = evaluateLog(STATE, [...ops, del(60, "pi_a", ["S1"]), g, cancel(80, "pi_a")]);
    const step = run.steps.at(-1);
    expect(step?.keptEffective).toEqual([{ event: 31, target: "f2" }]);
    expect(step?.knockOn).toEqual([
      {
        event: 51,
        target: "f2",
        before: "awaiting",
        after: "applied",
        because: [{ event: 31, target: "f2" }],
      },
    ]);
    expect(tl(run.final)).toEqual(['[10-01, 11-01) "2"', '[11-01, inf) "1"']);
    // The baseline of «撤回还原»: never deleted, W30 forced in effect at its own write number.
    const baseline = evaluateLog(STATE, [...ops, g], {
      forcedEffective: [{ event: 31, target: "f2" }],
    });
    expect(tl(baseline.final)).toEqual(tl(run.final));
    // Never deleted without the forcing differs: [11-03, ∞) is 2 there.
    expect(tl(evaluateLog(STATE, [...ops, g]).final)).toEqual([
      '[10-01, 11-01) "2"',
      '[11-01, 11-03) "1"',
      '[11-03, inf) "2"',
    ]);
  });

  it("it takes precedence over «撤回还原»: where it is kept, the state differs from never deleted", () => {
    // 03-deletion «推论» «撤回还原»: the exemption covers the intervals of writes kept in effect.
    const y = put(18, 19, "11", ["s19"], "11-01", "open", { seen: 16 });
    const cancelled = evaluateLog(STATE, grace(y)).final;
    const never = evaluateLog(STATE, [...conflict, { ...y, seen: 14 }]).final;
    expect(tl(cancelled)).toEqual(['[10-01, 11-01) "10"', '[11-01, inf) "11"']);
    expect(tl(never)).toEqual(['[10-01, 11-01) "9.5"', '[11-01, inf) "11"']);
  });
});

describe("a candidate put back as a corroboration", () => {
  // 03-deletion «撤回与宽限期». Candidate 1 (#15, 8 on [10-01, 11-01), evidence pointed at) is
  // deleted; the item is resolved by taking candidate 2 (8); the deletion is cancelled. Candidate
  // 1 is judged on the state at the cancellation: same value, evidence pointed at → a
  // corroboration, at its own write number. Modelling limit: candidate 1's item is taken to be
  // the one resolved on the same field in the grace period.
  const log: LogEntry[] = [
    put(10, 11, "9", ["s11"], "10-01", "open"),
    put(12, 13, "9.5", ["s13"], "10-01", "open"),
    put(14, 15, "8", ["s15"], "10-01", "11-01", { seen: 10, explicit: true }),
    put(16, 17, "8", ["s17"], "10-01", "open", { seen: 10 }),
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
    cancel(26, "pi_a"),
    {
      kind: "write",
      op: 28,
      event: 29,
      valid: { from: { mode: "given", value: d("10-15") }, to: { mode: "next_change" } },
      fields: { f2: { value: "7", sources: ["s29"] } },
    },
  ];

  it("is a corroboration at its own write number, without endpoints", () => {
    // A put-back corroboration only closes the candidate and adds sources: its endpoints are no
    // blocking points (05-time «挡点»), so #29's default end does not stop at 11-01.
    const ev = evaluateLog(STATE, log, ALLOWED).final;
    expect(items(ev, 15)).toEqual(['f2/0 corroborated [10-01, 11-01) "8"']);
    expect(items(ev, 29)).toEqual(['f2/0 applied [10-15, inf) "7"']);
    expect(tl(ev)).toEqual(['[10-01, 10-15) "8"', '[10-15, inf) "7"']);
  });

  it("a grace-period default-end write over the candidate's interval: judged on the replay without put-back candidates", () => {
    // 03-deletion «撤回与宽限期»: the put-back candidate is judged once, on the cancellation's
    // replay before any candidate is put back. There #25's default end runs on (no corroboration
    // end to stop it), so on [10-15, 11-01) the value in effect is 7, not candidate 1's 8: a new
    // conflict item. The result is recorded and not judged again in that replay.
    const circular: LogEntry[] = [
      ...log.slice(0, 6),
      {
        kind: "write",
        op: 24,
        event: 25,
        valid: { from: { mode: "given", value: d("10-15") }, to: { mode: "next_change" } },
        fields: { f2: { value: "7", sources: ["s25"] } },
      },
      cancel(26, "pi_a"),
    ];
    const ev = evaluateLog(STATE, circular, ALLOWED).final;
    expect(items(ev, 15)).toEqual(['f2/0 candidate [10-01, 11-01) "8"']);
    expect(items(ev, 25)).toEqual(['f2/0 applied [10-15, inf) "7"']);
    expect(tl(ev)).toEqual(['[10-01, 10-15) "8"', '[10-15, inf) "7"']);
  });
});

describe("a put-back corroboration gives no value and no blocking point", () => {
  // 03-deletion «撤回与宽限期»: a candidate put back at a cancellation and judged a corroboration
  // only closes the candidate and adds sources. Its start and end are no blocking points in the
  // cancellation's replay or any later one; a later deletion removing the value it corroborates
  // makes it the candidate that decision closed. Found by the «撤回还原» property: #21 (S2) is a
  // candidate 3 on [11-01, 11-03); deleting S2 and S5 removes it and #41; keep_effective closes
  // #31's item; cancelling the deletion puts #21 back as a corroboration of #41's 3.
  const w = (
    op: number,
    v: string,
    src: string,
    from: string,
    to: ToParam,
    seen: number,
    extra: Partial<WriteOp> = {},
  ): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: { f2: { value: v, sources: [src], ...(extra.fields ? {} : {}) } },
    ...extra,
  });
  const prefix = (from41: string): LogEntry[] => [
    w(10, "1", "S1", "10-01", { mode: "open" }, 0, { acknowledge: ["overwrite"] }),
    w(20, "3", "S2", "11-01", { mode: "given", value: d("11-03") }, 0, {
      fields: { f2: { value: "3", sources: ["S2"], explicit: true } },
    }),
    w(30, "3", "S1", "11-01", { mode: "open" }, 0),
    w(40, "3", "S5", from41, { mode: "next_change" }, 30),
  ];
  const grace: LogEntry[] = [
    {
      kind: "resolve",
      op: 60,
      event: 61,
      decision: "keep_effective",
      candidates: [31],
      unit: "f2",
    },
  ];
  const run = (from41: string, after: LogEntry[] = []) =>
    evaluateLog(
      STATE,
      [...prefix(from41), del(50, "pi_d", ["S2", "S5"]), ...grace, cancel(80, "pi_d"), ...after],
      ALLOWED,
    );
  /** The replay as never deleted, with what the cancellation kept (03-deletion «撤回还原»). */
  const neverDeleted = (
    from41: string,
    r: ReturnType<typeof evaluateLog>,
    after: LogEntry[] = [],
  ) =>
    evaluateLog(STATE, [...prefix(from41), ...grace, ...after], {
      ...ALLOWED,
      forcedEffective: r.steps.at(-1 - after.length)?.keptEffective ?? [],
      forcedSuperseded: r.steps.at(-1 - after.length)?.keptSuperseded ?? [],
    }).final;

  it("its end does not stop a default end: as never deleted", () => {
    const r = run("11-01");
    expect(r.steps.at(-1)?.putBack).toEqual([{ event: 21, target: "f2", judged: "corroborated" }]);
    expect(items(r.final, 21)).toEqual(['f2/0 corroborated [11-01, 11-03) "3"']);
    expect(items(r.final, 41)).toEqual(['f2/0 applied [11-01, inf) "3"']);
    expect(tl(r.final)).toEqual(['[10-01, 11-01) "1"', '[11-01, inf) "3"']);
    expect(tl(r.final)).toEqual(tl(neverDeleted("11-01", r)));
  });

  it("its start does not stop a default end either", () => {
    // #41 from 10-15: #21's start 11-01 does not cut it.
    const r = run("10-15");
    expect(items(r.final, 41)).toEqual(['f2/0 applied [10-15, inf) "3"']);
    expect(tl(r.final)).toEqual(tl(neverDeleted("10-15", r)));
  });

  it("a later deletion of the value it corroborates closes it as a candidate", () => {
    // Deleting S5 after the cancellation removes #41: #21 corroborates nothing and is the
    // candidate keep_effective closed, as in the replay that never deleted S2.
    const after = [del(90, "pi_5", ["S5"])];
    const r = run("11-01", after);
    expect(items(r.final, 21)).toEqual(['f2/0 candidate [11-01, 11-03) "3" (closed)']);
    expect(items(neverDeleted("11-01", r), 21)).toEqual(
      items(evaluateLog(STATE, [...prefix("11-01"), ...grace, ...after], ALLOWED).final, 21),
    );
    expect(tl(r.final)).toEqual(['[10-01, inf) "1"']);
  });
});

describe("review cases", () => {
  const TIMELESS: TableSchema = { kind: "timeless", required: ["f1"] };
  const tw = (op: number, fields: WriteOp["fields"], seen?: number): WriteOp => ({
    kind: "write",
    op,
    event: op,
    ...(seen !== undefined ? { seen } : {}),
    fields,
  });
  const at = (ev: Evaluation, f: FieldId) => ev.fields[f]?.[0]?.value;

  it("a cancellation keeps in effect only what this deletion made effective", () => {
    // 03-deletion «撤回与宽限期». #3 conflicts with #2; D (s4) is unrelated; #6 is written in D's
    // grace period; D2 (s2) then makes #3 effective. Cancelling D keeps nothing (D did not make
    // #3 effective; #6 came before #3 took effect); cancelling D2 sends #3 back: f1 = 2.
    const log: LogEntry[] = [
      tw(1, { f1: { value: "1", sources: ["s0"] } }),
      tw(2, { f1: { value: "2", sources: ["s2"] } }),
      tw(3, { f1: { value: "3", sources: ["s3"] } }, 1),
      tw(4, { f2: { value: "x", sources: ["s4"] } }),
      del(5, "D", ["s4"]),
      tw(6, { f3: { value: "y", sources: ["s6"] } }),
      del(7, "D2", ["s2"]),
      cancel(8, "D"),
      cancel(9, "D2"),
    ];
    const run = evaluateLog(TIMELESS, log);
    expect(run.steps[7]?.keptEffective).toEqual([]);
    expect(run.steps[8]?.keptEffective).toEqual([]);
    expect(items(run.final, 3)).toEqual(['f1/0 candidate [-inf, inf) "3"']);
    expect(at(run.final, "f1")).toBe("2");
  });

  it("a write another pending deletion made effective is not kept at this deletion's cancellation", () => {
    // D2 (s2) makes #3 effective; #8 is written on that version, inside both grace periods.
    // Cancelling D keeps nothing (D did not make #3 effective); cancelling D2 keeps #3.
    const log: LogEntry[] = [
      tw(1, { f1: { value: "1", sources: ["s0"] } }),
      tw(2, { f1: { value: "2", sources: ["s2"] } }),
      tw(3, { f1: { value: "3", sources: ["s3"] } }, 1),
      tw(4, { f2: { value: "x", sources: ["s4"] } }),
      del(5, "D", ["s4"]),
      del(7, "D2", ["s2"]),
      tw(8, { f3: { value: "y", sources: ["s8"] } }, 7),
      cancel(9, "D"),
      cancel(10, "D2"),
    ];
    const run = evaluateLog(TIMELESS, log);
    expect(run.steps[7]?.keptEffective).toEqual([]);
    expect(run.steps[8]?.keptEffective).toEqual([{ event: 3, target: "f1" }]);
    expect(at(run.final, "f1")).toBe("3");
  });

  it("a grace-period write before the write took effect is not its baseline", () => {
    // #4 conflicts with #2 (sa) and #3 (sb): it takes effect only once D (sa) and D2 (sb) are
    // both confirmed, at 7. #6, in D's grace period, came before that. Cancelling D keeps
    // nothing: #4 goes back to its conflict.
    const log: LogEntry[] = [
      tw(1, { f1: { value: "1", sources: ["s0"] } }),
      tw(2, { f1: { value: "2", sources: ["sa"] } }),
      tw(3, { f1: { value: "2.5", sources: ["sb"] } }),
      tw(4, { f1: { value: "3", sources: ["s4"] } }, 1),
      del(5, "D", ["sa"]),
      tw(6, { f3: { value: "y", sources: ["s6"] } }, 5),
      del(7, "D2", ["sb"]),
      cancel(8, "D"),
    ];
    const run = evaluateLog(TIMELESS, log);
    expect(items(run.steps[6]?.state as Evaluation, 4)).toEqual(['f1/0 applied [-inf, inf) "3"']);
    expect(run.steps[7]?.keptEffective).toEqual([]);
    expect(items(run.final, 4)).toEqual(['f1/0 candidate [-inf, inf) "3"']);
  });

  it("a grace-period corroboration does not keep the superseded item superseded", () => {
    // 09-references-conflict-sync «冲突判据» ②: a corroboration does not change the value in
    // effect, so it is no L; at the cancellation the item is restored and #3 is pending again.
    const log: LogEntry[] = [
      tw(1, { f1: { value: "1", sources: ["s1"] } }),
      tw(2, { f1: { value: "2", sources: ["s2"] } }),
      tw(3, { f1: { value: "3", sources: ["s3"] } }, 1),
      del(4, "D", ["s3"]),
      tw(5, { f1: { value: "2", sources: ["s5"], explicit: true } }),
      cancel(6, "D"),
    ];
    const run = evaluateLog(TIMELESS, log);
    expect(run.steps[5]?.keptSuperseded).toEqual([]);
    expect(items(run.final, 3)).toEqual(['f1/0 candidate [-inf, inf) "3"']);
  });

  it("a confirmed awaiting write stays confirmed in a deletion replay", () => {
    // 03-deletion «删除结果的定义»: the confirmation is a recorded decision (deviation one) and the
    // confirmed write is in effect by it (deviation two): [10-01, ∞) 9, no new pending item.
    const sw = (op: number, from: string, end: string, value: string, src: string, seen?: number) =>
      put(op, op, value, [src], from, end, seen !== undefined ? { seen } : {});
    const log: LogEntry[] = [
      sw(1, "10-01", "open", "1", "s1"),
      sw(2, "10-01", "10-15", "7", "sL"),
      sw(3, "10-01", "10-20", "5", "sY", 1),
      sw(4, "10-01", "open", "9", "sW", 2),
      { kind: "confirm", op: 5, event: 5, target: 4 },
      del(6, "D", ["sL"]),
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "9"']);
    expect(items(ev, 4)).toEqual(['f2/0 awaiting [10-01, inf) "9" (closed)']);
    expect(items(ev, 5)).toEqual(['f2/0 applied [10-01, inf) "9" carried #4/f2/0']);
    expect(
      ev.items.filter((x) => (x.status === "candidate" || x.status === "awaiting") && !x.closed),
    ).toEqual([]);
  });

  it("acknowledge with a ver before a deletion that changed the entity is not current", () => {
    // 03-deletion «重放规则», ver row; 05-time «高影响写入»: the write awaits confirmation.
    const log: LogEntry[] = [
      put(1, 1, "1", ["s1"], "10-01", "open"),
      put(2, 2, "2", ["s2"], "11-01", "open"),
      {
        kind: "write",
        op: 3,
        event: 3,
        valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
        fields: { f3: { value: "x", sources: ["s3"] } },
      },
      del(4, "D", ["s3"]),
      put(5, 5, "9", ["s5"], "10-01", "open", { seen: 3, acknowledge: ["overwrite"] }),
    ];
    expect(items(evaluateLog(STATE, log).final, 5)).toEqual(['f2/0 awaiting [10-01, inf) "9"']);
  });

  it("an awaiting write the deletion removed is not put back as a candidate; the kept write's knock-on is listed", () => {
    // 03-deletion «撤回与宽限期»: putting back applies to candidates of a resolved item. #51 is an
    // awaiting write (it would erase 11-05); deleting S1 removes it and lets #21 take effect; a
    // grace-period decision builds on that version, so #21 is kept in effect. #51 comes back to
    // its own item, and with #21 in effect it no longer erases a change point: it takes effect,
    // listed as a knock-on of #21. The result equals the forced replay of «撤回还原».
    const sw = (op: number, seen: number, from: string, end: string, value: string, src: string) =>
      put(op, op + 1, value, [src], from, end, { seen });
    const prefix: LogEntry[] = [
      put(10, 11, "1", ["S1"], "10-01", "open", { acknowledge: ["overwrite"], seen: 0 }),
      sw(20, 0, "11-03", "11-05", "3", "S4"),
      sw(30, 20, "11-05", "open", "3", "S1"),
      sw(50, 40, "11-03", "11-07", "2", "S1"),
    ];
    const grace: LogEntry[] = [
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 50,
        valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "next_change" } },
        fields: { f2: { value: "1", sources: ["G0"] } },
      },
      {
        kind: "resolve",
        op: 80,
        event: 81,
        decision: "take_candidate",
        candidates: [71],
        unit: "f2",
        take: 71,
      },
    ];
    const run = evaluateLog(
      STATE,
      [...prefix, del(60, "d", ["S1"]), ...grace, cancel(100, "d")],
      ALLOWED,
    );
    const step = run.steps.at(-1);
    expect(step?.putBack).toEqual([]);
    expect(step?.keptEffective).toEqual([{ event: 21, target: "f2" }]);
    expect(step?.knockOn).toEqual([
      {
        event: 51,
        target: "f2",
        before: "awaiting",
        after: "applied",
        because: [{ event: 21, target: "f2" }],
      },
    ]);
    const base = evaluateLog(STATE, [...prefix, ...grace], {
      ...ALLOWED,
      forcedEffective: [{ event: 21, target: "f2" }],
    });
    expect(tl(run.final)).toEqual(tl(base.final));
    expect(tl(run.final)).toEqual(['[10-01, 11-03) "1"', '[11-03, 11-07) "2"', '[11-07, inf) "3"']);
  });

  it("a candidate whose item lost its only candidate is restored, not put back, after a resolve of another item", () => {
    // 03-deletion «撤回与宽限期»: putting back applies to a candidate removed from an item that
    // stayed open; #81's item lost its only candidate, so the deletion superseded it, and the
    // cancellation restores it. The grace-period resolve closes a different item (#111's). #81
    // keeps its corroborated part, and #91 still reverts it.
    const sw = (
      op: number,
      seen: number,
      from: string,
      end: string,
      value: string,
      src: string,
      explicit = false,
    ) => put(op, op + 1, value, [src], from, end, { seen, explicit });
    const prefix: LogEntry[] = [
      sw(10, 0, "10-01", "open", "3", "S1"),
      sw(30, 20, "11-03", "open", "2", "S1"),
      put(50, 51, "1", ["S2"], "11-01", "open", { seen: 40, acknowledge: ["overwrite"] }),
      sw(60, 50, "11-03", "open", "2", "S1", true),
      withF3(sw(80, 50, "11-01", "open", "1", "S2", true)),
      { kind: "undo", op: 90, event: 91, target: 80, seen: 80, acknowledge: ["overwrite"] },
    ];
    const grace: LogEntry[] = [
      sw(110, 90, "11-01", "open", "1", "G0"),
      {
        kind: "resolve",
        op: 120,
        event: 121,
        decision: "keep_effective",
        candidates: [111],
        unit: "f2",
      },
    ];
    const run = evaluateLog(STATE, [...prefix, del(100, "d", ["S2"]), ...grace, cancel(140, "d")]);
    expect(run.steps.at(-1)?.putBack).toEqual([]);
    expect(f2Items(run.final, 81)).toEqual([
      'f2/0 corroborated [11-01, 11-03) "1"',
      'f2/1 candidate [11-03, inf) "1"',
    ]);
    expect(f2Items(run.final, 91)).toEqual(['f2/0 applied [11-01, 11-03) "1" carried #51/f2/0']);
    const base = evaluateLog(STATE, [...prefix, ...grace]).final;
    expect(f2Items(run.final, 91)).toEqual(f2Items(base, 91));
    expect(tl(run.final)).toEqual(tl(base));
  });

  it("putting back a candidate keeps the corroborated part of the same write", () => {
    // 03-deletion «撤回与宽限期»: what is put back is the candidate. #15 corroborates 9 on
    // [11-01, 11-15) and is a candidate on [10-01, 11-01) (where #13 changed the value); #17 is
    // the other candidate of the item. The deletion removes #15; the item is resolved in the grace
    // period; at the cancellation only the candidate part is judged again (a new conflict item).
    const log: LogEntry[] = [
      put(10, 11, "9", ["s11"], "10-01", "open"),
      put(12, 13, "9.5", ["s13"], "10-01", "11-01"),
      put(14, 15, "9", ["s15"], "10-01", "11-15", { seen: 10, explicit: true }),
      put(16, 17, "8", ["s17"], "10-01", "11-01", { seen: 10 }),
      del(20, "d", ["s15"]),
      {
        kind: "resolve",
        op: 22,
        event: 23,
        decision: "keep_effective",
        candidates: [17],
        unit: "f2",
      },
      cancel(24, "d"),
    ];
    const run = evaluateLog(STATE, log, ALLOWED);
    expect(run.steps.at(-1)?.putBack).toEqual([{ event: 15, target: "f2", judged: "candidate" }]);
    expect(items(run.final, 15)).toEqual([
      'f2/0 candidate [10-01, 11-01) "9"',
      'f2/1 corroborated [11-01, 11-15) "9"',
    ]);
  });

  describe("«撤回还原» with an item kept superseded: the baseline keeps it closed too", () => {
    // 03-deletion «推论» «撤回还原»: the baseline is the replay in which kept writes take effect
    // at their own write numbers and writes whose items were kept superseded do not take effect.
    const judged = (ev: Evaluation) =>
      ev.items
        .filter((x) => x.status !== "dropped")
        .map((x) => `#${x.event}/${x.k} ${x.status}${x.closed ? " closed" : ""}`)
        .sort();

    it("state table: a superseded awaiting write does not take effect outside the grace write", () => {
      // #41 awaits (high impact); #51 restates #21 with evidence and awaits too. Deleting S2, S4
      // lets #41 take effect and removes #51 (its item superseded). The grace write #71 builds on
      // that version (#41 kept in effect) and changes f2 inside #51's interval (#51's item kept
      // superseded). #51 does not take effect: [11-03, 11-05) is #41's 2.
      const sw = (
        op: number,
        seen: number,
        from: string,
        end: string,
        value: string,
        src: string,
        opts: Partial<WriteOp> = {},
      ) => put(op, op + 1, value, [src], from, end, { seen, ...opts });
      const prefix: LogEntry[] = [
        sw(10, 0, "10-01", "open", "1", "S1"),
        sw(20, 10, "11-03", "open", "3", "S1"),
        sw(30, 20, "11-01", "11-05", "1", "S2", { acknowledge: ["overwrite"] }),
        sw(40, 30, "11-03", "open", "2", "S1"),
        put(50, 51, "3", ["S4"], "11-03", "open", { seen: 40, explicit: true }),
      ];
      const grace = sw(70, 60, "11-05", "open", "1", "G0");
      const run = evaluateLog(STATE, [
        ...prefix,
        del(60, "d", ["S2", "S4"]),
        grace,
        cancel(90, "d"),
      ]);
      const step = run.steps.at(-1);
      expect(step?.keptEffective).toEqual([{ event: 41, target: "f2" }]);
      expect(step?.keptSuperseded).toEqual([51]);
      expect(tl(run.final)).toEqual([
        '[10-01, 11-03) "1"',
        '[11-03, 11-05) "2"',
        '[11-05, inf) "1"',
      ]);
      const base = evaluateLog(STATE, [...prefix, grace], {
        forcedEffective: [{ event: 41, target: "f2" }],
        forcedSuperseded: [51],
      }).final;
      expect(tl(base)).toEqual(tl(run.final));
      expect(judged(base)).toEqual(judged(run.final));
      // Forcing only the kept write: #51 takes effect there and [11-03, 11-05) is 3.
      const keptOnly = evaluateLog(STATE, [...prefix, grace], {
        forcedEffective: [{ event: 41, target: "f2" }],
      }).final;
      expect(tl(keptOnly)).toEqual([
        '[10-01, 11-03) "1"',
        '[11-03, 11-05) "3"',
        '[11-05, inf) "1"',
      ]);
    });

    it("event table: a superseded candidate is not judged again", () => {
      // #21 conflicts with #11; #41 (evidence pointed at, version before #31) conflicts with #31.
      // Deleting S1 lets #21 take effect and removes #41 (its item superseded); the grace write
      // #71 keeps #21 in effect and changes f2 (#41's item kept superseded). #41 stays a closed
      // candidate and #51 stays the change it was.
      const EVENT: TableSchema = { kind: "event", required: ["f2"] };
      const ew = (
        op: number,
        seen: number,
        value: string,
        src: string,
        explicit = false,
      ): WriteOp => ({
        kind: "write",
        op,
        event: op + 1,
        seen,
        fields: { f2: { value, sources: [src], explicit } },
      });
      const prefix: LogEntry[] = [
        ew(10, 0, "3", "S1"),
        ew(20, 0, "1", "S3"),
        ew(30, 20, "1", "S1"),
        ew(40, 20, "3", "S1", true),
        ew(50, 40, "3", "S1", true),
      ];
      const grace = ew(70, 60, "2", "G0");
      const run = evaluateLog(EVENT, [...prefix, del(60, "d", ["S1"]), grace, cancel(90, "d")]);
      const step = run.steps.at(-1);
      expect(step?.keptEffective).toEqual([{ event: 21, target: "f2" }]);
      expect(step?.keptSuperseded).toEqual([41]);
      expect(items(run.final, 41)).toEqual(['f2/0 candidate [-inf, inf) "3" (closed)']);
      const base = evaluateLog(EVENT, [...prefix, grace], {
        forcedEffective: [{ event: 21, target: "f2" }],
        forcedSuperseded: [41],
      }).final;
      expect(judged(base)).toEqual(judged(run.final));
      // Forcing only the kept write: #41 is judged again and takes effect, #51 corroborates it.
      const keptOnly = evaluateLog(EVENT, [...prefix, grace], {
        forcedEffective: [{ event: 21, target: "f2" }],
      }).final;
      expect(items(keptOnly, 41)).toEqual(['f2/0 applied [-inf, inf) "3"']);
      expect(items(keptOnly, 51)).toEqual(['f2/0 corroborated [-inf, inf) "3"']);
    });
  });
});

describe("undo of a revert", () => {
  // 03-deletion «回掉的权威定义» step 1; 04-write-and-read «撤回某次写入（undo）». An undo whose
  // target m is itself a revert lists m's event on every target m's record lists; it is rejected
  // when m has no write-back item when the undo is written, pending deletions included.
  const head: LogEntry[] = [
    put(10, 12, "5000", ["S12"], "10-01", "open"),
    put(20, 22, "3000", ["S22"], "11-02", "11-20"),
    put(23, 25, "3500", ["S_X"], "11-02", "11-20"),
    { kind: "undo", op: 30, event: 32, target: 20, seen: 23, acknowledge: ["overwrite"] },
  ];

  it("state table: a revert with no write-back cannot be undone, also after a deletion gives it one", () => {
    // #22 is wholly covered by X (#25) when operation 30 undoes it: no write-back. Operation 40
    // undoes operation 30: rejected. Deleting X later gives operation 30 a write-back (5000 on
    // [11-02, 11-20)); operation 40 stays rejected, as written.
    const log: LogEntry[] = [...head, { kind: "undo", op: 40, event: 42, target: 30 }];
    const asWritten = evaluateLog(STATE, log).final;
    expect(asWritten.reverts).toEqual([
      { op: 30, event: 32, status: "applied", record: [{ event: 22, target: "f2" }] },
      { op: 40, event: 42, status: "rejected", record: [] },
    ]);
    const ev = evaluateLog(STATE, [...log, del(50, "d", ["S_X"])]).final;
    expect(items(ev, 32)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
    expect(items(ev, 42)).toEqual([]);
    expect(tl(ev)).toEqual(['[10-01, inf) "5000"']);
  });

  it("state table: accepted while a pending deletion gives the revert a write-back; covers nothing once it is cancelled", () => {
    // Deleting X (pending) gives operation 30 a write-back; operation 40 undoes it then: accepted,
    // back to #22's 3000. Cancelling the deletion takes the write-back away again: operation 40
    // covers nothing, and the end is as if it had never been accepted.
    const pending: LogEntry[] = [
      ...head,
      del(35, "d", ["S_X"]),
      { kind: "undo", op: 40, event: 42, target: 30 },
    ];
    const during = evaluateLog(STATE, pending, ALLOWED).final;
    expect(during.reverts.find((r) => r.op === 40)).toEqual({
      op: 40,
      event: 42,
      status: "applied",
      record: [{ event: 32, target: "f2" }],
    });
    expect(items(during, 42)).toEqual(['f2/0 applied [11-02, 11-20) "3000" carried #22/f2/0']);
    const ev = evaluateLog(STATE, [...pending, cancel(45, "d")], ALLOWED).final;
    expect(items(ev, 42)).toEqual(["f2/0 dropped"]);
    expect(tl(ev)).toEqual(tl(evaluateLog(STATE, head, ALLOWED).final));
  });

  it("event table: a revert with no write-back cannot be undone", () => {
    // Operation 40 undoes W2, wholly covered by W3: no write-back. Operation 50 undoes operation
    // 40: rejected, also after deleting S3 gives operation 40 a write-back (45, from W1).
    const EVENT: TableSchema = { kind: "event", required: ["f3"] };
    const ew = (op: number, value: string, src: string): WriteOp => ({
      kind: "write",
      op,
      event: op + 2,
      fields: { f3: { value, sources: [src] } },
    });
    const log: LogEntry[] = [
      ew(21, "45", "S1"),
      ew(25, "54", "S2"),
      ew(33, "60", "S3"),
      { kind: "undo", op: 40, event: 42, target: 25 },
      { kind: "undo", op: 50, event: 52, target: 40 },
    ];
    expect(
      evaluateLog(EVENT, log).final.reverts.map((r) => [r.op, r.status, r.record.length]),
    ).toEqual([
      [40, "applied", 1],
      [50, "rejected", 0],
    ]);
    const ev = evaluateLog(EVENT, [...log, del(60, "d", ["S3"])]).final;
    expect(items(ev, 42)).toEqual(['f3/0 applied [-inf, inf) "45" carried #23/f3/0']);
    expect(items(ev, 52)).toEqual([]);
    expect(ev.fields["f3"]?.[0]?.value).toBe("45");
  });

  it("a revert with write-back items from the start: unchanged", () => {
    const log: LogEntry[] = [
      put(10, 12, "5000", ["S12"], "10-01", "open"),
      put(20, 22, "3000", ["S22"], "11-02", "11-20"),
      { kind: "undo", op: 30, event: 32, target: 20, seen: 20, acknowledge: ["overwrite"] },
      { kind: "undo", op: 40, event: 42, target: 30 },
      put(44, 46, "7", ["S9"], "12-01", "12-02"),
      del(50, "d", ["S9"]),
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(ev.reverts[1]).toEqual({
      op: 40,
      event: 42,
      status: "applied",
      record: [{ event: 32, target: "f2" }],
    });
    expect(items(ev, 42)).toEqual(['f2/0 applied [11-02, 11-20) "3000" carried #22/f2/0']);
    expect(tl(ev)).toEqual([
      '[10-01, 11-02) "5000"',
      '[11-02, 11-20) "3000"',
      '[11-20, inf) "5000"',
    ]);
  });
});

describe("original items of one write in one segment (09 §5.7)", () => {
  const w = (
    op: number,
    event: number,
    from: string,
    end: string,
    value: string,
    src: string,
    opts: Parameters<typeof put>[6] = {},
  ) => put(op, event, value, [src], from, end, opts);
  const at = (run: ReturnType<typeof evaluateLog>, kind: string) =>
    run.steps.filter((x) => x.entry.kind === kind).at(-1)?.state as Evaluation;

  it("the part of the undone write that takes effect through a deletion is undone too", () => {
    // W20 (S3) splits W30 into a candidate part and a corroborated part at 11-03; undo 40 lists
    // (#31, f2), both parts. Deleting S3 makes W30 one corroboration [11-01, ∞), all of it in
    // effect: the undo covers it all and writes back #11's 1 there (same value).
    const log: LogEntry[] = [
      w(10, 11, "10-01", "open", "1", "S1"),
      w(20, 21, "11-01", "11-03", "3", "S3", { seen: 10, acknowledge: ["overwrite"] }),
      withF3(w(30, 31, "11-01", "open", "1", "S1", { seen: 10, explicit: true })),
      { kind: "undo", op: 40, event: 41, target: 30, seen: 30, acknowledge: ["overwrite"] },
      del(60, "d", ["S3"]),
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(f2Items(ev, 31)).toEqual(['f2/0 corroborated [11-01, inf) "1"', "f2/1 dropped"]);
    expect(f2Items(ev, 41)).toEqual(['f2/0 applied [11-01, inf) "1" carried #11/f2/0']);
    expect(short(segments(ev, "f2"))).toEqual([
      '[10-01, 11-01) "1" by #11/f2/0',
      '[11-01, inf) "1" by #41/f2/0',
    ]);
  });

  it("example A: the boundary came from the deleted write; the undo covers the whole write", () => {
    // #26 is a candidate on [11-05, 11-10) (where #22 changed the value) and a corroboration on
    // [11-10, 11-20); undo 30 lists (#26, f2). Deleting #22's source makes #26 one corroboration
    // [11-05, 11-20), all of it covered by the undo: its endpoints stop counting, so 11-20 no
    // longer stops a later default end.
    const log: LogEntry[] = [
      w(10, 12, "10-01", "open", "5000", "S12"),
      w(20, 22, "11-02", "11-10", "3000", "S_B"),
      withF3(w(24, 26, "11-05", "11-20", "5000", "S_A", { seen: 10, explicit: true })),
      { kind: "undo", op: 30, event: 32, target: 24, seen: 24, acknowledge: ["overwrite"] },
      del(40, "d", ["S_B"]),
      {
        kind: "write",
        op: 50,
        event: 51,
        valid: { from: { mode: "given", value: d("11-12") }, to: { mode: "next_change" } },
        fields: { f2: { value: "2000", sources: ["S_C"] } },
      },
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(f2Items(ev, 26)).toEqual(['f2/0 corroborated [11-05, 11-20) "5000"', "f2/1 dropped"]);
    expect(f2Items(ev, 51)).toEqual(['f2/0 applied [11-12, inf) "2000"']);
  });

  describe("at a cancellation, items only the cancelled deletion gave are not originals", () => {
    // y (#17, [11-10, ∞) 4000) awaits: it would erase 11-25 (#13). Operation 30 undoes #22 with
    // one write-back item k0 [11-02, 11-20) 5000. Deleting S13 lets y take effect and splits k0
    // off a new k1 [11-10, 11-20) 4000; cancelling it makes them one 5000 segment again. k1 was
    // given only by the cancelled deletion's confirmation: its block is not an original interval
    // (03-deletion «回掉的权威定义» step 6, 09 §5.7), so the cancellation leaves no cut it drew and
    // the segment is one item, as if nothing had been deleted.
    /** The replay as never deleted, with what the cancellation kept (03-deletion «撤回与宽限期»). */
    const neverDeleted = (log: LogEntry[], run: ReturnType<typeof evaluateLog>) =>
      evaluateLog(
        STATE,
        log.filter((e) => e.kind !== "deletion" && e.kind !== "cancel"),
        {
          forcedEffective: run.steps.at(-1)?.keptEffective ?? [],
          forcedSuperseded: run.steps.at(-1)?.keptSuperseded ?? [],
        },
      ).final;
    const live = (xs: string[]) => xs.filter((x) => !x.endsWith("dropped"));
    const head = (extra: LogEntry[] = []): LogEntry[] => [
      w(10, 12, "10-01", "open", "5000", "S12"),
      w(12, 13, "11-25", "open", "4500", "S13"),
      w(15, 17, "11-10", "open", "4000", "S17"),
      ...extra,
      w(20, 22, "11-02", "11-20", "3000", "S22"),
      { kind: "undo", op: 30, event: 32, target: 20, seen: 20, acknowledge: ["overwrite"] },
    ];
    const takePrevious: LogEntry[] = [
      w(33, 34, "11-12", "11-14", "3500", "SA", { seen: 25 }),
      {
        kind: "resolve",
        op: 35,
        event: 36,
        decision: "take_previous",
        candidates: [34],
        unit: "f2",
      },
    ];

    it("listed by a take_previous in effect: one item after the cancellation", () => {
      const log = [...head(), ...takePrevious, del(40, "d", ["S13"]), cancel(50, "d")];
      const run = evaluateLog(STATE, log);
      expect(run.final.reverts.find((r) => r.op === 35)?.record).toEqual([
        { event: 32, target: "f2" },
      ]);
      expect(items(at(run, "deletion"), 32)).toEqual([
        'f2/0 applied [11-02, 11-10) "5000" carried #12/f2/0',
        'f2/1 applied [11-10, 11-20) "4000" carried #17/f2/0',
      ]);
      expect(items(run.final, 32)).toEqual([
        'f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0',
        "f2/1 dropped",
      ]);
      const base = neverDeleted(log, run);
      expect(live(items(run.final, 32))).toEqual(items(base, 32));
      expect(tl(run.final)).toEqual(tl(base));
    });

    it("three items: one item after the cancellation", () => {
      const y2 = [w(16, 18, "11-15", "open", "3800", "S18")];
      const tp: LogEntry[] = [
        w(33, 34, "11-04", "11-06", "3500", "SA", { seen: 25 }),
        {
          kind: "resolve",
          op: 35,
          event: 36,
          decision: "take_previous",
          candidates: [34],
          unit: "f2",
        },
      ];
      const log = [...head(y2), ...tp, del(40, "d", ["S13"]), cancel(50, "d")];
      const run = evaluateLog(STATE, log);
      expect(items(at(run, "deletion"), 32)).toHaveLength(3);
      expect(items(run.final, 32)).toEqual([
        'f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0',
        "f2/1 dropped",
        "f2/2 dropped",
      ]);
      const base = neverDeleted(log, run);
      expect(live(items(run.final, 32))).toEqual(items(base, 32));
      expect(tl(run.final)).toEqual(tl(base));
    });

    it("A′: listed by an awaiting proposal: one item", () => {
      const awaiting: LogEntry[] = [
        w(32, 33, "11-04", "11-06", "5100", "SL"),
        { kind: "undo", op: 37, event: 38, target: 30, includeLater: true },
      ];
      const run = evaluateLog(STATE, [
        ...head(),
        ...awaiting,
        del(40, "d", ["S13"]),
        cancel(50, "d"),
      ]);
      expect(run.final.reverts.find((r) => r.op === 37)?.status).toBe("awaiting");
      expect(items(run.final, 32)).toEqual([
        'f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0',
        "f2/1 dropped",
      ]);
    });

    it("listed by no revert: one item", () => {
      const run = evaluateLog(STATE, [...head(), del(40, "d", ["S13"]), cancel(50, "d")]);
      expect(items(run.final, 32)).toEqual([
        'f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0',
        "f2/1 dropped",
      ]);
    });
  });

  it("both listed by the same revert: merged", () => {
    // B.1's write-back items, both covered by undo 40's one entry (#32, f2); deleting S13 makes
    // them one segment.
    const log: LogEntry[] = [
      w(10, 12, "10-01", "open", "5000", "S12"),
      w(13, 15, "11-10", "open", "4000", "S13"),
      w(20, 22, "11-02", "11-20", "3000", "S20", { seen: 13, acknowledge: ["overwrite"] }),
      { kind: "undo", op: 30, event: 32, target: 20, seen: 20, acknowledge: ["overwrite"] },
      { kind: "undo", op: 40, event: 42, target: 30, seen: 30, acknowledge: ["overwrite"] },
      del(50, "d", ["S13"]),
    ];
    const run = evaluateLog(STATE, log);
    expect(run.final.reverts.find((r) => r.op === 40)?.record).toEqual([
      { event: 32, target: "f2" },
    ]);
    expect(items(run.final, 32)).toEqual([
      'f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0',
      "f2/1 dropped",
    ]);
  });
});

describe("order independence compares state and items, not restatement indices", () => {
  // 03-deletion «推论» «顺序无关». Found by the order-independence property: deleting S4 then
  // {S1, S2}, or the other way round. Restatement indices may differ with the history of
  // deletions (a new item continues after the largest index used); the comparison leaves them out.
  const log: LogEntry[] = [
    put(10, 11, "1", ["S1"], "10-01", "open", { seen: 0, acknowledge: ["overwrite"] }),
    put(20, 21, "2", ["S5"], "11-03", "open", { seen: 0 }),
    withF3(put(30, 31, "1", ["S5"], "11-01", "open", { seen: 20, explicit: true })),
    put(40, 41, "2", ["S4"], "11-01", "11-03", { seen: 30 }),
    { kind: "undo", op: 60, event: 61, target: 30, seen: 40, acknowledge: ["overwrite"] },
  ];
  const a = del(61, "pi_a", ["S4"]);
  const b = del(62, "pi_b", ["S1", "S2"]);

  it("the two orders and one deletion give the same state and items", () => {
    const ab = evaluateLog(STATE, [...log, a, b]).final;
    const ba = evaluateLog(STATE, [...log, { ...b, op: 61 }, { ...a, op: 62 }]).final;
    const once = evaluateLog(STATE, [...log, del(61, "pi_ab", ["S4", "S1", "S2"])]).final;
    expect(stateWithoutIndices(ba)).toEqual(stateWithoutIndices(ab));
    expect(stateWithoutIndices(once)).toEqual(stateWithoutIndices(ab));
    expect(tl(ab)).toEqual(tl(ba));
    // Restatement indices may differ with the history of deletions; the comparison leaves them out.
  });

  it("an undo of the undo appended after each: the same state and items", () => {
    // #61 has two write-back items, numbered differently in the two orders; the undo's record
    // lists (#61, f2) once, which covers both.
    for (const ack of [false, true]) {
      const further: LogEntry[] = [
        {
          kind: "undo",
          op: 70,
          event: 71,
          target: 60,
          ...(ack ? { acknowledge: ["overwrite"] } : {}),
        },
      ];
      const ab = evaluateLog(STATE, [...log, a, b, ...further], ALLOWED).final;
      const ba = evaluateLog(
        STATE,
        [...log, { ...b, op: 61 }, { ...a, op: 62 }, ...further],
        ALLOWED,
      ).final;
      const once = evaluateLog(
        STATE,
        [...log, del(61, "pi_ab", ["S4", "S1", "S2"]), ...further],
        ALLOWED,
      ).final;
      expect(ab.reverts.at(-1)?.record).toEqual([
        { event: 61, target: "f2" },
        { event: 61, target: "f3" },
      ]);
      expect(stateWithoutIndices(ba)).toEqual(stateWithoutIndices(ab));
      expect(stateWithoutIndices(once)).toEqual(stateWithoutIndices(ab));
    }
  });
});

describe("original items landing in one segment merge, in every order of the deletions", () => {
  // 03-deletion «回掉的权威定义» step 6, 09 §5.7; found by the order-independence property.
  // #41 has an old ver and is split by #31 (11-03) and #21 (11-05): k0 [11-01, 11-03) candidate,
  // k1 [11-03, 11-05) corroborating #11, k2 [11-05, ∞) candidate. #51 undoes #41 and lists
  // (#41, f2). Deleting S3 turns all of #41 into one candidate segment; the originals landing
  // there merge into k0, whatever the order of the deletions.
  const log: LogEntry[] = [
    put(10, 11, "3", ["S3"], "10-01", "open", { seen: 0 }),
    put(20, 21, "1", ["S4"], "11-05", "open", { seen: 10 }),
    put(30, 31, "1", ["S1"], "11-01", "11-03", { seen: 20 }),
    withF3(put(40, 41, "3", ["S1"], "11-01", "open", { seen: 10, explicit: true })),
    { kind: "undo", op: 50, event: 51, target: 40, seen: 40, acknowledge: ["overwrite"] },
  ];
  const orders: Record<string, LogEntry[]> = {
    "S4 then S3": [del(51, "pi_a", ["S4"]), del(52, "pi_b", ["S3"])],
    "S3 then S4": [del(51, "pi_b", ["S3"]), del(52, "pi_a", ["S4"])],
    "both at once": [del(51, "pi_ab", ["S4", "S3"])],
  };

  it("before the deletions: three items; the undo lists the write's (event, target)", () => {
    const ev = evaluateLog(STATE, log, ALLOWED).final;
    expect(f2Items(ev, 41)).toEqual([
      'f2/0 candidate [11-01, 11-03) "3"',
      'f2/1 corroborated [11-03, 11-05) "3"',
      'f2/2 candidate [11-05, inf) "3"',
    ]);
    expect(ev.reverts.at(-1)?.record).toEqual([
      { event: 41, target: "f2" },
      { event: 41, target: "f3" },
    ]);
  });

  it.each(Object.entries(orders))("%s: one candidate item", (_, ds) => {
    const ev = evaluateLog(STATE, [...log, ...ds], ALLOWED).final;
    expect(f2Items(ev, 41)).toEqual([
      'f2/0 candidate [11-01, inf) "3"',
      "f2/1 dropped",
      "f2/2 dropped",
    ]);
    expect(tl(ev)).toEqual(['[11-01, 11-03) "1"']);
  });

  it("the three orders give the same state and items, also after an undo of the undo", () => {
    for (const further of [[], [{ kind: "undo", op: 60, event: 61, target: 50 }]] as LogEntry[][]) {
      const [x, ...rest] = Object.values(orders).map((ds) =>
        stateWithoutIndices(evaluateLog(STATE, [...log, ...ds, ...further], ALLOWED).final),
      );
      for (const y of rest) expect(y).toEqual(x);
    }
  });

  describe("a cancelled deletion's restatement does not count", () => {
    // #26 (S5) from 11-07, before #41: deleting S4 restates k1 as [11-03, 11-07). Once that
    // deletion is cancelled, deleting S3 and S5 gives what deleting S3 and S5 alone gives.
    const withS5: LogEntry[] = [
      ...log.slice(0, 2),
      put(25, 26, "2", ["S5"], "11-07", "open", { seen: 20 }),
      ...log.slice(2),
    ];
    // Dropped entries are restatement bookkeeping (03-deletion «推论» «顺序无关»), left out.
    const items41 = (entries: LogEntry[]) =>
      f2Items(evaluateLog(STATE, [...withS5, ...entries], ALLOWED).final, 41).filter(
        (x) => !x.endsWith("dropped"),
      );
    const only = items41([del(51, "pi_b", ["S3", "S5"])]);

    it("deleting S4 restates k1 with an end drawn by S5", () => {
      expect(items41([del(51, "pi_a", ["S4"])])).toContain('f2/1 corroborated [11-03, 11-07) "3"');
    });
    it("deleting S3 and S5 alone: one candidate item", () => {
      expect(only).toEqual(['f2/0 candidate [11-01, inf) "3"']);
    });
    it("delete S4, cancel it, delete S3 and S5: as deleting S3 and S5 alone", () => {
      expect(
        items41([del(51, "pi_a", ["S4"]), cancel(52, "pi_a"), del(53, "pi_b", ["S3", "S5"])]),
      ).toEqual(only);
    });
    it("delete S4, delete S3 and S5, cancel the first: as deleting S3 and S5 alone", () => {
      expect(
        items41([del(51, "pi_a", ["S4"]), del(52, "pi_b", ["S3", "S5"]), cancel(53, "pi_a")]),
      ).toEqual(only);
    });
  });
});

describe("a revert covers every item of a listed (event, target), also an index first given later", () => {
  // 03-deletion «回掉的权威定义» steps 1 and 6, 09 §5.7. #51 has the ver of #11 and corroborates
  // [11-03, ∞); undo #61 lists (#51, f2). Deleting S2 first uncovers #21's 2 on [11-09, ∞): #51 was
  // in effect there, so a new index k1 applied [11-09, ∞) is given, and #61 covers it. Deleting S1
  // next makes k1 corroborate again, in one segment with k0: one item, as in every other order.
  const at = (
    op: number,
    v: string,
    src: string,
    from: string,
    to: ToParam,
    seen: number,
    explicit = false,
  ): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: { f2: { value: v, sources: [src], ...(explicit ? { explicit } : {}) } },
    acknowledge: ["overwrite"],
  });
  const open: ToParam = { mode: "open" };
  const next: ToParam = { mode: "next_change" };
  const log: LogEntry[] = [
    at(10, "1", "S4", "10-01", open, 0),
    at(20, "2", "S1", "11-01", open, 10, true),
    at(30, "1", "S2", "11-01", next, 20),
    at(40, "1", "S4", "11-03", { mode: "given", value: d("11-09") }, 30, true),
    at(50, "1", "S3", "11-03", open, 10, true),
    { kind: "undo", op: 60, event: 61, target: 50 },
    at(70, "1", "S5", "11-05", { mode: "given", value: d("11-07") }, 60),
    at(80, "2", "S2", "11-01", next, 70, true),
  ];
  const sets = { a: ["S2"], b: ["S1"], c: ["S5"] };
  const orders: Record<string, string[][]> = {
    "S2, S1, S5": [sets.a, sets.b, sets.c],
    "S1, S5, S2": [sets.b, sets.c, sets.a],
    "S5, S2, S1": [sets.c, sets.a, sets.b],
    "S5, S1, S2": [sets.c, sets.b, sets.a],
    "all at once": [[...sets.a, ...sets.b, ...sets.c]],
  };
  const run = (ds: string[][]) =>
    evaluateLog(STATE, [
      ...log,
      ...ds.map((sources, i): LogEntry => del(81 + i, `pi_${i}`, sources)),
    ]).final;
  it.each(Object.entries(orders))("%s: #51 is one corroborating item", (_, ds) => {
    expect(items(run(ds), 51).filter((x) => !x.endsWith("dropped"))).toEqual([
      'f2/0 corroborated [11-03, inf) "1"',
    ]);
  });
  it("the orders give the same state and items", () => {
    const [x, ...rest] = Object.values(orders).map((ds) => stateWithoutIndices(run(ds)));
    for (const y of rest) expect(y).toEqual(x);
  });
});

describe("logs whose items once depended on the order of deletions", () => {
  // 03-deletion «回掉的权威定义» steps 1 and 6, 09 §5.7. Each log: #51 has the ver of #11 and is
  // split into several items; #61 undoes it and lists (#51, f2). Every order of the deletions
  // gives the same state and items. These logs were found against the cut rules that indices
  // used to need; a revert now covers by (event, target), and the originals landing in one
  // segment merge.
  const w2 = (
    op: number,
    v: string,
    src: string,
    from: string,
    to: ToParam,
    seen: number,
    explicit = false,
  ): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: { f2: { value: v, sources: [src], ...(explicit ? { explicit } : {}) } },
    acknowledge: ["overwrite"],
  });
  const open: ToParam = { mode: "open" };
  const until = (md: string): ToParam => ({ mode: "given", value: d(md) });
  const check = (log: LogEntry[], orders: string[][][], expected: string[]) => {
    const last = Math.max(...log.map((e) => e.op));
    const results = orders.map(
      (ds) =>
        evaluateLog(STATE, [
          ...log,
          ...ds.map((sources, i): LogEntry => del(last + 1 + i, `pi_${i}`, sources)),
        ]).final,
    );
    for (const ev of results) {
      expect(items(ev, 51).filter((x) => !x.endsWith("dropped") && x.startsWith("f2/"))).toEqual(
        expected,
      );
    }
    const [x, ...rest] = results.map(stateWithoutIndices);
    for (const y of rest) expect(y).toEqual(x);
  };

  it("a new index split from a candidate item: covered like the rest of the write", () => {
    // Deleting S5 first turns [11-05, ∞) of #51's candidate k1 into a corroboration under a new
    // index. #61 covers (#51, f2), so the new index is covered too; once S1 is deleted as well, the
    // candidate parts land in one segment and merge.
    check(
      [
        w2(10, "2", "S1", "10-01", open, 0),
        w2(20, "1", "S3", "11-03", until("11-07"), 10),
        w2(30, "2", "S3", "11-05", until("11-07"), 20, true),
        w2(40, "1", "S5", "11-05", open, 30, true),
        w2(50, "2", "S2", "11-01", open, 10, true),
        { kind: "undo", op: 60, event: 61, target: 50 },
        w2(70, "3", "S1", "11-03", until("11-09"), 60),
        w2(80, "2", "S5", "11-05", { mode: "next_change" }, 70),
      ],
      [[["S1"], ["S5"]], [["S5"], ["S1"]], [["S1", "S5"]]],
      ['f2/0 candidate [11-01, inf) "2"'],
    );
  });

  it("a new index split off an original lands with it in one item", () => {
    // Deleting S5 first splits [11-05, 11-07) off #51's k1 as a new index; after S1 is deleted too
    // all of #51 is one candidate segment.
    check(
      [
        w2(10, "1", "S1", "10-01", open, 0),
        w2(20, "1", "S3", "11-01", open, 10),
        w2(30, "2", "S3", "11-05", until("11-07"), 20),
        w2(40, "2", "S5", "11-03", until("11-05"), 30),
        w2(50, "1", "S2", "11-01", open, 10, true),
        { kind: "undo", op: 60, event: 61, target: 50 },
      ],
      [[["S5"], ["S1"]], [["S1"], ["S5"]], [["S5", "S1"]]],
      ['f2/0 candidate [11-01, inf) "1"'],
    );
  });

  it("an original restated by a deletion merges with the others once they share a segment", () => {
    // Deleting S3 first restates #51's k1 as [11-05, 11-07). After S1 and S5 are deleted, #51 is
    // one candidate segment from 11-03, in every order.
    check(
      [
        w2(10, "2", "S1", "10-01", open, 0),
        w2(20, "1", "S5", "11-07", until("11-09"), 10, true),
        w2(30, "2", "S3", "11-07", open, 20, true),
        w2(40, "1", "S4", "11-03", until("11-05"), 30),
        w2(50, "2", "S2", "11-03", open, 10, true),
        { kind: "undo", op: 60, event: 61, target: 50 },
        w2(70, "1", "S2", "11-01", until("11-03"), 60, true),
        w2(80, "2", "S1", "11-07", until("11-09"), 70, true),
      ],
      [[["S3"], ["S1", "S5"]], [["S1", "S5"], ["S3"]], [["S3", "S1", "S5"]]],
      ['f2/0 candidate [11-03, inf) "2"'],
    );
  });

  it("an original item lands by its write-time block: the undo covers the same items in every order", () => {
    // #51's k0 [11-01, 11-07) a corroboration and k1 [11-07, ∞) a candidate when written: not
    // every item in effect, so not protected (03-deletion «删除结果的定义», the protection unit);
    // #61 lists (#51, f2). After S5 and S3 are deleted, in every order, #51 is judged in the replay:
    // [11-01, 11-05) and [11-07, ∞) are still the same as the version it saw (corroborations), and
    // [11-05, 11-07), which #31 changed after that version, is a candidate under a new index.
    // Values: [11-05, 11-07) is 1, given by #31.
    const log: LogEntry[] = [
      w2(10, "3", "S1", "10-01", open, 0),
      w2(20, "1", "S3", "11-05", { mode: "next_change" }, 10),
      w2(30, "1", "S4", "11-05", until("11-07"), 20, true),
      w2(40, "3", "S5", "11-05", { mode: "next_change" }, 30, true),
      withF3(w2(50, "3", "S2", "11-01", open, 10, true)),
      { kind: "undo", op: 60, event: 61, target: 50, seen: 50, acknowledge: ["overwrite"] },
      w2(70, "1", "S3", "11-07", open, 60),
      w2(80, "3", "S4", "11-05", { mode: "next_change" }, 70),
    ];
    check(
      log,
      [[["S5"], ["S3"]], [["S3"], ["S5"]], [["S5", "S3"]]],
      [
        'f2/0 corroborated [11-01, 11-05) "3"',
        'f2/1 corroborated [11-07, inf) "3"',
        'f2/2 candidate [11-05, 11-07) "3"',
      ],
    );
    const ev = evaluateLog(STATE, [...log, del(81, "pi_0", ["S5"]), del(82, "pi_1", ["S3"])]).final;
    expect(tl(ev)).toEqual(['[10-01, 11-05) "3"', '[11-05, 11-07) "1"', '[11-07, inf) "3"']);
    // The candidate stretch is within #61's record (by (event, target), an index a deletion gave
    // included): #51 was undone. Deleting S4 too (#31 and #81 gone), #51 is one item over
    // [11-01, ∞), registered as taken back by #61 there: it gives no value; 3 is #11's.
    const more = evaluateLog(STATE, [
      ...log,
      del(81, "pi_0", ["S5"]),
      del(82, "pi_1", ["S3"]),
      del(83, "pi_2", ["S4"]),
    ]).final;
    const own = more.items.filter((x) => x.event === 51 && x.target === "f2");
    expect(
      own.filter((x) => x.status !== "dropped").map((x) => [x.k, x.status, x.registrations]),
    ).toEqual([[0, "corroborated", [{ byOp: 60, valid: [{ from: d("11-01"), to: null }] }]]]);
    expect(tl(more)).toEqual(['[10-01, inf) "3"']);
  });

  it("an item whose start a deletion moved merges like the others", () => {
    // #51's k1 is written as [11-07, 11-09). Deleting S4 first restates it as [11-03, 11-09).
    // After S1 is deleted too, #51 is one candidate segment, as in the other orders.
    check(
      [
        w2(10, "3", "S1", "10-01", open, 0),
        w2(20, "1", "S3", "11-03", open, 10, true),
        w2(30, "3", "S4", "11-03", open, 20, true),
        w2(40, "1", "S3", "11-07", until("11-09"), 30),
        w2(50, "3", "S2", "11-01", open, 10, true),
        { kind: "undo", op: 60, event: 61, target: 50 },
        w2(70, "1", "S1", "11-03", { mode: "next_change" }, 60),
      ],
      [[["S4"], ["S1"]], [["S1"], ["S4"]], [["S4", "S1"]]],
      ['f2/0 candidate [11-01, inf) "3"'],
    );
  });
});

describe("a default end a deletion extends does not split a write's items", () => {
  // Deleting S4 extends #27's default end to 11-20, the start of #41's k1. Once #41 is one
  // candidate segment, all three orders give one item.
  const log: LogEntry[] = [
    put(10, 11, "3", ["S3"], "10-01", "open", { seen: 0 }),
    put(20, 21, "1", ["S2"], "11-20", "open", { seen: 10 }),
    put(24, 25, "3", ["S4"], "11-14", "11-16", { seen: 20, explicit: true }),
    {
      ...put(26, 27, "3", ["S5"], "11-12", "open", { seen: 24, explicit: true }),
      valid: { from: { mode: "given", value: d("11-12") }, to: { mode: "next_change" } },
    },
    put(40, 41, "3", ["S1"], "11-10", "open", { seen: 10, explicit: true }),
    { kind: "undo", op: 50, event: 51, target: 40 },
  ];
  const orders: Record<string, LogEntry[]> = {
    "S4 then S3, S5": [del(51, "pi_a", ["S4"]), del(52, "pi_b", ["S3", "S5"])],
    "S3, S5 then S4": [del(51, "pi_b", ["S3", "S5"]), del(52, "pi_a", ["S4"])],
    "all at once": [del(51, "pi_ab", ["S4", "S3", "S5"])],
  };
  it.each(Object.entries(orders))("%s: one candidate item", (_, ds) => {
    expect(
      items(evaluateLog(STATE, [...log, ...ds]).final, 41).filter((x) => !x.endsWith("dropped")),
    ).toEqual(['f2/0 candidate [11-10, inf) "3"']);
  });
});

it("an undo of a revert takes back all of that revert's write-back items, also one dropped when the undo was written", () => {
  // 03-deletion «回掉的权威定义» step 1, 09 §5.7. #71 undoes the undo #61 and writes back 7 on
  // [11-01, 11-03) and [11-05, 11-07). Deleting SX (#51) merges #71's items into one, k1 dropped.
  // During the grace period #91 undoes #71; its record lists (#71, f2). Cancelling the deletion brings
  // k1 back: #91 takes it back too, so no write-back item of #71 gives a value.
  const log: LogEntry[] = [
    put(10, 11, "1", ["S1"], "10-01", "open", { seen: 0, acknowledge: ["overwrite"] }),
    put(20, 21, "1", ["S3"], "11-01", "11-07", { seen: 10, explicit: true }),
    del(30, "pi_30", ["S1", "S4"]),
    put(40, 41, "7", ["SW"], "11-01", "11-07"),
    put(50, 51, "8", ["SX"], "11-03", "11-05"),
    { kind: "undo", op: 60, event: 61, target: 40, seen: 50, acknowledge: ["overwrite"] },
    { kind: "undo", op: 70, event: 71, target: 60, seen: 60, acknowledge: ["overwrite"] },
    del(80, "pi_x", ["SX"]),
    { kind: "undo", op: 90, event: 91, target: 70 },
    cancel(100, "pi_x"),
  ];
  const run = evaluateLog(STATE, log, ALLOWED);
  expect(run.steps[8]?.state.reverts.at(-1)?.record).toEqual([{ event: 71, target: "f2" }]);
  expect(short(segments(run.final, "f2"))).toEqual([
    '[11-01, 11-03) "1" by #91/f2/0',
    '[11-03, 11-05) "8" by #51/f2/0',
    '[11-05, 11-07) "1" by #91/f2/1',
  ]);
});

it("09 §5.7: at a cancellation the segment is one item again, as never deleted", () => {
  // y (#16) and x (#26) await, both because of #13 (B2). Operation 30 undoes #21 with one
  // write-back k0 [11-02, 11-15); a take_previous lists it. Deleting B2 lets y and x take effect:
  // x covers [11-12, 11-15) of #21 and y splits the rest, k0 [11-02, 11-08) and k1 [11-08, 11-12).
  // The cancellation sends both back: one segment [11-02, 11-15). k1 was given only by the
  // cancelled deletion's confirmation: its block is not an original interval (03-deletion
  // «回掉的权威定义» step 6), so k0 alone lands there and the segment is one item.
  const sw = (
    op: number,
    from: string,
    end: string,
    value: string,
    src: string,
    opts: Parameters<typeof put>[6] = {},
  ) => put(op, op + 1, value, [src], from, end, opts);
  const log: LogEntry[] = [
    sw(10, "10-01", "open", "5000", "B1"),
    sw(12, "11-22", "open", "4500", "B2"),
    sw(15, "11-08", "open", "4000", "B3"),
    sw(20, "11-02", "11-15", "3000", "B4"),
    sw(25, "11-12", "11-15", "5000", "B6"),
    { kind: "undo", op: 30, event: 31, target: 20, seen: 29, acknowledge: ["overwrite"] },
    sw(33, "11-02", "11-05", "3500", "B5", { seen: 18 }),
    { kind: "resolve", op: 35, event: 36, decision: "take_previous", candidates: [34], unit: "f2" },
    del(40, "d", ["B2"]),
    cancel(50, "d"),
  ];
  const run = evaluateLog(STATE, log);
  expect(items(run.steps[8]?.state as Evaluation, 31)).toEqual([
    'f2/0 applied [11-02, 11-08) "5000" carried #11/f2/0',
    'f2/1 applied [11-08, 11-12) "4000" carried #16/f2/0',
  ]);
  expect(items(run.final, 31)).toEqual([
    'f2/0 applied [11-02, 11-15) "5000" carried #11/f2/0',
    "f2/1 dropped",
  ]);
  const base = evaluateLog(
    STATE,
    log.filter((e) => e.kind !== "deletion" && e.kind !== "cancel"),
    {
      forcedEffective: run.steps.at(-1)?.keptEffective ?? [],
      forcedSuperseded: run.steps.at(-1)?.keptSuperseded ?? [],
    },
  ).final;
  expect(items(run.final, 31).filter((x) => !x.endsWith("dropped"))).toEqual(items(base, 31));
  expect(tl(run.final)).toEqual(tl(base));
});

describe("a write with an old ver after two deletion orders (03-deletion «推论» «顺序无关»)", () => {
  // Event table, f2 required. #11 1 (S1), #21 2 (S2), #31 1 (S4); A deletes S4, B deletes S2. A
  // then B changes f2 twice (1 → 2 → 1); B then A, or both at once, changes nothing. A deletion
  // counts as a change over what it recorded, so a write with the ver before both (#41, ver 30)
  // is a candidate after A then B and applied after the others. The state and items before #41
  // are the same in all three.
  const EVENT: TableSchema = { kind: "event", required: ["f2"] };
  const w = (op: number, value: string, src: string, seen: number): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    fields: { f2: { value, sources: [src] } },
  });
  const log: LogEntry[] = [w(10, "1", "S1", 0), w(20, "2", "S2", 10), w(30, "1", "S4", 20)];
  const a = (op: number) => del(op, "pi_a", ["S4"]);
  const b = (op: number) => del(op, "pi_b", ["S2"]);
  const orders: [string, LogEntry[]][] = [
    ["A then B", [a(31), b(32)]],
    ["B then A", [b(31), a(32)]],
    ["{A, B} at once", [del(31, "pi_ab", ["S4", "S2"])]],
  ];
  const later = w(40, "2", "S9", 30);

  it("the deletions alone: the same state and items", () => {
    const [x, ...rest] = orders.map(([, ds]) =>
      stateWithoutIndices(evaluateLog(EVENT, [...log, ...ds]).final),
    );
    for (const y of rest) expect(y).toEqual(x);
  });

  it("then the write with ver 30: a candidate after A then B, applied after the others", () => {
    const result = orders.map(([name, ds]) => {
      const ev = evaluateLog(EVENT, [...log, ...ds, later]).final;
      return [name, ev.items.find((x) => x.event === 41)?.status, tl(ev)];
    });
    expect(result).toEqual([
      ["A then B", "candidate", ['[-inf, inf) "1"']],
      ["B then A", "applied", ['[-inf, inf) "2"']],
      ["{A, B} at once", "applied", ['[-inf, inf) "2"']],
    ]);
  });
});

it("«删除不增加未决事项»: a write back to pending with its kind changed gets a new item", () => {
  // Found by the property. #51 awaits at its write (f3 over #21's shorter interval). Deleting
  // S2 removes #21: #51 takes effect, its awaiting item superseded. Deleting S1 removes #11, so
  // the entity begins at #31 (operation 30), after #51's ver 20: #51 is back to pending as a
  // conflict. Its kind changed, so the awaiting item stays superseded and a candidate item
  // replaces it.
  const f3 = (op: number, src: string, from: string, end: string, seen: number): WriteOp => ({
    ...put(op, op + 1, "1", [src], from, end, { seen }),
    fields: { f3: { value: "1", sources: [src] } },
  });
  const log: LogEntry[] = [
    put(10, 11, "1", ["S1"], "10-01", "open", { seen: 0, acknowledge: ["overwrite"] }),
    f3(20, "S2", "11-01", "11-03", 10),
    put(30, 31, "1", ["S5"], "11-01", "open", { seen: 20, explicit: true }),
    f3(50, "S4", "11-01", "open", 20),
    del(60, "pi_60", ["S2"]),
    del(70, "pi_70", ["S1"]),
  ];
  const run = evaluateLog(STATE, log);
  const status = (i: number) =>
    run.steps[i]?.state.items.filter((x) => x.event === 51).map((x) => [x.status, x.closed]);
  expect([status(3), status(4), status(5)]).toEqual([
    [["awaiting", undefined]],
    [["applied", undefined]],
    [["candidate", undefined]],
  ]);
  expect(tl(run.final, "f3")).toEqual(["[11-01, inf) null"]);
});

it("a deletion that brings the entity back ends the refusal of writes to it", () => {
  // 03-deletion «撤回与宽限期»: only writes to a row or entity a pending deletion removed are
  // refused. Deleting S1 removes #11, and #41's write-back (no value on [11-01, inf)) leaves the
  // entity with no value anywhere; deleting S5 then removes #21 as well, the write-back is no
  // longer a contribution and #31 gives the entity back. The undo after it is not refused, in
  // either order of the two deletions.
  const log: LogEntry[] = [
    put(10, 11, "1", ["S1"], "10-01", "open", { seen: 0 }),
    put(20, 21, "2", ["S5"], "11-01", "open", { seen: 0 }),
    put(30, 31, "1", ["S4"], "11-01", "11-03", { seen: 20, explicit: true }),
    { kind: "resolve", op: 40, event: 41, decision: "take_previous", candidates: [21], unit: "f2" },
    put(50, 51, "1", ["S1"], "11-01", "11-03", { seen: 40, explicit: true }),
  ];
  const undo: LogEntry = { kind: "undo", op: 60, event: 61, target: 50 };
  for (const [first, second] of [
    ["S1", "S5"],
    ["S5", "S1"],
  ] as const) {
    const run = evaluateLog(
      STATE,
      [...log, del(51, "pi_1", [first]), del(52, "pi_2", [second]), undo],
      ALLOWED,
    );
    expect(run.steps[5]?.state.exists).toBe(first === "S5");
    expect(run.steps[6]?.state.exists).toBe(true);
    expect(run.steps[7]?.refused).toBe(false);
    expect(run.final.reverts.at(-1)).toEqual({ op: 60, event: 61, status: "rejected", record: [] });
    expect(tl(run.final)).toEqual(['[11-01, 11-03) "1"']);
  }
});

describe("revert statuses are decided one by one in operation order, each as if in effect", () => {
  // 09 §5.7, 05-time «高影响写入»: deciding a revert counts the earlier ones by their decided
  // status and itself as in effect, once, never judged again. Each case below made the
  // evaluator loop when "the reverts in effect in the result" was its own input.
  const g = (from: string, to: ToParam) => ({
    from: { mode: "given" as const, value: d(from) },
    to,
  });
  const open: ToParam = { mode: "open" };
  const ack = { acknowledge: ["overwrite"] as const };

  it("an include_later undo that would take back a later write's item awaits, before and after a deletion", () => {
    // #81 undoes #61 with include_later; its record lists #71's write-back items (a later write).
    // Counted in effect, #81 covers #71's items 1 and 2 but not 0: #71 is cut, item 1 is in
    // #81's scope, so #81 takes back a later write: high-impact ④, awaiting. Deciding #81 as not
    // in effect instead would see #71 as one item, outside #81's scope, decide #81 in effect, and
    // then, executed with #81 counted, cut #71 and take back its item 1 without confirmation.
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: g("10-01", open),
        fields: { f2: { value: "1", sources: ["S1"] } },
        ...ack,
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: g("10-01", open),
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        ...ack,
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: g("11-07", open),
        fields: { f3: { value: "1", sources: ["S3"], explicit: false } },
        ...ack,
      },
      {
        kind: "revoke",
        op: 40,
        event: 41,
        seen: 30,
        valid: g("11-03", { mode: "given", value: d("11-05") }),
        validSources: ["S2"],
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: g("11-03", open),
        fields: { f3: { value: "1", sources: ["S5"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        valid: g("11-03", open),
        fields: { f3: { value: "1", sources: ["S3"], explicit: false } },
        ...ack,
      },
      { kind: "undo", op: 70, event: 71, target: 60, includeLater: false, seen: 60, ...ack },
      { kind: "undo", op: 80, event: 81, target: 60, includeLater: true, seen: 70, ...ack },
    ];
    for (const entries of [log, [...log, del(90, "pi_d", ["S1"])]]) {
      const ev = evaluateLog(STATE, entries).final;
      expect(ev.reverts.map((r) => [r.op, r.status])).toEqual([
        [70, "applied"],
        [80, "awaiting"],
      ]);
      expect(ev.items.filter((x) => x.registrations.some((r) => r.byOp === 80))).toEqual([]);
    }
  });

  it("an include_later undo whose high impact depends on a deletion settles", () => {
    // Found by review: counting the undo in effect made it high-impact (awaiting), not counting
    // it made it not high-impact (in effect through the deletion). Decided in operation order,
    // each revert as if in effect, the answer is one.
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: g("11-01", open),
        fields: { f2: { value: "1", sources: ["S1"] } },
        ...ack,
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: g("11-05", open),
        validSources: ["S4"],
        fields: {
          f3: { value: "2", sources: ["S6"], explicit: true },
          f2: { value: "2", sources: ["S6"] },
        },
        ...ack,
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: g("11-05", open),
        validSources: ["S3"],
        fields: { f2: { value: "1", sources: ["S3", "S5"] } },
        ...ack,
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 10,
        valid: g("11-01", { mode: "next_change" }),
        fields: { f2: { value: "1", sources: ["S2"], explicit: true } },
        ...ack,
      },
      del(50, "pi_mid", ["S5"]),
      { kind: "undo", op: 70, event: 71, target: 20, includeLater: true },
      del(82, "pi_0", ["S4", "S6"]),
    ];
    const run = evaluateLog(STATE, log, ALLOWED);
    // Awaiting when written: it lists #41's f2 as `later`, whose range is not empty. Deleting S4
    // and S6 removes the undone write #21 altogether: D(#41) is empty, no item marked `later` has a
    // range, so the undo is no longer high-impact and takes effect at its own number (05-time
    // «高影响写入» ④).
    expect(
      run.steps.find((x) => x.entry.op === 70)?.state.reverts.map((r) => [r.op, r.status]),
    ).toEqual([[70, "awaiting"]]);
    expect(run.final.reverts.map((r) => [r.op, r.status])).toEqual([[70, "applied"]]);
  });
});

describe("an include_later undo takes back later writes only where they supersede the undone write", () => {
  // 03-deletion «回掉的权威定义» step 2: an item x marked `later` is taken back on D(x), the union
  // of the intervals of the undone operation's items in effect that x supersedes. Two places where
  // this narrows what an undo did when written (the whole later item was taken back, and any
  // later item in the record made it high-impact ④).
  const sp = (from: string, to: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: { mode: "given" as const, value: d(to) },
  });
  const ack = { acknowledge: ["overwrite"] as ["overwrite"] };

  it("a later write is taken back only within D(x); beyond the undone write it stays", () => {
    // #11 writes 1 on [11-01, 11-05); #21 writes 2 on [11-03, 11-09), superseding #11 on
    // [11-03, 11-05). Undo #11 with include_later, confirmed: the value position is before #11,
    // where f2 has no value. #21 is taken back on [11-03, 11-05) only; on [11-05, 11-09) it stays.
    // #6 creates the entity on days the case does not meet: the first creation cannot be undone.
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 5,
        event: 6,
        valid: sp("10-01", "10-10"),
        fields: { f2: { value: "0", sources: ["S0"] } },
      },
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: sp("11-01", "11-05"),
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: sp("11-03", "11-09"),
        fields: { f2: { value: "2", sources: ["S2"] } },
        ...ack,
      },
      { kind: "undo", op: 30, event: 31, target: 10, includeLater: true },
      { kind: "confirm", op: 40, event: 41, target: 31 },
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(ev.reverts.map((r) => [r.op, r.status])).toEqual([
      [30, "awaiting"],
      [40, "applied"],
    ]);
    expect(ev.reverts[1]?.record).toEqual([
      { event: 11, target: "f2" },
      { event: 21, target: "f2", later: true },
    ]);
    expect(items(ev, 41)).toEqual(["f2/0 applied [11-01, 11-05) no_value"]);
    expect(tl(ev)).toEqual(['[10-01, 10-10) "0"', '[11-05, 11-09) "2"']);
  });

  it("a later item covered whole by a write outside the record has no range: not high-impact ④", () => {
    // #21 writes 2; #31 revokes [11-03, 11-05), superseding #21 there; #41 undoes #31, its
    // write-back restores existence there and covers #31 whole. Undo #21 with include_later: the
    // record lists #31 (later), not #41 (a restore does not supersede a field value). #31's range
    // is empty, so the undo is not high-impact ④ and takes effect at its own number: 1 again.
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: sp("11-01", "11-09"),
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: sp("11-01", "11-09"),
        fields: { f2: { value: "2", sources: ["S2"] } },
        ...ack,
      },
      {
        kind: "revoke",
        op: 30,
        event: 31,
        seen: 20,
        valid: sp("11-03", "11-05"),
        validSources: ["S3"],
      },
      { kind: "undo", op: 40, event: 41, target: 30, seen: 30, ...ack },
      { kind: "undo", op: 50, event: 51, target: 20, includeLater: true, seen: 40, ...ack },
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(ev.reverts.find((r) => r.op === 50)).toEqual({
      op: 50,
      event: 51,
      status: "applied",
      record: [
        { event: 21, target: "f2" },
        { event: 31, target: "existence", later: true },
      ],
    });
    expect(tl(ev)).toEqual(['[11-01, 11-09) "1"']);
  });
});

describe("an item marked later is registered only within D(x)", () => {
  // 03-deletion «回掉的权威定义» step 5: an item in effect is registered on its interval ∩ T(t);
  // an item marked `later` only within its domain D(x) as well, so an undo that is not high-impact
  // ④ registers no later write's item.
  const sp = (from: string, to: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: { mode: "given" as const, value: d(to) },
  });
  const ack = { acknowledge: ["overwrite"] as ["overwrite"] };
  const regsBy = (ev: Evaluation, event: number, op: number) =>
    ev.items
      .filter((x) => x.event === event && x.status !== "dropped")
      .flatMap((x) => x.registrations.filter((r) => r.byOp === op).map((r) => r.valid));

  it("a later entry left with an uncovered item only: nothing registered after the deletion", () => {
    // Found by the property on include_later undos not confirmed. Undo 50 of #31 writes back
    // #51/f3/0 no value and #51/f3/1 uncovered; undo 60 (include_later) lists (#51, f3) as later
    // and awaits. Deleting S1 turns #41 into a change covering #31 on [11-01, 11-03) and drops
    // #51/f3/0: (#51, f3) has only the uncovered item, which supersedes nothing, so D is empty,
    // undo 60 is not high-impact and takes effect, and registers nothing of #51.
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"] } },
        ...ack,
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 19,
        valid: sp("11-03", "11-05"),
        validSources: ["S3"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: sp("11-01", "11-05"),
        fields: { f3: { value: "2", sources: ["S2"] } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: sp("11-01", "11-03"),
        fields: { f3: { value: "2", sources: ["S3"], explicit: true } },
        ...ack,
      },
      { kind: "undo", op: 50, event: 51, target: 30, seen: 40, ...ack },
      { kind: "undo", op: 60, event: 61, target: 30, includeLater: true, seen: 50 },
      del(62, "pi_0", ["S1"]),
    ];
    const run = evaluateLog(STATE, log);
    expect(run.steps.find((x) => x.entry.op === 60)?.state.reverts.at(-1)).toMatchObject({
      status: "awaiting",
      record: [
        { event: 31, target: "f3" },
        { event: 51, target: "f3", later: true },
      ],
    });
    expect(run.final.reverts.find((r) => r.op === 60)?.status).toBe("applied");
    expect(items(run.final, 51)).toContain("f3/1 applied [11-03, 11-05) uncovered");
    expect(regsBy(run.final, 51, 60)).toEqual([]);
  });

  it("across targets: a later revoke listed through a field item is not registered over the undone revoke", () => {
    // W (#51) is an undo of a confirmed include_later undo: it writes back a restore on
    // [11-05, 11-08), a revoke on [11-08, 11-15) and f2 3 on [11-05, 11-08). V (#61) revokes
    // [11-07, 11-20) later and supersedes W's restore and f2 item, so undo 70 (include_later, of W)
    // lists it. D(V) = [11-05, 11-08): V is registered on [11-07, 11-08) only, not over W's revoke
    // on [11-08, 11-15), which V does not supersede.
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: sp("11-05", "11-15"),
        validSources: ["S2"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: sp("11-05", "11-08"),
        fields: { f2: { value: "3", sources: ["S3"] } },
        ...ack,
      },
      { kind: "undo", op: 40, event: 41, target: 20, includeLater: true, seen: 30, ...ack },
      { kind: "confirm", op: 45, event: 46, target: 41 },
      { kind: "undo", op: 50, event: 51, target: 45, seen: 45, ...ack },
      {
        kind: "revoke",
        op: 60,
        event: 61,
        seen: 50,
        valid: sp("11-07", "11-20"),
        validSources: ["S6"],
      },
      { kind: "undo", op: 70, event: 71, target: 50, includeLater: true, seen: 60, ...ack },
      { kind: "confirm", op: 75, event: 76, target: 71 },
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(items(ev, 51)).toEqual([
      "existence/0 applied [11-05, 11-08) restore",
      "existence/1 applied [11-08, 11-15) revoke",
      'f2/0 applied [11-05, 11-08) "3" carried #31/f2/0',
    ]);
    expect(ev.reverts.find((r) => r.op === 75)?.record).toContainEqual({
      event: 61,
      target: "existence",
      later: true,
    });
    expect(regsBy(ev, 61, 75)).toEqual([[{ from: d("11-07"), to: d("11-08") }]]);
  });

  it("a later item registered by an undo that is not high-impact already provides nothing there", () => {
    // As above, with an undo of V (op 65) whose write-back restores existence over V: V's range
    // is empty, so undo 70 is not high-impact and takes effect without a confirmation. It still
    // registers V on [11-07, 11-08) (T(existence) there comes from W's restore, which only a
    // revoke supersedes, and D(V) is not empty); apply does not compute coverage. V is registered
    // there by undo 65 already, so the registration changes no value (03-deletion step 5).
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: sp("11-05", "11-15"),
        validSources: ["S2"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: sp("11-05", "11-08"),
        fields: { f2: { value: "3", sources: ["S3"] } },
        ...ack,
      },
      { kind: "undo", op: 40, event: 41, target: 20, includeLater: true, seen: 30, ...ack },
      { kind: "confirm", op: 45, event: 46, target: 41 },
      { kind: "undo", op: 50, event: 51, target: 45, seen: 45, ...ack },
      {
        kind: "revoke",
        op: 60,
        event: 61,
        seen: 50,
        valid: sp("11-07", "11-20"),
        validSources: ["S6"],
      },
      { kind: "undo", op: 65, event: 66, target: 60, seen: 60, ...ack },
      { kind: "undo", op: 70, event: 71, target: 50, includeLater: true, seen: 65, ...ack },
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(ev.reverts.find((r) => r.op === 70)?.status).toBe("applied");
    expect(regsBy(ev, 61, 70)).toEqual([[{ from: d("11-07"), to: d("11-08") }]]);
    expect(regsBy(ev, 61, 65)).toEqual([[{ from: d("11-07"), to: d("11-20") }]]);
  });
});

describe("an undo's coverage does not depend on the deletions around it", () => {
  // 03-deletion «推论»: «撤回还原» and «顺序无关». Counterexamples to covering by index: an undo
  // written after a deletion listed indices that deletion gave, and a deletion of a source no
  // write cites rebuilt items the undo had not listed. Covering by (event, target), neither
  // depends on what was deleted when the undo was written.
  const open: ToParam = { mode: "open" };
  const next: ToParam = { mode: "next_change" };
  const until = (md: string): ToParam => ({ mode: "given", value: d(md) });
  const w = (
    op: number,
    v: string,
    src: string,
    from: string,
    to: ToParam,
    seen: number,
    extra: Partial<WriteOp> = {},
  ): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: { f2: { value: v, sources: [src] } },
    acknowledge: ["overwrite"],
    ...extra,
  });
  const state = (log: LogEntry[]) => stateWithoutIndices(evaluateLog(STATE, log).final);

  it("an undo written after a deletion keeps its effect when two deletions are deleted and cancelled", () => {
    const g = (from: string, to: ToParam) => ({
      from: { mode: "given" as const, value: d(from) },
      to,
    });
    const head: LogEntry[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: g("11-01", open),
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        valid: g("11-01", until("11-05")),
        validSources: ["S5"],
        seen: 10,
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        valid: g("11-05", next),
        fields: { f2: { value: "3", sources: ["S4"] } },
        seen: 20,
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        valid: g("11-03", next),
        fields: { f2: { value: "1", sources: ["S2"], explicit: true } },
        seen: 10,
        acknowledge: ["overwrite"],
      },
      del(50, "pi_mid", ["S4"]),
      { kind: "undo", op: 60, event: 61, target: 40 },
    ];
    // Deleting S1 and S5 and cancelling both leaves the log as it was.
    const cycle = [del(81, "a", ["S1"]), del(82, "b", ["S5"]), cancel(83, "a"), cancel(85, "b")];
    expect(state([...head, ...cycle])).toEqual(state(head));
  });

  it("deleting a source nothing cites changes nothing, also with an undo written after a deletion", () => {
    const head: LogEntry[] = [
      w(10, "1", "S1", "10-01", open, 0),
      w(30, "2", "S3", "11-07", open, 10),
      w(40, "1", "S6", "11-07", until("11-11"), 30),
      w(50, "1", "S2", "11-01", open, 10, {
        fields: { f2: { value: "1", sources: ["S2"], explicit: true } },
      }),
      del(55, "pi_3", ["S3"]),
      { kind: "undo", op: 60, event: 61, target: 50 },
    ];
    expect(state([...head, del(70, "pi_9", ["S9"])])).toEqual(state(head));
  });
});

describe("a row removed whole by pending deletions is judged on the deleted sets", () => {
  // 03-deletion «撤回与宽限期»: a write (revoke, undo) to a row or entity is refused with
  // `not_found` when it does not exist with the current deleted set and exists without the
  // pending deletions; `not_found` lists every pending deletion touching its contributions there.
  // Otherwise the ordinary rules apply. Only the sets count, not the order of the deletions.
  const open: ToParam = { mode: "open" };
  const w = (
    op: number,
    v: string,
    src: string,
    from: string,
    to: ToParam,
    seen: number,
    extra: Partial<WriteOp> = {},
  ): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: { f2: { value: v, sources: [src] } },
    acknowledge: ["overwrite"],
    ...extra,
  });
  const state = (log: LogEntry[]) => stateWithoutIndices(evaluateLog(STATE, log).final);

  it("the order of the deletions and a cancelled one do not change whether a write is refused", () => {
    const head: LogEntry[] = [
      w(10, "1", "S1", "11-01", open, 0),
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: { from: { mode: "given", value: d("11-01") }, to: open },
        validSources: ["S3"],
      },
    ];
    const write = w(40, "5", "S7", "11-01", open, 39);
    const ab = state([...head, del(30, "pi_a", ["S3"]), del(31, "pi_b", ["S1"]), write]);
    const ba = state([...head, del(30, "pi_b", ["S1"]), del(31, "pi_a", ["S3"]), write]);
    const once = state([...head, del(30, "pi_ab", ["S3", "S1"]), write]);
    expect(ab).toEqual(once);
    expect(ba).toEqual(once);
    // A cancelled deletion leaves no trace.
    const cancelled = state([
      ...head,
      del(30, "pi_a", ["S3"]),
      del(31, "pi_b", ["S1"]),
      cancel(32, "pi_a"),
      write,
    ]);
    expect(cancelled).toEqual(state([...head, del(30, "pi_b", ["S1"]), write]));
  });

  it("nothing of the entity left, pending deletions not the cause: the ordinary not_found, in every order", () => {
    // Without the pending deletions the entity has no value (the revoke covers it), so it was not
    // removed by them; with S1 and S3 deleted not one item is left, as if never created: a write
    // to it by its ID is the ordinary not_found (empty list), whatever the order of the deletions.
    const head: LogEntry[] = [
      w(10, "1", "S1", "11-01", open, 0),
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: { from: { mode: "given", value: d("11-01") }, to: open },
        validSources: ["S3"],
      },
    ];
    const write = w(40, "5", "S7", "11-01", open, 39);
    for (const dels of [
      [del(30, "pi_a", ["S3"]), del(31, "pi_b", ["S1"])],
      [del(30, "pi_b", ["S1"]), del(31, "pi_a", ["S3"])],
      [del(30, "pi_ab", ["S3", "S1"])],
    ]) {
      const run = evaluateLog(STATE, [...head, ...dels, write]);
      expect(run.steps.at(-2)?.state.items.filter((x) => x.status !== "dropped")).toEqual([]);
      expect(run.steps.at(-1)).toMatchObject({ refused: true, notFound: [] });
    }
  });

  it("a write that left nothing does not count as a creation: the next write creates the entity", () => {
    // #31 has only no-op fields and leaves no item; #41 then creates the entity. Nothing was ever
    // there, so it is not a write to an entity with nothing left (a judge comparison
    // counterexample).
    const run = evaluateLog(STATE, [
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: { from: { mode: "given", value: d("11-01") }, to: open },
        fields: {},
        noop: ["f3"],
        acknowledge: ["overwrite"],
      },
      w(40, "9", "S1", "11-01", { mode: "given", value: d("11-03") }, 0),
    ]);
    expect(run.steps.map((x) => x.refused)).toEqual([false, false]);
    expect(tl(run.final)).toEqual(['[11-01, 11-03) "9"']);
  });

  it("only the revoke left: the write fills the hole", () => {
    // Deleting S1 alone leaves the revoke: an item is left, so the ordinary rules apply and the
    // write fills the hole (05-time «高影响写入» ①).
    const run = evaluateLog(STATE, [
      w(10, "1", "S1", "11-01", open, 0),
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: { from: { mode: "given", value: d("11-01") }, to: open },
        validSources: ["S3"],
      },
      del(30, "pi_b", ["S1"]),
      w(40, "5", "S7", "11-01", open, 39),
    ]);
    expect(run.steps.at(-1)?.refused).toBe(false);
    expect(tl(run.final)).toEqual(['[11-01, inf) "5"']);
  });

  it("event table: only an optional field's contribution left: refused", () => {
    const EVENT: TableSchema = { kind: "event", required: ["f2"] };
    const run = evaluateLog(EVENT, [
      {
        kind: "write",
        op: 10,
        event: 11,
        fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "x", sources: ["S2"] } },
      },
      del(20, "pi_1", ["S1"]),
      { kind: "write", op: 30, event: 31, fields: { f3: { value: "y", sources: ["S3"] } } },
    ]);
    expect(run.steps[1]?.state.exists).toBe(false);
    expect(run.steps.at(-1)).toMatchObject({ refused: true, notFound: ["pi_1"] });
  });

  it("state table: only a revoke of part of the interval left: refused", () => {
    const run = evaluateLog(STATE, [
      w(10, "1", "S1", "10-01", open, 0),
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: d("11-01") },
          to: { mode: "given", value: d("11-05") },
        },
        validSources: ["S2"],
      },
      del(30, "pi_1", ["S1"]),
      w(40, "5", "S4", "11-10", open, 39),
    ]);
    expect(run.steps[2]?.state.exists).toBe(false);
    expect(run.steps.at(-1)).toMatchObject({ refused: true, notFound: ["pi_1"] });
  });

  it("lists every pending deletion touching the row, by operation number", () => {
    const run = evaluateLog(STATE, [
      w(10, "1", "S1", "10-01", open, 0),
      w(20, "2", "S2", "11-01", open, 10),
      del(30, "pi_b", ["S2"]),
      del(31, "pi_a", ["S1"]),
      del(32, "pi_c", ["S9"]),
      w(40, "5", "S4", "11-10", open, 39),
    ]);
    expect(run.steps.at(-1)).toMatchObject({ refused: true, notFound: ["pi_b", "pi_a"] });
  });
});

describe("a write-back revoke that hides a later field write is high-impact ④", () => {
  // 05-time «高影响写入» ④, 03-deletion «回掉的权威定义»: an undo (or take_previous) whose
  // write-back revoke would hide a field write in effect after the undone operation, not under
  // its record, awaits confirmation. A hidden corroboration is not high-impact: a warning.
  // #11 5; #21 revokes [11-05, 11-15); undo 30 restores it; #41 then writes there; undo 50 undoes
  // the restore, writing back the revoke.
  const sp = (from: string, to: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: { mode: "given" as const, value: d(to) },
  });
  const ack = { acknowledge: ["overwrite"] as ["overwrite"] };
  const head: LogEntry[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
      fields: { f2: { value: "5", sources: ["S1"] } },
    },
    {
      kind: "revoke",
      op: 20,
      event: 21,
      seen: 10,
      valid: sp("11-05", "11-15"),
      validSources: ["S2"],
    },
    { kind: "undo", op: 30, event: 31, target: 20, seen: 20, ...ack },
  ];
  const later = (value: string, to: string, explicit = false): WriteOp => ({
    kind: "write",
    op: 40,
    event: 41,
    seen: 30,
    valid: sp("11-05", to),
    fields: { f2: { value, sources: ["S4"], ...(explicit ? { explicit } : {}) } },
  });
  const undo: LogEntry = { kind: "undo", op: 50, event: 51, target: 30, seen: 40, ...ack };
  const status50 = (ev: Evaluation) => ev.reverts.find((r) => r.op === 50)?.status;

  it("9 filling [11-05, 11-15) exactly: awaits (it took effect directly before)", () => {
    const ev = evaluateLog(STATE, [...head, later("9", "11-15"), undo]).final;
    expect(status50(ev)).toBe("awaiting");
    expect(tl(ev)).toEqual(['[10-01, 11-05) "5"', '[11-05, 11-15) "9"', '[11-15, inf) "5"']);
  });

  it("9 written on [11-05, 11-20): awaits (it took effect directly before)", () => {
    const ev = evaluateLog(STATE, [...head, later("9", "11-20"), undo]).final;
    expect(status50(ev)).toBe("awaiting");
    expect(tl(ev)).toEqual(['[10-01, 11-05) "5"', '[11-05, 11-20) "9"', '[11-20, inf) "5"']);
  });

  it("a hidden same-value corroboration: in effect, with overwrote_corroborated", () => {
    const ev = evaluateLog(STATE, [...head, later("5", "11-15", true), undo]).final;
    expect(ev.reverts.find((r) => r.op === 50)).toMatchObject({
      status: "applied",
      warnings: ["overwrote_corroborated"],
    });
    expect(tl(ev)).toEqual(['[10-01, 11-05) "5"', '[11-15, inf) "5"']);
  });

  it("confirmed: the revoke is written back and hides the later write", () => {
    const ev = evaluateLog(STATE, [
      ...head,
      later("9", "11-15"),
      undo,
      { kind: "confirm", op: 60, event: 61, target: 51 },
    ]).final;
    expect(ev.reverts.find((r) => r.op === 60)?.status).toBe("applied");
    expect(items(ev, 61)).toEqual(["existence/0 applied [11-05, 11-15) revoke"]);
    expect(tl(ev)).toEqual(['[10-01, 11-05) "5"', '[11-15, inf) "5"']);
  });
});

describe("a write-back leaving a stretch without a value hides a later write of another field (05-time «高影响写入» ④)", () => {
  const sp = (from: string, to: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: { mode: "given" as const, value: d(to) },
  });
  /**
   * f2 is bX over [10-25, 11-01) and b0 over [11-10, 11-20); #5 fills the hole between with b1;
   * #7, another principal, writes f3 = c4 over all of it (one value: no change point of its own).
   * Undoing #5 writes f2 back without a value over [11-01, 11-10): both of f2's change points stay
   * (bX | none | b0), so it erases none, yet f3's value there goes with the stretch's.
   */
  const log = (): LogEntry[] => [
    {
      kind: "write",
      op: 1,
      event: 2,
      valid: sp("10-25", "11-01"),
      fields: { f2: { value: "bX", sources: ["S1"] } },
    },
    {
      kind: "write",
      op: 3,
      event: 4,
      seen: 1,
      acknowledge: ["overwrite"],
      valid: sp("11-10", "11-20"),
      fields: { f2: { value: "b0", sources: ["S2"] } },
    },
    {
      kind: "write",
      op: 5,
      event: 6,
      seen: 3,
      acknowledge: ["overwrite"],
      valid: sp("11-01", "11-10"),
      fields: { f2: { value: "b1", sources: ["S3"] } },
    },
    {
      kind: "write",
      op: 7,
      event: 8,
      seen: 5,
      valid: sp("10-25", "11-20"),
      fields: { f3: { value: "c4", sources: ["S4"] } },
    },
    { kind: "undo", op: 9, event: 10, target: 5, seen: 7 },
  ];

  it("with a required field: the undo awaits confirmation", () => {
    const ev = evaluateLog(STATE, log()).final;
    expect(ev.reverts.find((r) => r.op === 9)?.status).toBe("awaiting");
    // Not in effect: f3 keeps its value over the whole stretch.
    expect(tl(ev, "f3")).toEqual(['[10-25, 11-20) "c4"']);
  });

  it("with no required field: f3 keeps the stretch's value, the undo takes effect", () => {
    const LOOSE: TableSchema = { kind: "state", required: [] };
    const ev = evaluateLog(LOOSE, log()).final;
    expect(ev.reverts.find((r) => r.op === 9)?.status).toBe("applied");
    expect(tl(ev, "f3")).toEqual(['[10-25, 11-20) "c4"']);
  });
});

describe("a take_candidate executed as recorded lands by the ordinary rules", () => {
  // 03-deletion «重放规则» «人的决定（照记录）»: a take that entered the log is not checked again
  // on the state of a replay (a revoked row, a stretch without every required field); what it
  // writes lands by the ordinary rules.
  const g = (from: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: { mode: "open" as const },
  });

  it("on a stretch where a required field has no value after the deletion: no value there", () => {
    // f2 and f3 are required. #41 takes #31's f2 while #11 gives f3; deleting S1 leaves no f3.
    const STATE2: TableSchema = { kind: "state", required: ["f2", "f3"] };
    const run = evaluateLog(STATE2, [
      {
        kind: "write",
        op: 10,
        event: 11,
        valid: g("10-01"),
        fields: { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: g("10-01"),
        fields: { f2: { value: "2", sources: ["S2"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: g("10-01"),
        fields: { f2: { value: "3", sources: ["S3"] } },
      },
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_candidate",
        candidates: [31],
        take: 31,
        unit: "f2",
      },
      del(50, "pi_1", ["S1"]),
    ]);
    expect(run.steps.map((x) => x.refused)).toEqual([false, false, false, false, false]);
    expect(items(run.final, 41)).toEqual(['f2/0 applied [10-01, inf) "3" carried #31/f2/0']);
    expect(run.final.exists).toBe(false);
  });

  it("on an event row a deletion leaves revoked: the value stays on the row, the row revoked", () => {
    // #46 revokes with the version before #21, a candidate; deleting S2 removes #21, so the
    // revoke takes effect at its own number, before the take of #41's f2.
    // On an event table a revoke is about the row's existence and is no value item on a field
    // (03-deletion «重放规则», a field's value: the last contribution still there), so it does not
    // cover the take there even in a replay (deviation (2) holds on state tables only): the take
    // stays on the field; an undo of the revoke would show the 3 the user took.
    const EVENT: TableSchema = { kind: "event", required: ["f2"] };
    const ew = (op: number, v: string, src: string, seen: number): WriteOp => ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      fields: { f2: { value: v, sources: [src] } },
    });
    const run = evaluateLog(EVENT, [
      ew(10, "1", "S1", 0),
      ew(20, "2", "S2", 10),
      ew(40, "3", "S4", 10),
      { kind: "revoke", op: 45, event: 46, seen: 10 },
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "take_candidate",
        candidates: [41],
        take: 41,
        unit: "f2",
      },
      del(60, "pi_1", ["S2"]),
    ]);
    expect(run.steps.some((x) => x.refused)).toBe(false);
    expect(items(run.final, 46)).toEqual(["existence/0 applied [-inf, inf) revoke"]);
    expect(items(run.final, 51)).toEqual(['f2/0 applied [-inf, inf) "3" carried #41/f2/0']);
    expect(run.final.exists).toBe(false);
  });
});

describe("a conflict resolution is recorded by operation: K by (event, unit), take_candidate by its cover set", () => {
  // 03-deletion «回掉的权威定义» step 2, «搬运的值»; 01-objects «各处理方式的执行语义»: the item's
  // candidate items K are the recorded candidate writes' items on the unit that are candidates
  // in the replay, never taken by index; a take_candidate records its merge base and cover set O
  // and writes the taken value on the taken write's items in K, less what writes outside O cover.
  const ack = { acknowledge: ["overwrite"] as ["overwrite"] };
  const g = (from: string, to: string | "open" | "next"): WriteOp["valid"] => ({
    from: { mode: "given", value: d(from) },
    to:
      to === "open"
        ? { mode: "open" }
        : to === "next"
          ? { mode: "next_change" }
          : { mode: "given", value: d(to) },
  });
  const write = (
    op: number,
    fields: WriteOp["fields"],
    valid: WriteOp["valid"],
    extra: Partial<WriteOp> = {},
  ): WriteOp => ({ kind: "write", op, event: op + 1, valid, fields, ...extra }) as WriteOp;
  const f2 = (value: string, src: string, explicit?: boolean): WriteOp["fields"] => ({
    f2: { value, sources: [src], ...(explicit ? { explicit } : {}) },
  });
  /** The timeline from 11-09 on: before it #61 is partly a corroboration (left open). */
  const from09 = (ev: Evaluation) => tl(ev).filter((x) => x >= "[11-09");

  // #11 1 on [11-03, 11-11); #21 3 on [11-09, 11-20); #31 5 on [11-15, 11-18); #61 1 (explicit)
  // with the version of #11, from 11-03 to the next change: a corroboration on [11-03, 11-09), a
  // candidate on [11-09, 11-11). Deleting S1 removes #11: #61 runs to the end.
  const head: LogEntry[] = [
    write(10, f2("1", "S1"), g("11-03", "11-11")),
    write(20, f2("3", "S2"), g("11-09", "11-20"), { seen: 10, ...ack }),
    write(30, f2("5", "S3"), g("11-15", "11-18"), { seen: 20, ...ack }),
    write(60, f2("1", "S6", true), g("11-03", "next"), { seen: 10 }),
  ];
  const resolve = (decision: "take_previous" | "take_candidate"): LogEntry => ({
    kind: "resolve",
    op: 100,
    event: 101,
    decision,
    candidates: [61],
    unit: "f2",
    ...(decision === "take_candidate" ? { take: 61 } : {}),
  });

  it("take_previous: K follows #61 past the merged index; #21 is taken back, #31 stays", () => {
    const ev = evaluateLog(STATE, [
      ...head,
      resolve("take_previous"),
      del(110, "pi_1", ["S1"]),
    ]).final;
    expect(from09(ev)).toEqual(['[11-15, 11-18) "5"']);
    expect(items(ev, 101)).toEqual([
      "f2/0 applied [11-09, 11-15) no_value",
      "f2/1 applied [11-18, 11-20) no_value",
    ]);
  });

  it("take_candidate: the take follows #61 to the end, except where #31 (outside O) covers it", () => {
    const run = evaluateLog(STATE, [...head, resolve("take_candidate"), del(110, "pi_1", ["S1"])]);
    expect(run.final.takeCandidates).toEqual([
      { op: 100, mergeBase: 10, cover: [{ event: 21, target: "f2" }] },
    ]);
    // At the resolution: the take is the candidate's stretch, [11-09, 11-11).
    expect(tl(run.steps[4]?.state as Evaluation)).toEqual([
      '[11-03, 11-11) "1"',
      '[11-11, 11-15) "3"',
      '[11-15, 11-18) "5"',
      '[11-18, 11-20) "3"',
    ]);
    expect(from09(run.final)).toEqual(['[11-15, 11-18) "5"', '[11-18, inf) "1"']);
    expect(tl(run.final)).toContain('[11-03, 11-15) "1"');
  });

  it("the taken write deleted: the same-valued candidates take over, each on its own items", () => {
    // #31 is taken; #41 and #46 have its value on other stretches. Deleting S3 removes #31.
    const ev = evaluateLog(STATE, [
      write(10, f2("1", "S1"), g("10-01", "open")),
      write(20, f2("2", "S2"), g("10-01", "open"), { seen: 10, ...ack }),
      write(30, f2("5", "S3"), g("11-01", "11-20"), { seen: 10 }),
      write(40, f2("5", "S4"), g("11-01", "11-05"), { seen: 10 }),
      write(45, f2("5", "S6"), g("11-12", "11-15"), { seen: 10 }),
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "take_candidate",
        candidates: [31, 41, 46],
        take: 31,
        unit: "f2",
      },
      del(60, "pi_1", ["S3"]),
    ]).final;
    expect(tl(ev)).toEqual([
      '[10-01, 11-01) "2"',
      '[11-01, 11-05) "5"',
      '[11-05, 11-12) "2"',
      '[11-12, 11-15) "5"',
      '[11-15, inf) "2"',
    ]);
  });

  it("a field group: the taken write's item on one field deleted, the other field still taken", () => {
    // f2 and f3 judged together; #31's interval comes from S2, its f3 from S5. Deleting S5.
    const STATE2: TableSchema = { kind: "state", required: ["f2", "f3"] };
    const ev = evaluateLog(STATE2, [
      write(
        10,
        { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
        g("10-01", "open"),
      ),
      write(
        20,
        { f2: { value: "7", sources: ["S7"] }, f3: { value: "z", sources: ["S7"] } },
        g("10-01", "open"),
        { seen: 10, ...ack },
      ),
      write(
        30,
        { f2: { value: "2", sources: ["S2"] }, f3: { value: "b", sources: ["S5"] } },
        g("10-01", "open"),
        { seen: 10, validSources: ["S2"] },
      ),
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_candidate",
        candidates: [31],
        take: 31,
        unit: ["f2", "f3"],
      },
      del(50, "pi_1", ["S5"]),
    ]).final;
    expect(tl(ev, "f2")).toEqual(['[10-01, inf) "2"']);
    expect(tl(ev, "f3")).toEqual(['[10-01, inf) "z"']);
  });

  it("a field group: at the resolution both fields of the taken write are written", () => {
    const STATE2: TableSchema = { kind: "state", required: ["f2", "f3"] };
    const ev = evaluateLog(STATE2, [
      write(
        10,
        { f2: { value: "1", sources: ["S1"] }, f3: { value: "a", sources: ["S1"] } },
        g("10-01", "open"),
      ),
      write(
        20,
        { f2: { value: "7", sources: ["S7"] }, f3: { value: "z", sources: ["S7"] } },
        g("10-01", "open"),
        { seen: 10, ...ack },
      ),
      write(
        30,
        { f2: { value: "2", sources: ["S2"] }, f3: { value: "b", sources: ["S5"] } },
        g("10-01", "open"),
        { seen: 10, validSources: ["S2"] },
      ),
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_candidate",
        candidates: [31],
        take: 31,
        unit: ["f2", "f3"],
      },
    ]).final;
    expect(tl(ev, "f2")).toEqual(['[10-01, inf) "2"']);
    expect(tl(ev, "f3")).toEqual(['[10-01, inf) "b"']);
  });

  it("a deletion that puts a revoke in effect before the candidate: the take recorded on the field still lands", () => {
    // #31 revokes with the version before #21, a candidate; #41's f2 is a candidate in the f2
    // item (it met #21's change only). Deleting S2 removes #21: the revoke takes effect at 30,
    // before #41. K is taken by the unit the resolution recorded, so the take of the f2 item
    // still writes #41's value: on a row the replay leaves revoked, it stays on the row.
    // On an event table a revoke is about the row's existence and is no value item on a field
    // (03-deletion «重放规则», a field's value: the last contribution still there), so it does not
    // cover the take there even in a replay (deviation (2) holds on state tables only): the take
    // stays on the field; an undo of the revoke would show the 3 the user took.
    const EVENT: TableSchema = { kind: "event", required: ["f2"] };
    const ew = (op: number, v: string, src: string, seen: number): WriteOp => ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      fields: { f2: { value: v, sources: [src] } },
    });
    const run = evaluateLog(EVENT, [
      ew(10, "1", "S1", 0),
      ew(20, "2", "S2", 10),
      { kind: "revoke", op: 30, event: 31, seen: 10 },
      ew(40, "3", "S4", 10),
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "take_candidate",
        candidates: [41],
        take: 41,
        unit: "f2",
      },
      del(60, "pi_1", ["S2"]),
    ]);
    expect(items(run.final, 51)).toEqual(['f2/0 applied [-inf, inf) "3" carried #41/f2/0']);
    expect(run.final.exists).toBe(false);
  });

  it("a closed candidate a deletion extends into another item's stretch stays closed there", () => {
    // #31 (to the next change) is a candidate on [11-01, 11-05), its item kept as it was; #51 is a
    // candidate on [11-05, 11-10) in another item. Deleting S2 removes #21's change point: #31
    // runs on, closed, over #51's stretch. take_previous on #51's item takes back #26 there only.
    const ev = evaluateLog(
      STATE,
      [
        write(10, f2("1", "S1"), g("10-01", "open")),
        write(20, f2("2", "S2"), g("11-05", "open"), { seen: 10, ...ack }),
        write(25, f2("4", "S4"), g("11-01", "open"), { seen: 20, ...ack }),
        write(30, f2("3", "S3"), g("11-01", "next"), { seen: 10 }),
        {
          kind: "resolve",
          op: 40,
          event: 41,
          decision: "keep_effective",
          candidates: [31],
          unit: "f2",
        },
        write(50, f2("6", "S6"), g("11-05", "11-10"), { seen: 20 }),
        del(60, "pi_1", ["S2"]),
        {
          kind: "resolve",
          op: 70,
          event: 71,
          decision: "take_previous",
          candidates: [51],
          unit: "f2",
        },
      ],
      ALLOWED,
    ).final;
    expect(items(ev, 31)).toEqual(['f2/0 candidate [11-01, inf) "3" (closed)']);
    expect(tl(ev)).toEqual([
      '[10-01, 11-01) "1"',
      '[11-01, 11-05) "4"',
      '[11-05, 11-10) "1"',
      '[11-10, inf) "4"',
    ]);
  });

  it("a candidate put back into an item of its own belongs to that item: taking it there writes it", () => {
    // X (#31) and Y (#41) are candidates against #21. Deleting S3 removes X; Y's item is kept as
    // it was in the grace period; the cancellation puts X back into an item of its own, which is
    // then taken.
    const ev = evaluateLog(STATE, [
      write(10, f2("1", "S1"), g("10-01", "open")),
      write(20, f2("2", "S2"), g("10-01", "open"), { seen: 10, ...ack }),
      write(30, f2("3", "S3"), g("11-01", "11-10"), { seen: 10 }),
      write(40, f2("4", "S4"), g("11-01", "11-10"), { seen: 10 }),
      del(50, "pi_1", ["S3"]),
      {
        kind: "resolve",
        op: 60,
        event: 61,
        decision: "keep_effective",
        candidates: [41],
        unit: "f2",
      },
      cancel(70, "pi_1"),
      {
        kind: "resolve",
        op: 80,
        event: 81,
        decision: "take_candidate",
        candidates: [31],
        take: 31,
        unit: "f2",
      },
    ]).final;
    expect(tl(ev)).toEqual(['[10-01, 11-01) "2"', '[11-01, 11-10) "3"', '[11-10, inf) "2"']);
  });

  it("a candidate that a deletion makes the same as the value before it still counts in K", () => {
    // #31 (5, explicit) is a candidate against #21; #36 writes 9 on [11-01, 11-03) after it.
    // take_previous on #31's item takes back #21 and #36. Deleting S2 removes #21: #31 is now
    // the same as the value before it, still in K, so #36 is still taken back there.
    const ev = evaluateLog(STATE, [
      write(10, f2("5", "S1"), g("10-01", "open")),
      write(20, f2("2", "S2"), g("11-01", "11-05"), { seen: 10, ...ack }),
      write(30, f2("5", "S3", true), g("11-01", "11-05"), { seen: 10 }),
      write(35, f2("9", "S4"), g("11-01", "11-03"), { seen: 30, ...ack }),
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_previous",
        candidates: [31],
        unit: "f2",
      },
      del(50, "pi_1", ["S2"]),
    ]).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "5"']);
  });

  it("a revoke filled before the candidate is written is not its cause: the item is on the field (a judge comparison counterexample)", () => {
    // #21 revokes [11-01, 11-03); #31 fills it; #41 (the version before both) is a candidate that
    // met #31's change only: the revoke was no longer in effect when #41 was written. Its item is
    // the f2 item, so take_previous on it reverts #31 to the merge base: no value.
    const run = evaluateLog(STATE, [
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        validSources: ["S1"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "3", sources: ["S6"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "resolve",
        op: 43,
        event: 44,
        decision: "take_previous",
        candidates: [41],
        unit: "f2",
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S2"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S3"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as LogEntry[]);
    expect(run.steps.map((x) => x.refused)).toEqual([false, false, false, false, false, false]);
    expect(items(run.steps[3]?.state as Evaluation, 44)).toEqual([
      "f2/0 applied [11-01, inf) no_value",
    ]);
    expect(run.steps[3]?.state.exists).toBe(false);
  });

  it("a candidate the decision closed does not take effect when a deletion removes its conflict (two property counterexamples)", () => {
    // State table: #21 taken; #41 (S1) and #51 written after the resolution. Deleting S1 removes
    // #11 and #41: #21 is still the closed candidate the take carried, not a write in effect.
    const state = evaluateLog(STATE, [
      write(10, f2("1", "S1"), g("10-01", "open"), { seen: 0, ...ack }),
      write(20, f2("3", "S2", true), g("11-03", "open"), { seen: 0, ...ack }),
      {
        kind: "resolve",
        op: 30,
        event: 31,
        decision: "take_candidate",
        candidates: [21],
        take: 21,
        unit: "f2",
      },
      write(40, f2("3", "S1", true), g("11-03", "open"), { seen: 30 }),
      write(50, f2("1", "S3"), g("11-05", "11-09"), { seen: 30, ...ack }),
      del(51, "pi_x", ["S1"]),
    ]).final;
    expect(items(state, 21)).toEqual(['f2/0 candidate [11-03, inf) "3" (closed)']);
    expect(tl(state)).toEqual(['[11-03, 11-05) "3"', '[11-05, 11-09) "1"', '[11-09, inf) "3"']);
    // Event table: #21 (S1) taken over #31; deleting S1 removes #11 and #21. #31, which the take
    // left closed, does not take effect: nothing is left to give a value.
    const EVENT: TableSchema = { kind: "event", required: ["f2"] };
    const ew = (op: number, v: string, src: string): WriteOp => ({
      kind: "write",
      op,
      event: op + 1,
      seen: 0,
      fields: { f2: { value: v, sources: [src] } },
    });
    const event = evaluateLog(EVENT, [
      { ...ew(10, "1", "S1"), ...ack },
      ew(20, "2", "S1"),
      ew(30, "1", "S2"),
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_candidate",
        candidates: [21, 31],
        take: 21,
        unit: "f2",
      },
      del(51, "pi_x", ["S1"]),
    ]).final;
    expect(items(event, 31)).toEqual(['f2/0 candidate [-inf, inf) "1" (closed)']);
    expect(event.exists).toBe(false);
  });
});

describe("a take on existence, a take in a replay, and what covers a take", () => {
  // 03-deletion «搬运的值», «重放规则 · 人的决定»; 01-objects take_candidate. Fixed cases of the
  // existence-unit path and of the cover set in a replay.
  const ack = { acknowledge: ["overwrite"] as ["overwrite"] };
  const g = (from: string, to: string): WriteOp["valid"] => ({
    from: { mode: "given", value: d(from) },
    to:
      to === "open"
        ? { mode: "open" }
        : to === "next"
          ? { mode: "next_change" }
          : { mode: "given", value: d(to) },
  });
  const w = (
    op: number,
    fields: Record<string, [string, string]>,
    valid: WriteOp["valid"] | undefined,
    extra: Partial<WriteOp> = {},
  ): WriteOp =>
    ({
      kind: "write",
      op,
      event: op + 1,
      ...(valid ? { valid } : {}),
      fields: Object.fromEntries(
        Object.entries(fields).map(([f, [value, src]]) => [f, { value, sources: [src] }]),
      ),
      ...extra,
    }) as WriteOp;
  const rv = (op: number, from: string, to: string, src: string, seen: number): LogEntry =>
    ({
      kind: "revoke",
      op,
      event: op + 1,
      seen,
      valid: g(from, to),
      validSources: [src],
    }) as LogEntry;
  const take = (
    op: number,
    candidates: number[],
    unit: FieldId | FieldId[] | "existence",
    taken: number,
  ): LogEntry => ({
    kind: "resolve",
    op,
    event: op + 1,
    decision: "take_candidate",
    candidates,
    unit,
    take: taken,
  });

  // One write: f2's default end stops at 11-15 and it meets #13's change only; f3 runs on and
  // meets the revoke #31. As judge records it: without a group, f2 is in the f2 item and f3 in
  // the item on existence; with the group [f2, f3], both are in the item on existence.
  const mixed: LogEntry[] = [
    w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open")),
    w(12, { f2: ["7", "S7"] }, g("11-20", "open"), { seen: 10, ...ack }),
    w(20, { f2: ["2", "S2"] }, g("11-10", "11-15"), { seen: 12, ...ack }),
    rv(30, "11-25", "11-28", "S3", 20),
    w(40, { f2: ["5", "S5"], f3: ["b", "S5"] }, g("11-10", "next"), { seen: 12 }),
  ];

  it("one write, a field item and an item on existence: a take on existence takes f3 only", () => {
    const ev = evaluateLog(STATE, [...mixed, take(50, [41], "existence", 41)]).final;
    // f3 is taken; f2 only as the merge base's value carried into the hole, not #41's 5.
    expect(items(ev, 51)).toEqual([
      'f2/0 applied [11-25, 11-28) "7" carried #13/f2/0',
      'f3/0 applied [11-10, inf) "b" carried #41/f3/0',
    ]);
    expect(items(ev, 41)).toEqual([
      'f2/0 candidate [11-10, 11-20) "5"',
      'f3/0 candidate [11-10, inf) "b" (closed)',
    ]);
  });

  it("one write, a field item and an item on existence: keep_effective on existence leaves the f2 item open", () => {
    const ev = evaluateLog(STATE, [
      ...mixed,
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "keep_effective",
        candidates: [41],
        unit: "existence",
      },
    ]).final;
    expect(items(ev, 41)).toEqual([
      'f2/0 candidate [11-10, 11-20) "5"',
      'f3/0 candidate [11-10, inf) "b" (closed)',
    ]);
  });

  it("a group [f2, f3] where only f3 met a revoke: the whole unit is in the item on existence", () => {
    const grouped: TableSchema = { kind: "state", required: ["f2"], groups: [["f2", "f3"]] };
    const ev = evaluateLog(grouped, [...mixed, take(50, [41], "existence", 41)]).final;
    expect(items(ev, 51).map((x) => x.split(" ")[0])).toEqual(["f2/0", "f3/0"]);
    expect(items(ev, 51)).toEqual([
      'f2/0 applied [11-10, 11-20) "5" carried #41/f2/0',
      'f3/0 applied [11-10, inf) "b" carried #41/f3/0',
    ]);
    // f2 runs to #13's start at 11-20; inside #31's hole [11-25, 11-28) the required f2 has no
    // value, so the stretch stays without a value though f3 is taken there.
    expect(tl(ev)).toEqual([
      '[10-01, 11-10) "1"',
      '[11-10, 11-20) "5"',
      '[11-20, 11-25) "7"',
      '[11-28, inf) "7"',
    ]);
    expect(tl(ev, "f3")).toEqual(['[10-01, 11-10) "a"', '[11-10, 11-25) "b"', '[11-28, inf) "b"']);
  });
  it("existence item: the taken write deleted, a same-valued candidate takes over (state table)", () => {
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("11-01", "11-10"), { seen: 10, ...ack }),
      rv(30, "11-05", "11-08", "S3", 20),
      w(40, { f2: ["5", "S5"] }, g("11-01", "11-10"), { seen: 10 }),
      w(45, { f2: ["5", "S6"] }, g("11-01", "11-10"), { seen: 10 }),
      take(50, [41, 46], "existence", 41),
    ];
    const asWritten = evaluateLog(STATE, log).final;
    expect(tl(asWritten)).toEqual(['[10-01, 11-01) "1"', '[11-01, 11-10) "5"', '[11-10, inf) "1"']);
    const ev = evaluateLog(STATE, [...log, del(60, "pi_1", ["S5"])]).final;
    expect(tl(ev)).toEqual(['[10-01, 11-01) "1"', '[11-01, 11-10) "5"', '[11-10, inf) "1"']);
  });

  it("existence item: the taken write deleted, a same-valued candidate takes over (event table)", () => {
    const ew = (op: number, v: string, src: string, seen: number): WriteOp =>
      w(op, { f2: [v, src] }, undefined, { seen });
    const log: LogEntry[] = [
      ew(10, "1", "S1", 0),
      { kind: "revoke", op: 20, event: 21, seen: 10 },
      ew(30, "5", "S5", 10),
      ew(35, "5", "S6", 10),
      take(50, [31, 36], "existence", 31),
    ];
    const ev = evaluateLog({ kind: "event", required: ["f2"] }, [
      ...log,
      del(60, "pi_1", ["S5"]),
    ]).final;
    expect({ exists: ev.exists, f2: ev.fields["f2"]?.[0]?.value }).toEqual({
      exists: true,
      f2: "5",
    });
  });
  it("existence item in a replay: the take is not checked again for required fields in the hole", () => {
    // f2 and f3 required. #41 takes #31 (f2 5) on existence, carrying f3 from the merge base into
    // the hole [11-01, 11-10). Deleting S9 removes #11's f3: where the merge base has no f3 now,
    // nothing is carried and the stretch has no value; the take itself stays.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"], f3: ["a", "S9"] }, g("10-01", "11-05")),
      w(12, { f2: ["1", "S1b"], f3: ["b", "S8"] }, g("11-05", "open"), { seen: 10, ...ack }),
      rv(20, "11-01", "11-10", "S3", 12),
      w(30, { f2: ["5", "S5"] }, g("10-20", "11-20"), { seen: 12 }),
      take(40, [31], "existence", 31),
      del(50, "pi_1", ["S9"]),
    ];
    const ev = evaluateLog({ kind: "state", required: ["f2", "f3"] } as TableSchema, log).final;
    expect(tl(ev, "f2")).toEqual(['[11-05, 11-20) "5"', '[11-20, inf) "1"']);
    expect(tl(ev, "f3")).toEqual(['[11-05, inf) "b"']);
  });

  it("a write outside O under a later write in O does not cover the take", () => {
    // #16 (8) is a candidate against #13 when written; #21 (in O) writes 3 over it. Deleting S7
    // removes #13: #16 takes effect at 15, outside O, but #21 supersedes it, so it covers nothing.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(12, { f2: ["7", "S7"] }, g("11-10", "11-20"), { seen: 10, ...ack }),
      w(15, { f2: ["8", "S8"] }, g("11-12", "11-15"), { seen: 10 }),
      w(20, { f2: ["3", "S2"] }, g("11-01", "11-20"), { seen: 15, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("11-01", "next"), { seen: 12 }),
      take(40, [31], "f2", 31),
      del(50, "pi_1", ["S7"]),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual(['[10-01, 11-01) "1"', '[11-01, inf) "5"']);
  });

  it("existence item in a replay: a write outside O that a deletion puts in effect covers the take", () => {
    // #31 revokes [11-05, 11-08) (in O); #46 (9) is a candidate against #21 on [11-02, 11-04);
    // the take on existence writes 5 on [11-01, 11-10). Deleting S2 removes #21: #46 takes effect
    // at 45, outside O, and keeps 9 there.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("11-01", "11-10"), { seen: 10, ...ack }),
      rv(30, "11-05", "11-08", "S3", 20),
      w(40, { f2: ["5", "S5"] }, g("11-01", "11-10"), { seen: 10 }),
      w(45, { f2: ["9", "S9"] }, g("11-02", "11-04"), { seen: 10 }),
      take(50, [41], "existence", 41),
      del(60, "pi_1", ["S2"]),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual([
      '[10-01, 11-01) "1"',
      '[11-01, 11-02) "5"',
      '[11-02, 11-04) "9"',
      '[11-04, 11-10) "5"',
      '[11-10, inf) "1"',
    ]);
  });

  it("a field-group take into a hole is checked on the fields it writes", () => {
    // f2 and f3 required. #31 gives f2 only; taken on the unit [f2, f3] into the hole of #36,
    // where f3 has no value: rejected as on the unit f2.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
      rv(35, "11-01", "11-10", "S3", 34),
      take(40, [31], ["f2", "f3"], 31),
    ];
    expect(
      evaluateLog({ kind: "state", required: ["f2", "f3"] } as TableSchema, log).steps.at(-1),
    ).toMatchObject({
      refused: true,
      rejected: "missing_required",
    });
  });

  it("in a replay a revoke outside O that a deletion puts in effect covers a field take", () => {
    // #31 revokes [11-01, 11-10) with the version before #21: a candidate. #41 (5) is a candidate
    // against #21, taken on f2. Deleting S2 removes #21: the revoke takes effect at 30, before
    // the take, outside its cover set; it keeps its hole.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      rv(30, "11-01", "11-10", "S3", 10),
      w(40, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
      take(50, [41], "f2", 41),
      del(60, "pi_1", ["S2"]),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual(['[10-01, 11-01) "5"', '[11-10, inf) "5"']);
  });

  it("a revoke in effect when the take was judged stays filled: a deletion of another field leaves f2 as it was", () => {
    // #21 revokes [11-01, 11-10), after the merge base 10, in effect when #41 takes #36 (6 from
    // 10-01 on): the take fills the hole (deviation (2) when judged). Deleting S9 removes only
    // #39's f3; in that replay #21 is still the revoke the take filled, and covers nothing.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(15, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      rv(20, "11-01", "11-10", "S3", 15),
      w(25, { f2: ["4", "S4"] }, g("10-01", "10-20"), { seen: 20, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "10-20"), { seen: 10 }),
      w(35, { f2: ["6", "S6"] }, g("10-01", "open"), { seen: 20 }),
      w(38, { f3: ["x", "S9"] }, g("10-01", "open"), { seen: 35, ...ack }),
      take(40, [31, 36], "f2", 36),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual(['[10-01, inf) "6"']);
    expect(tl(evaluateLog(STATE, [...log, del(50, "pi_9", ["S9"])]).final)).toEqual([
      '[10-01, inf) "6"',
    ]);
  });

  it("a write outside O under a later write in O does not cover the take: a deletion of another field", () => {
    // As above, #26 over [10-01, ∞): it writes 4 over #21's hole, so #21, outside O, is
    // superseded by #26 in O and covers nothing; the take does not uncover #26's 4 there.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(15, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      rv(20, "11-01", "11-10", "S3", 15),
      w(25, { f2: ["4", "S4"] }, g("10-01", "open"), { seen: 20, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "10-20"), { seen: 10 }),
      w(35, { f2: ["6", "S6"] }, g("10-01", "open"), { seen: 20 }),
      w(38, { f3: ["x", "S9"] }, g("10-01", "open"), { seen: 35, ...ack }),
      take(40, [31, 36], "f2", 36),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual(['[10-01, inf) "6"']);
    expect(tl(evaluateLog(STATE, [...log, del(50, "pi_9", ["S9"])]).final)).toEqual([
      '[10-01, inf) "6"',
    ]);
  });

  it("a take made over a revoke a deletion put in effect: another deletion, a cancellation and the deletion again leave f2 as taken", () => {
    // #21 revokes [11-01, 11-10) with the version before #16: a candidate. Deleting S2 removes
    // #16, so #21 takes effect; the user takes #36 seeing it, filling the hole. Then another
    // field's source is deleted, the first deletion cancelled, and S2 deleted again: #21 is in
    // effect again, the revoke the take filled; f2 is as when the take was made.
    const pre: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(15, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      rv(20, "11-01", "11-10", "S3", 10),
      w(25, { f2: ["4", "S4"] }, g("10-01", "10-20"), { seen: 20, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "10-20"), { seen: 10 }),
      w(35, { f2: ["6", "S6"] }, g("10-01", "open"), { seen: 20 }),
      w(38, { f3: ["x", "S9"] }, g("10-01", "open"), { seen: 35, ...ack }),
      del(40, "pi_1", ["S2"]),
      take(45, [31, 36], "f2", 36),
    ];
    const taken = evaluateLog(STATE, pre, ALLOWED).final;
    expect(tl(taken)).toEqual(['[10-01, inf) "6"']);
    expect(items(taken, 21)).toEqual(["existence/0 applied [11-01, 11-10) revoke"]);
    const ev = evaluateLog(
      STATE,
      [...pre, del(50, "pi_9", ["S9"]), cancel(55, "pi_1"), del(60, "pi_3", ["S2"])],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "6"']);
    expect(items(ev, 21)).toEqual(["existence/0 applied [11-01, 11-10) revoke"]);
  });

  it("a filled revoke a deletion lengthens covers the take nowhere", () => {
    // #21 revokes from 11-01 to the next change, #13's start at 11-10: the take of #36 fills it.
    // Deleting S7 removes #13: #21 runs on to ∞. A revoke the take filled covers it nowhere,
    // whatever its interval in the replay (03-deletion «搬运的值»): judged by the whole revoke, not
    // by an interval whose end may come only from deleted content. The take stays 6 to ∞.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(12, { f2: ["7", "S7"] }, g("11-10", "open"), { seen: 10, ...ack }),
      rv(20, "11-01", "next", "S3", 12),
      w(25, { f2: ["4", "S4"] }, g("10-01", "10-20"), { seen: 20, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "10-20"), { seen: 10 }),
      w(35, { f2: ["6", "S6"] }, g("10-01", "open"), { seen: 20 }),
      take(40, [31, 36], "f2", 36),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual(['[10-01, inf) "6"']);
    const ev = evaluateLog(STATE, [...log, del(50, "pi_7", ["S7"])]).final;
    expect(items(ev, 21)).toEqual(["existence/0 applied [11-01, inf) revoke"]);
    expect(tl(ev)).toEqual(['[10-01, inf) "6"']);
  });

  it("existence item in a replay: a write outside O that a deletion puts in effect covers a taken revoke", () => {
    // #31 revokes [11-01, 11-10) with the version before #21: a candidate on existence. #46 (9 on
    // [11-02, 11-04)) is a candidate against #21 in the f2 item, outside O. The take of #31 writes
    // the revoke. Deleting S2 removes #21: #46 takes effect at 45 and keeps 9 under the take.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("11-01", "11-10"), { seen: 10, ...ack }),
      rv(30, "11-01", "11-10", "S3", 10),
      w(45, { f2: ["9", "S9"] }, g("11-02", "11-04"), { seen: 10 }),
      take(50, [31], "existence", 31),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual(['[10-01, 11-01) "1"', '[11-10, inf) "1"']);
    expect(tl(evaluateLog(STATE, [...log, del(60, "pi_1", ["S2"])]).final)).toEqual([
      '[10-01, 11-01) "1"',
      '[11-02, 11-04) "9"',
      '[11-10, inf) "1"',
    ]);
  });

  it("a write outside O a deletion extends into the take, taken back by an earlier undo: its write-back covers", () => {
    // #16 (8 from 10-20 to the next change, #13's start at 11-05) is in effect when the take is
    // judged but outside its range, so not in O; #19 undoes it. Deleting S7 removes #13: #16 runs
    // on over the take's range, registered as taken back there too (an undo's range is found
    // again in a replay), so it gives nothing; #19's write-back of 1, outside O as well, covers
    // the take where no later write in O (#21) supersedes it.
    const log: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(12, { f2: ["7", "S7"] }, g("11-05", "open"), { seen: 10, ...ack }),
      w(15, { f2: ["8", "S8"] }, g("10-20", "next"), { seen: 12, ...ack }),
      { kind: "undo", op: 18, event: 19, target: 15, seen: 15, ...ack },
      w(20, { f2: ["3", "S2"] }, g("11-06", "11-08"), { seen: 18, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("11-05", "11-10"), { seen: 12 }),
      take(40, [31], "f2", 31),
    ];
    expect(tl(evaluateLog(STATE, log).final)).toEqual([
      '[10-01, 11-05) "1"',
      '[11-05, 11-10) "5"',
      '[11-10, inf) "7"',
    ]);
    const ev = evaluateLog(STATE, [...log, del(50, "pi_7", ["S7"])]).final;
    expect(ev.items.find((x) => x.event === 16)?.registrations).toEqual([
      { byOp: 18, valid: [{ from: d("10-20"), to: null }] },
    ]);
    expect(tl(ev)).toEqual(['[10-01, 11-06) "1"', '[11-06, 11-08) "5"', '[11-08, inf) "1"']);
  });

  // #21 awaits confirmation when written (it erases the change points it saw; #16 is only a
  // candidate). Deleting S6 removes #14: #16 takes effect after #21's version, so #21 conflicts
  // with it, a candidate in a successor item, which the user resolves by taking #21.
  const turned: LogEntry[] = [
    w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
    w(12, { f2: ["7", "S7"] }, g("11-01", "open"), { seen: 10, ...ack }),
    w(13, { f2: ["6", "S6"] }, g("10-01", "10-15"), { seen: 12, ...ack }),
    w(15, { f2: ["9", "S9"] }, g("10-01", "10-15"), { seen: 12 }),
    w(20, { f2: ["3", "S3"] }, g("10-01", "open"), { seen: 14 }),
    del(30, "pi_6", ["S6"]),
    take(40, [21], "f2", 21),
  ];

  it("a write awaiting when written that a deletion made a candidate is in K of its successor item", () => {
    expect(items(evaluateLog(STATE, turned.slice(0, 5), ALLOWED).final, 21)).toEqual([
      'f2/0 awaiting [10-01, inf) "3"',
    ]);
    const ev = evaluateLog(STATE, turned, ALLOWED);
    expect(ev.steps.some((x) => x.refused)).toBe(false);
    expect(items(ev.final, 41)).toEqual(['f2/0 applied [10-01, inf) "3" carried #21/f2/0']);
    expect(tl(ev.final)).toEqual(['[10-01, inf) "3"']);
  });

  it("... and when that deletion is cancelled, the take made in its grace period stays in effect", () => {
    const ev = evaluateLog(STATE, [...turned, cancel(50, "pi_6")], ALLOWED).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "3"']);
    expect(items(ev, 21).some((x) => x.includes("awaiting"))).toBe(false);
  });

  // Second review (!199 note 6924): each log as given, red on 604db6e before its fix.
  const res = (
    op: number,
    decision: "keep_effective" | "take_previous",
    candidates: number[],
    unit: FieldId | FieldId[] | "existence",
  ): LogEntry => ({ kind: "resolve", op, event: op + 1, decision, candidates, unit });

  it("R2-3a a put-back candidate a grace-period take listed by event gives no value nobody decided", () => {
    const G: TableSchema = {
      kind: "state",
      required: ["f2"],
      groups: [["f2" as FieldId, "f3" as FieldId]],
    };
    const run = evaluateLog(G, [
      w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"], f3: ["b", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      w(30, { f2: ["3", "SX"], f3: ["c", "SY"] }, g("11-01", "11-10"), {
        seen: 10,
        validSources: ["SV"],
      }),
      w(40, { f2: ["4", "S4"] }, g("11-01", "11-10"), { seen: 10 }),
      del(50, "pi_1", ["SX"]),
      take(60, [31, 41], ["f2" as FieldId, "f3" as FieldId], 31),
      cancel(70, "pi_1"),
    ]);
    expect(tl(run.final)).toEqual(['[10-01, inf) "2"']);
    expect(items(run.final, 31).filter((x) => x.startsWith("f2/"))).toEqual([
      'f2/0 candidate [11-01, 11-10) "3"',
    ]);
  });

  it("R2-3b ... with keep_effective, the put-back candidate judged a candidate is open", () => {
    const G: TableSchema = {
      kind: "state",
      required: ["f2"],
      groups: [["f2" as FieldId, "f3" as FieldId]],
    };
    const run = evaluateLog(
      G,
      [
        w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open")),
        w(20, { f2: ["2", "S2"], f3: ["b", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
        w(30, { f2: ["3", "SX"], f3: ["c", "SY"] }, g("11-01", "11-10"), {
          seen: 10,
          validSources: ["SV"],
        }),
        w(40, { f2: ["4", "S4"] }, g("11-01", "11-10"), { seen: 10 }),
        del(50, "pi_1", ["SX"]),
        res(60, "keep_effective", [31, 41], ["f2" as FieldId, "f3" as FieldId]),
        cancel(70, "pi_1"),
      ],
      ALLOWED,
    );
    const put = run.steps.at(-1)?.putBack ?? [];
    if (put.some((x) => x.judged === "candidate")) {
      expect(items(run.final, 31).filter((x) => x.startsWith("f2/"))).toEqual([
        'f2/0 candidate [11-01, 11-10) "3"',
      ]);
    } else expect(put).toEqual([{ event: 31, target: "f2", judged: "candidate" }]);
  });

  it("R2-4 a taken revoke is not checked again in a replay: as the same revoke written in effect", () => {
    const head = (revoke: LogEntry[]): LogEntry[] => [
      w(10, { f2: ["1", "S10"], f3: ["a", "S11"] }, g("10-01", "open"), { validSources: ["SV"] }),
      w(12, { f3: ["b", "S13"] }, g("10-12", "open"), { seen: 10, ...ack }),
      ...revoke,
      w(40, { f2: ["5", "S40"] }, g("10-10", "10-15"), { seen: 30, ...ack }),
      del(50, "pi", ["S10"]),
    ];
    const taken = evaluateLog(
      STATE,
      head([rv(20, "10-10", "10-15", "R20", 10), take(30, [21], "existence", 21)]),
    ).final;
    const direct = evaluateLog(STATE, head([rv(20, "10-10", "10-15", "R20", 12)])).final;
    expect(tl(taken, "f3")).toEqual(tl(direct, "f3"));
    expect(tl(taken)).toEqual(['[10-10, 10-15) "5"']);
    expect(tl(taken, "f3")).toEqual(["[10-10, 10-15) null"]);
    expect(items(taken, 31)).toEqual(["existence/0 applied [10-10, 10-15) revoke"]);
  });

  it("R2-9b a put-back candidate is not in K of a take on existence made before the cancellation", () => {
    const ev = evaluateLog(
      STATE,
      [
        w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open")),
        rv(20, "11-25", "11-28", "SR", 10),
        w(30, { f2: ["3", "SX"], f3: ["c", "SY"] }, g("11-20", "open"), {
          seen: 10,
          validSources: ["SV"],
        }),
        w(40, { f2: ["4", "S4"] }, g("11-20", "open"), { seen: 10 }),
        del(50, "pi_1", ["SX"]),
        take(60, [31, 41], "existence", 31),
        cancel(70, "pi_1"),
      ],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "1"']);
  });
  it("R2-1a a take of a write awaiting when written stays after the deletion that made it a candidate is cancelled", () => {
    const ev = evaluateLog(
      STATE,
      [
        w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
        w(12, { f2: ["7", "S7"] }, g("11-01", "open"), { seen: 10, ...ack }),
        w(14, { f2: ["4", "S4"] }, g("10-01", "10-15"), { seen: 12, ...ack }),
        w(16, { f2: ["3", "S6"] }, g("10-01", "10-15"), { seen: 14, ...ack }),
        w(20, { f2: ["3", "S3"] }, g("10-01", "open"), { seen: 12 }),
        del(30, "pi_6", ["S6"]),
        take(40, [21], "f2", 21),
        cancel(50, "pi_6"),
      ],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "3"']);
    expect(items(ev, 21).some((x) => x.includes("awaiting"))).toBe(false);
  });

  it("R2-1b ... and after another deletion removes the write that made it a candidate", () => {
    const ev = evaluateLog(STATE, [...turned, del(50, "pi_9", ["S9"])], ALLOWED).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "3"']);
    expect(items(ev, 21).some((x) => x.includes("awaiting"))).toBe(false);
    const kept = evaluateLog(
      STATE,
      [...turned.slice(0, 6), res(40, "keep_effective", [21], "f2"), del(50, "pi_9", ["S9"])],
      ALLOWED,
    ).final;
    expect(items(kept, 21).some((x) => x.includes("awaiting"))).toBe(false);
  });

  it("R2-1c a take_previous of such an item: what it took back stays taken back after the cancellation", () => {
    const ev = evaluateLog(
      STATE,
      [...turned.slice(0, 6), res(40, "take_previous", [21], "f2"), cancel(50, "pi_6")],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, 10-15) "6"', '[10-15, 11-01) "1"', '[11-01, inf) "7"']);
    expect(items(ev, 21)).toEqual(['f2/0 candidate [10-01, inf) "3" (closed)']);
    expect(items(ev, 41)).toEqual(['f2/0 applied [10-01, 10-15) "6" carried #14/f2/0']);
  });
  // The confirmation side (second review, item 1): #21 is a candidate against #15 when written;
  // deleting SC removes #15, and #21, which erases the change point it saw, awaits confirmation.
  const toAwait: LogEntry[] = [
    w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
    w(12, { f2: ["7", "S7"] }, g("11-01", "open"), { seen: 10, ...ack }),
    w(14, { f2: ["6", "SC"] }, g("10-01", "10-15"), { seen: 12, ...ack }),
    w(20, { f2: ["3", "S3"] }, g("10-01", "open"), { seen: 12 }),
    del(30, "pi", ["SC"]),
  ];
  const decide = (kind: "confirm" | "reject"): LogEntry => ({
    kind,
    op: 40,
    event: 41,
    target: 21,
  });

  it("R2-1d a confirmation of a write a deletion made awaiting stays after that deletion is cancelled", () => {
    const ev = evaluateLog(STATE, [...toAwait, decide("confirm"), cancel(50, "pi")], ALLOWED).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "3"']);
    expect(items(ev, 41)).toEqual(['f2/0 applied [10-01, inf) "3" carried #21/f2/0']);
    expect(items(ev, 21)).toEqual(['f2/0 awaiting [10-01, inf) "3" (closed)']);
  });

  it("R2-1e ... and after another deletion", () => {
    const ev = evaluateLog(
      STATE,
      [...toAwait, decide("confirm"), del(50, "pi_7", ["S7"])],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "3"']);
    expect(items(ev, 21)).toEqual(['f2/0 awaiting [10-01, inf) "3" (closed)']);
  });

  it("R2-1f a rejection of such a write stays: not in effect, not reopened as a candidate", () => {
    for (const tail of [[cancel(50, "pi")], [del(50, "pi_7", ["S7"])]]) {
      const ev = evaluateLog(STATE, [...toAwait, decide("reject"), ...tail], ALLOWED).final;
      expect(items(ev, 21)).toEqual(['f2/0 awaiting [10-01, inf) "3" (closed)']);
      expect(tl(ev).some((x) => x.endsWith('"3"'))).toBe(false);
    }
  });
  it("R2-2 a take in the grace period: the revoke the cancelled deletion brings back does not cover it", () => {
    const ev = evaluateLog(
      STATE,
      [
        w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
        w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
        w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
        rv(40, "11-01", "11-10", "SR", 30),
        del(50, "pi", ["SR"]),
        take(60, [31], "f2", 31),
        cancel(70, "pi"),
      ],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "5"']);
  });

  // Second review, item 2: what a deletion pending when a take is judged removed, back after the

  const graceTake = (vSeen: number): LogEntry[] => [
    w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
    w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
    w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
    w(40, { f2: ["9", "S9"] }, g("11-01", "11-10"), { seen: vSeen, ...(vSeen === 30 ? ack : {}) }),
    del(50, "pi", ["S9"]),
    take(60, [31], "f2", 31),
  ];

  it("R2-2b a value a pending deletion removed, back after the cancellation, does not cover the take", () => {
    expect(tl(evaluateLog(STATE, [...graceTake(30), cancel(70, "pi")], ALLOWED).final)).toEqual([
      '[10-01, inf) "5"',
    ]);
  });

  it("R2-2c ... unless it is back not in effect and takes effect through another deletion", () => {
    // #41 erases #26's change point at 11-05: awaiting when written, so no candidate of #31's
    // item and not put back. Deleting S4 removes #26: #41 takes effect at 40 and covers the take.
    const ev = evaluateLog(
      STATE,
      [
        w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
        w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
        w(25, { f2: ["4", "S4"] }, g("11-05", "open"), { seen: 20, ...ack }),
        w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
        w(40, { f2: ["9", "S9"] }, g("11-01", "11-10"), { seen: 30 }),
        del(50, "pi", ["S9"]),
        take(60, [31], "f2", 31),
        cancel(70, "pi"),
        del(80, "pi_4", ["S4"]),
      ],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, 11-01) "5"', '[11-01, 11-10) "9"', '[11-10, inf) "5"']);
  });

  it("R2-2d ... and with the deletion not cancelled nothing comes back", () => {
    expect(tl(evaluateLog(STATE, graceTake(30), ALLOWED).final)).toEqual(['[10-01, inf) "5"']);
  });

  it("R2-2e on existence: a value a pending deletion removed, back after the cancellation, does not cover the taken revoke", () => {
    const ev = evaluateLog(
      STATE,
      [
        w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
        w(20, { f2: ["2", "S2"] }, g("11-01", "11-10"), { seen: 10, ...ack }),
        rv(30, "11-01", "11-10", "S3", 10),
        w(40, { f2: ["9", "S9"] }, g("11-02", "11-04"), { seen: 30, ...ack }),
        del(50, "pi", ["S9"]),
        take(60, [31], "existence", 31),
        cancel(70, "pi"),
      ],
      ALLOWED,
    ).final;
    expect(tl(ev)).toEqual(['[10-01, 11-01) "1"', '[11-10, inf) "1"']);
  });
  it("R2-5 event table: a field write outside O does not cover a taken revoke", () => {
    const E: TableSchema = { kind: "event", required: ["f2"] };
    const ew = (op: number, v: string, src: string, seen: number, extra: object = {}): WriteOp =>
      ({
        kind: "write",
        op,
        event: op + 1,
        seen,
        fields: { f2: { value: v, sources: [src] } },
        ...extra,
      }) as WriteOp;
    const ev = evaluateLog(E, [
      ew(10, "1", "S1", 0),
      ew(20, "2", "S2", 10, ack),
      { kind: "revoke", op: 30, event: 31, seen: 10 },
      ew(40, "5", "S5", 10),
      take(50, [31], "existence", 31),
      del(60, "pi", ["S2"]),
    ]).final;
    // The row stays revoked; #41's 5 stays on the field, under the revoke.
    expect(ev.exists).toBe(false);
    expect(items(ev, 51)).toEqual(["existence/0 applied [-inf, inf) revoke"]);
    expect(items(ev, 41)).toEqual(['f2/0 applied [-inf, inf) "5"']);
  });
  it("R2-6 the revokes a take filled are those over the taken items' range, not the whole K", () => {
    const log = (other: boolean): LogEntry[] => [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(12, { f2: ["7", "S7"] }, g("10-10", "10-12"), { seen: 10, ...ack }),
      w(14, { f2: ["2", "S2"] }, g("10-02", "10-04"), { seen: 12, ...ack }),
      ...(other ? [w(16, { f2: ["8", "S8"] }, g("10-02", "10-25"), { seen: 12 })] : []),
      rv(18, "10-20", "10-30", "SR", 16),
      w(20, { f2: ["5", "S5"] }, g("10-02", "next"), { seen: 12 }),
      take(22, other ? [17, 21] : [21], "f2", 21),
      del(30, "pi_7", ["S7"]),
    ];
    const ev = evaluateLog(STATE, log(true)).final;
    expect(tl(ev)).toEqual(tl(evaluateLog(STATE, log(false)).final));
    expect(tl(ev)).toEqual(['[10-01, 10-02) "1"', '[10-02, 10-20) "5"', '[10-30, inf) "5"']);
    expect(items(ev, 19)).toEqual(["existence/0 applied [10-20, 10-30) revoke"]);
    expect(items(ev, 23)).toEqual([
      'f2/0 applied [10-02, 10-20) "5" carried #21/f2/0',
      'f2/1 applied [10-30, inf) "5" carried #21/f2/0',
    ]);
  });
  it("R2-7 a revoke at or before the merge base that a deletion puts in effect does not cover the take", () => {
    // Beside "in a replay a revoke outside O that a deletion puts in effect covers a field take",
    // where the revoke comes after the merge base: here #21 revokes at 20 and the candidate #41
    // carries version 20, the merge base. #21 is under the version the taken write saw, which its
    // value covers: it does not cover the take.
    const ev = evaluateLog(STATE, [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(12, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      rv(20, "11-01", "11-10", "SR", 10),
      w(30, { f2: ["3", "S3"] }, g("10-01", "open"), { seen: 20, ...ack }),
      w(40, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 20 }),
      take(50, [41], "f2", 41),
      del(60, "pi", ["S2"]),
    ]).final;
    expect(items(ev, 21)).toEqual(["existence/0 applied [11-01, 11-10) revoke"]);
    expect(tl(ev)).toEqual(['[10-01, inf) "5"']);
  });
  const undo = (op: number, target: number, extra: object = {}): LogEntry =>
    ({ kind: "undo", op, event: op + 1, target, ...extra }) as LogEntry;

  const valueOn = (ev: Evaluation, from: string, to: string, f: FieldId = "f2") =>
    (ev.fields[f] ?? []).find((x) => covers(x.valid, { from: d(from), to: d(to) } as Iv))?.value;

  it("R2-9a a write outside O registered as taken back does not cover the take", () => {
    const ev = evaluateLog(STATE, [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(12, { f2: ["2", "S2"] }, g("10-01", "10-03"), { seen: 10, ...ack }),
      w(14, { f2: ["8", "S8"] }, g("10-01", "10-03"), { seen: 10 }),
      rv(16, "10-10", "10-20", "SR", 14),
      undo(18, 16, { seen: 16, ...ack }),
      w(20, { f2: ["3", "S3"] }, g("10-05", "10-08"), { seen: 18, ...ack }),
      w(22, { f2: ["5", "S5"] }, g("10-05", "open"), { seen: 18 }),
      take(24, [15, 23], "f2", 23),
      del(30, "pi", ["S_NONE"]),
    ]).final;
    expect(valueOn(ev, "10-10", "10-20")).toBe("5");
    expect(tl(ev)).toEqual(['[10-01, 10-03) "2"', '[10-03, 10-05) "1"', '[10-05, inf) "5"']);
    expect(items(ev, 25)).toEqual(['f2/0 applied [10-05, inf) "5" carried #23/f2/0']);
  });
  it("R2-2f event table: a write a pending deletion put out of effect indirectly, back after the cancellation, does not cover the take", () => {
    // #41 (1, S1, no evidence pointed at) is in effect when written; deleting S4 removes #31, so
    // #41 is the same as its seen version, a no-op, out of effect though its own source is not
    // deleted. #21 (5) is taken in that grace period; cancelling the deletion brings #41 back in
    // effect, outside O: it does not cover the take.
    const E: TableSchema = { kind: "event", required: ["f2"] };
    const ew = (op: number, v: string, src: string, seen: number, extra: object = {}): WriteOp =>
      ({
        kind: "write",
        op,
        event: op + 1,
        seen,
        fields: { f2: { value: v, sources: [src], ...extra } },
      }) as WriteOp;
    const ev = evaluateLog(
      E,
      [
        { ...ew(10, "1", "S1", 0), acknowledge: ["overwrite"] } as WriteOp,
        ew(20, "5", "S2", 0),
        ew(30, "3", "S4", 20),
        ew(40, "1", "S1", 30),
        del(50, "pi_50", ["S4"]),
        take(60, [21], "f2", 21),
        cancel(70, "pi_50"),
      ],
      ALLOWED,
    ).final;
    expect(ev.fields["f2"]?.[0]?.by?.event).toBe(61);
  });

  // A field group (09-references-conflict-sync «冲突单元», «组值»): conflicts are judged by the
  // unit, as the kernel judges them (conflict criterion ⑤).
  const G73: TableSchema = { kind: "state", required: ["f2", "f3"], groups: [["f2", "f3"]] };
  const log73: LogEntry[] = [
    w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open"), { seen: 0 }),
    w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
    w(30, { f2: ["5", "S5"], f3: ["c", "S5"] }, g("10-01", "open"), { seen: 10 }),
    rv(35, "11-01", "11-10", "S3", 34),
  ];

  it("a group write meeting a change on f2 only: f3 is a candidate too, as in the kernel", () => {
    const ev = evaluateLog(G73, [...log73, take(40, [31], ["f2", "f3"], 31)]).final;
    // As the kernel: 31/f3 a closed candidate too, 41/f3 "c", O = [21/f2].
    expect(items(ev, 31)).toEqual([
      'f2/0 candidate [10-01, inf) "5" (closed)',
      'f3/0 candidate [10-01, inf) "c" (closed)',
    ]);
    expect(items(ev, 41)).toEqual([
      'f2/0 applied [10-01, inf) "5" carried #31/f2/0',
      'f3/0 applied [10-01, inf) "c" carried #31/f3/0',
    ]);
    expect(ev.takeCandidates).toEqual([
      {
        op: 40,
        mergeBase: 10,
        cover: [{ event: 21, target: "f2" }],
      },
    ]);
  });

  it("a write giving f3 only in a group: a candidate (the unit met #21's change on f2), as in the kernel", () => {
    const ev = evaluateLog({ kind: "state", required: ["f2"], groups: [["f2", "f3"]] }, [
      w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open"), { seen: 0 }),
      w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      w(30, { f3: ["c", "S5"] }, g("10-01", "open"), { seen: 10 }),
    ]).final;
    // As the kernel: a candidate (the unit [f2, f3] met #21's change).
    expect(items(ev, 31)).toEqual(['f3/0 candidate [10-01, inf) "c"']);
  });

  // Third review (!199 note 7398): each log as given, red on 7dd461c before its fix.
  const decide3 = (kind: "confirm" | "reject", op: number, target: number): LogEntry => ({
    kind,
    op,
    event: op + 1,
    target,
  });

  // #61 awaits confirmation when written (it erases #31's and #51's change points it saw at 45);
  // deleting S5 removes #31: #61 meets the revoke #51, a candidate in the item on existence,
  // which the user resolves by taking #61.
  const awaitingTaken: LogEntry[] = [
    w(10, { f2: ["3", "S1"] }, g("10-01", "open"), { seen: 0, ...ack }),
    rv(30, "11-07", "11-09", "S5", 30),
    rv(50, "11-07", "11-09", "S3", 30),
    w(60, { f2: ["2", "S3"] }, g("11-05", "open"), { seen: 45, ...ack }),
    del(1000, "pi_0", ["S5"]),
    take(1100, [61], "existence", 61),
  ];

  it("R3-1 a take on existence of a write awaiting when written stays through any later replay", () => {
    const tails: [string, LogEntry[]][] = [
      ["as judged", []],
      ["an unrelated deletion", [del(1200, "pi_x", ["S_NONE"])]],
      ["the deletion cancelled", [cancel(1200, "pi_0")]],
    ];
    for (const [label, tail] of tails) {
      const ev = evaluateLog(STATE, [...awaitingTaken, ...tail], ALLOWED).final;
      expect(tl(ev), label).toEqual(['[10-01, 11-05) "3"', '[11-05, inf) "2"']);
      expect(items(ev, 1101), label).toEqual(['f2/0 applied [11-05, inf) "2" carried #61/f2/0']);
    }
  });

  it("R3-2 a taken revoke that wrote nothing where there was no value is carried out once the gap is gone", () => {
    const head = (revoke: LogEntry[]): LogEntry[] => [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      rv(20, "11-01", "11-10", "SA", 10),
      ...revoke,
      del(50, "pi", ["SA"]),
    ];
    const taken = evaluateLog(
      STATE,
      head([rv(30, "11-01", "11-10", "SC", 10), take(40, [31], "existence", 31)]),
    ).final;
    const direct = evaluateLog(STATE, head([rv(30, "11-01", "11-10", "SC", 20)])).final;
    expect(tl(taken)).toEqual(['[10-01, 11-01) "1"', '[11-10, inf) "1"']);
    expect(short(taken.gaps.map((x) => `[${x.from ?? "-inf"}, ${x.to ?? "inf"})`))).toEqual([
      "[-inf, 10-01)",
      "[11-01, 11-10)",
    ]);
    expect(tl(taken)).toEqual(tl(direct));
    expect(items(taken, 41)).toEqual(["existence/0 applied [11-01, 11-10) revoke"]);
    // When judged, where there is already no value, it writes its item too.
    const judged = evaluateLog(
      STATE,
      head([])
        .slice(0, 2)
        .concat([rv(30, "11-01", "11-10", "SC", 10), take(40, [31], "existence", 31)]),
    ).final;
    expect(items(judged, 41)).toEqual(["existence/0 applied [11-01, 11-10) revoke"]);
  });

  // #21 awaits on f2 (it erases #13's change point it saw) and is a candidate on f3 (#15 changed
  // f3 after the version it saw). Deleting SB removes #15: f3's conflict is gone.
  const confirmedThenFreed = (kind: "confirm" | "reject"): LogEntry[] => [
    w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, g("10-01", "open")),
    w(12, { f2: ["7", "S7"] }, g("11-01", "open"), { seen: 10, ...ack }),
    w(14, { f3: ["b", "SB"] }, g("10-01", "open"), { seen: 12, ...ack }),
    w(20, { f2: ["3", "S3"], f3: ["c", "S3"] }, g("10-01", "open"), { seen: 12 }),
    decide3(kind, 30, 21),
    del(40, "pi", ["SB"]),
  ];

  it("R3-3 a confirmed write: a target in a conflict item at the confirmation takes effect once the conflict is gone", () => {
    // Before the deletion: the confirmation carries out f2 only; f3 stays an open candidate (a
    // confirmation resolves no conflict).
    const before = evaluateLog(STATE, confirmedThenFreed("confirm").slice(0, -1)).final;
    expect(tl(before, "f3")).toEqual(['[10-01, inf) "b"']);
    expect(items(before, 21).filter((x) => x.startsWith("f3/"))).toEqual([
      'f3/0 candidate [10-01, inf) "c"',
    ]);
    expect(items(before, 31)).toEqual(['f2/0 applied [10-01, inf) "3" carried #21/f2/0']);
    const ev = evaluateLog(STATE, confirmedThenFreed("confirm")).final;
    expect(tl(ev, "f3")).toEqual(['[10-01, inf) "c"']);
    expect(items(ev, 31).filter((x) => x.startsWith("f3/"))).toEqual([
      'f3/0 applied [10-01, inf) "c" carried #21/f3/0',
    ]);
  });

  it("R3-3b ... and a rejected one: not in effect, closed", () => {
    const ev = evaluateLog(STATE, confirmedThenFreed("reject")).final;
    expect(tl(ev, "f3")).toEqual(['[10-01, inf) "a"']);
    expect(items(ev, 21).filter((x) => x.startsWith("f3/"))).toEqual([
      'f3/0 awaiting [10-01, inf) "c" (closed)',
    ]);
  });

  // Fourth review, item 5: a taken revoke is an item in effect after #21, not in the undo's
  // record: it supersedes #21. On an event table an item is whole, so the undo of #21 has an
  // empty range while the take's revoke covers it: the row stays revoked.
  const revokeAll = (op: number, seen: number): LogEntry =>
    ({ kind: "revoke", op, event: op + 1, seen }) as LogEntry;

  // #24, the take of the revoke candidate #14, writes a revoke over #21's: undoing #20
  // while #24 covers it takes back nothing and the row stays revoked (`revoked`); undoing #23, the
  // revoke in effect now, is accepted though #21 keeps the row revoked, and registers #24, so #20
  // can be undone in turn. Either order ends with the row existing.
  const takenOverRevoke = (kind: "event" | "timeless"): [TableSchema, LogEntry[]] => [
    { kind, required: ["f2"] },
    [
      w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, undefined, { seen: 0 }),
      revokeAll(13, 2),
      revokeAll(20, 10),
      take(23, [14], "existence", 14),
    ],
  ];
  const revertsOf = (ev: Evaluation) => ev.reverts.map((x) => [x.op, x.status, x.reason ?? null]);

  for (const kind of ["event", "timeless"] as const) {
    it(`R4-5 ${kind} table: undo the revoke a take covers (revoked), the take (accepted), then the revoke`, () => {
      const [schema, log] = takenOverRevoke(kind);
      const first = evaluateLog(schema, [...log, undo(30, 20)]).final;
      expect(revertsOf(first)).toEqual([[30, "rejected", "revoked"]]);
      expect(first.exists).toBe(false);
      const second = evaluateLog(schema, [...log, undo(30, 20), undo(40, 23)]).final;
      expect(revertsOf(second)).toEqual([
        [30, "rejected", "revoked"],
        [40, "applied", null],
      ]);
      expect(second.exists).toBe(false);
      const full = [...log, undo(30, 20), undo(40, 23), undo(50, 20)];
      const third = evaluateLog(schema, full).final;
      expect(revertsOf(third).at(-1)).toEqual([50, "applied", null]);
      expect(third.exists).toBe(true);
      // A replay (an unrelated deletion) gives the same.
      const replayed = evaluateLog(schema, [...full, del(60, "pi_x", ["S_NONE"])]).final;
      expect(revertsOf(replayed)).toEqual(revertsOf(third));
      expect(stateWithoutIndices(replayed)).toEqual(stateWithoutIndices(third));
    });

    it(`R4-5 ${kind} table: undo the take first, then the revoke: the row exists`, () => {
      const [schema, log] = takenOverRevoke(kind);
      const ev = evaluateLog(schema, [...log, undo(30, 23), undo(40, 20)]).final;
      expect(revertsOf(ev)).toEqual([
        [30, "applied", null],
        [40, "applied", null],
      ]);
      expect(ev.exists).toBe(true);
    });
  }

  it("R4-5 event table: an undo of the revoke in effect now with include_later is not refused", () => {
    // The target's own item is the revoke in effect: include_later does not change that.
    const [schema, log] = takenOverRevoke("event");
    const ev = evaluateLog(schema, [...log, undo(30, 23, { includeLater: true })]).final;
    expect(ev.reverts.at(-1)?.status).not.toBe("rejected");
  });

  it("R4-5 event table: a revoke written directly on a revoked row is a no-op, so no second revoke is in effect", () => {
    const ev = evaluateLog({ kind: "event", required: ["f2"] }, [
      w(10, { f2: ["1", "S1"], f3: ["a", "S1"] }, undefined, { seen: 0 }),
      revokeAll(20, 10),
      revokeAll(30, 20),
    ]).final;
    expect(items(ev, 31)).toEqual([]);
  });

  it("R4-5c event table: after undoing the undo of a revoke, undoing that or the revoke brings the row back", () => {
    const base: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, undefined, { seen: 0 }),
      revokeAll(20, 10),
      undo(30, 20),
      undo(40, 30),
    ];
    const ev = evaluateLog({ kind: "event", required: ["f2"] }, base).final;
    expect(ev.exists).toBe(false);
    for (const [target, status, exists] of [
      [40, "applied", true],
      [30, "rejected", false],
      [20, "applied", true],
    ] as const) {
      const after = evaluateLog({ kind: "event", required: ["f2"] }, [
        ...base,
        undo(50, target),
      ]).final;
      expect(after.reverts.at(-1)?.status, String(target)).toBe(status);
      expect(after.exists, String(target)).toBe(exists);
    }
  });

  it("R4-5b state table: the same log keeps the stretch without a value", () => {
    // No revoked state on a state table: the undo takes the interval path, and the rule for a
    // revoke in effect now does not apply.
    const ev = evaluateLog(STATE, [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open"), { seen: 0 }),
      rv(13, "11-01", "11-10", "SA", 2),
      rv(20, "11-01", "11-10", "SB", 10),
      take(23, [14], "existence", 14),
      undo(30, 20),
    ]).final;
    expect(tl(ev)).toEqual(['[10-01, 11-01) "1"', '[11-10, inf) "1"']);
  });

  // A resolution listing a candidate with no open candidate item on its unit, or taking one it
  // does not list, is rejected when judged (`invalid`, as the kernel's `openCandidates`).
  const twoCandidates: LogEntry[] = [
    w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
    w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
    w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
    rv(40, "11-01", "11-10", "SR", 10),
  ];

  it("a resolution on a unit its candidate is not on is rejected as invalid", () => {
    // #31 is a candidate on f2; #41, a revoke on the version before #21, is one on existence.
    for (const [entry, ok] of [
      [res(50, "keep_effective", [31], "f2"), true],
      [res(50, "keep_effective", [41], "existence"), true],
      [res(50, "keep_effective", [31], "existence"), false],
      [res(50, "keep_effective", [41], "f2"), false],
      [res(50, "keep_effective", [31, 41], "f2"), false],
    ] as [LogEntry, boolean][]) {
      const step = evaluateLog(STATE, [...twoCandidates, entry]).steps.at(-1);
      expect(step?.refused, JSON.stringify(entry)).toBe(!ok);
      if (!ok) expect(step?.rejected).toBe("invalid");
    }
  });

  it("a take of a candidate the resolution does not list is rejected as invalid", () => {
    const step = evaluateLog(STATE, [...twoCandidates, take(50, [31], "f2", 21)]).steps.at(-1);
    expect(step?.rejected).toBe("invalid");
    // A candidate already closed by an earlier resolution: rejected too.
    const again = evaluateLog(STATE, [
      ...twoCandidates,
      res(50, "keep_effective", [31], "f2"),
      take(60, [31], "f2", 31),
    ]).steps.at(-1);
    expect(again?.rejected).toBe("invalid");
  });

  // #82: cancelling a deletion unrelated to an item does not record that item as kept superseded
  // when another deletion, still pending, is what superseded it.
  it("#82 cancelling an unrelated deletion leaves an item another pending deletion superseded as without it", () => {
    const head: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
    ];
    const tail: LogEntry[] = [
      del(50, "pi_2", ["S2"]),
      w(60, { f2: ["7", "S7"] }, g("11-01", "open"), { seen: 50, ...ack }),
    ];
    const without = evaluateLog(STATE, [...head, ...tail]).final;
    expect(tl(without)).toEqual(['[10-01, 11-01) "5"', '[11-01, inf) "7"']);
    const cancelled = evaluateLog(STATE, [
      ...head,
      del(40, "pi_x", ["S_NONE"]),
      ...tail,
      cancel(70, "pi_x"),
    ]);
    expect(cancelled.steps.at(-1)?.keptSuperseded ?? []).toEqual([]);
    expect(tl(cancelled.final)).toEqual(tl(without));
    expect(items(cancelled.final, 31)).toEqual(items(without, 31));
  });

  // #82: a rejection is of the whole write. #21 awaits on f2 and is a candidate on f3; it is
  // rejected; deleting both causes (SB, the conflict on f3; S7, the high impact on f2) must not
  // put f3 in effect.
  it("#82 a rejected write takes effect on no target in any later replay", () => {
    const ev = evaluateLog(STATE, [
      ...confirmedThenFreed("reject").slice(0, -1),
      del(40, "pi", ["SB", "S7"]),
    ]).final;
    expect(tl(ev, "f3")).toEqual(['[10-01, inf) "a"']);
    expect(tl(ev)).toEqual(['[10-01, inf) "1"']);
    expect(items(ev, 21).every((x) => x.endsWith("(closed)"))).toBe(true);
  });

  // #82: an undo of a confirmation lists the confirmation's event on every target of the
  // confirmed write as of that write, by the record and not by the state when the undo is
  // written. Confirming #21 carries out f2; deleting SB puts f3 in effect at the confirmation;
  // the undo takes back f3 too, whether it comes after the deletion or before.
  it("#82 an undo of a confirmation lists every target of the confirmed write", () => {
    const run = evaluateLog(STATE, [...confirmedThenFreed("confirm"), undo(50, 30)], ALLOWED);
    expect(run.final.reverts.at(-1)?.record).toEqual([
      { event: 31, target: "f2" },
      { event: 31, target: "f3" },
    ]);
    expect(tl(run.final, "f3")).toEqual(['[10-01, inf) "a"']);
  });

  it("#82 ... undone before the deletion: the same record, and the deletion does not let f3 fall at the confirmation", () => {
    const head = confirmedThenFreed("confirm").slice(0, -1);
    const run = evaluateLog(STATE, [...head, undo(40, 30), del(50, "pi", ["SB"])]);
    expect(run.final.reverts.at(-1)?.record).toEqual([
      { event: 31, target: "f2" },
      { event: 31, target: "f3" },
    ]);
    expect(tl(run.final, "f3")).toEqual(['[10-01, inf) "a"']);
  });

  // Known limitation in the first version (kept as it is):
  // on a state table, two revokes over the same stretch, both undone, leave the stretch without
  // a value in either order: undoing the later one writes back a revoke (the state before it was
  // revoked by the earlier), and undoing the earlier one first writes back a restore that counts
  // as superseding the later one. No data is lost: writing the value again gives it back. The fix
  // records registrations in the revert record instead of deriving them from write-backs, an
  // event-format change left for after the first version.
  it("known limitation: two stacked revokes on a state table, both undone, leave the stretch without a value", () => {
    const head: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open"), { seen: 0 }),
      rv(13, "11-01", "11-10", "SA", 10),
      rv(20, "11-01", "11-10", "SB", 13),
    ];
    for (const order of [
      [undo(30, 20), undo(40, 13)],
      [undo(30, 13), undo(40, 20)],
    ]) {
      const label = JSON.stringify(order.map((x) => (x as { target: number }).target));
      const ev = evaluateLog(STATE, [...head, ...order]).final;
      expect(tl(ev), label).toEqual(['[10-01, 11-01) "1"', '[11-10, inf) "1"']);
      const again = evaluateLog(STATE, [
        ...head,
        ...order,
        w(50, { f2: ["1", "S5"] }, g("11-01", "11-10"), { seen: 40, ...ack }),
      ]).final;
      expect(tl(again), label).toEqual(['[10-01, inf) "1"']);
    }
  });

  // #82 review 1: two deletions, each enough to take the same candidate out of its item (one
  // deletes its own source, one the cause of its conflict), a grace-period write over its field;
  // both cancelled, in either order: the same end state.
  it("#82 two deletions each superseding the same candidate, both cancelled: the order does not matter", () => {
    const head: LogEntry[] = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
      del(40, "pi_1", ["S5"]),
      del(50, "pi_2", ["S2"]),
      w(60, { f2: ["7", "S7"] }, g("11-01", "open"), { seen: 50, ...ack }),
    ];
    const ab = evaluateLog(STATE, [...head, cancel(70, "pi_1"), cancel(80, "pi_2")]).final;
    const ba = evaluateLog(STATE, [...head, cancel(70, "pi_2"), cancel(80, "pi_1")]).final;
    expect(tl(ba)).toEqual(tl(ab));
    expect(items(ba, 31)).toEqual(items(ab, 31));
    // #61 changed f2 in the grace period: #31 stays superseded, a closed candidate.
    expect(items(ab, 31)).toEqual(['f2/0 candidate [10-01, inf) "5" (closed)']);
    expect(tl(ab)).toEqual(['[10-01, 11-01) "2"', '[11-01, inf) "7"']);
  });

  // ... and the grace-period write falls between the two deletions: #31 is out of its item when it
  // is written (taken out by pi_1, whichever is cancelled first). Both orders keep #31 superseded.
  for (const [first, second] of [
    ["pi_1", "pi_2"],
    ["pi_2", "pi_1"],
  ] as const) {
    it(`#82 ... the write between the two deletions, ${first} cancelled first: #31 stays superseded`, () => {
      const ev = evaluateLog(STATE, [
        w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
        w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
        w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
        del(40, "pi_1", ["S5"]),
        w(44, { f2: ["7", "S7"] }, g("11-01", "open"), { seen: 40, ...ack }),
        del(50, "pi_2", ["S2"]),
        cancel(70, first),
        cancel(80, second),
      ]).final;
      expect(items(ev, 31)).toEqual(['f2/0 candidate [10-01, inf) "5" (closed)']);
      expect(tl(ev)).toEqual(['[10-01, 11-01) "2"', '[11-01, inf) "7"']);
    });
  }

  // #82 review: a decision is judged valid on the state without it, as the kernel judges it.
  // #31 is a candidate against #21; deleting S2 puts it in effect: no candidate is left to keep.
  it("#82 a resolution listing a candidate a deletion has put in effect is invalid", () => {
    const log = [
      w(10, { f2: ["1", "S1"] }, g("10-01", "open")),
      w(20, { f2: ["2", "S2"] }, g("10-01", "open"), { seen: 10, ...ack }),
      w(30, { f2: ["5", "S5"] }, g("10-01", "open"), { seen: 10 }),
      del(44, "pi", ["S2"]),
      res(50, "keep_effective", [31], "f2"),
    ];
    const run = evaluateLog(STATE, log);
    expect(run.steps.at(-1)).toMatchObject({ refused: true, rejected: "invalid" });
    expect(tl(run.final)).toEqual(['[10-01, inf) "5"']);
  });

  // #15 is only a candidate (nothing awaits); deleting s16 puts it in effect. Neither state has an
  // awaiting item to confirm or reject.
  it("#82 a confirmation or rejection with nothing awaiting is invalid", () => {
    const conflicting = [
      w(10, { f2: ["9", "s15"] }, g("10-01", "open")),
      w(12, { f2: ["9.5", "s16"] }, g("10-01", "open"), { seen: 10, ...ack }),
      w(14, { f2: ["10", "s17"] }, g("10-01", "open"), { seen: 10 }),
    ];
    for (const kind of ["confirm", "reject"] as const) {
      const onCandidate = evaluateLog(STATE, [...conflicting, decide3(kind, 16, 15)]);
      expect(onCandidate.steps.at(-1)).toMatchObject({ refused: true, rejected: "invalid" });
      const inEffect = evaluateLog(STATE, [
        ...conflicting,
        del(16, "pi", ["s16"]),
        decide3(kind, 20, 15),
      ]);
      expect(inEffect.steps.at(-1)).toMatchObject({ refused: true, rejected: "invalid" });
      expect(tl(inEffect.final)).toEqual(['[10-01, inf) "10"']);
    }
  });

  // A rejection is of the whole write (03-deletion «冲突消失之后»). Deleting S7 alone removes what
  // made f2 high impact; the rejected write still takes effect on no target.
  it("#82 a rejected write, one of its causes deleted: still in effect nowhere", () => {
    const ev = evaluateLog(STATE, [
      ...confirmedThenFreed("reject").slice(0, -1),
      del(40, "pi", ["S7"]),
    ]).final;
    expect(tl(ev)).toEqual(['[10-01, inf) "1"']);
    expect(tl(ev, "f3")).toEqual(['[10-01, inf) "b"']);
    // f2 stays not in effect and closed; f3 is still a candidate against #15, not in effect.
    expect(items(ev, 21)).toEqual([
      'f2/0 awaiting [10-01, inf) "3" (closed)',
      'f3/0 candidate [10-01, inf) "c"',
    ]);
  });

  // An undo of a confirmation with include_later, confirmed before a deletion puts f3 in effect at
  // the confirmation: the record lists the confirmed write's targets at the confirmation's event
  // and the later write it takes back; f3 is undone too.
  it("#82 an undo of a confirmation with include_later", () => {
    const head = confirmedThenFreed("confirm").slice(0, -1);
    const log = [
      ...head,
      w(34, { f2: ["8", "S8"] }, g("10-01", "open"), { seen: 30 }),
      undo(40, 30, { includeLater: true }),
      decide3("confirm", 44, 41),
      del(50, "pi", ["SB"]),
    ];
    const run = evaluateLog(STATE, log);
    expect(run.steps.every((x) => !x.refused)).toBe(true);
    expect(run.final.reverts.at(-1)).toMatchObject({
      op: 44,
      status: "applied",
      record: [
        { event: 31, target: "f2" },
        { event: 31, target: "f3" },
        { event: 35, target: "f2", later: true },
      ],
    });
    expect(tl(run.final)).toEqual(['[10-01, 11-01) "1"', '[11-01, inf) "7"']);
    expect(tl(run.final, "f3")).toEqual(['[10-01, inf) "a"']);
  });
});

describe("the protection unit: a write on a target, every item in effect when written (03-deletion «删除结果的定义»)", () => {
  const ack = { acknowledge: ["overwrite"] as ["overwrite"] };
  const g = (from: string, to: string): WriteOp["valid"] => ({
    from: { mode: "given", value: d(from) },
    to: to === "open" ? { mode: "open" } : { mode: "given", value: d(to) },
  });
  const w = (
    op: number,
    v: string,
    src: string,
    from: string,
    to: string,
    extra: Partial<WriteOp> & { explicit?: boolean } = {},
  ): WriteOp => {
    const { explicit, ...rest } = extra;
    return {
      kind: "write",
      op,
      event: op + 1,
      valid: g(from, to),
      fields: { f2: { value: v, sources: [src], ...(explicit ? { explicit: true } : {}) } },
      ...rest,
    } as WriteOp;
  };
  const res = (op: number, decision: "keep_effective" | "take_previous", c: number[]): LogEntry =>
    ({ kind: "resolve", op, event: op + 1, decision, candidates: c, unit: "f2" }) as LogEntry;
  const kept = (run: ReturnType<typeof evaluateLog>) => run.steps.at(-1)?.keptEffective ?? [];

  // M: #41 (1 over [11-01, 11-09), on the version of 10, pointed at evidence) is cut into a
  // candidate (against #21), a corroboration [11-03, 11-07) and a candidate (against #31): not
  // every item in effect, so not protected. #13 (5 on [11-03, 11-07)) is a candidate against #11.
  const M: LogEntry[] = [
    w(10, "1", "S1", "10-01", "open", { seen: 0 }),
    w(12, "5", "S5", "11-03", "11-07", { seen: 0 }),
    w(20, "2", "S2", "11-01", "11-03", { seen: 10, ...ack }),
    w(30, "2", "S3", "11-07", "11-09", { seen: 20, ...ack }),
    w(40, "1", "S4", "11-01", "11-09", { seen: 10, explicit: true }),
  ];

  it("a write cut into a corroboration and candidates, its base deleted: one candidate, in its own item", () => {
    expect(items(evaluateLog(STATE, M).final, 41)).toEqual([
      'f2/0 candidate [11-01, 11-03) "1"',
      'f2/1 corroborated [11-03, 11-07) "1"',
      'f2/2 candidate [11-07, 11-09) "1"',
    ]);
    // Deleting S1 puts #13 in effect: every stretch of #41 was changed after its version; one
    // candidate, open (in the item it was a candidate of), the corroboration no longer keeping 1.
    const ev = evaluateLog(STATE, [...M, del(50, "pi", ["S1"])]).final;
    expect(items(ev, 41).filter((x) => !x.endsWith("dropped"))).toEqual([
      'f2/0 candidate [11-01, 11-09) "1"',
    ]);
    expect(ev.items.find((x) => x.event === 41 && x.k === 0)?.closed).toBeUndefined();
    expect(tl(ev)).toEqual(['[11-01, 11-03) "2"', '[11-03, 11-07) "5"', '[11-07, 11-09) "2"']);
  });

  it("... its item resolved by a person before: closed by that decision, no new item", () => {
    const kept = evaluateLog(STATE, [
      ...M,
      res(44, "keep_effective", [41]),
      del(50, "pi", ["S1"]),
    ]).final;
    expect(items(kept, 41).filter((x) => !x.endsWith("dropped"))).toEqual([
      'f2/0 candidate [11-01, 11-09) "1" (closed)',
    ]);
    expect(kept.items.find((x) => x.event === 41 && x.k === 0)?.closed).toBe(true);
    const back = evaluateLog(STATE, [
      ...M,
      res(44, "take_previous", [41]),
      del(50, "pi", ["S1"]),
    ]).final;
    expect(back.items.find((x) => x.event === 41 && x.k === 0)?.closed).toBe(true);
    expect(items(back, 45)).toEqual([
      "f2/0 applied [11-01, 11-03) no_value",
      "f2/1 applied [11-07, 11-09) no_value",
    ]);
    expect(tl(back)).toEqual(['[11-03, 11-07) "5"']);
  });

  // K: #41 (9 over [11-01, 11-09), on the version of 10) is a candidate against #21 (S2) and #31
  // (S3); deleting both puts it in effect. G writes 7 from 11-15 on the version given.
  const K: LogEntry[] = [
    w(10, "1", "S1", "10-01", "open", { seen: 0 }),
    w(20, "2", "S2", "11-01", "11-03", { seen: 10, ...ack }),
    w(30, "2", "S3", "11-07", "11-09", { seen: 20, ...ack }),
    w(40, "9", "S4", "11-01", "11-09", { seen: 10 }),
  ];
  const G = (op: number, seen: number) => w(op, "7", `SG${op}`, "11-15", "open", { seen, ...ack });

  it("kept in effect: a write after it came wholly into effect took it as a baseline", () => {
    const run = evaluateLog(STATE, [
      ...K,
      del(50, "d1", ["S2"]),
      del(60, "d2", ["S3"]),
      G(64, 60),
      cancel(70, "d2"),
    ]);
    expect(kept(run)).toEqual([{ event: 41, target: "f2" }]);
    expect(items(run.final, 41)).toEqual(['f2/0 applied [11-01, 11-09) "9"']);
  });

  it("not kept: the baseline write is earlier than the deletion that made it wholly in effect", () => {
    // Two grace periods overlapping: G is written after d1, before d2; cancelling d2, or d1.
    for (const id of ["d2", "d1"]) {
      const run = evaluateLog(STATE, [
        ...K,
        del(50, "d1", ["S2"]),
        G(54, 50),
        del(60, "d2", ["S3"]),
        cancel(70, id),
      ]);
      expect({ id, kept: kept(run) }).toEqual({ id, kept: [] });
      expect(items(run.final, 41)).toEqual(['f2/0 candidate [11-01, 11-09) "9"']);
    }
  });

  it("not kept: only in part in effect before the cancellation", () => {
    // #41 (1 over [11-01, 11-07), on the version of 12, pointed at evidence) is a candidate when
    // written. Deleting S5 makes [11-03, 11-07) the same as the version it saw (a corroboration);
    // [11-01, 11-03) stays a candidate against #21. G takes the row as its baseline; cancelling
    // does not keep #41: its candidate part would take effect with nobody deciding it.
    const run = evaluateLog(STATE, [
      w(10, "1", "S1", "10-01", "open", { seen: 0 }),
      w(12, "5", "S5", "11-03", "11-07", { seen: 10, ...ack }),
      w(20, "2", "S2", "11-01", "11-03", { seen: 12, ...ack }),
      w(40, "1", "S4", "11-01", "11-07", { seen: 12, explicit: true }),
      del(50, "d", ["S5"]),
      G(54, 50),
      cancel(70, "d"),
    ]);
    expect(kept(run)).toEqual([]);
    expect(items(run.final, 41).filter((x) => !x.endsWith("dropped"))).toEqual([
      'f2/0 candidate [11-01, 11-07) "1"',
    ]);
  });

  it("kept: a write with a corroboration when written, wholly in effect only through the deletions", () => {
    // M's #41: a corroboration does not protect it (not every item in effect when written), so it
    // is in the same place as one all candidates: kept when every item is in effect before the
    // cancellation and the baseline write saw it so.
    const run = evaluateLog(STATE, [
      ...M,
      del(50, "d1", ["S2"]),
      del(60, "d2", ["S3"]),
      G(64, 60),
      cancel(70, "d2"),
    ]);
    expect(kept(run)).toEqual([{ event: 41, target: "f2" }]);
    expect(items(run.final, 41).filter((x) => !x.endsWith("dropped"))).toEqual([
      'f2/0 corroborated [11-01, 11-07) "1"',
      'f2/2 applied [11-07, 11-09) "1"',
    ]);
  });
});

describe("a deletion carried out at expiry (03-deletion «到期物理删除»; 09 §3.5, §5.7)", () => {
  const open: ToParam = { mode: "open" };
  const next: ToParam = { mode: "next_change" };
  const until = (md: string): ToParam => ({ mode: "given", value: d(md) });
  const w2 = (
    op: number,
    v: string,
    src: string,
    from: string,
    to: ToParam,
    seen: number,
    explicit = false,
  ): WriteOp => ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    valid: { from: { mode: "given", value: d(from) }, to },
    fields: { f2: { value: v, sources: [src], ...(explicit ? { explicit } : {}) } },
    acknowledge: ["overwrite"],
  });
  const exec = (op: number, id: string): LogEntry => ({ kind: "execute", op, id });
  // #51 (3 from 11-01, explicit, f3 too) is cut into stretches by the writes around 11-05 and
  // 11-07; #61 undoes it (as in "an original item lands by its write-time block").
  const S: LogEntry[] = [
    w2(10, "3", "S1", "10-01", open, 0),
    w2(20, "1", "S3", "11-05", next, 10),
    w2(30, "1", "S4", "11-05", until("11-07"), 20, true),
    w2(40, "3", "S5", "11-05", next, 30, true),
    withF3(w2(50, "3", "S2", "11-01", open, 10, true)),
    { kind: "undo", op: 60, event: 61, target: 50, seen: 50, acknowledge: ["overwrite"] },
    w2(70, "1", "S3", "11-07", open, 60),
    w2(80, "3", "S4", "11-05", next, 70),
  ];

  it("carrying a deletion out changes nothing now; it can no longer be cancelled", () => {
    const log = [...S, del(81, "pi_a", ["S5"])];
    const before = evaluateLog(STATE, log);
    const run = evaluateLog(STATE, [
      ...log,
      exec(82, "pi_a"),
      cancel(83, "pi_a"),
      exec(84, "pi_a"),
      exec(85, "pi_none"),
    ]);
    expect(run.steps.slice(-4).map((x) => [x.entry.kind, x.refused])).toEqual([
      ["execute", false],
      ["cancel", true],
      ["execute", true],
      ["execute", true],
    ]);
    expect(run.final).toEqual(before.final);
  });

  it("a later deletion after one carried out: the same values; indices follow the blocks left readable", () => {
    // Deleting S5 restates #51's k1 as [11-05, ∞); carried out, the write-time block of k1
    // ([11-07, ∞), its start given by #41, which S5 deletes) is removed, and k1 lands by the block
    // as last given. Deleting S3 then: the values are those of both deletions pending, k1 on
    // [11-05, 11-07) where it was on [11-07, ∞) (09 §5.7: an index lands by its block as last
    // given once its write-time block is removed).
    const pendingBoth = evaluateLog(STATE, [
      ...S,
      del(81, "a", ["S5"]),
      del(82, "b", ["S3"]),
    ]).final;
    const carried = evaluateLog(STATE, [
      ...S,
      del(81, "a", ["S5"]),
      exec(82, "a"),
      del(83, "b", ["S3"]),
    ]).final;
    expect(stateWithoutIndices(carried)).toEqual(stateWithoutIndices(pendingBoth));
    expect(items(pendingBoth, 51).filter((x) => x.startsWith("f2/"))).toEqual([
      'f2/0 corroborated [11-01, 11-05) "3"',
      'f2/1 corroborated [11-07, inf) "3"',
      'f2/2 candidate [11-05, 11-07) "3"',
    ]);
    expect(items(carried, 51).filter((x) => x.startsWith("f2/"))).toEqual([
      'f2/0 corroborated [11-01, 11-05) "3"',
      'f2/1 candidate [11-05, 11-07) "3"',
      'f2/2 corroborated [11-07, inf) "3"',
    ]);
    expect(tl(carried)).toEqual(['[10-01, 11-05) "3"', '[11-05, 11-07) "1"', '[11-07, inf) "3"']);
  });

  it("a deletion's own restatements are not on its list: readable after it is carried out", () => {
    // Both carried out, then S4 deleted: #51 is one stretch again and keeps index 0. Were the
    // blocks the deletions gave removed with them, no original index would land and it would
    // take a new one.
    const ev = evaluateLog(STATE, [
      ...S,
      del(81, "a", ["S5"]),
      exec(82, "a"),
      del(83, "b", ["S3"]),
      exec(84, "b"),
      del(85, "c", ["S4"]),
    ]).final;
    expect(items(ev, 51).filter((x) => x.startsWith("f2/") && !x.endsWith("dropped"))).toEqual([
      'f2/0 corroborated [11-01, inf) "3"',
    ]);
  });

  it("L's record rests on what cuts its segment too: a cutter deleted, pending or carried out", () => {
    // #11 1 from 10-01; #16 4 from 11-01; #18 1 on [11-03, 11-05) cuts #16; #21 2 on [11-01,
    // 11-03). d1 (S2) changes f2 on [11-01, 11-03) from 2 to 4, a segment given by #16 and cut at
    // 11-03 by #18 (09 §5.9: the segment's deps include what cuts it). d2 deletes S6 (#18):
    // d1's record rests on it, and counts over the whole unit, pending or carried out.
    const L: LogEntry[] = [
      w2(10, "1", "S1", "10-01", open, 0),
      w2(15, "4", "S5", "11-01", open, 10),
      w2(17, "1", "S6", "11-03", until("11-05"), 15),
      w2(20, "2", "S2", "11-01", until("11-03"), 17),
      del(30, "d1", ["S2"]),
      del(40, "d2", ["S6"]),
    ];
    const W = w2(50, "5", "SW", "11-10", open, 20);
    // By the deleted set, carried out or not (09-references «冲突判据»): the same either way.
    for (const log of [
      [...L, W],
      [...L, exec(45, "d2"), W],
    ]) {
      expect(items(evaluateLog(STATE, log).final, 51)).toEqual(['f2/0 candidate [11-10, inf) "5"']);
    }
  });

  it("an end given by a required field's item: the block on another field is removed", () => {
    // f3's default end at 11-10 is where the entity has no value any more: #11's end on the
    // required f2 gives it (05-time «给出挡点的贡献»). Deleting S1 and carrying it out removes
    // #21's block on f3.
    const w = (
      op: number,
      f: string,
      v: string,
      src: string,
      from: string,
      to: ToParam,
      seen: number,
    ) =>
      ({
        kind: "write",
        op,
        event: op + 1,
        seen,
        valid: { from: { mode: "given", value: d(from) }, to },
        fields: { [f]: { value: v, sources: [src] } },
        acknowledge: ["overwrite"],
      }) as WriteOp;
    const run = evaluateLog(STATE, [
      w(10, "f2", "1", "S1", "10-01", until("11-10"), 0),
      w(12, "f2", "2", "S0", "11-20", open, 10),
      w(20, "f3", "x", "S2", "10-05", next, 12),
      del(30, "a", ["S1"]),
      exec(31, "a"),
    ]);
    expect(run.removed.filter((b) => b.startsWith("21/f3#"))).not.toEqual([]);
  });

  it("removal to a fixed point: a block resting on an item restated as it is goes too", () => {
    // #17 (SY) ends where #13 (SX) gives it; #19 (SZ) ends where #17 starts. Deleting SX restates
    // #17 as it is (its block is on the list), so #19's block, resting on #17, is on the list too.
    const w = (op: number, v: string, src: string, from: string, to: ToParam, seen: number) =>
      ({
        kind: "write",
        op,
        event: op + 1,
        seen,
        valid: { from: { mode: "given", value: d(from) }, to },
        fields: { f2: { value: v, sources: [src] } },
        acknowledge: ["overwrite"],
      }) as WriteOp;
    const run = evaluateLog(STATE, [
      w(10, "1", "S0", "10-01", open, 0),
      w(12, "2", "SX", "10-10", until("11-01"), 10),
      w(14, "3", "SW", "11-01", until("11-10"), 12),
      w(16, "4", "SY", "10-20", next, 14),
      w(18, "5", "SZ", "10-15", next, 16),
      del(30, "a", ["SX"]),
      exec(31, "a"),
    ]);
    expect(run.removed).toEqual(expect.arrayContaining(["19/f2#0"]));
  });

  it("L's record resting on a deleted contribution: a change over the whole unit, pending or carried out", () => {
    // d1 (S2) changes f2 on [11-01, 11-03) from 2 to 4, resting on #16. d2 deletes S5 (#16): d1's
    // record rests on a contribution in the deleted set and is not to be trusted; it counts as a
    // change over the whole unit, and a write on [11-10, ∞) on the version before d1 is a
    // candidate, whether d2 is pending or carried out.
    const L: LogEntry[] = [
      w2(10, "1", "S1", "10-01", open, 0),
      w2(15, "4", "S5", "11-01", until("11-03"), 10),
      w2(20, "2", "S2", "11-01", until("11-03"), 15),
      del(30, "d1", ["S2"]),
      del(40, "d2", ["S5"]),
    ];
    const W = w2(50, "5", "SW", "11-10", open, 20);
    // By the deleted set, carried out or not (09-references «冲突判据»): the same either way.
    for (const log of [
      [...L, W],
      [...L, exec(45, "d2"), W],
    ]) {
      expect(items(evaluateLog(STATE, log).final, 51)).toEqual(['f2/0 candidate [11-10, inf) "5"']);
    }
  });
});

describe("保持已被取代 ②: a write's change judged as it was when written", () => {
  // Found by the property "a cancelled deletion leaves no trace". #21 (f3 = a, S3) is a
  // candidate; pi_30 deletes S3; #40 writes f2 in its grace period (it changes f2, not f3); pi_30
  // is cancelled at #50 and keeps nothing superseded. A later deletion A = {S1, S3} cancelled
  // with no write in its grace period must leave no trace either: #40 changed f3 nowhere when
  // written, whatever deleting S1 (#10's value) would make of it now.
  const log: LogEntry[] = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: { from: { mode: "given", value: "2026-10-01" as BizPoint }, to: { mode: "open" } },
      fields: { f2: { value: "1", sources: ["S1"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 0,
      valid: {
        from: { mode: "given", value: "2026-11-05" as BizPoint },
        to: { mode: "given", value: "2026-11-07" as BizPoint },
      },
      fields: {
        f2: { value: "1", sources: ["S3"], explicit: true },
        f3: { value: "a", sources: ["S3"] },
      },
      acknowledge: ["overwrite"],
    },
    { kind: "deletion", op: 30, id: "pi_30", sources: ["S3", "S4"] },
    {
      kind: "write",
      op: 40,
      event: 41,
      seen: 20,
      valid: {
        from: { mode: "given", value: "2026-11-03" as BizPoint },
        to: { mode: "next_change" },
      },
      fields: { f2: { value: "2", sources: ["S2"], explicit: true } },
      acknowledge: ["overwrite"],
    },
    { kind: "cancel", op: 50, id: "pi_30" },
    { kind: "undo", op: 70, event: 71, target: 20 },
    { kind: "execute", op: 80, id: "pi_30" },
  ];
  const run = (entries: LogEntry[]) => evaluateLog(STATE, [...log, ...entries]);
  const a = ["S1", "S3"];
  const b = ["S2"];

  it("#21's f3 is a candidate, not kept superseded, as the log stands", () => {
    const final = run([]).final;
    expect(
      final.items
        .filter((x) => x.event === 21 && x.target === "f3")
        .map((x) => [x.status, x.closed]),
    ).toEqual([["candidate", undefined]]);
  });

  it("delete A, cancel A, delete B = delete A, delete B, cancel A = delete B", () => {
    const onlyB = stateWithoutIndices(
      run([{ kind: "deletion", op: 81, id: "pi_b", sources: b }]).final,
    );
    const cancelFirst = run([
      { kind: "deletion", op: 81, id: "pi_a", sources: a },
      { kind: "cancel", op: 82, id: "pi_a" },
      { kind: "deletion", op: 83, id: "pi_b", sources: b },
    ]);
    expect(cancelFirst.steps.find((s) => s.entry.op === 82)?.keptSuperseded).toEqual([]);
    expect(stateWithoutIndices(cancelFirst.final)).toEqual(onlyB);
    expect(
      stateWithoutIndices(
        run([
          { kind: "deletion", op: 81, id: "pi_a", sources: a },
          { kind: "deletion", op: 82, id: "pi_b", sources: b },
          { kind: "cancel", op: 83, id: "pi_a" },
        ]).final,
      ),
    ).toEqual(onlyB);
  });
});

// The first version (03-deletion «撤回与宽限期»; 04-contract `resolve` step 3 and `undo`): in a
// deletion's grace period, no decision and no `undo` on a row the pending deletion affects, refused
// as `invalid_argument` (`pending_deletion_target`) with the pending deletions touching it, and
// nothing appended. On a row it does not affect, decisions go ahead. After the cancellation a
// candidate the deletion removed is back in its item, still open: nothing put back, nothing
// judged again. The cases of the rule set aside for later pass `ALLOWED` above.
describe("in the grace period, decisions and undo on the affected row are refused (first version)", () => {
  // #13 (seen #11) and #15, #17 (seen #11, the version before #13): #15 and #17 candidates of one
  // item. Deleting s15 removes #15: the row is affected.
  const candidates: LogEntry[] = [
    put(10, 11, "9", ["s11"], "10-01", "open"),
    put(12, 13, "9.5", ["s13"], "10-01", "open", { seen: 10 }),
    put(14, 15, "9", ["s15"], "10-01", "open", { seen: 10, explicit: true }),
    put(16, 17, "8", ["s17"], "10-01", "open", { seen: 10 }),
  ];
  const resolve = (decision: string, extra: object = {}): LogEntry =>
    ({
      kind: "resolve",
      op: 22,
      event: 23,
      decision,
      candidates: [17],
      unit: "f2",
      ...extra,
    }) as LogEntry;
  // #13 9.5 over [11-01, 11-05); #15 (seen #13) writes 9 there again, erasing #13's change points
  // without acknowledging: awaiting (high impact ①). #17 writes 7 over [11-07, 11-09). Deleting s17
  // removes #17 and leaves #15 awaiting: the row is affected.
  const awaiting: LogEntry[] = [
    put(10, 11, "9", ["s11"], "10-01", "open"),
    put(12, 13, "9.5", ["s13"], "11-01", "11-05", { seen: 10, acknowledge: ["overwrite"] }),
    put(14, 15, "9", ["s15"], "11-01", "11-05", { seen: 12 }),
    put(16, 17, "7", ["s17"], "11-07", "11-09", { seen: 14, acknowledge: ["overwrite"] }),
  ];
  const cases: [string, LogEntry[], string[], LogEntry][] = [
    ["keep_effective", candidates, ["s15"], resolve("keep_effective")],
    ["take_previous", candidates, ["s15"], resolve("take_previous")],
    ["take_candidate", candidates, ["s15"], resolve("take_candidate", { take: 17 })],
    ["confirm", awaiting, ["s17"], { kind: "confirm", op: 22, event: 23, target: 15 }],
    ["reject", awaiting, ["s17"], { kind: "reject", op: 22, event: 23, target: 15 }],
    ["undo", candidates, ["s15"], { kind: "undo", op: 22, event: 23, target: 12 }],
  ];
  it.each(cases)("%s: refused, the pending deletion named", (_, head, sources, decision) => {
    // The decision is valid on the state after the deletion: refused for the row, not for itself.
    const after = evaluateLog(STATE, [...head, del(20, "d", sources)]).final;
    if (decision.kind === "confirm" || decision.kind === "reject") {
      expect(items(after, 15).some((x) => x.includes(" awaiting "))).toBe(true);
    }
    const run = evaluateLog(STATE, [...head, del(20, "d", sources), decision]);
    const step = run.steps.at(-1);
    expect({ refused: step?.refused, by: step?.pendingDeletionTarget }).toEqual({
      refused: true,
      by: ["d"],
    });
    // Nothing appended: the state is the one after the deletion.
    expect(stateWithoutIndices(run.final)).toEqual(
      stateWithoutIndices(evaluateLog(STATE, [...head, del(20, "d", sources)]).final),
    );
  });
  it.each(cases)(
    '%s: the same with `graceDecisions: "allowed"` goes ahead',
    (_, head, sources, decision) => {
      const step = evaluateLog(STATE, [...head, del(20, "d", sources), decision], ALLOWED).steps.at(
        -1,
      );
      expect(step?.refused).toBe(false);
    },
  );
  it("on a row the pending deletion does not affect, a decision goes ahead", () => {
    // s99 is cited nowhere on this row: the two replays are the same.
    const run = evaluateLog(STATE, [
      ...candidates,
      del(20, "d", ["s99"]),
      resolve("keep_effective"),
    ]);
    expect(run.steps.at(-1)?.refused).toBe(false);
    expect(run.steps.at(-1)?.decided).toEqual(["17/f2"]);
  });
  // #19 writes 7 over [11-07, 11-09), apart from the item: deleting s19 affects the row too.
  const withNineteen: LogEntry[] = [
    ...candidates,
    put(18, 19, "7", ["s19"], "11-07", "11-09", { seen: 16, acknowledge: ["overwrite"] }),
  ];
  const keep: LogEntry = {
    kind: "resolve",
    op: 40,
    event: 41,
    decision: "keep_effective",
    candidates: [17],
    unit: "f2",
  } as LogEntry;
  const execute = (op: number, id: string): LogEntry => ({ kind: "execute", op, id });
  it("only the pending deletions touching the row are named, in operation order", () => {
    // pi_m removes a source cited nowhere on the row; pi_z and pi_a each remove one of its.
    const run = evaluateLog(STATE, [
      ...withNineteen,
      del(20, "pi_m", ["s99"]),
      del(22, "pi_z", ["s15"]),
      del(24, "pi_a", ["s19"]),
      keep,
    ]);
    expect(run.steps.at(-1)?.pendingDeletionTarget).toEqual(["pi_z", "pi_a"]);
  });
  // A deletion carried out (`execute`) is no longer pending: the row is judged on its state after
  // it, and only deletions still pending can make it affected (03-deletion «撤回与宽限期»: "待执行"
  // until the tombstone).
  it("the affecting deletion carried out: the decision goes ahead", () => {
    const run = evaluateLog(STATE, [
      ...withNineteen,
      del(20, "d", ["s15"]),
      execute(30, "d"),
      keep,
    ]);
    expect(run.steps.at(-1)?.refused).toBe(false);
  });
  it("the affecting deletion carried out, an unrelated one still pending: the decision goes ahead", () => {
    const run = evaluateLog(STATE, [
      ...withNineteen,
      del(20, "d", ["s15"]),
      del(22, "m", ["s99"]),
      execute(30, "d"),
      keep,
    ]);
    expect(run.steps.at(-1)?.refused).toBe(false);
  });
  it("the affecting deletion carried out, another affecting one still pending: refused, naming only that one", () => {
    const run = evaluateLog(STATE, [
      ...withNineteen,
      del(20, "d", ["s15"]),
      del(22, "e", ["s19"]),
      execute(30, "d"),
      keep,
    ]);
    expect({
      refused: run.steps.at(-1)?.refused,
      by: run.steps.at(-1)?.pendingDeletionTarget,
    }).toEqual({ refused: true, by: ["e"] });
  });
  it("cancelled: the candidate the deletion removed is back in its open item, nothing put back", () => {
    const run = evaluateLog(STATE, [
      ...candidates,
      del(20, "d", ["s15"]),
      resolve("keep_effective"),
      cancel(24, "d"),
    ]);
    expect(run.steps.at(-1)?.putBack ?? []).toEqual([]);
    expect(stateWithoutIndices(run.final)).toEqual(
      stateWithoutIndices(evaluateLog(STATE, candidates).final),
    );
  });
});
