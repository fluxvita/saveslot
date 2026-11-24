// The judge compares values through `delta`'s `sameValue` and builds its tokens from `delta`'s
// canonical text. This holds the new test to the one it replaced: over the same values, the old
// comparison (copied from `valueToken` as it was before the change) and the new one agree on every
// pair, and the token is the same text.

import { canonicalize, type FieldValue, type JcsValue } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sameValue } from "../delta/index.ts";
import { valueToken } from "./state.ts";

/** `valueToken` as it was before it was built on `delta`'s `valueText`. */
const oldToken = (v: FieldValue): string => `v:${canonicalize(v as JcsValue)}`;
const oldSame = (a: FieldValue, b: FieldValue): boolean => oldToken(a) === oldToken(b);

const instant = "2026-11-01T00:00:00.000Z" as never;
/** Normalised values of every type: what the judge is given. */
const CORPUS: FieldValue[] = [
  null,
  true,
  false,
  "",
  "a",
  "A",
  "é",
  "é",
  "null",
  "true",
  "0",
  // Decimals and integers as normalised text, scale texts that differ.
  "1.5",
  "1.50",
  "-1.5",
  "0.0",
  "-0",
  "100",
  "1e2",
  // Quantities, by value and by unit; the object's key order does not matter.
  { value: "5", unit: "km" },
  { unit: "km", value: "5" },
  { value: "5.0", unit: "km" },
  { value: "5", unit: "mi" },
  { value: "0", unit: "CNY" },
  // Zoned datetimes: the same instant in different zones is not the same value.
  { instant, zone: "Asia/Shanghai" },
  { zone: "Asia/Shanghai", instant },
  { instant, zone: "UTC" },
  { instant: "2026-11-01T00:00:00.001Z" as never, zone: "UTC" },
  // References, as the IDs they are written with.
  `r_${"a".repeat(26)}`,
  `r_${"b".repeat(26)}`,
  `pi_${"1".repeat(16)}`,
];

const valueArb: fc.Arbitrary<FieldValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.string({ unit: "grapheme", maxLength: 6 }),
  fc.constantFrom(...CORPUS),
  fc.record({
    value: fc.constantFrom("1", "1.0", "2", "-3.25"),
    unit: fc.constantFrom("km", "CNY"),
  }),
  fc.record({
    instant: fc.constantFrom(instant, "2026-12-01T00:00:00.000Z" as never),
    zone: fc.constantFrom("UTC", "Asia/Shanghai"),
  }),
);

describe("the judge's value comparison, old against new", () => {
  it("agrees on every pair of the corpus (decimals of different scale text, zoned datetimes, null, refs)", () => {
    let pairs = 0;
    let same = 0;
    for (const a of CORPUS) {
      for (const b of CORPUS) {
        expect(sameValue(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(oldSame(a, b));
        pairs++;
        if (oldSame(a, b)) same++;
      }
    }
    expect(pairs).toBe(CORPUS.length ** 2);
    // The corpus holds both outcomes, and the pairs that differ only by key order or are the
    // same value written twice (so the agreement is not only on "different").
    expect(same).toBeGreaterThan(CORPUS.length);
    expect(same).toBeLessThan(pairs);
  });

  it("gives the same token as before for every value but the empty one", () => {
    for (const v of CORPUS) if (v !== null) expect(valueToken(v)).toBe(oldToken(v));
  });

  it("reads an empty value as no contribution does, and no other value so", () => {
    // 10-types-and-units «清空字段»: an empty value and no contribution both read empty, the same
    // value. The token of no contribution is "none" (state.ts `token`).
    expect(valueToken(null)).toBe("none");
    for (const v of CORPUS) if (v !== null) expect(valueToken(v)).not.toBe("none");
  });

  it("agrees on generated pairs, and the token's equality is the comparison", () => {
    fc.assert(
      fc.property(valueArb, valueArb, (a, b) => {
        expect(sameValue(a, b)).toBe(oldSame(a, b));
        expect(valueToken(a) === valueToken(b)).toBe(oldSame(a, b));
        if (a !== null) expect(valueToken(a)).toBe(oldToken(a));
        else expect(valueToken(a)).toBe("none");
      }),
      { numRuns: 1000 },
    );
  });
});
