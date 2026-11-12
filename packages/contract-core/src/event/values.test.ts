import { describe, expect, it } from "vitest";
import { isCanonicalDecimal, isCanonicalInteger, isRawDecimal } from "./values.ts";

// §1.2 / §1.3 (R174): canonical decimals for values saveslot computes or converts; raw decimals
// for caller-given values, kept verbatim. A template literal type cannot tell "1.0" from "1", so
// these runtime predicates are where the canonical form is enforced.

describe("decimal predicates", () => {
  it.each(["0", "1", "-1", "45", "5.5", "0.05", "-0.5", "1000", "123.456", "9007199254740993.1"])(
    "%j is canonical and raw",
    (s) => {
      expect(isCanonicalDecimal(s)).toBe(true);
      expect(isRawDecimal(s)).toBe(true);
    },
  );

  it.each(["1.0", "5.50", "-0", "-0.0", "0.0", "01", "00", "-01.5", "1e3", "1E-2", "1.5e+2"])(
    "%j is raw but not canonical",
    (s) => {
      expect(isCanonicalDecimal(s)).toBe(false);
      expect(isRawDecimal(s)).toBe(true);
    },
  );

  it.each(["", "+1", ".5", "1.", "-", "1,5", " 1", "1 ", "NaN", "Infinity", "0x10", "1_000", "５"])(
    "%j is neither",
    (s) => {
      expect(isCanonicalDecimal(s)).toBe(false);
      expect(isRawDecimal(s)).toBe(false);
    },
  );

  it("canonical integers have no fraction, no leading zeros and no -0", () => {
    for (const s of ["0", "3", "-3", "120"]) expect(isCanonicalInteger(s), s).toBe(true);
    for (const s of ["3.0", "3.5", "03", "-0", "+3", "1e2", ""]) {
      expect(isCanonicalInteger(s), s).toBe(false);
    }
  });

  it("the spec's decimal examples are canonical", () => {
    for (const s of ["45", "5.5", "54", "32", "5000", "4000", "0"]) {
      expect(isCanonicalDecimal(s), s).toBe(true);
    }
  });
});
