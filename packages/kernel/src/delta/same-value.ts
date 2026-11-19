// The same-value criterion (docs/zh-CN/spec/03-data-model/10-types-and-units.md «同值判据»), once.

import type { FieldValue, JcsValue } from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";

/**
 * The canonical text of a normalised value; `null` (an empty value) has one, "no value" does not:
 * `undefined` throws, so that absence is never read as emptiness by accident.
 */
export function valueText(v: FieldValue): string {
  if (v === undefined) throw new TypeError("a value is required: no value is not a value");
  return canonicalize(v as JcsValue);
}

/**
 * Whether two values are the same value. It compares two values that are there, and takes them
 * already normalised the way stored values are, never the raw writing a caller gave: a decimal is
 * its text rounded to the field's `scale` in canonical form, a quantity is in the field's unit,
 * text is NFC, and a `zoned_datetime` is `{ instant, zone }` with the zone name normalised. Empty
 * (`null`) and non-empty differ. An absent value (`undefined`) is not accepted and throws: the
 * caller says what absence means.
 */
export const sameValue = (a: FieldValue, b: FieldValue): boolean => valueText(a) === valueText(b);
