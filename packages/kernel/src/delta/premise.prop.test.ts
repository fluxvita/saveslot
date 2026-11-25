// `premiseDelta` against a direct reading of 02-integrity «写入的前提» «什么算前提变了», day by day: a
// premise changed on a day of its scope exactly when, on a declared field, the value that day is not
// the value seen, or a revoke is on either side that day (any difference in existence, on the whole
// row). Neither `targetDelta` nor `sameValue` is used by the oracle: values come from a small set
// sorted into classes beforehand (some written two ways), and the oracle compares the classes.

import { writeFileSync } from "node:fs";
import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type PremiseScope, premiseDelta } from "./premise.ts";
import type { EntitySegment, Range, Stretch, TargetState } from "./types.ts";

const DAYS = 12;
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
const FIELDS = ["f1", "f2"] as FieldId[];

const CLASSES: { cls: string; writings: FieldValue[] }[] = [
  { cls: "A", writings: ["a"] },
  { cls: "B", writings: ["b"] },
  { cls: "N", writings: [null] },
  {
    cls: "KM1",
    writings: [
      { value: "1", unit: "km" },
      { unit: "km", value: "1" },
    ],
  },
];
const WRITINGS = CLASSES.flatMap((c) => c.writings);
const spelled = (v: FieldValue): string =>
  JSON.stringify(
    v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)))
      : v,
  );
const CLASS_OF = new Map(CLASSES.flatMap((c) => c.writings.map((w) => [spelled(w), c.cls])));
const classOf = (v: FieldValue): string => CLASS_OF.get(spelled(v)) as string;
const SOURCES = ["", "s1", "s2"];

type Entity = Extract<TargetState, { kind: "entity" }>;
type Row = Extract<TargetState, { kind: "row" }>;
type Cut = { values: Record<string, FieldValue>; source: Record<string, string> } | null;

const valueArb = fc.constantFrom(...WRITINGS);
const cutArb: fc.Arbitrary<Cut> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  {
    weight: 4,
    arbitrary: fc.record({
      values: fc.record({ f1: valueArb, f2: valueArb }),
      source: fc.record({ f1: fc.constantFrom(...SOURCES), f2: fc.constantFrom(...SOURCES) }),
    }),
  },
);
const entityArb: fc.Arbitrary<Entity> = fc
  .uniqueArray(fc.integer({ min: 2, max: DAYS }), { maxLength: 6 })
  .chain((points) => {
    const cuts = [1, ...[...points].sort((a, b) => a - b)];
    return fc
      .array(fc.tuple(cutArb, fc.boolean()), { minLength: cuts.length, maxLength: cuts.length })
      .map((cs) => {
        const segments: EntitySegment[] = [];
        const revoked: Range[] = [];
        for (const [i, from] of cuts.entries()) {
          const next = cuts[i + 1];
          const range = { from: day(from), to: next === undefined ? null : day(next) };
          const [c, gone] = cs[i] as [Cut, boolean];
          if (c === null) {
            if (gone) revoked.push(range);
          } else segments.push({ ...range, ...c });
        }
        return { kind: "entity" as const, segments, revoked };
      });
  });

/** A seen state and a later one: the later one often the seen one with a few days rewritten. */
const pairArb: fc.Arbitrary<[Entity, Entity]> = fc.oneof(
  fc.tuple(entityArb, entityArb),
  fc
    .tuple(
      entityArb,
      entityArb,
      fc.integer({ min: 1, max: DAYS }),
      fc.integer({ min: 1, max: DAYS }),
    )
    .map(([seen, other, x, y]): [Entity, Entity] => {
      // Days [lo, hi) taken from `other`, the rest from `seen`.
      const [lo, hi] = [day(Math.min(x, y)), day(Math.max(x, y) + 1)];
      const clip = <T extends Range>(r: T, from: string, to: string | null): T[] => {
        const f = r.from > from ? r.from : from;
        const t = r.to === null ? to : to === null ? r.to : r.to < to ? r.to : to;
        return t === null || f < t ? [{ ...r, from: f, to: t }] : [];
      };
      const outside = <T extends Range>(r: T): T[] => [
        ...clip(r, day(1), lo),
        ...clip(r, hi, null),
      ];
      return [
        seen,
        {
          kind: "entity",
          segments: [
            ...seen.segments.flatMap(outside),
            ...other.segments.flatMap((s) => clip(s, lo, hi)),
          ],
          revoked: [
            ...seen.revoked.flatMap(outside),
            ...other.revoked.flatMap((r) => clip(r, lo, hi)),
          ],
        },
      ];
    }),
);

const scopeArb: fc.Arbitrary<PremiseScope> = fc.record(
  {
    fields: fc.subarray(FIELDS, { minLength: 1 }),
    range: fc.oneof(
      fc.integer({ min: 1, max: DAYS + 1 }).map((n) => ({ at: day(n) })),
      fc
        .tuple(
          fc.integer({ min: 1, max: DAYS + 1 }),
          fc.option(fc.integer({ min: 1, max: DAYS + 1 })),
        )
        .filter(([a, b]) => b === null || a < b)
        .map(([a, b]) => ({ from: day(a), to: b === null ? null : day(b) })),
    ),
  },
  { requiredKeys: [] },
);

type Status = { kind: "live"; values: Record<string, FieldValue> } | { kind: "revoked" | "absent" };
const at = (e: Entity, n: number): Status => {
  const within = (x: Range) => x.from <= day(n) && (x.to === null || day(n) < x.to);
  const s = e.segments.find(within);
  if (s !== undefined) return { kind: "live", values: s.values };
  return { kind: e.revoked.some(within) ? "revoked" : "absent" };
};
/** A field's class that day; no value and an empty value are alike (a field cannot show the difference). */
const valueOn = (s: Status, f: string): string =>
  s.kind === "live" ? classOf(s.values[f] as FieldValue) : "N";

const inScope = (scope: PremiseScope, n: number): boolean => {
  const r = scope.range;
  if (r === undefined) return true;
  if ("at" in r) return r.at === day(n);
  return r.from <= day(n) && (r.to === null || day(n) < r.to);
};
const covers = (ss: readonly Stretch[] | undefined, n: number) =>
  (ss ?? []).some((s) => s.from <= day(n) && (s.to === null || day(n) < s.to));

const stats = {
  runs: 0,
  changed: 0,
  unchanged: 0,
  revokes: 0,
  sameValueDays: 0,
  // A declared field that had a value and has none, with no revoke on either side: a change.
  goneWithoutRevoke: 0,
};

describe("premiseDelta against the criterion, day by day (entity)", () => {
  it("is empty exactly when no declared field nor a revoke differs on a day of the scope, and gives those days", () => {
    fc.assert(
      fc.property(pairArb, scopeArb, ([seen, now], scope) => {
        const ds = premiseDelta(seen, now, scope);
        const fields = scope.fields ?? FIELDS;
        let any = false;
        for (let n = 1; n <= DAYS + 1; n++) {
          if (!inScope(scope, n)) continue;
          const [x, y] = [at(seen, n), at(now, n)];
          const revoke = x.kind !== y.kind && (x.kind === "revoked" || y.kind === "revoked");
          const existence = scope.fields === undefined ? x.kind !== y.kind : revoke;
          if (revoke) stats.revokes++;
          const gone = ds.find((d) => d.field === "existence");
          expect(covers(gone?.comparable ? gone.stretches : undefined, n)).toBe(existence);
          any ||= existence;
          for (const f of fields) {
            const differs = valueOn(x, f) !== valueOn(y, f);
            if (scope.fields !== undefined && x.kind === "live" && y.kind === "absent" && differs)
              stats.goneWithoutRevoke++;
            if (!differs && x.kind === "live" && y.kind === "live") stats.sameValueDays++;
            const d = ds.find((e) => e.field === f);
            expect(covers(d?.comparable ? d.stretches : undefined, n)).toBe(differs);
            any ||= differs;
          }
        }
        for (const d of ds) {
          expect(d.field === "existence" || fields.includes(d.field as FieldId)).toBe(true);
          // Within the scope only: a stretch out of it would show a change the premise is not on.
          if (d.comparable && scope.range !== undefined && !("at" in scope.range))
            for (const s of d.stretches ?? []) {
              expect(s.from >= scope.range.from).toBe(true);
              if (scope.range.to !== null)
                expect(s.to !== null && s.to <= scope.range.to).toBe(true);
            }
          if (d.comparable) for (const s of d.stretches ?? []) expect(s.change).toBe("value");
        }
        expect(ds.length > 0).toBe(any);
        stats.runs++;
        if (any) stats.changed++;
        else stats.unchanged++;
      }),
      { numRuns: 1500 },
    );
    // The generator reaches both conclusions and revokes: a degraded one would make this pass empty.
    expect(stats.changed).toBeGreaterThan(stats.runs / 10);
    expect(stats.unchanged).toBeGreaterThan(stats.runs / 10);
    expect(stats.revokes).toBeGreaterThan(0);
    expect(stats.goneWithoutRevoke).toBeGreaterThan(0);
    // DELTA_STATS=<file>: the counts of a run, for a pull request.
    const out = process.env["DELTA_STATS"];
    if (out !== undefined) writeFileSync(out, `${JSON.stringify(stats)}\n`);
  });
});

const rowArb: fc.Arbitrary<Row> = fc
  .record({
    presence: fc.constantFrom("live", "revoked"),
    f1: fc.record({ value: valueArb, source: fc.constantFrom(...SOURCES) }),
    f2: fc.record({ value: valueArb, source: fc.constantFrom(...SOURCES) }),
  })
  .map(({ presence, ...fields }) => ({ kind: "row" as const, presence, fields }));

describe("premiseDelta against the criterion (row)", () => {
  it("is empty exactly when no declared field's value nor the row's revoke differs", () => {
    fc.assert(
      fc.property(
        rowArb,
        rowArb,
        fc.option(fc.subarray(FIELDS, { minLength: 1 })),
        (seen, now, fs) => {
          const scope: PremiseScope = fs === null ? {} : { fields: fs };
          const ds = premiseDelta(seen, now, scope);
          const fields = fs ?? FIELDS;
          const want = [
            ...(seen.presence !== now.presence ? ["existence"] : []),
            ...fields.filter(
              (f) =>
                classOf(seen.fields[f]?.value as FieldValue) !==
                classOf(now.fields[f]?.value as FieldValue),
            ),
          ];
          expect(ds.map((d) => d.field)).toEqual(want);
        },
      ),
      { numRuns: 500 },
    );
  });
});
