// The compiled schema definition (docs/zh-CN/spec/09-event-format.md §7): the `compiled` block of
// `schema.compiled`. Replay, as-of reads, deletion replay and migrations read only this.
//
// `reextract` declarations are not part of the v1 compilation result (§7, §10) and are not
// admitted. Multi-field `migrate` / `backfill` and the unit `offset` key are later additions (§10).

import type { FieldType, Granularity, RefTarget, Rounding, TimeDependency } from "./enums.ts";
import type {
  DecimalString,
  FieldId,
  FieldValue,
  RuleId,
  SlotId,
  TableId,
  TimeZoneName,
  UnitCode,
  VersionNumber,
} from "./values.ts";

/** Unit of a `quantity` field, from the unit vocabulary `units@1`. No `to_base` for currencies and temperatures. */
export interface CompiledUnit {
  readonly code: UnitCode;
  readonly dimension: string;
  readonly to_base?: DecimalString;
}

/** Precision of `quantity` / `decimal` fields: scale 0–12; filled with defaults by the compiler. */
export interface CompiledPrecision {
  readonly scale: number;
  readonly rounding: Rounding;
}

/** `{"sql": …}`: a restricted SQL expression bound to the previous version's table and field IDs. */
export interface SqlExpression {
  readonly sql: string;
}

/** Constant backfill: the only form that gives a value where there was none. A canonical value. */
export interface ConstBackfill {
  readonly const: FieldValue;
}

/** Keys every field has; `description` is required on every field (§7). */
interface FieldBase<T extends FieldType> {
  readonly id: FieldId;
  readonly name: string;
  readonly type: T;
  readonly description: string;
  readonly aliases?: readonly string[];
}

/** Keys only base table fields have. */
interface BaseFieldExtras {
  /** Present only when `true`; absent = optional (§7). */
  readonly required?: true;
  readonly migrate?: SqlExpression;
  readonly backfill?: SqlExpression | ConstBackfill;
  /** The field ID in the previous version this field comes from (rename, type change). */
  readonly from?: FieldId;
}

interface NumericBounds {
  readonly min?: DecimalString;
  readonly max?: DecimalString;
}

/** A field of a base table, by field type. */
export type CompiledBaseField = BaseFieldExtras &
  (
    | FieldBase<"text">
    | FieldBase<"boolean">
    | FieldBase<"date">
    | FieldBase<"zoned_datetime">
    | (FieldBase<"enum"> & { readonly values: readonly string[] })
    | (FieldBase<"integer"> & NumericBounds)
    | (FieldBase<"decimal"> & NumericBounds & { readonly precision: CompiledPrecision })
    | (FieldBase<"quantity"> &
        NumericBounds & { readonly unit: CompiledUnit; readonly precision: CompiledPrecision })
    | (FieldBase<"ref"> & {
        readonly ref: { readonly table: TableId; readonly target: RefTarget };
      })
  );

/** A field of a derived table: type, unit and precision are inferred by the compiler. */
export type CompiledDerivedField =
  | FieldBase<"text">
  | FieldBase<"boolean">
  | FieldBase<"date">
  | FieldBase<"zoned_datetime">
  | FieldBase<"enum">
  | FieldBase<"integer">
  | FieldBase<"ref">
  | (FieldBase<"decimal"> & { readonly precision: CompiledPrecision })
  | (FieldBase<"quantity"> & {
      readonly unit: CompiledUnit;
      readonly precision: CompiledPrecision;
    });

/** `physical`: `since` may be omitted when it equals this version's `sv` (a new physical table). */
export interface CompiledPhysical {
  readonly table: string;
  readonly since?: VersionNumber;
}

/** Time type of a base table. */
export type CompiledTime =
  | { readonly type: "none" }
  | { readonly type: "event"; readonly field: FieldId }
  | { readonly type: "state"; readonly granularity: Granularity };

interface TableBase {
  readonly id: TableId;
  readonly name: string;
  /** Required on every table (§7). */
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly physical: CompiledPhysical;
}

interface BaseTableCommon extends TableBase {
  readonly kind: "base";
  readonly fields: readonly CompiledBaseField[];
  /** Conflict groups: a field in at most one group, each of two fields or more. */
  readonly together?: readonly (readonly FieldId[])[];
}

/** External key: 1–4 key fields. */
export type ExternalKey =
  | readonly [FieldId]
  | readonly [FieldId, FieldId]
  | readonly [FieldId, FieldId, FieldId]
  | readonly [FieldId, FieldId, FieldId, FieldId];

/**
 * A base table. `external_key` and `duplicate_keys` only on event and timeless tables; `entity_key`
 * only on state tables.
 */
export type CompiledBaseTable = BaseTableCommon &
  (
    | {
        readonly time:
          | { readonly type: "none" }
          | { readonly type: "event"; readonly field: FieldId };
        readonly external_key?: ExternalKey;
        readonly duplicate_keys?: readonly (readonly FieldId[])[];
        readonly entity_key?: never;
      }
    | {
        readonly time: { readonly type: "state"; readonly granularity: Granularity };
        /** Not empty; every key field required. */
        readonly entity_key?: readonly [FieldId, ...FieldId[]];
        readonly external_key?: never;
        readonly duplicate_keys?: never;
      }
  );

/** A derived rule. Rules keep the `rsql` version they were compiled with. */
export interface CompiledRule {
  readonly id: RuleId;
  readonly version: VersionNumber;
  readonly rsql: string;
  readonly sql: string;
  readonly time_dependency: TimeDependency;
  readonly depends_on: readonly { readonly table: TableId; readonly field: FieldId }[];
  readonly scope:
    | {
        readonly kind: "group";
        readonly key: readonly FieldId[];
        readonly key_from_free_text: boolean;
      }
    | { readonly kind: "tenant" };
}

/** A derived table. */
export interface CompiledDerivedTable extends TableBase {
  readonly kind: "derived";
  readonly rule: CompiledRule;
  readonly fields: readonly CompiledDerivedField[];
}

export type CompiledTable = CompiledBaseTable | CompiledDerivedTable;

/** The whole compiled definition of one schema version: every table, not only the changed ones. */
export interface CompiledSchema {
  /** Compiler output format version. v1 knows only 1; unknown values stop `apply` (§1.6). */
  readonly compiler: 1;
  /** Restricted SQL whitelist version (e.g. `rsql@1`); unknown versions stop `apply`. */
  readonly rsql: string;
  readonly slot: SlotId;
  readonly name: string;
  readonly sv: VersionNumber;
  readonly timezone: TimeZoneName;
  readonly tables: readonly CompiledTable[];
}
