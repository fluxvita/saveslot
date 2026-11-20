// A corroboration and a write of another value, both from the same version, in either order
// (05-time «用同样的值写»; 09-references-conflict-sync «冲突判据»). Base [10-01, ∞) 5000; A says
// 5000 with evidence pointed at (a corroboration); B says 3000. The part of A changed since its
// version is judged as A was written: with a default end, from A's start, resolved on the current
// state when merged. A corroboration makes no version, so B coming after A with the same `ver` saw
// it (`ver.current`): no conflict, and B covering A's corroboration only warns. A after B did not
// see B: its changed part meets B by the conflict criterion. Each of the seven cells, both orders.

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

/** An interval as written: a start, and a day, "next" (a default end) or "open". */
type Written = readonly [string, string];

function write(
  op: number,
  value: string,
  [from, to]: Written,
  o: { seen?: number; current?: boolean; explicit?: boolean } = {},
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
    valid: { from: { mode: "given", value: d(from) }, to: end },
    now: d("11-05"),
    fields: { f2: { value, ...(o.explicit ? { explicit: true } : {}) } } as never,
  };
}

/** Judges the inputs one by one: the judgements and the state after. */
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

/** An item as `status [from, to)`, `to` absent for ∞. */
const shown = (j: Judgement) =>
  j.record.kind === "write"
    ? j.record.items.map((x) => {
        const a = x.valid[0];
        return `${x.status} ${a?.from?.slice(5) ?? "-∞"}..${a?.to?.slice(5) ?? "∞"}`;
      })
    : [];

/** The values of f2 after, as `from..to value`, equal neighbours joined. */
function stretches(state: RowState): string[] {
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

interface Outcome {
  readonly a: readonly string[];
  readonly b: readonly string[];
  readonly conflicts: number;
  readonly warned: number;
  readonly end: readonly string[];
}

/** A then B (B saw A: the same version, still current) and B then A (A did not see B). */
function both(A: Written, B: Written) {
  const aFirst = run([
    BASE,
    write(20, "5000", A, { seen: 10, explicit: true }),
    write(30, "3000", B, { seen: 10, current: true }),
  ]);
  const bFirst = run([
    BASE,
    write(20, "3000", B, { seen: 10 }),
    write(30, "5000", A, { seen: 10, explicit: true }),
  ]);
  const outcome = (r: { state: RowState; js: Judgement[] }, a: number, b: number): Outcome => ({
    a: shown(r.js[a] as Judgement),
    b: shown(r.js[b] as Judgement),
    conflicts: r.js.reduce((n, j) => n + j.conflicts.length, 0),
    warned: r.js.reduce((n, j) => n + j.warnings.length, 0),
    end: stretches(r.state),
  });
  return { aFirst: outcome(aFirst, 1, 2), bFirst: outcome(bFirst, 2, 1) };
}

describe("both orders, the seven cells", () => {
  it("1. A from 11-20 to the next change, B from 11-02 to the next change: the same end state", () => {
    const r = both(["11-20", "next"], ["11-02", "next"]);
    const end = ["10-01..11-02 5000", "11-02..11-20 3000", "11-20..∞ 5000"];
    expect(r.aFirst).toEqual({
      a: ["corroborated 11-20..∞"],
      b: ["applied 11-02..11-20"],
      conflicts: 0,
      warned: 0,
      end,
    });
    // A's changed part: a default end from 11-20, not B's start: merged, resolved now.
    expect(r.bFirst).toEqual({
      a: ["applied 11-20..∞"],
      b: ["applied 11-02..∞"],
      conflicts: 0,
      warned: 0,
      end,
    });
  });

  it("2. both from 11-20 to the next change: B covers A's corroboration; A after B conflicts", () => {
    const r = both(["11-20", "next"], ["11-20", "next"]);
    expect(r.aFirst).toEqual({
      a: ["corroborated 11-20..∞"],
      b: ["applied 11-20..∞"],
      conflicts: 0,
      warned: 1,
      end: ["10-01..11-20 5000", "11-20..∞ 3000"],
    });
    // Default end against default end, from the same start, other values.
    expect(r.bFirst).toEqual({
      a: ["candidate 11-20..∞"],
      b: ["applied 11-20..∞"],
      conflicts: 1,
      warned: 0,
      end: ["10-01..11-20 5000", "11-20..∞ 3000"],
    });
  });

  it("3. A from 11-20 to the next change, B over [11-02, 11-22)", () => {
    const r = both(["11-20", "next"], ["11-02", "11-22"]);
    expect(r.aFirst).toEqual({
      a: ["corroborated 11-20..∞"],
      b: ["applied 11-02..11-22"],
      conflicts: 0,
      warned: 1,
      end: ["10-01..11-02 5000", "11-02..11-22 3000", "11-22..∞ 5000"],
    });
    expect(r.bFirst).toEqual({
      a: ["candidate 11-20..11-22", "corroborated 11-22..∞"],
      b: ["applied 11-02..11-22"],
      conflicts: 1,
      warned: 0,
      end: ["10-01..11-02 5000", "11-02..11-22 3000", "11-22..∞ 5000"],
    });
  });

  it("4. A over [11-20, 11-25), B from 11-02 to the next change: B stops at A's start", () => {
    const r = both(["11-20", "11-25"], ["11-02", "next"]);
    // A's explicit start is a blocking point B, having seen A, stops at: nothing covered.
    expect(r.aFirst).toEqual({
      a: ["corroborated 11-20..11-25"],
      b: ["applied 11-02..11-20"],
      conflicts: 0,
      warned: 0,
      end: ["10-01..11-02 5000", "11-02..11-20 3000", "11-20..∞ 5000"],
    });
    expect(r.bFirst).toEqual({
      a: ["candidate 11-20..11-25"],
      b: ["applied 11-02..∞"],
      conflicts: 1,
      warned: 0,
      end: ["10-01..11-02 5000", "11-02..∞ 3000"],
    });
  });

  it("5. A over [11-20, 11-25), B over [11-02, 11-22)", () => {
    const r = both(["11-20", "11-25"], ["11-02", "11-22"]);
    expect(r.aFirst).toEqual({
      a: ["corroborated 11-20..11-25"],
      b: ["applied 11-02..11-22"],
      conflicts: 0,
      warned: 1,
      end: ["10-01..11-02 5000", "11-02..11-22 3000", "11-22..∞ 5000"],
    });
    expect(r.bFirst).toEqual({
      a: ["candidate 11-20..11-22", "corroborated 11-22..11-25"],
      b: ["applied 11-02..11-22"],
      conflicts: 1,
      warned: 0,
      end: ["10-01..11-02 5000", "11-02..11-22 3000", "11-22..∞ 5000"],
    });
  });

  it("6. A over [11-20, 11-25), B over [11-20, 11-22)", () => {
    const r = both(["11-20", "11-25"], ["11-20", "11-22"]);
    expect(r.aFirst).toEqual({
      a: ["corroborated 11-20..11-25"],
      b: ["applied 11-20..11-22"],
      conflicts: 0,
      warned: 1,
      end: ["10-01..11-20 5000", "11-20..11-22 3000", "11-22..∞ 5000"],
    });
    expect(r.bFirst).toEqual({
      a: ["candidate 11-20..11-22", "corroborated 11-22..11-25"],
      b: ["applied 11-20..11-22"],
      conflicts: 1,
      warned: 0,
      end: ["10-01..11-20 5000", "11-20..11-22 3000", "11-22..∞ 5000"],
    });
  });

  it("7. A from 11-20 to the next change, B over [11-02, 11-10): apart, both merged", () => {
    const r = both(["11-20", "next"], ["11-02", "11-10"]);
    const end = ["10-01..11-02 5000", "11-02..11-10 3000", "11-10..∞ 5000"];
    expect(r.aFirst).toEqual({
      a: ["corroborated 11-20..∞"],
      b: ["applied 11-02..11-10"],
      conflicts: 0,
      warned: 0,
      end,
    });
    // Nothing of A changed since: a corroboration only.
    expect(r.bFirst).toEqual({
      a: ["corroborated 11-20..∞"],
      b: ["applied 11-02..11-10"],
      conflicts: 0,
      warned: 0,
      end,
    });
  });
});

describe("merged, the changed part resolved again on the current state", () => {
  it("shorter than seen: it stops at a start made since, not where the seen version ended it", () => {
    // B 3000 from 11-02 and X 7000 from 11-25, both to the next change, both from #10. A, from
    // #10 too, says 5000 from 11-20 to the next change: [11-20, ∞) at #10, all of it changed now.
    // No conflict (other starts); resolved now, A stops at X's start 11-25.
    const { js } = run([
      BASE,
      write(20, "3000", ["11-02", "next"], { seen: 10 }),
      write(30, "7000", ["11-25", "next"], { seen: 10 }),
      write(40, "5000", ["11-20", "next"], { seen: 10, explicit: true }),
    ]);
    expect(shown(js[3] as Judgement)).toEqual(["applied 11-20..11-25"]);
    expect((js[3] as Judgement).conflicts).toEqual([]);
  });

  it("all of it the same now, shorter than seen: corroborated, the blocking point's giver among its deps", () => {
    // L 3000 from 11-25, then A 5000 from 11-20, both from #10: at #10 A is [11-20, ∞); now it
    // stops at L's start, and all of [11-20, 11-25) is still 5000. Nothing in effect.
    const { js } = run([
      BASE,
      write(20, "3000", ["11-25", "next"], { seen: 10 }),
      write(30, "5000", ["11-20", "next"], { seen: 10, explicit: true }),
    ]);
    const j = js[2] as Judgement;
    expect(shown(j)).toEqual(["corroborated 11-20..11-25"]);
    expect(j.conflicts).toEqual([]);
    const r = j.record;
    expect(r.kind === "write" ? r.items.map((x) => x.deps) : []).toEqual([
      [{ event: 21, target: "f2", k: 0 }],
    ]);
  });

  it("two changes since the seen version: corroborated up to the nearer one, both among its deps", () => {
    // L1 3000 from 11-25 (from #10), L2 4000 from 11-22 (from #20, current: it stops at 11-25).
    // A 5000 from 11-20, from #10: now it stops at 11-22.
    const { js } = run([
      BASE,
      write(20, "3000", ["11-25", "next"], { seen: 10 }),
      write(30, "4000", ["11-22", "next"], { seen: 20, current: true }),
      write(40, "5000", ["11-20", "next"], { seen: 10, explicit: true }),
    ]);
    const j = js[3] as Judgement;
    expect(shown(j)).toEqual(["corroborated 11-20..11-22"]);
    expect(j.conflicts).toEqual([]);
    const r = j.record;
    const deps = r.kind === "write" ? r.items.flatMap((x) => x.deps.map((y) => y.event)) : [];
    expect([...new Set(deps)].sort()).toEqual([21, 31]);
  });

  it("the writes that changed it among its deps, where no blocking point gives one", () => {
    // Cell 1, B then A: A in effect over [11-20, ∞), no end to give; B changed it.
    const { js } = run([
      BASE,
      write(20, "3000", ["11-02", "next"], { seen: 10 }),
      write(30, "5000", ["11-20", "next"], { seen: 10, explicit: true }),
    ]);
    const r = (js[2] as Judgement).record;
    expect(r.kind === "write" ? r.items.map((x) => x.deps) : []).toEqual([
      [{ event: 21, target: "f2", k: 0 }],
    ]);
  });
});

describe("a corroboration earlier in the same request", () => {
  it("op 1 with a current ver saw op 0's corroboration: its default end stops at its start", () => {
    // Op 0 corroborates [11-25, 11-30); op 1 of the same request, its ver current, writes 3000 from
    // 11-02 to the next change. It sees the state just before it, op 0 included (09 §5.2): it stops
    // at 11-25. (The reference evaluator has no index within a request: only this case keeps it.)
    const a: WriteInput = {
      ...write(20, "5000", ["11-25", "11-30"], { seen: 10, explicit: true }),
    };
    const b: WriteInput = {
      ...write(20, "3000", ["11-02", "next"], { seen: 10, current: true }),
      index: 1,
      event: 22,
    };
    const { js, state } = run([BASE, a, b]);
    expect(shown(js[1] as Judgement)).toEqual(["corroborated 11-25..11-30"]);
    expect(shown(js[2] as Judgement)).toEqual(["applied 11-02..11-25"]);
    expect(js.reduce((n, j) => n + j.conflicts.length, 0)).toBe(0);
    expect(stretches(state)).toEqual(["10-01..11-02 5000", "11-02..11-25 3000", "11-25..∞ 5000"]);
  });
});
