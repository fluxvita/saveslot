// The reference evaluator on a corroboration and a write of another value from the same version,
// in either order (05-time «用同样的值写»; 09-references-conflict-sync «冲突判据»): the seven cells
// kernel's judge pins in judge/corroboration-orders.test.ts, the same expectations. Base
// [10-01, ∞) 5000; A says 5000 with evidence pointed at; B says 3000. B after A carries a version
// still current (a corroboration makes none): `seenCurrent`. A after B did not see B.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.ts";
import type { Op, TableSchema, ToParam, WriteOp } from "./model.ts";
import { itemsOf, timeline } from "./views.ts";

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const d = (md: string) => `2026-${md}` as BizPoint;

type Written = readonly [string, string];

function put(
  op: number,
  value: string,
  [from, to]: Written,
  o: { seen?: number; current?: boolean; explicit?: boolean } = {},
): WriteOp {
  const end: ToParam =
    to === "next"
      ? { mode: "next_change" }
      : to === "open"
        ? { mode: "open" }
        : { mode: "given", value: d(to) };
  return {
    kind: "write",
    op,
    event: op + 1,
    ...(o.seen !== undefined ? { seen: o.seen } : {}),
    ...(o.current ? { seenCurrent: true as const } : {}),
    valid: { from: { mode: "given", value: d(from) }, to: end },
    fields: { f2: { value, sources: [`S${op}`], ...(o.explicit ? { explicit: true } : {}) } },
  };
}

const BASE = put(10, "5000", ["10-01", "open"]);
/** An item as `status [from, to) value`, without its index. */
const shown = (ev: ReturnType<typeof evaluate>, event: number) =>
  itemsOf(ev, event).map((s) => s.replace(/^f2\/[0-9]+ /, "").replaceAll("2026-", ""));
const values = (ev: ReturnType<typeof evaluate>) =>
  timeline(ev, "f2" as never).map((s) => s.replaceAll("2026-", ""));

function both(A: Written, B: Written) {
  const aFirst = evaluate(STATE, [
    BASE,
    put(20, "5000", A, { seen: 10, explicit: true }),
    put(30, "3000", B, { seen: 10, current: true }),
  ] as Op[]);
  const bFirst = evaluate(STATE, [
    BASE,
    put(20, "3000", B, { seen: 10 }),
    put(30, "5000", A, { seen: 10, explicit: true }),
  ] as Op[]);
  return {
    aFirst: { a: shown(aFirst, 21), b: shown(aFirst, 31), end: values(aFirst) },
    bFirst: { a: shown(bFirst, 31), b: shown(bFirst, 21), end: values(bFirst) },
  };
}

describe("both orders, the seven cells (as judge)", () => {
  it("1. A from 11-20 to the next change, B from 11-02: the same end state", () => {
    const end = ['[10-01, 11-02) "5000"', '[11-02, 11-20) "3000"', '[11-20, inf) "5000"'];
    expect(both(["11-20", "next"], ["11-02", "next"])).toEqual({
      aFirst: {
        a: ['corroborated [11-20, inf) "5000"'],
        b: ['applied [11-02, 11-20) "3000"'],
        end,
      },
      bFirst: { a: ['applied [11-20, inf) "5000"'], b: ['applied [11-02, inf) "3000"'], end },
    });
  });

  it("2. both from 11-20 to the next change", () => {
    const end = ['[10-01, 11-20) "5000"', '[11-20, inf) "3000"'];
    expect(both(["11-20", "next"], ["11-20", "next"])).toEqual({
      aFirst: { a: ['corroborated [11-20, inf) "5000"'], b: ['applied [11-20, inf) "3000"'], end },
      bFirst: { a: ['candidate [11-20, inf) "5000"'], b: ['applied [11-20, inf) "3000"'], end },
    });
  });

  it("3. A from 11-20 to the next change, B over [11-02, 11-22)", () => {
    const end = ['[10-01, 11-02) "5000"', '[11-02, 11-22) "3000"', '[11-22, inf) "5000"'];
    expect(both(["11-20", "next"], ["11-02", "11-22"])).toEqual({
      aFirst: {
        a: ['corroborated [11-20, inf) "5000"'],
        b: ['applied [11-02, 11-22) "3000"'],
        end,
      },
      bFirst: {
        a: ['candidate [11-20, 11-22) "5000"', 'corroborated [11-22, inf) "5000"'],
        b: ['applied [11-02, 11-22) "3000"'],
        end,
      },
    });
  });

  it("4. A over [11-20, 11-25), B from 11-02 to the next change", () => {
    expect(both(["11-20", "11-25"], ["11-02", "next"])).toEqual({
      aFirst: {
        a: ['corroborated [11-20, 11-25) "5000"'],
        b: ['applied [11-02, 11-20) "3000"'],
        end: ['[10-01, 11-02) "5000"', '[11-02, 11-20) "3000"', '[11-20, inf) "5000"'],
      },
      bFirst: {
        a: ['candidate [11-20, 11-25) "5000"'],
        b: ['applied [11-02, inf) "3000"'],
        end: ['[10-01, 11-02) "5000"', '[11-02, inf) "3000"'],
      },
    });
  });

  it("5. A over [11-20, 11-25), B over [11-02, 11-22)", () => {
    const end = ['[10-01, 11-02) "5000"', '[11-02, 11-22) "3000"', '[11-22, inf) "5000"'];
    expect(both(["11-20", "11-25"], ["11-02", "11-22"])).toEqual({
      aFirst: {
        a: ['corroborated [11-20, 11-25) "5000"'],
        b: ['applied [11-02, 11-22) "3000"'],
        end,
      },
      bFirst: {
        a: ['candidate [11-20, 11-22) "5000"', 'corroborated [11-22, 11-25) "5000"'],
        b: ['applied [11-02, 11-22) "3000"'],
        end,
      },
    });
  });

  it("6. A over [11-20, 11-25), B over [11-20, 11-22)", () => {
    const end = ['[10-01, 11-20) "5000"', '[11-20, 11-22) "3000"', '[11-22, inf) "5000"'];
    expect(both(["11-20", "11-25"], ["11-20", "11-22"])).toEqual({
      aFirst: {
        a: ['corroborated [11-20, 11-25) "5000"'],
        b: ['applied [11-20, 11-22) "3000"'],
        end,
      },
      bFirst: {
        a: ['candidate [11-20, 11-22) "5000"', 'corroborated [11-22, 11-25) "5000"'],
        b: ['applied [11-20, 11-22) "3000"'],
        end,
      },
    });
  });

  it("7. A from 11-20 to the next change, B over [11-02, 11-10): apart", () => {
    const end = ['[10-01, 11-02) "5000"', '[11-02, 11-10) "3000"', '[11-10, inf) "5000"'];
    expect(both(["11-20", "next"], ["11-02", "11-10"])).toEqual({
      aFirst: {
        a: ['corroborated [11-20, inf) "5000"'],
        b: ['applied [11-02, 11-10) "3000"'],
        end,
      },
      bFirst: {
        a: ['corroborated [11-20, inf) "5000"'],
        b: ['applied [11-02, 11-10) "3000"'],
        end,
      },
    });
  });
});

describe("merged, and the current version", () => {
  it("the changed part resolved again on the current state: shorter than seen", () => {
    const ev = evaluate(STATE, [
      BASE,
      put(20, "3000", ["11-02", "next"], { seen: 10 }),
      put(30, "7000", ["11-25", "next"], { seen: 10 }),
      put(40, "5000", ["11-20", "next"], { seen: 10, explicit: true }),
    ] as Op[]);
    expect(shown(ev, 41)).toEqual(['applied [11-20, 11-25) "5000"']);
  });

  it("all of it the same now, shorter than seen: corroborated, nothing in effect", () => {
    const ev = evaluate(STATE, [
      BASE,
      put(20, "3000", ["11-25", "next"], { seen: 10 }),
      put(30, "5000", ["11-20", "next"], { seen: 10, explicit: true }),
    ] as Op[]);
    expect(shown(ev, 31)).toEqual(['corroborated [11-20, 11-25) "5000"']);
  });

  it("two changes since the seen version: corroborated up to the nearer one", () => {
    const ev = evaluate(STATE, [
      BASE,
      put(20, "3000", ["11-25", "next"], { seen: 10 }),
      put(30, "4000", ["11-22", "next"], { seen: 20, current: true }),
      put(40, "5000", ["11-20", "next"], { seen: 10, explicit: true }),
    ] as Op[]);
    expect(shown(ev, 41)).toEqual(['corroborated [11-20, 11-22) "5000"']);
  });

  it("a ver current after a corroboration sees it: the default end stops at its start", () => {
    const ev = (current: boolean) =>
      evaluate(STATE, [
        BASE,
        put(20, "5000", ["11-20", "11-25"], { seen: 10, explicit: true }),
        put(30, "5000", ["11-10", "next"], { seen: 10, current, explicit: true }),
      ] as Op[]);
    expect(shown(ev(true), 31)).toEqual(['corroborated [11-10, 11-20) "5000"']);
    // Not current, it saw #10 only: on to the end of time.
    expect(shown(ev(false), 31)).toEqual(['corroborated [11-10, inf) "5000"']);
  });
});

describe("acknowledge with a ver not current when written, in a deletion's replay (08 «P3 前»)", () => {
  it("takes effect once the change it waited on is deleted: pinned as it is", () => {
    // #10 5000 from 10-01; #15 4000 from 11-10; #20 3000 over [12-01, 12-05) (source S20). #30,
    // from #15 (no longer current: no seenCurrent), 6000 over [11-02, 11-20) with acknowledge,
    // erasing 11-10: awaiting. Without the key, "not current when written" and an old log read
    // the same, so the replay after S20 is deleted judges "anything in effect since #15?" again,
    // finds nothing, and #30 is in effect. Whether a stale acknowledge stays as recorded is open.
    const ack = (op: number): WriteOp => ({
      ...put(op, "6000", ["11-02", "11-20"], { seen: 15 }),
      acknowledge: ["overwrite"],
    });
    const ops = [
      BASE,
      put(15, "4000", ["11-10", "open"]),
      put(20, "3000", ["12-01", "12-05"]),
      ack(30),
    ] as Op[];
    expect(shown(evaluate(STATE, ops), 31)).toEqual(['awaiting [11-02, 11-20) "6000"']);
    expect(shown(evaluate(STATE, ops, ["S20"]), 31)).toEqual(['applied [11-02, 11-20) "6000"']);
  });
});
