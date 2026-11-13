// Fixed cases for deletions interleaved with operations: confirmation and cancellation as log
// events (03-deletion «撤回与宽限期», «结果怎么落进日志»; 09 §5.9). Fictional data.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateLog } from "./evaluate.ts";
import type { Evaluation, LogEntry, Op, TableSchema, ToParam, WriteOp } from "./model.ts";
import { itemsOf, segments, stateWithoutIndices, timeline } from "./views.ts";

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
    evaluateLog(STATE, [
      ...prefix(from41),
      del(50, "pi_d", ["S2", "S5"]),
      ...grace,
      cancel(80, "pi_d"),
      ...after,
    ]);
  /** The replay as never deleted, with what the cancellation kept (03-deletion «撤回还原»). */
  const neverDeleted = (
    from41: string,
    r: ReturnType<typeof evaluateLog>,
    after: LogEntry[] = [],
  ) =>
    evaluateLog(STATE, [...prefix(from41), ...grace, ...after], {
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
      items(evaluateLog(STATE, [...prefix("11-01"), ...grace, ...after]).final, 21),
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
    const during = evaluateLog(STATE, pending).final;
    expect(during.reverts.find((r) => r.op === 40)).toEqual({
      op: 40,
      event: 42,
      status: "applied",
      record: [{ event: 32, target: "f2" }],
    });
    expect(items(during, 42)).toEqual(['f2/0 applied [11-02, 11-20) "3000" carried #22/f2/0']);
    const ev = evaluateLog(STATE, [...pending, cancel(45, "d")]).final;
    expect(items(ev, 42)).toEqual(["f2/0 dropped"]);
    expect(tl(ev)).toEqual(tl(evaluateLog(STATE, head).final));
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
      w(30, 31, "11-01", "open", "1", "S1", { seen: 10, explicit: true }),
      { kind: "undo", op: 40, event: 41, target: 30, seen: 30, acknowledge: ["overwrite"] },
      del(60, "d", ["S3"]),
    ];
    const ev = evaluateLog(STATE, log).final;
    expect(items(ev, 31)).toEqual(['f2/0 corroborated [11-01, inf) "1"', "f2/1 dropped"]);
    expect(items(ev, 41)).toEqual(['f2/0 applied [11-01, inf) "1" carried #11/f2/0']);
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
      w(24, 26, "11-05", "11-20", "5000", "S_A", { seen: 10, explicit: true }),
      { kind: "undo", op: 30, event: 32, target: 24 },
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
    expect(items(ev, 26)).toEqual(['f2/0 corroborated [11-05, 11-20) "5000"', "f2/1 dropped"]);
    expect(items(ev, 51)).toEqual(['f2/0 applied [11-12, inf) "2000"']);
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
    put(30, 31, "1", ["S5"], "11-01", "open", { seen: 20, explicit: true }),
    put(40, 41, "2", ["S4"], "11-01", "11-03", { seen: 30 }),
    { kind: "undo", op: 60, event: 61, target: 30 },
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
      const ab = evaluateLog(STATE, [...log, a, b, ...further]).final;
      const ba = evaluateLog(STATE, [...log, { ...b, op: 61 }, { ...a, op: 62 }, ...further]).final;
      const once = evaluateLog(STATE, [
        ...log,
        del(61, "pi_ab", ["S4", "S1", "S2"]),
        ...further,
      ]).final;
      expect(ab.reverts.at(-1)?.record).toEqual([{ event: 61, target: "f2" }]);
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
    put(40, 41, "3", ["S1"], "11-01", "open", { seen: 10, explicit: true }),
    { kind: "undo", op: 50, event: 51, target: 40 },
  ];
  const orders: Record<string, LogEntry[]> = {
    "S4 then S3": [del(51, "pi_a", ["S4"]), del(52, "pi_b", ["S3"])],
    "S3 then S4": [del(51, "pi_b", ["S3"]), del(52, "pi_a", ["S4"])],
    "both at once": [del(51, "pi_ab", ["S4", "S3"])],
  };

  it("before the deletions: three items; the undo lists the write's (event, target)", () => {
    const ev = evaluateLog(STATE, log).final;
    expect(items(ev, 41)).toEqual([
      'f2/0 candidate [11-01, 11-03) "3"',
      'f2/1 corroborated [11-03, 11-05) "3"',
      'f2/2 candidate [11-05, inf) "3"',
    ]);
    expect(ev.reverts.at(-1)?.record).toEqual([{ event: 41, target: "f2" }]);
  });

  it.each(Object.entries(orders))("%s: one candidate item", (_, ds) => {
    const ev = evaluateLog(STATE, [...log, ...ds]).final;
    expect(items(ev, 41)).toEqual([
      'f2/0 candidate [11-01, inf) "3"',
      "f2/1 dropped",
      "f2/2 dropped",
    ]);
    expect(tl(ev)).toEqual(['[11-01, 11-03) "1"']);
  });

  it("the three orders give the same state and items, also after an undo of the undo", () => {
    for (const further of [[], [{ kind: "undo", op: 60, event: 61, target: 50 }]] as LogEntry[][]) {
      const [x, ...rest] = Object.values(orders).map((ds) =>
        stateWithoutIndices(evaluateLog(STATE, [...log, ...ds, ...further]).final),
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
      items(evaluateLog(STATE, [...withS5, ...entries]).final, 41).filter(
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
      expect(items(ev, 51).filter((x) => !x.endsWith("dropped"))).toEqual(expected);
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
    // #51's k0 [11-01, 11-07) and k1 [11-07, ∞): #61 lists (#51, f2). Deleting S5 first restates
    // k1 as [11-05, ∞); after S3 is deleted too, [11-05, 11-07) takes effect under a new index,
    // covered by #61 and taken back by it, as in the other orders. Values: [11-05, 11-07) is 1,
    // given by #61.
    const log: LogEntry[] = [
      w2(10, "3", "S1", "10-01", open, 0),
      w2(20, "1", "S3", "11-05", { mode: "next_change" }, 10),
      w2(30, "1", "S4", "11-05", until("11-07"), 20, true),
      w2(40, "3", "S5", "11-05", { mode: "next_change" }, 30, true),
      w2(50, "3", "S2", "11-01", open, 10, true),
      { kind: "undo", op: 60, event: 61, target: 50 },
      w2(70, "1", "S3", "11-07", open, 60),
      w2(80, "3", "S4", "11-05", { mode: "next_change" }, 70),
    ];
    check(
      log,
      [[["S5"], ["S3"]], [["S3"], ["S5"]], [["S5", "S3"]]],
      [
        'f2/0 corroborated [11-01, 11-05) "3"',
        'f2/1 corroborated [11-07, inf) "3"',
        'f2/2 applied [11-05, 11-07) "3"',
      ],
    );
    const ev = evaluateLog(STATE, [...log, del(81, "pi_0", ["S5"]), del(82, "pi_1", ["S3"])]).final;
    expect(tl(ev)).toEqual(['[10-01, 11-05) "3"', '[11-05, 11-07) "1"', '[11-07, inf) "3"']);
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
  const run = evaluateLog(STATE, log);
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
    const run = evaluateLog(STATE, [
      ...log,
      del(51, "pi_1", [first]),
      del(52, "pi_2", [second]),
      undo,
    ]);
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
    const run = evaluateLog(STATE, log);
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
    const log: LogEntry[] = [
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
    expect(tl(ev)).toEqual(['[11-05, 11-09) "2"']);
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
