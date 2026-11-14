// Exact decimal arithmetic for request values (docs/zh-CN/spec/04-contract.md §1 «值的编码»;
// 03-data-model/10-types-and-units.md «精度与舍入», «单位词表»): the caller's decimal text parsed by
// the JSON number grammar, as an exact rational of BigInts; unit conversion as value × source factor
// ÷ target factor; rounding to a scale, half up (away from zero at exactly half) or half even.
// Nothing goes through floating point.
//
// An exponent is judged by the digits' position before it is expanded: a value whose integer part
// would pass `maxIntegerDigits` is out of range without building a huge BigInt, and one whose first
// digit lies further right than `TINY` places is kept as a stand-in that rounds to zero at any scale
// 0–12 (and is not an integer).

/** The JSON number grammar (RFC 8259 §6), the one grammar of a caller's decimal text. */
const RAW = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/** A first significant digit this far right of the point is below half a unit at any scale 0–12. */
const TINY = 40;

/** An exact rational number `num / den`, `den > 0`. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export type ParsedDecimal =
  | { readonly ok: true; readonly value: Rational }
  | { readonly ok: false; readonly why: "malformed" | "too_large" };

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * Parses decimal text by the JSON number grammar. `too_large`: the integer part would have more than
 * `maxIntegerDigits` digits (judged before expanding the exponent).
 */
export function parseDecimal(text: string, maxIntegerDigits: number): ParsedDecimal {
  const m = RAW.exec(text);
  if (m === null) return { ok: false, why: "malformed" };
  const sign = m[1] === "-" ? -1n : 1n;
  const int = m[2] as string;
  const frac = m[3] ?? "";
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  // An exponent beyond 2^53: far too large, or far too small (a tiny value, below).
  if (!Number.isSafeInteger(exp) && exp > 0) return { ok: false, why: "too_large" };
  const digits = (int + frac).replace(/^0+/, "");
  if (digits === "") return { ok: true, value: { num: 0n, den: 1n } };
  // The value is digits × 10^(exp − frac.length); its first digit sits at position
  // (digits.length − 1) + exp − frac.length (0 = units).
  const shift = Number.isSafeInteger(exp) ? exp - frac.length : Number.NEGATIVE_INFINITY;
  const first = digits.length - 1 + shift;
  if (first + 1 > maxIntegerDigits) return { ok: false, why: "too_large" };
  const n = sign * BigInt(digits);
  // Far right of the point: kept as a stand-in below half a unit at any scale 0–12, so it still
  // rounds to zero and still counts as rounded (or as not an integer).
  if (first < -TINY) return { ok: true, value: { num: sign, den: pow10(TINY + 1) } };
  return {
    ok: true,
    value: shift >= 0 ? { num: n * pow10(shift), den: 1n } : reduce(n, pow10(-shift)),
  };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function reduce(num: bigint, den: bigint): Rational {
  if (num === 0n) return { num: 0n, den: 1n };
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

export function multiply(a: Rational, b: Rational): Rational {
  return reduce(a.num * b.num, a.den * b.den);
}

export function divide(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new Error("division by zero");
  const sign = b.num < 0n ? -1n : 1n;
  return reduce(a.num * b.den * sign, a.den * b.num * sign);
}

export function compare(a: Rational, b: Rational): number {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Whether the value is an integer. */
export function isInteger(a: Rational): boolean {
  return a.den === 1n;
}

/** Whether the value has more decimal places than `scale` (it needs rounding). */
export function exceedsScale(a: Rational, scale: number): boolean {
  return (a.num * pow10(scale)) % a.den !== 0n;
}

/**
 * The value rounded to `scale` decimal places: `half_up` away from zero at exactly half,
 * `half_even` to the even neighbour at exactly half (10 «精度与舍入»).
 */
export function round(a: Rational, scale: number, mode: "half_up" | "half_even"): Rational {
  const scaled = a.num * pow10(scale);
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  let q = abs / a.den;
  const r2 = (abs % a.den) * 2n;
  if (r2 > a.den || (r2 === a.den && (mode === "half_up" || q % 2n === 1n))) q += 1n;
  return reduce(neg ? -q : q, pow10(scale));
}

/** Canonical decimal text of a value with a terminating expansion (09 §1.2): `-?(0|[1-9]…)(\.…[1-9])?`. */
export function canonical(a: Rational): `${number}` {
  // den is 2^x 5^y: scale up to a power of ten.
  let den = a.den;
  let scale = 0;
  let num = a.num;
  while (den !== 1n) {
    if (den % 10n === 0n) den /= 10n;
    else if (den % 2n === 0n) {
      den /= 2n;
      num *= 5n;
    } else if (den % 5n === 0n) {
      den /= 5n;
      num *= 2n;
    } else throw new Error("not a terminating decimal");
    scale++;
  }
  if (num === 0n) return "0" as `${number}`;
  const neg = num < 0n;
  const digits = (neg ? -num : num).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac === "" ? "" : `.${frac}`}` as `${number}`;
}

/** The number of digits of the integer part of `|a|` (0 for |a| < 1). */
export function integerDigits(a: Rational): number {
  const q = (a.num < 0n ? -a.num : a.num) / a.den;
  return q === 0n ? 0 : q.toString().length;
}

/** A canonical decimal string as a rational (for schema bounds and unit factors). */
export function rationalOf(canonicalText: string): Rational {
  const p = parseDecimal(canonicalText, Number.MAX_SAFE_INTEGER);
  if (!p.ok) throw new Error(`not a decimal: ${canonicalText}`);
  return p.value;
}
