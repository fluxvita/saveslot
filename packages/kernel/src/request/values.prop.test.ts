// Properties of number normalization (04-contract §1; 10 «精度与舍入», «单位词表»), each against a
// reference computed by the definition in another way than the implementation:
//
// 1. Rounding: any decimal text (exponents included), any scale 0–12, half_up or half_even, gives
//    the value obtained by moving the point in the text and looking at the digits cut off; the
//    `rounded` warning comes exactly when a non-zero digit is cut off. The value arrives in each of
//    the three forms (a string, a JsonNumber, a plain number: then read as its shortest round-trip
//    text, refused past 15 significant digits unless a safe integer). More than 18 integer digits,
//    before or after rounding, is refused as out of range. Exact halves are generated on purpose and
//    must make up a minimum share.
// 2. Unit conversion: any value in any unit of a convertible dimension, written to a field in any
//    unit of the same dimension, gives value × source factor ÷ target factor (exact, by long
//    division) rounded to the field's scale, with `unit_converted` when the units differ. Samples
//    with different units must make up a minimum share.

import type { CompiledBaseField, CompiledUnit } from "@fluxvita/saveslot-contract-core";
import { Hits, propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { unitCodes, unitOf } from "../schema/index.ts";
import { jsonNumber } from "./number.ts";
import { normalizeValue } from "./values.ts";

type Mode = "half_up" | "half_even";

/** Plain decimal text (no exponent) of raw text, by moving the point in the string. */
function plain(text: string): { neg: boolean; int: string; frac: string } {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text) as RegExpExecArray;
  const neg = m[1] === "-";
  let digits = (m[2] as string) + (m[3] ?? "");
  let point = (m[2] as string).length + Number(m[4] ?? 0);
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += "0".repeat(point - digits.length);
  const int = digits.slice(0, point).replace(/^0+/, "") || "0";
  return { neg, int, frac: digits.slice(point) };
}

/** Adds one unit in the last place to a digit string. */
function increment(digits: string): string {
  const a = [...digits].map(Number);
  let i = a.length - 1;
  while (i >= 0) {
    if ((a[i] as number) < 9) {
      a[i] = (a[i] as number) + 1;
      return a.join("");
    }
    a[i] = 0;
    i--;
  }
  return `1${a.join("")}`;
}

/** Canonical text of sign, integer digits and fraction digits. */
function canonicalText(neg: boolean, int: string, frac: string): string {
  const i = int.replace(/^0+/, "") || "0";
  const f = frac.replace(/0+$/, "");
  const zero = /^0*$/.test(i + f);
  return `${neg && !zero ? "-" : ""}${i}${f === "" ? "" : `.${f}`}`;
}

/** The reference rounding of decimal text: by the digits cut off. */
function roundText(text: string, scale: number, mode: Mode): { value: string; cut: boolean } {
  const { neg, int, frac } = plain(text);
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  const next = Number(frac[scale] ?? "0");
  const rest = /[1-9]/.test(frac.slice(scale + 1));
  const cut = next !== 0 || rest;
  const last = Number((int + kept).at(-1));
  const up = next > 5 || (next === 5 && (rest || mode === "half_up" || last % 2 === 1));
  const digits = up ? increment(int + kept) : int + kept;
  return {
    value: canonicalText(
      neg,
      digits.slice(0, digits.length - scale),
      digits.slice(digits.length - scale),
    ),
    cut,
  };
}

const decimalField = (scale: number, rounding: Mode): CompiledBaseField =>
  ({
    id: "f1",
    name: "x",
    type: "decimal",
    description: "x",
    precision: { scale, rounding },
  }) as CompiledBaseField;

const digitString = (min: number, max: number) =>
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: min, maxLength: max })
    .map((d) => d.join(""));

type Form = "string" | "json" | "plain";

/**
 * Decimal text by the JSON grammar, in one of the three forms; a third of samples end in an exact
 * half at the scale. One in twenty has 19–22 integer digits. Most plain numbers are cut to at most
 * 15 digits, so that most are taken.
 */
const sample = fc
  .record({
    scale: fc.integer({ min: 0, max: 12 }),
    mode: fc.constantFrom<Mode>("half_up", "half_even"),
    neg: fc.boolean(),
    int: fc
      .oneof(
        { arbitrary: digitString(1, 12), weight: 19 },
        { arbitrary: digitString(19, 22).map((d) => `1${d}`), weight: 1 },
      )
      .map((s) => s.replace(/^0+(?=\d)/, "")),
    frac: digitString(0, 16),
    exp: fc.option(fc.integer({ min: -6, max: 4 }), { nil: undefined, freq: 4 }),
    half: fc.integer({ min: 0, max: 2 }),
    E: fc.boolean(),
    form: fc.constantFrom<Form>("string", "json", "plain"),
    cut: fc.integer({ min: 0, max: 3 }),
  })
  .map((s) => {
    // Exact half: fraction of exactly scale + 1 digits ending in 5, no exponent.
    let frac = s.half === 0 ? `${s.frac.slice(0, s.scale).padEnd(s.scale, "3")}5` : s.frac;
    if (s.form === "plain" && s.cut > 0) frac = frac.slice(0, Math.max(0, 15 - s.int.length));
    const exp = s.half === 0 ? undefined : s.exp;
    const text = `${s.neg ? "-" : ""}${s.int}${frac === "" ? "" : `.${frac}`}${exp === undefined ? "" : `${s.E ? "E" : "e"}${exp}`}`;
    const exactHalf = s.half === 0 && frac.length === s.scale + 1 && frac.endsWith("5");
    return { ...s, text, exactHalf };
  });

/** Significant digits of decimal text, for the plain-number rule. */
const significant = (text: string) =>
  text
    .replace(/^-/, "")
    .replace(/[eE].*$/, "")
    .replace(".", "")
    .replace(/^0+/, "")
    .replace(/0+$/, "").length;

describe("rounding to the field's scale", () => {
  it("equals rounding by the digits cut off; warns exactly when it cut something", () => {
    const hits = new Hits(0.75);
    let halves = 0;
    fc.assert(
      fc.property(
        sample,
        hits.track((s) => {
          const input =
            s.form === "string" ? s.text : s.form === "json" ? jsonNumber(s.text) : Number(s.text);
          // What the kernel reads: a plain number by its shortest round-trip text.
          const read = typeof input === "number" ? String(input) : s.text;
          const r = normalizeValue(decimalField(s.scale, s.mode), input, {
            op: 0,
            name: "x",
            zone: "UTC",
          });
          const at = `${s.form} ${s.text} (read ${read})`;
          if (typeof input === "number" && !Number.isSafeInteger(input) && significant(read) > 15) {
            expect(r, at).toMatchObject({ ok: false, detail: { code: "malformed" } });
            return;
          }
          const ref = roundText(read, s.scale, s.mode);
          const intDigits = (t: string) => plain(t.replace(/^-/, "")).int.replace(/^0+/, "").length;
          if (intDigits(read) > 18 || intDigits(ref.value) > 18) {
            expect(r, at).toMatchObject({ ok: false, detail: { code: "out_of_range" } });
            return;
          }
          if (!r.ok) throw new Error(`${at}: ${JSON.stringify(r.detail)}`);
          hits.hit();
          if (s.exactHalf && read === s.text) halves++;
          expect(r.value, at).toBe(ref.value);
          expect(r.raw, at).toBe(read);
          expect(r.warnings.length, at).toBe(ref.cut ? 1 : 0);
        }),
      ),
      { numRuns: propRuns(2000) },
    );
    hits.check();
    expect(halves / hits.hits).toBeGreaterThanOrEqual(0.2);
  });
});

// --- conversion -------------------------------------------------------------------------------

const CONVERTIBLE = new Map<string, CompiledUnit[]>();
for (const code of unitCodes()) {
  const u = unitOf(code) as CompiledUnit;
  if (u.to_base === undefined) continue;
  CONVERTIBLE.set(u.dimension, [...(CONVERTIBLE.get(u.dimension) ?? []), u]);
}
const DIMENSIONS = [...CONVERTIBLE.values()].filter((us) => us.length > 1);

/** A decimal string as digits and scale. */
function scaled(s: string): { n: bigint; s: number } {
  const [i = "0", f = ""] = s.replace(/^-/, "").split(".");
  return { n: BigInt(i + f) * (s.startsWith("-") ? -1n : 1n), s: f.length };
}

/** value × from ÷ to, rounded to `scale` by long division (reference). */
function convertText(value: string, from: string, to: string, scale: number, mode: Mode): string {
  const v = scaled(value);
  const a = scaled(from);
  const b = scaled(to);
  // value·from/to = (v.n·a.n·10^b.s) / (b.n·10^(v.s+a.s))
  let num = v.n * a.n * 10n ** BigInt(b.s);
  const den = b.n * 10n ** BigInt(v.s + a.s);
  const neg = num < 0n;
  if (neg) num = -num;
  const int = num / den;
  let rem = num % den;
  let frac = "";
  for (let k = 0; k < scale + 1; k++) {
    rem *= 10n;
    frac += (rem / den).toString();
    rem %= den;
  }
  const textual = `${neg ? "-" : ""}${int}.${frac}${rem !== 0n ? "1" : ""}`;
  return roundText(textual, scale, mode).value;
}

const conversion = fc
  .record({
    dim: fc.constantFrom(...DIMENSIONS),
    i: fc.nat(),
    j: fc.nat(),
    neg: fc.boolean(),
    int: fc.integer({ min: 0, max: 99_999_999 }),
    frac: digitString(0, 6),
    scale: fc.integer({ min: 0, max: 12 }),
    mode: fc.constantFrom<Mode>("half_up", "half_even"),
  })
  .map((s) => {
    const from = s.dim[s.i % s.dim.length] as CompiledUnit;
    const to = s.dim[s.j % s.dim.length] as CompiledUnit;
    const value = `${s.neg ? "-" : ""}${s.int}${s.frac === "" ? "" : `.${s.frac}`}`;
    return { from, to, value, scale: s.scale, mode: s.mode };
  });

describe("unit conversion", () => {
  it("equals value × source factor ÷ target factor, rounded; warns when the units differ", () => {
    const hits = new Hits(0.9);
    let converted = 0;
    fc.assert(
      fc.property(
        conversion,
        hits.track((s) => {
          const field = {
            id: "f1",
            name: "x",
            type: "quantity",
            description: "x",
            unit: s.to,
            precision: { scale: s.scale, rounding: s.mode },
          } as CompiledBaseField;
          const expected = convertText(
            s.value,
            s.from.to_base as string,
            s.to.to_base as string,
            s.scale,
            s.mode,
          );
          const r = normalizeValue(
            field,
            { value: s.value, unit: s.from.code },
            { op: 0, name: "x", zone: "UTC" },
          );
          // Past 18 integer digits after converting: refused as out of range, not compared.
          if ((expected.replace(/^-/, "").split(".")[0] ?? "").length > 18) {
            expect(r.ok).toBe(false);
            return;
          }
          if (!r.ok)
            throw new Error(`${s.value} ${s.from.code}→${s.to.code}: ${JSON.stringify(r.detail)}`);
          hits.hit();
          expect(r.value, `${s.value} ${s.from.code}→${s.to.code}`).toEqual({
            value: expected,
            unit: s.to.code,
          });
          expect(r.raw).toEqual({ value: s.value, unit: s.from.code });
          const differ = s.from.code !== s.to.code;
          if (differ) converted++;
          // Same unit: `rounded` exactly when a non-zero digit is cut off.
          const cut = roundText(s.value, s.scale, s.mode).cut;
          expect(r.warnings.map((w) => w.code)).toEqual(
            differ ? ["unit_converted"] : cut ? ["rounded"] : [],
          );
        }),
      ),
      { numRuns: propRuns(2000) },
    );
    hits.check();
    expect(converted / hits.hits).toBeGreaterThanOrEqual(0.5);
  });
});
