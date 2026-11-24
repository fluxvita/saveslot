// A field value of a write request, checked and normalized against its compiled field
// (docs/zh-CN/spec/04-contract.md §1 «值的编码»; 03-data-model/10-types-and-units.md «字段类型与
// 取值范围», «精度与舍入», «单位词表», «同值判据»): the normalized value is what same-value
// judgement compares (unit converted, rounded, canonical text, NFC text, UTC instant); the raw value
// is what the caller wrote, as the head event records it.
//
// Order for numbers: parse (grammar, then integer digits judged before expanding an exponent),
// convert units exactly, round to the field's scale, then check the integer digits and the field's
// min / max on the rounded value (10 «精度与舍入»: bounds use the rounded value).
//
// A converted quantity reports `unit_converted` with the final value; `rounded` only when no
// conversion happened (a converted value is generally not a terminating decimal to report).

import type {
  CompiledBaseField,
  FieldValue,
  RawFieldValue,
} from "@fluxvita/saveslot-contract-core";
import { isDate, isId } from "@fluxvita/saveslot-contract-core";
import { unitCandidates, unitOf } from "../schema/index.ts";
import { localYear, zonedText } from "../time/index.ts";
import {
  canonical,
  compare,
  divide,
  exceedsScale,
  integerDigits,
  isInteger,
  multiply,
  parseDecimal,
  type Rational,
  rationalOf,
  round,
} from "../values/index.ts";
import { decimalText } from "./number.ts";
import { get, has, isObj, keysOf } from "./own.ts";
import { instantText, parseDateTime, validDate } from "./times.ts";
import type { ExampleValue, WriteValidationDetail, WriteWarning } from "./types.ts";

/** 10 «字段类型与取值范围»: a decimal's integer part has at most 18 digits. */
const DECIMAL_INTEGER_DIGITS = 18;
/** 64-bit signed (integer fields): 19 digits at most. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** 10: text at most 8 KB in UTF-8. */
export const TEXT_BYTES = 8 * 1024;
const utf8Bytes = (s: string) => Buffer.byteLength(s, "utf8");

export type ValueResult =
  | {
      readonly ok: true;
      readonly value: FieldValue;
      readonly raw: RawFieldValue;
      readonly warnings: readonly WriteWarning[];
    }
  | { readonly ok: false; readonly detail: WriteValidationDetail };

export interface ValueContext {
  readonly op: number;
  /** The field's name in the current version (details and warnings name fields). */
  readonly name: string;
  readonly zone: string;
  /**
   * The value is to be stored (a write), not only compared (a condition, a key looked up): it must
   * then also be one that can be written out and read back (a zoned date-time, below).
   */
  readonly kept?: true;
  /**
   * The temporary names an earlier op of the request declared (`as`): a `ref` value "@name" names
   * one, the row it binds resolved by the write path. Absent: no temporary name is taken.
   */
  readonly names?: ReadonlySet<string>;
}

/**
 * The string a zoned date-time written as an object (`{instant, zone}`, the shape it is read back
 * in elsewhere) is to be written as: `2026-11-12T09:30:00+08:00[Asia/Shanghai]`. Undefined when
 * the object does not name an instant, or names a zone this saveslot does not know.
 */
function zonedSuggestion(v: unknown, zone: string): string | undefined {
  if (!isObj(v)) return undefined;
  const instant = get(v, "instant");
  const named = get(v, "zone");
  if (typeof instant !== "string") return undefined;
  const p = parseDateTime(instant, zone, true);
  if (!p.ok) return undefined;
  try {
    return zonedText(instantText(p.epochMs), typeof named === "string" ? named : (p.zone ?? zone));
  } catch {
    return undefined;
  }
}

/**
 * A valid value of `f`'s type, as `set` takes it, for `type_mismatch` (04-contract-types §9
 * `ValidationDetail.example`): within the field's bounds, of its unit and its declared values; a
 * zoned date-time names its zone, in the slot's zone `zone`. It does not depend on what was given.
 * None when no value is (a decimal whose bounds hold no value of its scale).
 */
export function exampleOf(f: CompiledBaseField, zone: string): ExampleValue | undefined {
  switch (f.type) {
    case "text":
      return "text";
    case "enum":
      return f.values[0] ?? "";
    case "boolean":
      return true;
    case "date":
      return "2026-11-12";
    case "zoned_datetime":
      return zonedText("2026-11-12T01:30:00.000Z", zone);
    case "ref":
      return `${f.ref.target === "entity" ? "e_" : "r_"}${"0".repeat(26)}`;
    case "integer": {
      const n = f.min ?? f.max ?? "1";
      return Number.isSafeInteger(Number(n)) ? Number(n) : n;
    }
    case "decimal":
      return decimalExample(f);
    case "quantity": {
      const value = decimalExample(f);
      return value === undefined ? undefined : { value, unit: f.unit.code };
    }
  }
}

/**
 * A decimal's example: written at its scale, so that rounding leaves it as it is, and within its
 * bounds once rounded (a bound may have more places than the scale: `min` is taken up to the
 * scale, `max` down). The lower bound, else the upper, else 1; none when the two meet no value.
 */
function decimalExample(f: {
  readonly min?: string;
  readonly max?: string;
  readonly precision: { readonly scale: number };
}): string | undefined {
  const at = f.precision.scale;
  const lo = f.min === undefined ? undefined : toScale(rationalOf(f.min), at, "up");
  const hi = f.max === undefined ? undefined : toScale(rationalOf(f.max), at, "down");
  if (lo !== undefined && hi !== undefined && compare(lo, hi) > 0) return undefined;
  const pick = lo ?? hi;
  return pick === undefined ? "1" : canonical(pick);
}

/** `a` at `scale` places, taken toward +∞ (`up`) or −∞ (`down`). */
function toScale(a: Rational, scale: number, way: "up" | "down"): Rational {
  const unit = 10n ** BigInt(scale);
  const n = a.num * unit;
  let q = n / a.den;
  // BigInt division truncates toward zero.
  if (n % a.den !== 0n) {
    if (way === "up" && n > 0n) q += 1n;
    if (way === "down" && n < 0n) q -= 1n;
  }
  return divide({ num: q, den: 1n }, { num: unit, den: 1n });
}

const exampleField = (example: ExampleValue | undefined) =>
  example === undefined ? {} : { example };

/** Normalizes one value for `f`. `null` (clearing) is handled by the caller. */
export function normalizeValue(f: CompiledBaseField, v: unknown, c: ValueContext): ValueResult {
  const fail = (
    code: WriteValidationDetail["code"],
    extra: Omit<WriteValidationDetail, "op" | "field" | "code"> = {},
  ): ValueResult => ({
    ok: false,
    detail: {
      op: c.op,
      field: c.name,
      code,
      ...extra,
      ...(code === "type_mismatch" ? exampleField(exampleOf(f, c.zone)) : {}),
    },
  });
  const ok = (
    value: FieldValue,
    raw: RawFieldValue,
    warnings: WriteWarning[] = [],
  ): ValueResult => ({
    ok: true,
    value,
    raw,
    warnings,
  });

  switch (f.type) {
    case "text": {
      // PostgreSQL text cannot hold NUL.
      if (typeof v !== "string" || !v.isWellFormed() || v.includes("\u0000"))
        return fail("type_mismatch");
      const nfc = v.normalize("NFC");
      // Both what was written and what is kept (NFC can lengthen text).
      if (utf8Bytes(v) > TEXT_BYTES || utf8Bytes(nfc) > TEXT_BYTES) return fail("out_of_range");
      return ok(nfc, v);
    }
    case "enum": {
      if (typeof v !== "string") return fail("type_mismatch");
      // Compared as the same string (10: values are declared in NFC, written as declared).
      if (!f.values.includes(v)) return fail("enum_value", { allowed_values: f.values });
      return ok(v, v);
    }
    case "boolean":
      return typeof v === "boolean" ? ok(v, v) : fail("type_mismatch");
    case "date": {
      if (typeof v !== "string") return fail("type_mismatch");
      // A calendar date outside 0001–9999 is out of range; anything else is no date.
      if (!validDate(v)) return isDate(v) ? fail("out_of_range") : fail("type_mismatch");
      return ok(v, v);
    }
    case "zoned_datetime": {
      if (typeof v !== "string") {
        const fix = zonedSuggestion(v, c.zone);
        return fail("type_mismatch", fix === undefined ? {} : { suggestion: fix });
      }
      const p = parseDateTime(v, c.zone, true);
      if (!p.ok) return fail(p.why === "out_of_range" ? "out_of_range" : "type_mismatch");
      const instant = instantText(p.epochMs);
      if (c.kept) {
        // A stored value is written back out on its zone's wall clock (04-contract-types §1.3): a
        // year there outside 0001–9999 is out of range (10-types-and-units), and so is an instant
        // its text cannot name, which reads back as another (seconds where a clock went back by
        // less than a minute, the offset rounded): what is stored can always be written back.
        const zone = p.zone ?? c.zone;
        const year = localYear(p.epochMs, zone);
        if (year < 1 || year > 9999) return fail("out_of_range");
        const back = parseDateTime(zonedText(instant, zone), zone, true);
        if (!back.ok || back.epochMs !== p.epochMs) return fail("out_of_range");
      }
      const warnings: WriteWarning[] =
        p.zone === undefined
          ? [{ code: "timezone_assumed", op: c.op, field: c.name, timezone: c.zone }]
          : [];
      // The value names the zone as normalized (same-value judgement compares it); the raw value as
      // the caller wrote it. Without a zone, both are the slot's.
      return ok(
        { instant, zone: p.zone ?? c.zone },
        { instant, zone: p.zoneText ?? c.zone },
        warnings,
      );
    }
    case "ref": {
      if (typeof v !== "string") return fail("type_mismatch");
      // A temporary name: one an earlier op declares (04-contract «临时名 as»), kept as written
      // for the write path to resolve; any other names no row (ref_not_found, 04-contract §1).
      if (v.startsWith("@")) return c.names?.has(v.slice(1)) ? ok(v, v) : fail("ref_not_found");
      if (!isId("row", v) && !isId("entity", v)) return fail("type_mismatch");
      return ok(v, v);
    }
    case "integer": {
      // A fraction is a type mismatch, however it is written ("1.5" below, as text).
      if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v))
        return fail("type_mismatch");
      const t = decimalText(v);
      if (!t.ok) return fail(t.why === "not_a_number" ? "type_mismatch" : "malformed");
      // An integer given as a plain number must be a safe integer (04-contract §1).
      if (typeof v === "number" && !Number.isSafeInteger(v)) return fail("malformed");
      const p = parseDecimal(t.text, 19);
      if (!p.ok) return fail(p.why === "malformed" ? "malformed" : "out_of_range");
      if (!isInteger(p.value)) return fail("type_mismatch");
      if (p.value.num < INT64_MIN || p.value.num > INT64_MAX) return fail("out_of_range");
      const bounds = checkBounds(f, p.value);
      if (bounds !== undefined) return fail("out_of_range", bounds);
      return ok(canonical(p.value), t.text);
    }
    case "decimal": {
      const t = decimalText(v);
      if (!t.ok) return fail(t.why === "not_a_number" ? "type_mismatch" : "malformed");
      const p = parseDecimal(t.text, DECIMAL_INTEGER_DIGITS);
      if (!p.ok) return fail(p.why === "malformed" ? "malformed" : "out_of_range");
      const { scale, rounding } = f.precision;
      const r = round(p.value, scale, rounding);
      if (integerDigits(r) > DECIMAL_INTEGER_DIGITS) return fail("out_of_range");
      const bounds = checkBounds(f, r);
      if (bounds !== undefined) return fail("out_of_range", bounds);
      const value = canonical(r);
      const warnings: WriteWarning[] = exceedsScale(p.value, scale)
        ? [{ code: "rounded", op: c.op, field: c.name, from: t.text, to: value, scale }]
        : [];
      return ok(value, t.text, warnings);
    }
    case "quantity": {
      if (!isObj(v)) return fail("type_mismatch");
      for (const k of keysOf(v)) if (k !== "value" && k !== "unit") return fail("type_mismatch");
      if (!has(v, "value")) return fail("type_mismatch");
      const unitText = get(v, "unit");
      if (unitText === undefined || unitText === null) return fail("unit_missing");
      if (typeof unitText !== "string") return fail("type_mismatch");
      const t = decimalText(get(v, "value"));
      if (!t.ok) return fail(t.why === "not_a_number" ? "type_mismatch" : "malformed");
      const unit = unitOf(unitText);
      if (unit === undefined)
        return fail("unit_unknown", { allowed_units: unitCandidates(unitText) });
      const target = f.unit;
      const converting = unit.code !== target.code;
      if (
        converting &&
        (unit.dimension !== target.dimension ||
          unit.to_base === undefined ||
          target.to_base === undefined)
      ) {
        return fail("unit_dimension");
      }
      // Generous digits before converting: the converted value is checked after rounding.
      const p = parseDecimal(t.text, DECIMAL_INTEGER_DIGITS + 12);
      if (!p.ok) return fail(p.why === "malformed" ? "malformed" : "out_of_range");
      const exact = converting
        ? divide(
            multiply(p.value, rationalOf(unit.to_base as string)),
            rationalOf(target.to_base as string),
          )
        : p.value;
      const { scale, rounding } = f.precision;
      const r = round(exact, scale, rounding);
      if (integerDigits(r) > DECIMAL_INTEGER_DIGITS) return fail("out_of_range");
      const bounds = checkBounds(f, r);
      if (bounds !== undefined) return fail("out_of_range", bounds);
      const value = canonical(r);
      const warnings: WriteWarning[] = converting
        ? [
            {
              code: "unit_converted",
              op: c.op,
              field: c.name,
              from: { value: t.text, unit: unit.code },
              to: { value, unit: target.code },
            },
          ]
        : exceedsScale(p.value, scale)
          ? [{ code: "rounded", op: c.op, field: c.name, from: t.text, to: value, scale }]
          : [];
      return ok(
        { value, unit: target.code },
        { value: t.text as `${number}`, unit: unitText },
        warnings,
      );
    }
  }
}

/** The field's min / max when the value lies outside them. */
function checkBounds(
  f: CompiledBaseField,
  x: Rational,
): { min?: string; max?: string } | undefined {
  if (f.type !== "integer" && f.type !== "decimal" && f.type !== "quantity") return undefined;
  const below = f.min !== undefined && compare(x, rationalOf(f.min)) < 0;
  const above = f.max !== undefined && compare(x, rationalOf(f.max)) > 0;
  if (!below && !above) return undefined;
  return {
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
  };
}
