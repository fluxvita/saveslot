import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkPathSyntax, matchPathAll, VOCABULARY } from "./vocabulary.ts";

const word = fc.stringMatching(/^[a-z_]{1,12}$/);
const shortNumber = fc.integer({ min: 1, max: 1_000_000 }).map(String);
const index = fc.nat({ max: Number.MAX_SAFE_INTEGER }).map(String);
const tableId = shortNumber.map((n) => `t${n}`);
const fieldId = shortNumber.map((n) => `f${n}`);
const validSegment = fc.oneof(word, index, tableId, fieldId);

/** An independent oracle for one segment: written differently from the implementation. */
function segmentOk(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (ch.charCodeAt(0) > 0x7f) return false;
  const isNumber = (t: string) =>
    t !== "" && String(Number(t)) === t && Number.isSafeInteger(Number(t));
  if (isNumber(s)) return Number(s) >= 0;
  if ((s[0] === "t" || s[0] === "f") && isNumber(s.slice(1))) return Number(s.slice(1)) >= 1;
  return [...s].every((ch) => ch === "_" || (ch >= "a" && ch <= "z"));
}

describe("checkPathSyntax (properties)", () => {
  it("accepts every path built from valid segments and returns them in order", () => {
    fc.assert(
      fc.property(fc.array(validSegment, { minLength: 1, maxLength: 6 }), (segments) => {
        const result = checkPathSyntax(segments.join("/"));
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.segments.map((s) => s.text)).toEqual(segments);
      }),
    );
  });

  it("agrees with an independent oracle on arbitrary strings", () => {
    const alphabet = fc.constantFrom(..."aft_z0129/-.é 　".split(""), "😀", "T", "F");
    const path = fc.oneof(
      fc.string({ unit: alphabet, maxLength: 16 }),
      fc.string({ unit: "grapheme", maxLength: 16 }),
      fc.array(validSegment, { minLength: 1, maxLength: 4 }).map((s) => s.join("/")),
    );
    fc.assert(
      fc.property(path, (p) => {
        const expected = p.length > 0 && p.split("/").every(segmentOk);
        expect(checkPathSyntax(p).ok).toBe(expected);
      }),
    );
  });

  it("rejects an index or a short ID with a leading zero", () => {
    fc.assert(
      fc.property(
        fc.array(validSegment, { maxLength: 3 }),
        fc.constantFrom("", "t", "f"),
        fc.nat({ max: 1_000_000 }),
        fc.array(validSegment, { maxLength: 3 }),
        (before, prefix, n, after) => {
          const bad = `${prefix}0${n}`;
          expect(checkPathSyntax([...before, bad, ...after].join("/")).ok).toBe(false);
        },
      ),
    );
  });

  it("rejects any path containing a non-ASCII character", () => {
    // One non-ASCII code point (BMP or astral), as fast-check's default strings are ASCII-only.
    const nonAscii = fc
      .oneof(fc.integer({ min: 0x80, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0x10ffff }))
      .map((cp) => String.fromCodePoint(cp));
    fc.assert(
      fc.property(
        fc.array(validSegment, { minLength: 1, maxLength: 4 }),
        nonAscii,
        fc.nat(),
        (segs, junk, at) => {
          const p = segs.join("/");
          const i = at % (p.length + 1);
          expect(checkPathSyntax(p.slice(0, i) + junk + p.slice(i)).ok).toBe(false);
        },
      ),
    );
  });
});

describe("matchPath (properties)", () => {
  const entries = Object.entries(VOCABULARY).flatMap(([type, list]) =>
    list.map((entry) => ({ type, entry })),
  );

  it("matches any instantiation of a pattern to that entry only", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...entries),
        tableId,
        fieldId,
        index,
        ({ type, entry }, t, f, n) => {
          const path = entry.path
            .replaceAll("<table>", t)
            .replaceAll("<field>", f)
            .replaceAll("<n>", n);
          expect(matchPathAll(type, path)).toEqual([entry]);
        },
      ),
    );
  });
});
