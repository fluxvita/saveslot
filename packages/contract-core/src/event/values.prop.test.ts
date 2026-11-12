import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isRawDecimal } from "./values.ts";

// §1.3: a raw decimal is exactly the text of a JSON number. Oracle: JSON.parse of the bare text
// yields a number (JSON.parse tolerates surrounding whitespace, which a raw decimal may not have).
function isJsonNumberText(s: string): boolean {
  if (s.trim() !== s || s === "") return false;
  try {
    return typeof JSON.parse(s) === "number";
  } catch {
    return false;
  }
}

const numberish = fc.stringMatching(/^[-+]?[0-9.eE+-]{0,8}$/);

describe("raw decimal grammar", () => {
  it("accepts exactly the JSON number texts", () => {
    fc.assert(
      fc.property(numberish, (s) => {
        expect(isRawDecimal(s)).toBe(isJsonNumberText(s));
      }),
      { numRuns: 5000 },
    );
  });

  it("accepts every number JSON.stringify produces", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (n) => {
        expect(isRawDecimal(JSON.stringify(n))).toBe(true);
      }),
    );
  });
});
