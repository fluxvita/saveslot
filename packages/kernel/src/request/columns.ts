// A field's value from the columns a version or business table row stores it in (../store
// `selectOf`): what reads show and receipts give, one decoding for both.

import type { CompiledBaseField, FieldValue } from "@fluxvita/saveslot-contract-core";
import { canonical, rationalOf } from "./decimal.ts";

/** The value of `f` from its columns' raw values, in `selectOf`'s order. */
export function decodeColumns(f: CompiledBaseField, cells: readonly unknown[]): FieldValue {
  const [v, zone] = cells;
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "boolean":
      return v as boolean;
    case "integer":
    case "decimal":
      return canonical(rationalOf(String(v)));
    case "quantity":
      return { value: canonical(rationalOf(String(v))), unit: f.unit.code };
    case "zoned_datetime":
      return { instant: String(v) as never, zone: String(zone) };
    default:
      return String(v);
  }
}
