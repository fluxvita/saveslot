import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonical,
  cut,
  holds,
  type IntervalSet,
  interval,
  isNothing,
  meet,
  minus,
  sameSet,
  unionOf,
  WHOLE,
} from "./interval.ts";

const P = ["2026-11-01", "2026-11-03", "2026-11-05", "2026-11-07"] as BizPoint[];
const point = fc.option(fc.constantFrom(...P), { nil: null });
const set: fc.Arbitrary<IntervalSet> = fc
  .array(fc.record({ from: point, to: point }), { maxLength: 3 })
  .map((xs) => canonical(xs));
/** Membership at every probe point, the open ends included. */
const PROBES = ["2026-10-01", ...P, "2026-11-02", "2026-11-06", "2026-12-01"] as BizPoint[];
const members = (a: IntervalSet) => PROBES.map((p) => holds(a, p));

describe("interval sets", () => {
  it("meet, union and minus agree with membership", () => {
    fc.assert(
      fc.property(set, set, (a, b) => {
        expect(members(meet(a, b))).toEqual(PROBES.map((p) => holds(a, p) && holds(b, p)));
        expect(members(unionOf(a, b))).toEqual(PROBES.map((p) => holds(a, p) || holds(b, p)));
        expect(members(minus(a, b))).toEqual(PROBES.map((p) => holds(a, p) && !holds(b, p)));
      }),
    );
  });

  it("the canonical form joins adjacent and overlapping intervals", () => {
    const a = canonical([
      { from: P[1] as BizPoint, to: P[2] as BizPoint },
      { from: P[0] as BizPoint, to: P[1] as BizPoint },
    ]);
    expect(a).toEqual(interval(P[0] as BizPoint, P[2] as BizPoint));
    expect(sameSet(minus([WHOLE], [WHOLE]), [])).toBe(true);
    expect(isNothing(interval(P[1] as BizPoint, P[1] as BizPoint))).toBe(true);
  });

  it("cut covers the whole timeline in order", () => {
    expect(cut([P[0] as BizPoint, P[1] as BizPoint])).toEqual([
      { from: null, to: P[0] },
      { from: P[0], to: P[1] },
      { from: P[1], to: null },
    ]);
  });
});
