// A guard on part of the conflict criterion's symmetry (09-references-conflict-sync
// «冲突判据 · 对称»): two writes from the same version, both to the next change, neither pointing
// evidence at a field nor erasing a change point of the version it saw, judged in either order,
// both conflict or both merge, and merged they leave the same values. It covers this subset only,
// not the clause: an explicit interval beside a default end, or a write awaiting for high impact,
// is where the clause says more than the rules give (08 «P3 前»; symmetry.test.ts pins those as
// they are). Its use: judging a corroboration's changed part as written, and `ver.current`, left
// this as it was.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import type { Op, WriteOp } from "@fluxvita/saveslot-reference";
import { DAYS, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { view } from "./judge.ts";
import { judged } from "./scenarios.fixture.ts";
import type { RowState } from "./state.ts";

const RUNS = propRuns(400);

/** A write's interval as given: a start, to the next change. */
const written = fc.nat(DAYS.length - 1).map((from) => ({
  from: { mode: "given" as const, value: DAYS[from] as BizPoint },
  to: { mode: "next_change" as const },
}));
const value = fc.constantFrom("3000", "4000", "5000", "6000");

/**
 * The values of f2, equal neighbours joined: the state as values, not as which write gives them
 * (the two orders give the same values from different writes).
 */
function values(state: RowState): string[] {
  const out: [string | null, string | null, string][] = [];
  for (const s of view(state).fields["f2" as FieldId] ?? []) {
    const from = s.valid[0]?.from ?? null;
    const to = s.valid[s.valid.length - 1]?.to ?? null;
    const v = JSON.stringify(s.value);
    const prev = out[out.length - 1];
    if (prev !== undefined && prev[1] === from && prev[2] === v) prev[1] = to;
    else out.push([from, to, v]);
  }
  return out.map(([f, t, v]) => `${f}..${t} ${v}`);
}

const put = (op: number, v: string, valid: WriteOp["valid"], seen?: number): WriteOp => ({
  kind: "write",
  op,
  event: op + 1,
  ...(seen !== undefined ? { seen } : {}),
  ...(valid !== undefined ? { valid } : {}),
  fields: { f2: { value: v, sources: [`S${op}`] } },
});

describe("two writes from the same version to the next change, no evidence, no point erased", () => {
  it("in either order: both conflict, or both merge into the same values", () => {
    let compared = 0;
    fc.assert(
      fc.property(
        fc.option(fc.tuple(value, written), { nil: undefined }),
        value,
        written,
        value,
        written,
        (before, v1, w1, v2, w2) => {
          // The base, and maybe a change before the version both carry.
          const base: Op[] = [
            put(10, "5000", {
              from: { mode: "given", value: "2026-10-01" as BizPoint },
              to: { mode: "open" },
            }),
            ...(before !== undefined ? [put(15, before[0], before[1], 10)] : []),
          ];
          const ver = before !== undefined ? 15 : 10;
          const run = (a: [string, WriteOp["valid"]], b: [string, WriteOp["valid"]]) => {
            const { steps, refused } = judged(
              STATE,
              [...base, put(20, a[0], a[1], ver), put(30, b[0], b[1], ver)],
              [],
            );
            const last = steps[steps.length - 1];
            return {
              refused: refused.length > 0,
              conflict: steps.some((s) => s.judgement.conflicts.length > 0),
              erased: steps.some((x) => x.judgement.erased.length > 0),
              values: last === undefined ? [] : values(last.state),
            };
          };
          const one = run([v1, w1], [v2, w2]);
          const two = run([v2, w2], [v1, w1]);
          // A write refused (a gap, no value now) is no pair of writes to compare; one erasing a
          // change point it saw is outside this subset.
          if (one.refused || two.refused || one.erased || two.erased) return;
          compared++;
          expect(one.conflict).toBe(two.conflict);
          if (!one.conflict) expect(one.values).toEqual(two.values);
        },
      ),
      { numRuns: RUNS },
    );
    // Most samples are compared, not skipped: a guard that skips them all says nothing.
    expect(compared).toBeGreaterThan(RUNS / 4);
  });
});
