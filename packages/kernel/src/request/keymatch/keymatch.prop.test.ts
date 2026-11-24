// Properties of keymatch@1 (docs/zh-CN/spec/03-data-model/10-types-and-units.md «相近的键») on keys
// mixing ASCII, CJK, full-width forms, combining marks, characters beyond the BMP and white space:
// the distance is a metric over code points; comparing is symmetric; `fold` exactly when the folded
// forms are equal; each level only with its lengths. (N need not be idempotent: case folding may
// leave a form NFKC would change, and the criterion compares code points without normalizing again.)

import { Hits, propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { distance, distanceWithin, foldKey, matchText } from "./index.ts";

const RUNS = propRuns(400);
const CHARS = [
  "a",
  "b",
  "c",
  "A",
  "B",
  "q",
  "4",
  "推",
  "广",
  "预",
  "算",
  "房",
  "租",
  "贷",
  "Ａ",
  "ｂ",
  "４",
  "́",
  "̈",
  "é",
  "e",
  "ẞ",
  "ß",
  "ﬁ",
  "𠀀",
  "𠀁",
  " ",
  "　",
  " ",
  "\t",
];
const key = fc
  .array(fc.constantFrom(...CHARS), { minLength: 0, maxLength: 9 })
  .map((x) => x.join(""));
/**
 * A key and a second one made from it by one or two small changes (a case or width changed, white
 * space put in, a character replaced, dropped or added, a prefix or suffix): alike often, at every
 * level, and not alike when the changes add up.
 */
const VARIANTS: Record<string, string> = {
  a: "A",
  b: "Ｂ",
  q: "Q",
  "4": "４",
  推: "推",
  é: "e\u0301",
  ẞ: "ß",
};
const change = fc.oneof(
  fc.record({ t: fc.constant("swap" as const), at: fc.nat() }),
  fc.record({
    t: fc.constant("space" as const),
    at: fc.nat(),
    c: fc.constantFrom(" ", "\u3000", "\t"),
  }),
  fc.record({ t: fc.constant("replace" as const), at: fc.nat(), c: fc.constantFrom(...CHARS) }),
  fc.record({ t: fc.constant("drop" as const), at: fc.nat() }),
  fc.record({ t: fc.constant("add" as const), at: fc.nat(), c: fc.constantFrom(...CHARS) }),
  fc.record({
    t: fc.constant("affix" as const),
    end: fc.boolean(),
    c: fc.constantFrom("预算", "Q4", "x"),
  }),
);
const pair = fc.tuple(key, fc.array(change, { minLength: 1, maxLength: 2 })).map(([a, changes]) => {
  let b = [...a];
  for (const c of changes) {
    const at = "at" in c && b.length > 0 ? c.at % b.length : 0;
    if (c.t === "swap" && b.length > 0) b[at] = VARIANTS[b[at] as string] ?? (b[at] as string);
    else if (c.t === "space" || c.t === "add") b.splice(at, 0, c.c);
    else if (c.t === "replace" && b.length > 0) b[at] = c.c;
    else if (c.t === "drop") b.splice(at, 1);
    else if (c.t === "affix") b = c.end ? [...b, c.c] : [c.c, ...b];
  }
  return [a, b.join("")] as [string, string];
});
const cps = fc.array(fc.constantFrom(1, 2, 3, 0x20000), { maxLength: 8 });

describe("keymatch@1, properties", () => {
  it("the distance: 0 exactly on equal sequences, symmetric, the triangle inequality", () => {
    const hits = new Hits(0.5);
    fc.assert(
      fc.property(
        cps,
        cps,
        cps,
        hits.track((a, b, c) => {
          const ab = distance(a, b);
          expect(ab === 0).toBe(a.join() === b.join());
          expect(distance(b, a)).toBe(ab);
          expect(distance(a, c)).toBeLessThanOrEqual(ab + distance(b, c));
          if (ab > 0) hits.hit();
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("comparing is symmetric; fold exactly when the folded forms are equal; each level only with its lengths", () => {
    // Hit: the two keys are alike at some level.
    const hits = new Hits(0.2);
    fc.assert(
      fc.property(
        pair,
        hits.track(([a, b]) => {
          const m = matchText(a, b);
          expect(matchText(b, a)).toEqual(m);
          const x = foldKey(a);
          const y = foldKey(b);
          expect(m?.match === "fold").toBe(x.join() === y.join());
          const short = Math.min(x.length, y.length);
          if (m?.match === "affix") expect(short).toBeGreaterThanOrEqual(2);
          if (m?.match === "edit") {
            expect(short).toBeGreaterThanOrEqual(3);
            expect(m.distance).toBeLessThanOrEqual(short >= 8 ? 2 : 1);
          }
          if (m !== undefined) {
            hits.hit();
            expect(m.distance).toBe(distance(x, y));
          }
        }),
      ),
      {
        numRuns: RUNS,
        examples: [
          [["q4 推广", "Q4推广"]],
          [["Q4推广预算", "Q4推广"]],
          [["marketting", "marketing"]],
        ],
      },
    );
    hits.check();
  });

  it("the bounded distance is the distance up to its bound, the bound plus one beyond", () => {
    fc.assert(
      fc.property(cps, cps, fc.nat({ max: 3 }), (a, b, k) => {
        expect(distanceWithin(a, b, k)).toBe(Math.min(distance(a, b), k + 1));
      }),
      { numRuns: RUNS },
    );
  });

  it("lengths are code points: a character beyond the BMP counts one", () => {
    expect(foldKey("𠀀𠀁")).toHaveLength(2);
    expect(distance(foldKey("𠀀𠀀𠀀"), foldKey("𠀀𠀀𠀁"))).toBe(1);
    expect(matchText("𠀀𠀀𠀀", "𠀀𠀀𠀁")?.match).toBe("edit");
  });
});
