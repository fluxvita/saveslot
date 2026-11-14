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
} from "./decimal.ts";
import { decimalText } from "./number.ts";
import { get, has, isObj, keysOf } from "./own.ts";
import { instantText, parseDateTime, validDate } from "./times.ts";
import type { WriteValidationDetail, WriteWarning } from "./types.ts";

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
}

/** Normalizes one value for `f`. `null` (clearing) is handled by the caller. */
export function normalizeValue(f: CompiledBaseField, v: unknown, c: ValueContext): ValueResult {
  const fail = (
    code: WriteValidationDetail["code"],
    extra: Omit<WriteValidationDetail, "op" | "field" | "code"> = {},
  ): ValueResult => ({ ok: false, detail: { op: c.op, field: c.name, code, ...extra } });
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
      if (typeof v !== "string") return fail("type_mismatch");
      const p = parseDateTime(v, c.zone, true);
      if (!p.ok) return fail(p.why === "out_of_range" ? "out_of_range" : "type_mismatch");
      const instant = instantText(p.epochMs);
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
      // A temporary name needs `as`, not in this version: no op of the request declares one.
      if (v.startsWith("@")) return fail("ref_not_found");
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
