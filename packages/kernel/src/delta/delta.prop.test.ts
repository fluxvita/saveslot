// Properties of `targetDelta` over generated states (the cases to cover are built by the
// generators, not found by chance): the comparison depends on what the states say, never on where
// their segments are cut, and it is exact: its stretches are the days where the sides differ.
//
// The oracle does not call `sameValue`: the values come from a small set sorted into classes
// beforehand (some written two ways), and the oracle compares the classes.

import type { FieldValue } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { targetDelta } from "./delta.ts";
import type { Change, ComparedDelta, EntitySegment, Range, Stretch, TargetState } from "./types.ts";

const DAYS = 12;
const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
type Fid = `f${number}`;
const FIELDS: Fid[] = ["f1", "f2"];

// The classes of value: two writings of one class are the same value, any two of different
// classes are not.
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
  { cls: "KM2", writings: [{ value: "2", unit: "km" }] },
  {
    cls: "T1",
    writings: [
      { instant: "2026-11-01T00:00:00.000Z" as never, zone: "UTC" },
      { zone: "UTC", instant: "2026-11-01T00:00:00.000Z" as never },
    ],
  },
  {
    cls: "T2",
    writings: [{ instant: "2026-11-01T00:00:00.000Z" as never, zone: "Asia/Shanghai" }],
  },
];
const WRITINGS = CLASSES.flatMap((c) => c.writings);
// A value's class, by its writing with the keys in order (not by `sameValue`, which is under test).
const spelled = (v: FieldValue): string =>
  JSON.stringify(
    v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)))
      : v,
  );
const CLASS_OF = new Map(CLASSES.flatMap((c) => c.writings.map((w) => [spelled(w), c.cls])));
const classOf = (v: FieldValue | undefined): string => {
  const cls = CLASS_OF.get(spelled(v as FieldValue));
  if (cls === undefined)
    throw new Error(`a value outside the classes: ${spelled(v as FieldValue)}`);
  return cls;
};
const SOURCES = ["", "s1", "s2"];

type Cut = { values: Record<Fid, FieldValue>; source: Record<Fid, string> } | null;
type Entity = Extract<TargetState, { kind: "entity" }>;

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

/** An entity over days 1..DAYS: pieces cut at generated points, some with no value, some revoked, the last open. */
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
          // A stretch is valued, revoked, or neither (never written or cleared).
          if (c === null) {
            if (gone) revoked.push(range);
          } else segments.push({ ...range, ...c });
        }
        return { kind: "entity" as const, segments, revoked };
      });
  });

/** The same entity cut again: some segment and some revoke split at a point inside it. */
function recut(e: Entity, at: number): Entity {
  const p = day(at);
  const split = <T extends Range>(x: T): T[] =>
    x.from < p && (x.to === null || p < x.to)
      ? [
          { ...x, to: p },
          { ...x, from: p },
        ]
      : [x];
  return { kind: "entity", segments: e.segments.flatMap(split), revoked: e.revoked.flatMap(split) };
}

type Status =
  | { kind: "live"; values: Record<Fid, FieldValue>; source: Record<Fid, string> }
  | { kind: "revoked" }
  | { kind: "absent" };
const at = (e: Entity, d: number): Status => {
  const within = (x: Range) => x.from <= day(d) && (x.to === null || day(d) < x.to);
  const s = e.segments.find(within);
  if (s !== undefined) return { kind: "live", values: s.values, source: s.source };
  return e.revoked.some(within) ? { kind: "revoked" } : { kind: "absent" };
};

/** The stretch a day is in, of a field's (or existence's) delta. */
const stretchOn = (d: ComparedDelta | undefined, n: number): Stretch | undefined =>
  (d?.stretches ?? []).find((s) => day(n) >= s.from && (s.to === null || day(n) < s.to));

const compared = (ds: ReturnType<typeof targetDelta>): ComparedDelta[] =>
  ds.map((d) => {
    if (!d.comparable) throw new Error("every position compares in this version");
    return d;
  });

describe("targetDelta properties (entity)", () => {
  it("is nothing between a state and itself or its re-cut", () => {
    fc.assert(
      fc.property(entityArb, fc.integer({ min: 2, max: DAYS }), (e, point) => {
        expect(targetDelta(e, e)).toEqual([]);
        expect(targetDelta(e, recut(e, point))).toEqual([]);
        expect(targetDelta(recut(e, point), e)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("is the same whatever either side's cut", () => {
    fc.assert(
      fc.property(
        entityArb,
        entityArb,
        fc.integer({ min: 2, max: DAYS }),
        fc.integer({ min: 2, max: DAYS }),
        (b, a, x, y) => {
          expect(targetDelta(recut(b, x), recut(a, y))).toEqual(targetDelta(b, a));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("gives exactly the days where the sides differ, with their conclusion and what each side held", () => {
    fc.assert(
      fc.property(entityArb, entityArb, (b, a) => {
        const ds = compared(targetDelta(b, a));
        for (let n = 1; n <= DAYS + 1; n++) {
          const [x, y] = [at(b, n), at(a, n)];
          // Existence: the presence of the two sides differs (absent, live, revoked).
          const gone = stretchOn(
            ds.find((d) => d.field === "existence"),
            n,
          );
          expect(gone !== undefined).toBe(x.kind !== y.kind);
          if (gone !== undefined) {
            const flag = (k: Status["kind"]) => (k === "absent" ? undefined : k === "live");
            expect(gone.before).toBe(flag(x.kind));
            expect(gone.after).toBe(flag(y.kind));
          }
          for (const f of FIELDS) {
            const s = stretchOn(
              ds.find((d) => d.field === f),
              n,
            );
            let want: Change = "none";
            if (x.kind === "live" && y.kind === "live") {
              want =
                classOf(x.values[f]) !== classOf(y.values[f])
                  ? "value"
                  : x.source[f] !== y.source[f]
                    ? "source_only"
                    : "none";
            } else if (x.kind === "live" || y.kind === "live") {
              // One side has no value: a change, unless the side that has one holds an empty one.
              const there =
                x.kind === "live"
                  ? x.values[f]
                  : (y as { values: Record<Fid, FieldValue> }).values[f];
              want = classOf(there) === "N" ? "none" : "value";
            }
            expect(s?.change ?? "none").toBe(want);
            if (s === undefined) continue;
            // What the stretch says each side held there is what that side held on this day,
            // whatever the days around it held: a stretch run together too far fails here.
            if (x.kind === "live")
              expect(classOf(s.before as FieldValue)).toBe(classOf(x.values[f]));
            else expect(s.before).toBeUndefined();
            if (y.kind === "live")
              expect(classOf(s.after as FieldValue)).toBe(classOf(y.values[f]));
            else expect(s.after).toBeUndefined();
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  it("runs stretches together as far as they can: no two neighbours with one conclusion and the same values", () => {
    fc.assert(
      fc.property(entityArb, entityArb, (b, a) => {
        for (const d of compared(targetDelta(b, a))) {
          const ss: readonly Stretch[] = d.stretches ?? [];
          const side = (v: FieldValue | undefined) =>
            v === undefined ? "-" : typeof v === "boolean" ? String(v) : classOf(v);
          for (const [i, s] of ss.entries()) {
            const next = ss[i + 1];
            if (next === undefined) continue;
            expect(s.to !== null && s.to <= next.from).toBe(true);
            const together =
              s.to === next.from &&
              s.change === next.change &&
              side(s.before) === side(next.before) &&
              side(s.after) === side(next.after);
            expect(together).toBe(false);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it("swaps before and after when the sides swap", () => {
    fc.assert(
      fc.property(entityArb, entityArb, (b, a) => {
        const swap = (s: Stretch): Stretch => {
          const { before, after, ...rest } = s;
          return {
            ...rest,
            ...(after === undefined ? {} : { before: after }),
            ...(before === undefined ? {} : { after: before }),
          };
        };
        const swapped = compared(targetDelta(a, b)).map((d) => ({
          ...d,
          stretches: (d.stretches ?? []).map(swap),
        }));
        expect(swapped).toEqual(
          compared(targetDelta(b, a)).map((d) => ({ ...d, stretches: d.stretches ?? [] })),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("gives the strongest of the stretches as the field's change", () => {
    fc.assert(
      fc.property(entityArb, entityArb, (b, a) => {
        for (const d of compared(targetDelta(b, a)))
          expect(d.change).toBe(
            (d.stretches ?? []).some((s) => s.change === "value") ? "value" : "source_only",
          );
      }),
      { numRuns: 300 },
    );
  });
});

type Row = Extract<TargetState, { kind: "row" }>;
const rowArb: fc.Arbitrary<Row> = fc
  .record({
    presence: fc.constantFrom("absent", "live", "revoked"),
    f1: fc.record({ value: valueArb, source: fc.constantFrom(...SOURCES) }),
    f2: fc.record({ value: valueArb, source: fc.constantFrom(...SOURCES) }),
  })
  .map(({ presence, ...fields }) => ({ kind: "row" as const, presence, fields }));
/** The pairs of presences the version table can show. */
const possible = (b: Row, a: Row) => !(a.presence === "absent" && b.presence !== "absent");

describe("targetDelta properties (row)", () => {
  it("is nothing between a state and itself", () => {
    fc.assert(
      fc.property(rowArb, (r) => {
        expect(targetDelta(r, r)).toEqual([]);
      }),
    );
  });

  it("counts existence and fields apart", () => {
    fc.assert(
      fc.property(
        rowArb.chain((b) => rowArb.map((a) => [b, a] as const)).filter(([b, a]) => possible(b, a)),
        ([b, a]) => {
          const ds = compared(targetDelta(b, a));
          // Existence: the presence differs, absent to live included; none from an absent side.
          const e = ds.find((d) => d.field === "existence");
          expect(e !== undefined).toBe(b.presence !== a.presence);
          if (e !== undefined) {
            const flag = (p: Row["presence"]) => (p === "absent" ? undefined : p === "live");
            expect(e.before).toBe(flag(b.presence));
            expect(e.after).toBe(flag(a.presence));
          }
          for (const f of FIELDS) {
            const [x, y] = [
              b.presence === "absent" ? undefined : b.fields[f],
              a.presence === "absent" ? undefined : a.fields[f],
            ];
            let want: Change = "none";
            if (x !== undefined && y !== undefined)
              want =
                classOf(x.value) !== classOf(y.value)
                  ? "value"
                  : x.source !== y.source
                    ? "source_only"
                    : "none";
            else if (y !== undefined && classOf(y.value) !== "N") want = "value";
            expect(ds.find((d) => d.field === f)?.change ?? "none").toBe(want);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("refuses the presences the version table cannot show", () => {
    fc.assert(
      fc.property(
        rowArb.chain((b) => rowArb.map((a) => [b, a] as const)).filter(([b, a]) => !possible(b, a)),
        ([b, a]) => {
          expect(() => targetDelta(b, a)).toThrow(RangeError);
        },
      ),
    );
  });
});
