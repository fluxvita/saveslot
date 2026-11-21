// A number field's value carried from one definition to another (03-data-model/07-schema-evolution.md
// «确定性转换怎么重放»; 10-types-and-units.md «精度与舍入», «单位词表»): converted from the old unit
// to the new one (same dimension: value × old factor ÷ new factor) and rounded to the new scale by
// the new rounding, exactly. One implementation for every place a value or a bound crosses a
// change: judging whether a draft tightens a bound, counting what breaks it, building a version.

import type { CompiledUnit } from "@fluxvita/saveslot-contract-core";
import { canonical, divide, integerDigits, multiply, rationalOf, round } from "./decimal.ts";

/** 10 «字段类型与取值范围»: a decimal's integer part has at most 18 digits. */
export const DECIMAL_INTEGER_DIGITS = 18;

/** A number field's shape as far as its values go: its unit (a quantity) and its precision. */
export interface NumberShape {
  readonly unit?: CompiledUnit;
  readonly scale: number;
  readonly rounding: "half_up" | "half_even";
}

export type Converted =
  | { readonly ok: true; readonly value: `${number}` }
  /**
   * `out_of_range`: the integer part passes 18 digits once converted. `unit_dimension`: the units
   * are of different dimensions, or one has no factor (a currency or temperature changed for another).
   */
  | { readonly ok: false; readonly why: "out_of_range" | "unit_dimension" };

/**
 * `value` (canonical decimal text, in `from`'s unit) as `to` has it: converted when the units
 * differ, then rounded to `to`'s scale by `to`'s rounding (`half_up` away from zero at exactly half,
 * negative values too; `half_even` to the even neighbour). The same unit and a scale not going down
 * give the value back unchanged.
 */
export function convertValue(value: string, from: NumberShape, to: NumberShape): Converted {
  let exact = rationalOf(value);
  const a = from.unit;
  const b = to.unit;
  if (a?.code !== b?.code) {
    if (
      a === undefined ||
      b === undefined ||
      a.dimension !== b.dimension ||
      a.to_base === undefined ||
      b.to_base === undefined
    )
      return { ok: false, why: "unit_dimension" };
    exact = divide(multiply(exact, rationalOf(a.to_base)), rationalOf(b.to_base));
  }
  const r = round(exact, to.scale, to.rounding);
  if (integerDigits(r) > DECIMAL_INTEGER_DIGITS) return { ok: false, why: "out_of_range" };
  return { ok: true, value: canonical(r) };
}
