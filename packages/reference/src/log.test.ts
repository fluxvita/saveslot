// Fixed cases for deletions interleaved with operations: confirmation and cancellation as log
// events (03-deletion «撤回与宽限期», «结果怎么落进日志»; 09 §5.9). Fictional data.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateLog } from "./evaluate.ts";
import type { Evaluation, LogEntry, Op, TableSchema, ToParam, WriteOp } from "./model.ts";
import { itemsOf, timeline } from "./views.ts";

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const d = (md: string) => `2026-${md}` as BizPoint;
const short = (xs: string[]) => xs.map((s) => s.replaceAll("2026-", ""));
const tl = (ev: Evaluation, f: FieldId = "f2") => short(timeline(ev, f));
const items = (ev: Evaluation, event: number) =>
  short(itemsOf(ev, event)).map((s) => {
    const x = ev.items.find((i) => i.event === event && s.startsWith(`${i.target}/${i.k} `));
    return x?.closed ? `${s} (closed)` : s;
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
    const ev = evaluateLog(STATE, log).final;
    expect(items(ev, 15)).toEqual(['f2/0 applied [10-01, inf) "10"']);
    expect(ev.reverts).toEqual([
      { op: 20, event: 21, status: "applied", record: [{ event: 15, target: "f2", k: 0 }] },
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

  it("is a corroboration at its own write number", () => {
    // At operation 14 its end 11-01 is covered by the take-candidate write at 22, which changed
    // the value over an interval containing it (05-time «挡点»): #29's default end does not stop
    // there. Placed at the cancellation's number (26) it would, and #29 would end at 11-01.
    const ev = evaluateLog(STATE, log).final;
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
    const ev = evaluateLog(STATE, circular).final;
    expect(items(ev, 15)).toEqual(['f2/0 candidate [10-01, 11-01) "8"']);
    expect(items(ev, 25)).toEqual(['f2/0 applied [10-15, inf) "7"']);
    expect(tl(ev)).toEqual(['[10-01, 10-15) "8"', '[10-15, inf) "7"']);
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
    const run = evaluateLog(STATE, [...prefix, del(60, "d", ["S1"]), ...grace, cancel(100, "d")]);
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
      sw(80, 50, "11-01", "open", "1", "S2", true),
      { kind: "undo", op: 90, event: 91, target: 80 },
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
    expect(items(run.final, 81)).toEqual([
      'f2/0 corroborated [11-01, 11-03) "1"',
      'f2/1 candidate [11-03, inf) "1"',
    ]);
    expect(items(run.final, 91)).toEqual(['f2/0 applied [11-01, 11-03) "1" carried #51/f2/0']);
    const base = evaluateLog(STATE, [...prefix, ...grace]).final;
    expect(items(run.final, 91)).toEqual(items(base, 91));
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
    const run = evaluateLog(STATE, log);
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
  // 03-deletion «回掉的权威定义» step 1: an undo whose target m is itself a revert expands to every
  // write-back item of m on this row first given by a deletion's restatement, even when its
  // record is empty because m had no write-back when the undo was written.
  it("state table: the undone revert regains write-back items after a deletion; the undo reverts them", () => {
    // #22 is wholly covered by X (#25) when operation 30 undoes it: no write-back. Operation 40
    // undoes operation 30: accepted, empty record. Deleting X gives operation 30 a write-back
    // (5000 on [11-02, 11-20)); operation 40 now reverts it: back to #22's 3000.
    const log: LogEntry[] = [
      put(10, 12, "5000", ["S12"], "10-01", "open"),
      put(20, 22, "3000", ["S22"], "11-02", "11-20"),
      put(23, 25, "3500", ["S_X"], "11-02", "11-20"),
      { kind: "undo", op: 30, event: 32, target: 20, seen: 23, acknowledge: ["overwrite"] },
      { kind: "undo", op: 40, event: 42, target: 30 },
    ];
    const asWritten = evaluateLog(STATE, log).final;
    expect(asWritten.reverts).toEqual([
      { op: 30, event: 32, status: "applied", record: [{ event: 22, target: "f2", k: 0 }] },
      { op: 40, event: 42, status: "applied", record: [] },
    ]);
    const ev = evaluateLog(STATE, [...log, del(50, "d", ["S_X"])]).final;
    expect(items(ev, 32)).toEqual(['f2/0 applied [11-02, 11-20) "5000" carried #12/f2/0']);
    expect(items(ev, 42)).toEqual(['f2/0 applied [11-02, 11-20) "3000" carried #22/f2/0']);
    expect(tl(ev)).toEqual([
      '[10-01, 11-02) "5000"',
      '[11-02, 11-20) "3000"',
      '[11-20, inf) "5000"',
    ]);
  });

  it("event table: the same on a single value", () => {
    // Operation 40 undoes W2, wholly covered by W3: no write-back. Operation 50 undoes operation
    // 40: accepted, empty record. Deleting S3 gives operation 40 a write-back (45, from W1);
    // operation 50 reverts it: back to W2's 54.
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
      [50, "applied", 0],
    ]);
    const ev = evaluateLog(EVENT, [...log, del(60, "d", ["S3"])]).final;
    expect(items(ev, 42)).toEqual(['f3/0 applied [-inf, inf) "45" carried #23/f3/0']);
    expect(items(ev, 52)).toEqual(['f3/0 applied [-inf, inf) "54" carried #27/f3/0']);
    expect(ev.fields["f3"]?.[0]?.value).toBe("54");
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
      record: [{ event: 32, target: "f2", k: 0 }],
    });
    expect(items(ev, 42)).toEqual(['f2/0 applied [11-02, 11-20) "3000" carried #22/f2/0']);
    expect(tl(ev)).toEqual([
      '[10-01, 11-02) "5000"',
      '[11-02, 11-20) "3000"',
      '[11-20, inf) "5000"',
    ]);
  });
});
