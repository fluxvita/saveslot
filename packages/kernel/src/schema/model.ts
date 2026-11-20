// Inputs, results and errors of compiling the schema document that creates a slot
// (docs/zh-CN/spec/03-data-model/07-schema-evolution.md «schema 文档格式»; the error codes are
// 04-contract «schema_draft» and 04-contract-types §9).

import type {
  ChangesBlock,
  ChangeTarget,
  CompiledSchema,
  FieldType,
  RefTarget,
  Rounding,
  SlotId,
  TimeDependency,
} from "@fluxvita/saveslot-contract-core";
import type { SqlReason } from "../rules/index.ts";

/** The detail codes the compiler reports (04-contract-types `ValidationDetailCode`, schema part). */
export type SchemaDetailCode =
  | "reserved_name"
  | "duplicate_name"
  | "description_missing"
  | "unknown_type"
  | "entity_key_not_required"
  | "cross_slot_ref"
  | "untrusted_marker"
  | "alias_invalid"
  | "unit_unknown"
  | "external_key_table_kind"
  | "external_key_field_type"
  | "external_key_in_together"
  | "unknown_reference"
  | "key_not_applicable"
  | "out_of_bounds"
  | "duplicate_entry"
  | "timezone_unknown"
  // A derived table's rule (11-restricted-sql.md «拒绝时报什么», derived rule column).
  | "rule_sql_rejected"
  | "nondeterministic_function"
  | "unit_inference_failed"
  // A change to an existing slot (04-contract «schema_draft» 四个与数据有关的编译明细码).
  | "still_referenced"
  // A new table or field named what another of the same draft is renamed away from.
  | "name_renamed_away";

/** The rules of an alias (07 «schema 文档格式» 别名), in the order a finding takes the first broken. */
export type AliasRule =
  | "count"
  | "length"
  | "empty"
  | "control"
  | "surrounding_space"
  | "repeat"
  | "name";

/** One finding, at its position in the document (`tables/0/fields/2`, `tables/1/entity_key/0`). */
export interface SchemaDetail {
  readonly path: string;
  readonly code: SchemaDetailCode;
  /** `unit_unknown`: codes of `units@1` the text may have meant; may be empty. */
  readonly allowed_units?: readonly string[];
  /**
   * `out_of_bounds`: the bounds that apply to the value at `path`, as decimal text: a count's or a
   * length's, a type's range, `min` on a `max` smaller than the `min` given.
   */
  readonly min?: string;
  readonly max?: string;
  /** `unknown_type`, and `key_not_applicable` where the type is wrong: the types it may be. */
  readonly allowed_values?: readonly string[];
  /**
   * `key_not_applicable` on an event table's `time/field`: the field is not required. `alias_invalid`:
   * the rule the alias breaks, the first in this order (`count` and `length` with `max`).
   */
  readonly reason?: AliasRule | "not_required";
  /** A rule's details: the line in its SQL, the reason, a fix when one can be given. */
  readonly line?: number;
  readonly sql_reason?: SqlReason;
  readonly suggestion?: string;
  /**
   * `still_referenced`: what still depends on the table to drop, as positions in the document
   * (`tables/1/fields/0`) or, for a table the draft does not list, as names (`runs.account`).
   */
  readonly referenced_by?: readonly string[];
}

export type CompileError =
  /** The document breaks the compilation rules: every finding, in document order. */
  | { readonly code: "validation_failed"; readonly details: readonly SchemaDetail[] }
  /** A key v1 does not support (07 «改动分类与迁移手段», end). `param`: its position. */
  | { readonly code: "not_in_this_version"; readonly param: string }
  /** The document is not of the document's form: not an object, a key missing, a JSON type wrong, a key unknown. */
  | {
      readonly code: "invalid_argument";
      readonly reason: "missing" | "malformed";
      readonly param: string;
      /** At a derived table's rule, its keys, or a `sql` on the table: what a rule looks like. */
      readonly example?: Readonly<Record<string, string>>;
      /** At a rule's `time_dependency`: the values this version takes. */
      readonly allowed_values?: readonly string[];
    }
  /** In v1, but not compiled yet: changing a slot, rule forms not compiled yet. Not for callers to see as such. */
  | { readonly code: "not_implemented"; readonly what: string; readonly param: string };

/** What compiling a change to an existing slot adds to the errors of a new slot's. */
export type ChangeError =
  | CompileError
  /** A field of the slot's current version the draft neither matched nor drops (07 «字段匹配规则»). */
  | {
      readonly code: "field_unmatched";
      readonly fields: readonly {
        readonly table: string;
        readonly id: string;
        readonly name: string;
      }[];
    }
  /** `base_version` is not the current version (04-contract «schema_draft»). */
  | {
      readonly code: "draft_outdated";
      readonly reason: "base_version";
      readonly current_sv: number;
    };

export type CompileWarning =
  | {
      readonly code: "single_field_external_key";
      /** The table's name: what `schema_draft` gives (04-contract-types §7 `Warning`). */
      readonly table: string;
      /** Position of the table's `external_key`. */
      readonly path: string;
    }
  | {
      /** A derived table's group key comes from free text: it goes with the group when deleted (06 «派生行身份»). */
      readonly code: "group_key_free_text";
      /** The derived table's name: what `schema_draft` gives (04-contract-types §7 `Warning`). */
      readonly table: string;
      /** Position of the derived table's `rule`. */
      readonly path: string;
    };

export interface CompileNewSlotInput {
  /** The schema document as the caller gave it (parsed JSON). */
  readonly document: unknown;
  /** The new slot's ID, allocated by the caller. */
  readonly slotId: SlotId;
  /** The next table number free in the tenant: table IDs are unique in the tenant and never reused. */
  readonly nextTableNumber: number;
  /** The next rule number free in the tenant: rule IDs are unique in the tenant and never reused. */
  readonly nextRuleNumber: number;
  /** The names of the tenant's slots, for `duplicate_name`. */
  readonly existingSlotNames: readonly string[];
}

export type CompileResult =
  | {
      readonly ok: true;
      readonly compiled: CompiledSchema;
      /** `schema.compiled` `changes`: `create_slot`, then `add_table` / `add_derived_table` per table. */
      readonly changes: ChangesBlock;
      readonly outcome: "applied";
      readonly targetVersion: 1;
      readonly warnings: readonly CompileWarning[];
    }
  | { readonly ok: false; readonly error: CompileError };

export interface CompileChangeInput {
  /** The draft as the caller gave it (parsed JSON), `base_version` the version it was written on. */
  readonly document: unknown;
  /** The definition of the slot's current version, which the draft's `slot` names. */
  readonly current: CompiledSchema;
  /** The names of the tenant's slots, this one included, for `duplicate_name`. */
  readonly existingSlotNames: readonly string[];
  /** The next table number free in the tenant: table IDs are unique in the tenant and never reused. */
  readonly nextTableNumber: number;
  /** The slot policy's `auto_apply` classes. */
  readonly autoApply: readonly string[];
  /** Whether nobody but the submitter uses the table or field (07 «改名自动生效的前提»). */
  readonly unused: (target: ChangeTarget) => boolean;
}

export type CompileChangeResult =
  | {
      readonly ok: true;
      readonly compiled: CompiledSchema;
      readonly changes: ChangesBlock;
      /** `applied` when every change is automatic under the policy, else `pending`. */
      readonly outcome: "applied" | "pending";
      readonly targetVersion: number;
      readonly warnings: readonly CompileWarning[];
    }
  | { readonly ok: false; readonly error: ChangeError };

// --- the document, after its form is checked ---------------------------------------------------

/** A field as written; `min` / `max` are canonical decimal text. */
export interface DocField {
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  /** NFC-normalized, in the order written; not checked yet (./validate.ts). */
  readonly aliases?: readonly string[];
  readonly required: boolean;
  /** Keys present, for the per-type rules. */
  readonly keys: ReadonlySet<string>;
  readonly min?: string;
  readonly max?: string;
  readonly values?: readonly string[];
  readonly unit?: string;
  readonly scale?: number;
  readonly rounding?: Rounding;
  readonly ref?: { readonly table: string; readonly target: RefTarget };
}

export type DocTime =
  | { readonly type: "none" }
  | { readonly type: "event"; readonly field: string }
  | { readonly type: "state"; readonly granularity: "date" | "instant" };

export interface DocTable {
  readonly kind: "base";
  readonly path: string;
  /** Keys present: a derived table's `rule` is reported, not read. */
  readonly keys: ReadonlySet<string>;
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  readonly time: DocTime;
  readonly fields: readonly DocField[];
  readonly entity_key?: readonly string[];
  readonly external_key?: readonly string[];
  readonly together?: readonly (readonly string[])[];
  readonly duplicate_keys?: readonly (readonly string[])[];
}

/** A field of a derived table as written: type, unit and precision only where inference needs them. */
export interface DocDerivedField {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  /** Keys present: keys only base fields take are reported, not read. */
  readonly keys: ReadonlySet<string>;
  readonly type?: string;
  readonly unit?: string;
  readonly scale?: number;
  readonly rounding?: Rounding;
}

export interface DocDerivedTable {
  readonly kind: "derived";
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
  /** Keys present: keys only base tables take are reported, not read. */
  readonly keys: ReadonlySet<string>;
  readonly rule: { readonly sql: string; readonly time_dependency: TimeDependency };
  readonly fields: readonly DocDerivedField[];
}

export interface DocSlot {
  readonly slot: string;
  readonly timezone: string;
  readonly tables: readonly (DocTable | DocDerivedTable)[];
}

export const FIELD_TYPE_SET: ReadonlySet<string> = new Set<FieldType>([
  "text",
  "integer",
  "decimal",
  "quantity",
  "boolean",
  "enum",
  "date",
  "zoned_datetime",
  "ref",
]);
