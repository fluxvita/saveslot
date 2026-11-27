// apply's `settle` against judge's view and the reference evaluator (02-architecture §11 «测试矩阵»):
// three implementations of "which item is in effect at a point" held together. Each step of the
// judged scenarios is settled from the items in effect after it (with their registrations), and
// must give the values, the items giving them, the gaps and the existence that judge's `view` and
// the reference evaluator give for the same log. Here because `write` may import both `apply` and
// `judge`; `apply` itself does not depend on `judge`.

import type { FieldId } from "@fluxvita/saveslot-contract-core";
import { evaluateLog } from "@fluxvita/saveslot-reference";
import { EVENT, Hits, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { type Settled, type SettleItem, settle } from "../apply/settle.ts";
import { view } from "../judge/judge.ts";
import { judged, scenario } from "../judge/scenarios.fixture.ts";
import { EVERYTHING, type RowState } from "../judge/state.ts";
import { givesVersion } from "../judge/versions.ts";
import { canonical, type IntervalSet, meet, minus, WHOLE } from "../time/index.ts";

vi.setConfig({ testTimeout: 60_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 50_000, markInterruptAsFailure: true });

const RUNS = propRuns(1500);

/** The row's items in effect with their registrations, as apply reads them from storage. */
function settleItems(state: RowState): SettleItem[] {
  return state.items
    .filter((x) => x.status === "applied" || x.status === "corroborated")
    .map((x) => ({
      event: x.event,
      target: x.target,
      k: x.k,
      status: x.status as "applied" | "corroborated",
      valid: x.valid,
      content: x.content,
      reverted: state.registrations(x, EVERYTHING).map((r) => ({ op: r.op, valid: r.valid })),
    }))
    .sort((a, b) => a.event - b.event || a.target.localeCompare(b.target) || a.k - b.k);
}

type Stretch = {
  valid: IntervalSet;
  value: unknown;
  by?: { event: number; target: string; k: number };
};
type View = {
  exists: boolean;
  gaps: IntervalSet;
  fields: Partial<Record<FieldId, readonly Stretch[]>>;
};

/** What settle gives, in the shape of judge's view, on the fields the view lists. */
function asView(s: Settled, isState: boolean, fields: readonly FieldId[]): View {
  // A null cell names the no-value item emptying it; judge's view gives an empty stretch no item.
  const stretch = (c: Settled["cells"][number]): Stretch => ({
    valid: [isState ? (c.valid ?? WHOLE) : WHOLE],
    value: c.value,
    ...(c.by !== null && c.value !== null ? { by: c.by } : {}),
  });
  if (isState) {
    // Where the entity has no value, cells only say why (a required field's no-value item, a
    // revoke's existence cell); the view lists fields where it has one.
    const has = canonical(s.rows.map((r) => r.valid ?? WHOLE));
    const inHas = (c: Settled["cells"][number]) => meet(has, [c.valid ?? WHOLE]).length > 0;
    return {
      exists: s.rows.length > 0,
      gaps: minus([WHOLE], has),
      fields: Object.fromEntries(
        fields.map((f) => [
          f,
          merged(s.cells.filter((c) => c.field === f && inHas(c)).map(stretch)),
        ]),
      ),
    };
  }
  const exists = s.rows.length === 1 && s.rows[0]?.revoked === false;
  return {
    exists,
    gaps: [],
    fields: exists
      ? Object.fromEntries(
          fields.map((f) => [f, s.cells.filter((c) => c.field === f).map(stretch)]),
        )
      : {},
  };
}

/** Runs touching stretches of the same value and item together (as judge's view does). */
function merged(xs: readonly Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    const a = last?.valid[0];
    const b = x.valid[0];
    if (
      last !== undefined &&
      a !== undefined &&
      b !== undefined &&
      a.to !== null &&
      a.to === b.from &&
      JSON.stringify([last.value, last.by]) === JSON.stringify([x.value, x.by])
    ) {
      out[out.length - 1] = { ...last, valid: [{ from: a.from, to: b.to }] };
    } else out.push(x);
  }
  return out;
}

const plain = (v: { exists: boolean; gaps: IntervalSet; fields: object }) =>
  JSON.parse(JSON.stringify({ exists: v.exists, gaps: v.gaps, fields: v.fields })) as unknown;

/** The version-table cells of a settled row/entity, keyed as write-base.ts compares them. */
const cellKeys = (s: Settled): string =>
  JSON.stringify(
    s.cells
      .map((c) =>
        JSON.stringify([
          c.field,
          c.valid?.from ?? null,
          c.valid?.to ?? null,
          c.by === null ? null : [c.by.event, c.by.target, c.by.k],
          c.noValue === true,
          c.revoked === true,
        ]),
      )
      .sort(),
  );

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

describe.each(both)("%s table", (_, schema, isState) => {
  it("settle gives the row or entity judge's view and the reference evaluator give, step by step", () => {
    const hits = new Hits(0.15);
    const seen = { samples: 0, registered: 0, revoked: 0, gaps: 0, uncovered: 0 };
    fc.assert(
      fc.property(
        scenario(isState),
        hits.track(({ ops, decisions }) => {
          const { table, steps } = judged(schema, ops, decisions);
          seen.samples++;
          const sample = { registered: false, revoked: false, gaps: false, uncovered: false };
          let prevCells: string | undefined;
          steps.forEach((step, n) => {
            const items = settleItems(step.state);
            if (items.some((x) => x.reverted.length > 0)) sample.registered = true;
            if (items.some((x) => x.content.kind === "uncovered")) sample.uncovered = true;
            const settled = settle(
              { kind: table.kind, fields: table.fields, required: table.valued },
              items,
            );
            const nowCells = cellKeys(settled);
            if (n > 0) {
              expect({
                step: n,
                gives: givesVersion(steps[n - 1]?.state, step),
              }).toEqual({
                step: n,
                gives: nowCells !== prevCells,
              });
            }
            prevCells = nowCells;
            const v = view(step.state);
            const fields = Object.keys(v.fields).sort() as FieldId[];
            if (!v.exists && !isState && settled.rows.length > 0) sample.revoked = true;
            if (isState && v.exists && v.gaps.length > 2) sample.gaps = true;
            const got = plain(asView(settled, isState, fields));
            expect(got).toEqual(plain(v));
            // The reference evaluator on the same log, field by field.
            const ref = evaluateLog(
              schema,
              steps.slice(0, n + 1).map((x) => x.op),
            ).final;
            expect(got).toEqual(
              plain({
                exists: ref.exists,
                gaps: ref.gaps as IntervalSet,
                fields: ref.exists || isState ? pick(ref.fields, fields) : {},
              }),
            );
            // Fields the view does not list have no item: settle leaves them empty (a revoked row
            // keeps its values, and the view lists no field of it).
            for (const f of table.fields.filter(
              (x) => (isState || v.exists) && !fields.includes(x),
            )) {
              expect(settled.cells.filter((c) => c.field === f && c.value !== null)).toEqual([]);
            }
          });
          for (const k of ["registered", "revoked", "gaps", "uncovered"] as const) {
            if (sample[k]) seen[k]++;
          }
          if (sample.registered) hits.hit();
        }),
      ),
      { numRuns: RUNS },
    );
    if (process.env["JUDGE_STATS"])
      console.log(schema.kind, JSON.stringify({ ...seen, hits: hits.hits }));
    hits.check();
    // Each situation that tells the implementations apart is reached in a share of the samples
    // (about half the share observed at 1500 samples): registrations, interior gaps, revoked
    // rows, registration-only write-backs.
    expect(seen.registered / seen.samples).toBeGreaterThan(0.15);
    if (isState) {
      expect(seen.gaps / seen.samples).toBeGreaterThan(0.07);
      // At least 6.9 % seen over 5 runs of 1,500: 2 % leaves odds under 1e-12 a run.
      expect(seen.uncovered / seen.samples).toBeGreaterThan(0.02);
    } else expect(seen.revoked / seen.samples).toBeGreaterThan(0.2);
  });
});

function pick(fields: Readonly<Partial<Record<FieldId, unknown>>>, ids: readonly FieldId[]) {
  return Object.fromEntries(ids.map((f) => [f, fields[f] ?? []]));
}
