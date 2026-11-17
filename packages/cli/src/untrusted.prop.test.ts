// Properties of untrusted text in the terminal (06-cli §6.4), over strings made of what an attacker
// would use and of the cases the context rules decide (default ignorables, combining marks at the
// start and after an escape, compatibility forms, lone surrogates, spaces), and over any code unit.
// Judged by Unicode properties written here on their own, not by the implementation's set:
//   - nothing without an exception survives escaping (controls, lone surrogates, bidi controls,
//     the separators, the corner brackets and their compatibility forms, spaces but U+0020, a run
//     of three U+0020); a default ignorable survives only as one of the two exceptions allow;
//   - an escaped text reads back to exactly the text; no tag can be opened or closed;
//   - the colour sequences are only the renderer's; a cut never splits a pair;
//   - JSON parses back to the same value, with none of the same characters as they are.
// Every character not plain ASCII is made from its code point: the source holds none.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cutCodePoints,
  escapeUntrusted,
  jsonText,
  unescapeUntrusted,
  wrapEscaped,
} from "./untrusted.ts";

const RUNS = Number(process.env["PROP_RUNS"] ?? 500);
const cp = (...points: number[]) => String.fromCodePoint(...points);
const unit = (u: number) => String.fromCharCode(u);
const ESC = cp(0x1b);

// The judgment, on its own.
const NEVER = [/^\p{Cc}$/v, /^\p{Cs}$/v, /^\p{Bidi_Control}$/v];
const NEVER_POINTS = new Set([0x2028, 0x2029, 0x300c, 0x300d, 0xff62, 0xff63, 0xfe41, 0xfe42]);
const IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/v;
/** The default ignorables an exception may keep: the joiners and the presentation selectors. */
const EXCEPTED = new Set([0x200c, 0x200d, 0xfe0e, 0xfe0f]);
const SPACE_SEPARATOR = /^\p{Zs}$/v;
const EMOJI = /^[\p{Emoji}\p{Extended_Pictographic}]$/v;

/** Whether `c`, left as it is in a writing, breaks the judgment. */
function forbidden(c: string): boolean {
  const p = c.codePointAt(0) as number;
  if (NEVER.some((r) => r.test(c)) || NEVER_POINTS.has(p)) return true;
  if (IGNORABLE.test(c) && !EXCEPTED.has(p)) return true;
  return SPACE_SEPARATOR.test(c) && c !== " ";
}

/** The characters of a writing: a pair as one, a lone surrogate as one. */
function chars(w: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < w.length; ) {
    const c = String.fromCodePoint(w.codePointAt(i) as number);
    out.push(c);
    i += c.length;
  }
  return out;
}

/** Pieces an attacker would put together, and the cases the context rules decide. */
const PIECES = [
  `${ESC}[2J`,
  `${ESC}]0;title${cp(0x7)}`,
  `${cp(0x9b)}31m`,
  cp(0x202e),
  cp(0x2066),
  cp(0x200b),
  cp(0x200c),
  cp(0x200d),
  cp(0xfe0e),
  cp(0xfe0f),
  cp(0xfe00),
  cp(0xe0041),
  cp(0x34f),
  cp(0xad),
  cp(0x301),
  cp(0x20e3),
  cp(0x1f3fd),
  cp(0x2028),
  cp(0x300c),
  cp(0x300d),
  cp(0xff62),
  cp(0xfe42),
  cp(0xff3c),
  cp(0xfe68),
  cp(0xff1c),
  cp(0xa0),
  cp(0x3000),
  cp(0x2003),
  "   ",
  cp(0x5c),
  `${cp(0x5c)}x1b`,
  "<U+202E>",
  "<untrusted-data-",
  "</untrusted-data-",
  "0".repeat(32),
  "<",
  "U+",
  unit(0xd800),
  unit(0xdc00),
  cp(0x1f600),
  cp(0x2764),
  "#",
  "a",
  "中",
  " ",
  cp(0xa),
];

const piece = fc.constantFrom(...PIECES);
/** Lone surrogates, really made: a code unit of either half on its own. */
const lone = fc.integer({ min: 0xd800, max: 0xdfff }).map(unit);
const text = fc.oneof(
  fc.array(fc.oneof(piece, lone), { maxLength: 12 }).map((xs) => xs.join("")),
  fc.string({ unit: "binary", maxLength: 40 }),
  fc
    .array(fc.oneof(lone, fc.string({ unit: "binary", maxLength: 3 })), { maxLength: 8 })
    .map((xs) => xs.join("")),
  fc.string({ unit: "grapheme", maxLength: 20 }),
);

describe("escaping", () => {
  it("reads back to exactly the text", () => {
    fc.assert(
      fc.property(text, (s) => {
        expect(unescapeUntrusted(escapeUntrusted(s))).toBe(s);
      }),
      { numRuns: RUNS },
    );
  });

  it("leaves nothing the judgment forbids, and no run of three spaces", () => {
    fc.assert(
      fc.property(text, (s) => {
        const w = escapeUntrusted(s);
        for (const c of chars(w)) expect(forbidden(c), JSON.stringify(c)).toBe(false);
        expect(w).not.toContain("   ");
      }),
      { numRuns: RUNS },
    );
  });

  it("keeps a joiner only between two characters shown, a selector only after an emoji", () => {
    fc.assert(
      fc.property(text, (s) => {
        const cs = chars(escapeUntrusted(s));
        cs.forEach((c, i) => {
          const p = c.codePointAt(0) as number;
          if (p === 0x200c || p === 0x200d) {
            for (const n of [cs[i - 1], cs[i + 1]]) {
              expect(n !== undefined && n !== " " && !forbidden(n), JSON.stringify(s)).toBe(true);
            }
          }
          if (p === 0xfe0e || p === 0xfe0f) {
            const before = cs[i - 1];
            expect(before !== undefined && EMOJI.test(before), JSON.stringify(s)).toBe(true);
          }
        });
      }),
      { numRuns: RUNS },
    );
  });

  it("leaves nothing that opens or closes a boundary tag", () => {
    fc.assert(
      fc.property(text, (s) => {
        expect(escapeUntrusted(s)).not.toMatch(/<\/?untrusted-data-/);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("the forms of a value", () => {
  it("terminal with colour: exactly the renderer's two sequences, outside the brackets", () => {
    fc.assert(
      fc.property(text, (s) => {
        const w = wrapEscaped(escapeUntrusted(s), { kind: "terminal", color: true });
        expect(w.split(ESC)).toHaveLength(3);
        expect(w.startsWith(`${ESC}[2m${cp(0x300c)}`)).toBe(true);
        expect(w.endsWith(`${cp(0x300d)}${ESC}[22m`)).toBe(true);
        expect(w.split(cp(0x300c))).toHaveLength(2);
        expect(w.split(cp(0x300d))).toHaveLength(2);
      }),
      { numRuns: RUNS },
    );
  });

  it("tagged: the two tags, and no other", () => {
    const n = "f".repeat(32);
    fc.assert(
      fc.property(text, (s) => {
        const w = wrapEscaped(escapeUntrusted(s), { kind: "tagged", n });
        expect(w.match(/<\/?untrusted-data-[0-9a-f]+>/g)).toEqual([
          `<untrusted-data-${n}>`,
          `</untrusted-data-${n}>`,
        ]);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("cutting and JSON", () => {
  it("cuts to whole code points, a prefix of the text", () => {
    fc.assert(
      fc.property(text, fc.nat(30), (s, max) => {
        const { text: t, cut } = cutCodePoints(s, max);
        expect(s.startsWith(t)).toBe(true);
        expect(Array.from(t).length).toBe(Math.min(max, Array.from(s).length));
        expect(cut).toBe(t.length < s.length);
        // The cut never falls between the two halves of a pair.
        const before = t.charCodeAt(t.length - 1);
        const after = s.charCodeAt(t.length);
        const split = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
        expect(split).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it("JSON parses back to the same value, and leaves nothing the judgment forbids", () => {
    fc.assert(
      fc.property(fc.dictionary(text, text, { maxKeys: 4 }), (v) => {
        const w = jsonText(v);
        expect(JSON.parse(w)).toEqual(v);
        for (const c of chars(w)) expect(forbidden(c), JSON.stringify(c)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  it("JSON: every C1 control, DEL and every bidi control as \\u", () => {
    const c1 = Array.from({ length: 32 }, (_, i) => 0x80 + i);
    const bidi = [0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e];
    for (const p of [0x7f, ...c1, ...bidi, 0x2066, 0x2067, 0x2068, 0x2069]) {
      const w = jsonText(cp(p));
      expect(w, p.toString(16)).toBe(`"${cp(0x5c)}u${p.toString(16).padStart(4, "0")}"`);
    }
  });
});
