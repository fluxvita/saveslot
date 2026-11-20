// Differential property test: our encoder against the `canonicalize` package (Apache-2.0,
// pinned dev dependency), and round-trip properties that hold for any JCS implementation.

import { runInNewContext } from "node:vm";
import referenceCanonicalize from "canonicalize";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, type JcsValue } from "./jcs.ts";

/**
 * `JSON.parse` in a context of its own, the value copied back. The oracle cannot be this
 * context's `JSON.parse`: in the V8 of Node 24 before 24.22.1 (and of 26 before its fix, V8 commit
 * 93cd21e8254b), once an object with a key of one backslash (`"\\"`) has been parsed, a later
 * object whose key at that place is one `\uXXXX` escape gets the key `\` instead. A property run
 * makes both, so the oracle would fail on a writing that is right. A context of its own has no
 * such earlier parse.
 */
const parseApart = (text: string): unknown =>
  structuredClone(runInNewContext("JSON.parse(text)", { text }) as unknown);

const cp = (...points: number[]) => String.fromCodePoint(...points);

/** Characters from tricky ranges: controls, quote, backslash, surrogate pairs, CJK, combining marks. */
const trickyChar = fc.constantFrom(
  ...[0x00, 0x08, 0x1f, 0x22, 0x2f, 0x5c, 0x7f, 0x80, 0x2028, 0xfb33, 0xff61, 0xfeff].map((p) =>
    cp(p),
  ),
  cp(0x65, 0x301),
  "午",
  "饭",
  cp(0x20000),
  cp(0x1f600),
  "a",
  "A",
  "_",
  "1",
);
const trickyString = fc.string({
  unit: fc.oneof(trickyChar, fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 })),
  maxLength: 8,
});

const jsonValue: fc.Arbitrary<JcsValue> = fc.letrec<{ value: JcsValue }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    trickyString,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.dictionary(trickyString, tie("value"), { maxKeys: 5 }),
  ),
})).value;

describe("canonicalize (properties)", () => {
  it("matches the canonicalize package on JSON values", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(canonicalize(value)).toBe(referenceCanonicalize(value));
      }),
      { numRuns: 2000 },
    );
  });

  it("is a fixed point: parsing the output and canonicalizing again gives the same text", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const text = canonicalize(value);
        expect(canonicalize(parseApart(text) as JcsValue)).toBe(text);
      }),
    );
  });

  it("does not depend on key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(trickyString, jsonValue, { maxKeys: 6 }), (dict) => {
        const reversed = Object.fromEntries(Object.entries(dict).reverse());
        expect(canonicalize(reversed)).toBe(canonicalize(dict));
      }),
    );
  });
});
