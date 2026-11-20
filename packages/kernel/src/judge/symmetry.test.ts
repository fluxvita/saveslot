// Where the conflict criterion's symmetry clause (09-references-conflict-sync «冲突判据», 对称)
// says more than the rules give, as it stands: two writes from the same version, in either order
// ((c) also with a corroboration). Pinned as it is, not as a fault: whether the clause or the rules
// change is open (08 «P3 前», the symmetry clause). The subset the clause does hold on is
// symmetry.prop.test.ts.

import type { BizPoint, FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { emptyState, judgeOp, view } from "./judge.ts";
import type { Judgement, TableShape, ToParam, WriteInput } from "./model.ts";
import type { RowState } from "./state.ts";

const STATE: TableShape = {
  kind: "state",
  fields: ["f2"] as FieldId[],
  valued: ["f2"] as FieldId[],
  required: ["f2"] as FieldId[],
  groups: [],
};
const d = (md: string) => `2026-${md}` as BizPoint;

function write(
  op: number,
  value: string,
  [from, to]: readonly [string, string],
  o: { seen?: number; current?: boolean; explicit?: boolean; ack?: boolean } = {},
): WriteInput {
  const end: ToParam =
    to === "next"
      ? { mode: "next_change" }
      : to === "open"
        ? { mode: "open" }
        : { mode: "given", value: d(to) };
  return {
    kind: "write",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    seen: o.seen ?? op - 1,
    seenExplicit: true,
    ...(o.current ? { seenCurrent: true as const } : {}),
    ...(o.ack ? { acknowledge: true as const } : {}),
    valid: { from: { mode: "given", value: d(from) }, to: end },
    now: d("11-05"),
    fields: { f2: { value, ...(o.explicit ? { explicit: true } : {}) } } as never,
  };
}

function run(inputs: readonly WriteInput[]): { state: RowState; js: Judgement[] } {
  let state = emptyState(STATE);
  const js: Judgement[] = [];
  for (const i of inputs) {
    const r = judgeOp(state, i);
    js.push(r.judgement);
    state = r.state;
  }
  return { state, js };
}

const statuses = (j: Judgement | undefined) =>
  j?.record.kind === "write" ? j.record.items.map((x) => x.status) : [];

function values(state: RowState): string[] {
  const out: [BizPoint | null, BizPoint | null, FieldValue][] = [];
  for (const s of view(state).fields["f2" as FieldId] ?? []) {
    const from = s.valid[0]?.from ?? null;
    const to = s.valid[s.valid.length - 1]?.to ?? null;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev[1] === from && prev[2] === s.value) prev[1] = to;
    else out.push([from, to, s.value]);
  }
  return out.map(([f, t, v]) => `${f?.slice(5) ?? "-∞"}..${t?.slice(5) ?? "∞"} ${String(v)}`);
}

const BASE = write(10, "5000", ["10-01", "open"], { seen: 0 });

describe("the symmetry clause, where it does not hold (08 «P3 前»)", () => {
  it("(a) an explicit interval and a default end, the same start and value: both merge, two end states", () => {
    // W1 3000 over [11-01, 11-03); W2 3000 from 11-01 to the next change; both from #10.
    const W1 = (op: number) => write(op, "3000", ["11-01", "11-03"], { seen: 10 });
    const W2 = (op: number) => write(op, "3000", ["11-01", "next"], { seen: 10 });
    const first = run([BASE, W1(20), W2(30)]);
    const second = run([BASE, W2(20), W1(30)]);
    expect(first.js.flatMap((j) => j.conflicts)).toEqual([]);
    expect(second.js.flatMap((j) => j.conflicts)).toEqual([]);
    // W1 first: W2, merged, resolves on the current state and stops at W1's end.
    expect(values(first.state)).toEqual([
      "10-01..11-01 5000",
      "11-01..11-03 3000",
      "11-03..∞ 5000",
    ]);
    // W2 first: it runs on; W1 writes the same value over [11-01, 11-03).
    expect(values(second.state)).toEqual(["10-01..11-01 5000", "11-01..∞ 3000"]);
  });

  it("(b) a write awaiting for high impact is no L: one order a candidate, the other awaiting and in effect", () => {
    // 6000 over [11-01, 11-03) at #15. W1 3000 from 11-01 to the next change; W2 5000 over
    // [11-01, ∞), which erases the version's change points at 11-01 and 11-03 (high impact ①).
    const SIX = write(15, "6000", ["11-01", "11-03"], { seen: 10 });
    const first = run([
      BASE,
      SIX,
      write(20, "3000", ["11-01", "next"], { seen: 15, current: true }),
      write(30, "5000", ["11-01", "open"], { seen: 15 }),
    ]);
    // W1 in effect; W2 meets it, other values: a candidate.
    expect(statuses(first.js[2])).toEqual(["applied"]);
    expect(statuses(first.js[3])).toEqual(["candidate"]);
    expect(first.js[3]?.conflicts).toHaveLength(1);
    const second = run([
      BASE,
      SIX,
      write(20, "5000", ["11-01", "open"], { seen: 15, current: true }),
      // W2 awaits, in effect nowhere: no new version, W1's ver is still the current one.
      write(30, "3000", ["11-01", "next"], { seen: 15, current: true }),
    ]);
    expect(statuses(second.js[2])).toEqual(["awaiting"]);
    expect(statuses(second.js[3])).toEqual(["applied"]);
    expect(second.js.flatMap((j) => j.conflicts)).toEqual([]);
  });

  // (c) A write's default end stopped at a point of its seen version that a later write, with
  // acknowledge, erased. Base 5000 from 10-01, 4000 from 11-25 (#12). From #12: L 4000 from 11-10
  // to the next change with acknowledge (11-25 is no change point after it); A from 11-20 to the
  // next change. Both orders merge and open nothing; A after L runs to the end of time, over the
  // 4000 of [11-25, ∞) in its own seen version, which it never spoke of.
  const C = [BASE, write(12, "4000", ["11-25", "next"], { seen: 10, current: true })] as const;
  const L = (op: number, current: boolean) =>
    write(op, "4000", ["11-10", "next"], { seen: 12, current, ack: true });
  it.each([
    ["a write of another value", "6000", false],
    ["a corroboration", "5000", true],
  ] as const)(
    "(c) %s whose end a later acknowledge erased: both merge, two end states",
    (_, v, explicit) => {
      const A = (op: number, current: boolean) =>
        write(op, v, ["11-20", "next"], { seen: 12, current, explicit });
      const lFirst = run([...C, L(20, true), A(30, false)]);
      const aFirst = run([...C, A(20, true), L(30, false)]);
      expect([...lFirst.js, ...aFirst.js].flatMap((j) => j.conflicts)).toEqual([]);
      expect(statuses(lFirst.js[3])).toEqual(["applied"]);
      expect(values(lFirst.state)).toEqual([
        "10-01..11-10 5000",
        "11-10..11-20 4000",
        `11-20..∞ ${v}`,
      ]);
      expect(statuses(aFirst.js[2])).toEqual([explicit ? "corroborated" : "applied"]);
      expect(values(aFirst.state)).toEqual([
        "10-01..11-10 5000",
        "11-10..11-20 4000",
        ...(explicit ? ["11-20..11-25 5000"] : ["11-20..11-25 6000"]),
        "11-25..∞ 4000",
      ]);
    },
  );
});
