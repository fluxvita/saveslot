// Properties of a result's text (05-surfaces §5), over strings full of what an attacker would use,
// and over any code point. The writing is checked against a judgment written here on its own: each
// Unicode property by its own pattern, the exceptions by their own rules, not the implementation's.
//   - The writing is exactly the judgment's, and is undone exactly.
//   - Cut back by its number, a rendered result gives exactly its untrusted parts, in order, once
//     their writing is undone; outside the boundaries there is only the wording and the values;
//     the number occurs in the whole text in the tags only.
//   - JSON as written parses to the same value, keys too, and leaves no character of the set as
//     it is but where an exception allows it.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  escapeJson,
  escapeText,
  id,
  type Line,
  name,
  num,
  render,
  t,
  unescapeText,
  untrusted,
} from "./text.ts";
import { UNTRUSTED_NOTICE } from "./texts.ts";

const RUNS = Number(process.env["PROP_RUNS"] ?? 500);
const cp = (...points: number[]) => String.fromCodePoint(...points);
const BS = "\\";

// The judgment, on its own.
const PROPERTIES = [
  /^\p{Cc}$/u,
  /^\p{Cs}$/u,
  /^\p{Default_Ignorable_Code_Point}$/u,
  /^\p{Bidi_Control}$/u,
  /^\p{Noncharacter_Code_Point}$/u,
];
const OTHERS = [0x2028, 0x2029, 0xfff9, 0xfffa, 0xfffb, 0xfffc, 0x2800];
const point = (c: string) => c.codePointAt(0) ?? 0;
const SYNTAX = [BS, '"', "|"];
const ofSet = (c: string) =>
  PROPERTIES.some((r) => r.test(c)) ||
  OTHERS.includes(point(c)) ||
  (!SYNTAX.includes(c) && SYNTAX.some((x) => c.normalize("NFKC").includes(x)));
const blank = (c: string) => /^\p{White_Space}$/u.test(c);
const joiner = (p: number) => p === 0x200c || p === 0x200d;
const presentation = (p: number) => p === 0xfe0e || p === 0xfe0f;
const emoji = (c: string | undefined) =>
  c !== undefined && (/^\p{Emoji}$/u.test(c) || /^\p{Extended_Pictographic}$/u.test(c));
const combining = (c: string) => /^\p{M}$/u.test(c) || /^\p{Emoji_Modifier}$/u.test(c);

/** Where the judgment keeps a character of the set, and where it escapes a combining one. */
function judgedEscapes(cs: readonly string[], short: (c: string) => boolean): boolean[] {
  // A selector kept: U+FE0E or U+FE0F after an emoji not of the set; an ASCII one in a keycap.
  const selectorKept = cs.map((c, i) => {
    const b = cs[i - 1];
    if (!presentation(point(c)) || b === undefined || ofSet(b) || !emoji(b)) return false;
    return point(b) >= 0x80 || point(cs[i + 1] ?? "") === 0x20e3;
  });
  const plainAt = (j: number) => {
    const c = cs[j];
    return c !== undefined && ((!ofSet(c) && !blank(c)) || selectorKept[j] === true);
  };
  const e = cs.map((c, i) => {
    if (!ofSet(c)) return false;
    if (selectorKept[i]) return false;
    if (joiner(point(c)) && plainAt(i - 1) && plainAt(i + 1)) return false;
    return true;
  });
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i] ?? "";
    if (e[i] || !combining(c)) continue;
    if (i === 0 || e[i - 1] || short(cs[i - 1] ?? "")) e[i] = true;
  }
  return e;
}

const SHORT: Readonly<Record<string, string>> = {
  [BS]: BS + BS,
  "\n": `${BS}n`,
  "\t": `${BS}t`,
  "|": `${BS}|`,
};

function judged(s: string): string {
  const cs = Array.from(s);
  const e = judgedEscapes(cs, (c) => c in SHORT);
  return cs
    .map(
      (c, i) =>
        SHORT[c] ?? (e[i] ? `${BS}u{${point(c).toString(16).toUpperCase().padStart(4, "0")}}` : c),
    )
    .join("");
}

/** The escapes in a writing, in order. */
const escapesIn = (w: string) => w.match(/\\(?:\\|n|t|\||u\{[0-9A-F]+\})/g) ?? [];

const anyPoint = fc
  .integer({ min: 0, max: 0x10ffff })
  .map((p) => (p >= 0xd800 && p <= 0xdfff ? String.fromCharCode(p) : cp(p)));
const special = fc.constantFrom(
  ...[
    0x00, 0x0d, 0x7f, 0x85, 0x61c, 0x115f, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x2028, 0x202e,
    0x2060, 0x2062, 0x2066, 0x2069, 0x206a, 0x206f, 0x2800, 0x3164, 0xfe0f, 0xfe64, 0xfe65, 0xfeff,
    0xff1c, 0xff1e, 0xffa0, 0xfff9, 0xfffc, 0xfdd0, 0xe0000, 0xe0069, 0xe007f, 0xe0080, 0xe0100,
    0xe01ef, 0xe01f0, 0xad, 0x338, 0x301, 0x1f3fb, 0x845b, 0x645, 0x627, 0x1f469, 0x1f4bb, 0x2764,
    0x1f3f3, 0x1f308, 0xfe0e, 0xfe00, 0x20e3, 0x31, 0x23, 0xfe68, 0xff3c, 0xff5c, 0xff02,
  ].map((p) => cp(p)),
  String.fromCharCode(0xd800),
  String.fromCharCode(0xdc00),
  "\n",
  "\t",
  "|",
  " ",
  BS,
  `${BS}n`,
  `${BS}u{202E}`,
  "</untrusted-data>",
  `<untrusted-data-${"0".repeat(32)}>`,
);
const nasty = fc
  .array(fc.oneof(special, special, anyPoint, fc.string({ unit: "grapheme", maxLength: 2 })), {
    maxLength: 12,
  })
  .map((xs) => xs.join(""));

describe("the writing of text", () => {
  it("is exactly the judgment's, and is undone exactly", () => {
    fc.assert(
      fc.property(nasty, (s) => {
        const w = escapeText(s);
        expect(w).toBe(judged(s));
        expect(unescapeText(w)).toBe(s);
        // Each escape is the same escape once the text is normalized.
        expect(escapesIn(w.normalize("NFC"))).toEqual(escapesIn(w));
        expect(escapesIn(w.normalize("NFKC"))).toEqual(escapesIn(w));
        // What can stay of the set: presentation selectors, at most one an emoji, and joiners.
        const cs = Array.from(w);
        const kept = cs.filter((c) => ofSet(c));
        expect(kept.every((c) => presentation(point(c)) || joiner(point(c)))).toBe(true);
        expect(kept.filter((c) => presentation(point(c))).length).toBeLessThanOrEqual(
          Array.from(s).filter((c) => emoji(c)).length,
        );
        // Joiners: no more than the places with an ordinary character on both sides.
        const ins = Array.from(s);
        const places = ins.filter((_, i) => i > 0 && i < ins.length - 1).length;
        expect(kept.filter((c) => joiner(point(c))).length).toBeLessThanOrEqual(places);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("a rendered result", () => {
  type Item = { u: string } | { n: string } | { k: number } | { i: string };
  const item: fc.Arbitrary<Item> = fc.oneof(
    nasty.map((u) => ({ u })),
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,15}$/).map((n) => ({ n })),
    fc.integer({ min: -1e6, max: 1e6 }).map((k) => ({ k })),
    fc.constantFrom(`r_${"1".repeat(26)}`, "v57.0").map((i) => ({ i })),
  );
  const writing = (x: Item) => ("u" in x ? "" : "n" in x ? x.n : "k" in x ? String(x.k) : x.i);
  const part = (x: Item) =>
    "u" in x ? untrusted(x.u) : "n" in x ? name(x.n) : "k" in x ? num(x.k) : id(x.i);

  it("cut back by its number, gives the untrusted parts and only them", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(item, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 }),
        (spec) => {
          const lines: Line[] = spec.map((xs) => xs.flatMap((x) => t` ${part(x)}`));
          const out = render(lines).split("\n");
          const want = spec.flat().flatMap((x) => ("u" in x ? [x.u] : []));
          if (want.length > 0) expect(out[0]).toBe(UNTRUSTED_NOTICE);
          const body = (want.length > 0 ? out.slice(1) : out).join("\n");
          expect(body.split("\n")).toHaveLength(lines.length);
          const n = /<untrusted-data-([0-9a-f]{32})>/.exec(body)?.[1];
          if (want.length === 0) {
            expect(n).toBeUndefined();
            return;
          }
          const open = `<untrusted-data-${n}>`;
          const close = `</untrusted-data-${n}>`;
          expect(body.split(n ?? "").length - 1).toBe(2 * want.length);
          const got: string[] = [];
          let outside = "";
          let rest = body;
          for (;;) {
            const i = rest.indexOf(open);
            if (i < 0) break;
            const j = rest.indexOf(close, i);
            expect(j).toBeGreaterThan(i);
            outside += rest.slice(0, i);
            got.push(unescapeText(rest.slice(i + open.length, j)));
            rest = rest.slice(j + close.length);
          }
          outside += rest;
          expect(got).toEqual(want);
          expect(outside).toBe(
            spec.map((xs) => xs.map((x) => ` ${writing(x)}`).join("")).join("\n"),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("JSON as written", () => {
  const json: fc.Arbitrary<unknown> = fc.letrec<{ v: unknown }>((tie) => ({
    v: fc.oneof(
      { depthSize: "small" },
      nasty,
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie("v"), { maxLength: 3 }),
      fc.dictionary(nasty, tie("v"), { maxKeys: 3 }),
    ),
  })).v;

  it("parses to the same value; no character of the set stays but where an exception allows", () => {
    fc.assert(
      fc.property(json, (v) => {
        const text = escapeJson(v);
        expect(JSON.parse(text)).toEqual(v);
        // Normalizing the text breaks no escape: it still parses.
        expect(() => JSON.parse(text.normalize("NFC"))).not.toThrow();
        // Nor does a compatibility normalization add a key or end a string early.
        const k = JSON.parse(text.normalize("NFKC")) as unknown;
        const shape = (x: unknown): unknown =>
          Array.isArray(x)
            ? x.map(shape)
            : x !== null && typeof x === "object"
              ? Object.keys(x).length
              : typeof x;
        expect(shape(k)).toEqual(shape(v));
        const kept = Array.from(text).filter((c) => ofSet(c));
        expect(kept.every((c) => presentation(point(c)) || joiner(point(c)))).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});
