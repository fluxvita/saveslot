// convertValue (10-types-and-units.md «精度与舍入», «单位词表»; 07-schema-evolution.md
// «确定性转换怎么重放»): the one conversion of a value or a bound across a change of unit or precision.

import type { CompiledUnit } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { type Converted, convertValue, type NumberShape } from "./convert-value.ts";

const unit = (code: string, dimension: string, to_base?: string): CompiledUnit =>
  ({ code, dimension, ...(to_base !== undefined ? { to_base } : {}) }) as CompiledUnit;
const KG = unit("kg", "mass", "1000");
const G = unit("g", "mass", "1");
const M = unit("m", "length", "1");
const KM = unit("km", "length", "1000");
const MM = unit("mm", "length", "0.001");
const MI = unit("mi", "length", "1609.344");
const USD = unit("USD", "currency:USD");
const EUR = unit("EUR", "currency:EUR");
const UP = (scale: number, u?: CompiledUnit): NumberShape => ({
  ...(u !== undefined ? { unit: u } : {}),
  scale,
  rounding: "half_up",
});
const EVEN = (scale: number, u?: CompiledUnit): NumberShape => ({
  ...(u !== undefined ? { unit: u } : {}),
  scale,
  rounding: "half_even",
});
const ok = (value: string): Converted => ({ ok: true, value: value as `${number}` });

const cases: readonly [string, string, NumberShape, NumberShape, Converted][] = [
  // Nothing to do: the same unit, the scale not going down.
  ["same unit and scale", "4.9", UP(6, KG), UP(6, KG), ok("4.9")],
  ["a scale going up", "4.95", UP(2), UP(4), ok("4.95")],
  ["zero", "0", UP(6, KG), UP(6, G), ok("0")],
  // Units of a dimension: value × old factor ÷ new factor, exactly.
  ["kg to g", "4.9", UP(6, KG), UP(6, G), ok("4900")],
  ["kg to g, past a bound of 5000", "5.1", UP(6, KG), UP(6, G), ok("5100")],
  ["m to km: a bound of 5 m", "5", UP(6, M), UP(6, KM), ok("0.005")],
  ["mi to km", "1", UP(6, MI), UP(6, KM), ok("1.609344")],
  ["negative, km to m", "-2.5", UP(6, KM), UP(6, M), ok("-2500")],
  ["g to kg, rounded to the new scale", "1234.5678", UP(6, G), UP(6, KG), ok("1.234568")],
  ["mm to km, below the new scale: rounds to zero", "0.4", UP(6, MM), UP(6, KM), ok("0")],
  // half_up: away from zero at exactly half, negative values too.
  ["half_up 5.4 to 0 places", "5.4", UP(2), UP(0), ok("5")],
  ["half_up 5.5 to 0 places", "5.5", UP(2), UP(0), ok("6")],
  ["half_up 4.5 to 0 places", "4.5", UP(2), UP(0), ok("5")],
  ["half_up -5.5 to 0 places", "-5.5", UP(2), UP(0), ok("-6")],
  ["half_up -5.4 to 0 places", "-5.4", UP(2), UP(0), ok("-5")],
  ["half_up 0.125 to 2 places", "0.125", UP(3), UP(2), ok("0.13")],
  // half_even: to the even neighbour at exactly half; otherwise to the nearest.
  ["half_even 4.5 to 0 places", "4.5", UP(2), EVEN(0), ok("4")],
  ["half_even 5.5 to 0 places", "5.5", UP(2), EVEN(0), ok("6")],
  ["half_even -4.5 to 0 places", "-4.5", UP(2), EVEN(0), ok("-4")],
  ["half_even -5.5 to 0 places", "-5.5", UP(2), EVEN(0), ok("-6")],
  ["half_even 4.51 to 0 places: not half", "4.51", UP(2), EVEN(0), ok("5")],
  ["half_even 0.125 to 2 places", "0.125", UP(3), EVEN(2), ok("0.12")],
  ["the new rounding, not the old", "2.5", EVEN(1), UP(0), ok("3")],
  // The integer part: at most 18 digits once converted.
  ["18 digits kept", "999999999999999.999", UP(3, KM), UP(0, M), ok("999999999999999999")],
  [
    "19 digits out of range",
    "999999999999999999",
    UP(0, KM),
    UP(0, MM),
    { ok: false, why: "out_of_range" },
  ],
  [
    "rounding up into 19 digits",
    "999999999999999999.5",
    UP(1),
    UP(0),
    { ok: false, why: "out_of_range" },
  ],
  // Not of one dimension, or without a factor.
  ["mass to length", "1", UP(6, KG), UP(6, M), { ok: false, why: "unit_dimension" }],
  ["one currency for another", "1", UP(2, USD), UP(2, EUR), { ok: false, why: "unit_dimension" }],
  ["a unit taken away", "1", UP(6, KG), UP(6), { ok: false, why: "unit_dimension" }],
];

describe("convertValue", () => {
  it.each(cases)("%s", (_, value, from, to, expected) => {
    expect(convertValue(value, from, to)).toEqual(expected);
  });
});
