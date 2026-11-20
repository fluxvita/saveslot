// Validation details of errors (docs/zh-CN/spec/04-contract-types.md §9 `ValidationDetail`).
// Separate from errors.ts because schema results (`SchemaImpact.trial`) use the detail codes too.

import type { FieldName, Interval, TableName, TargetRef, Value } from "./common.ts";

/** 04-contract-types §9 `ValidationDetailCode`. */
export const VALIDATION_DETAIL_CODES = [
  // writes
  "type_mismatch",
  "unit_missing",
  "unit_unknown",
  "unit_dimension",
  "out_of_range",
  "enum_value",
  "required_missing",
  "required_in_gap",
  "ref_not_found",
  "ref_wrong_table",
  // an event or timeless insert giving no field a non-empty value: the row would not exist
  "empty_row",
  "malformed",
  // schema compilation
  "reserved_name",
  "duplicate_name",
  "description_missing",
  "unknown_type",
  "entity_key_not_required",
  "cross_slot_ref",
  "rule_sql_rejected",
  "nondeterministic_function",
  "unit_inference_failed",
  "backfill_required",
  "untrusted_marker",
  "migrate_failed",
  "backfill_const_required",
  "backfill_both_forms",
  "still_referenced",
  "name_renamed_away",
  "external_key_table_kind",
  "external_key_field_type",
  "external_key_existing_field",
  "external_key_in_together",
  "rule_eval_failed",
  "alias_invalid",
  "unknown_reference",
  "key_not_applicable",
  "out_of_bounds",
  "duplicate_entry",
  "timezone_unknown",
] as const;
/** 04-contract-types §9 `ValidationDetailCode`. */
export type ValidationDetailCode = (typeof VALIDATION_DETAIL_CODES)[number];

/** 04-contract-types §9 `ValidationDetail.sql_reason`; the same values as `sql_rejected`'s `reason`. */
import type { SqlReason } from "@fluxvita/saveslot-contract-core";

export { SQL_REASONS, type SqlReason } from "@fluxvita/saveslot-contract-core";

/** 04-contract-types §9 `ValidationDetail`: one item of a validation error. */
export interface ValidationDetail {
  /** Index into `ops`. */
  op?: number;
  table?: TableName;
  field?: FieldName;
  /** Position in the schema document: `"tables/0/fields/2"`. */
  path?: string;
  code: ValidationDetailCode;
  /** Line of the rule SQL. */
  line?: number;
  /** `required_in_gap`: the interval missing the field. */
  valid?: Interval;
  allowed_units?: string[];
  allowed_values?: string[];
  /** `out_of_bounds`: the bounds that apply to the value at `path`. */
  min?: string;
  max?: string;
  /**
   * `type_mismatch`: a valid value of the field's type, written as in the ops' `set`; independent
   * of the value given (`suggestion` is the fix for that value). Both may be given.
   */
  example?: Value;
  /**
   * `key_not_applicable` on an event table's `time/field`: the field is not required. `alias_invalid`:
   * the rule the alias breaks, the first in this order: `count`, `length` (both with `max`),
   * `empty`, `control`, `surrounding_space`, `repeat`, `name`. Only there.
   */
  reason?:
    | "not_required"
    | "count"
    | "length"
    | "empty"
    | "control"
    | "surrounding_space"
    | "repeat"
    | "name";
  /** `backfill_required`: number of violating rows. */
  rows?: number;
  /** `backfill_required`: sample rows. */
  samples?: TargetRef[];
  /**
   * `still_referenced`: the dependents, as positions in the schema document when the draft lists
   * them, else as names (`table.field`; a derived table by its name).
   */
  referenced_by?: string[];
  sql_reason?: SqlReason;
  /** A machine-usable fix, such as a replacement SQL fragment. */
  suggestion?: string;
}
