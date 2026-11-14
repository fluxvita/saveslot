// Inputs, results and errors of compiling the schema document that creates a slot
// (docs/zh-CN/spec/03-data-model/07-schema-evolution.md «schema 文档格式»; the error codes are
// 04-contract «schema_draft» and 04-contract-types §9).

import type {
  ChangesBlock,
  CompiledSchema,
  FieldType,
  RefTarget,
  Rounding,
  SlotId,
} from "@fluxvita/saveslot-contract-core";

/** The detail codes the compiler reports (04-contract-types `ValidationDetailCode`, schema part). */
export type SchemaDetailCode =
  | "reserved_name"
  | "duplicate_name"
  | "description_missing"
  | "unknown_type"
  | "entity_key_not_required"
  | "cross_slot_ref"
  | "untrusted_marker"
  | "unit_unknown"
  | "external_key_table_kind"
  | "external_key_field_type"
  | "external_key_in_together"
  | "unknown_reference"
  | "key_not_applicable"
  | "out_of_bounds"
  | "duplicate_entry"
  | "timezone_unknown";

/** One finding, at its position in the document (`tables/0/fields/2`, `tables/1/entity_key/0`). */
export interface SchemaDetail {
  readonly path: string;
  readonly code: SchemaDetailCode;
  /** `unit_unknown`: codes of `units@1` the text may have meant; may be empty. */
  readonly allowed_units?: readonly string[];
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
    }
  /** In v1, but not compiled yet: changing a slot, derived tables, aliases. Not for callers to see as such. */
  | { readonly code: "not_implemented"; readonly what: string; readonly param: string };

export type CompileWarning = {
  readonly code: "single_field_external_key";
  /** Position of the table's `external_key`. */
  readonly path: string;
};

export interface CompileNewSlotInput {
  /** The schema document as the caller gave it (parsed JSON). */
  readonly document: unknown;
  /** The new slot's ID, allocated by the caller. */
  readonly slotId: SlotId;
  /** The next table number free in the tenant: table IDs are unique in the tenant and never reused. */
  readonly nextTableNumber: number;
  /** The names of the tenant's slots, for `duplicate_name`. */
  readonly existingSlotNames: readonly string[];
}

export type CompileResult =
  | {
      readonly ok: true;
      readonly compiled: CompiledSchema;
      /** `schema.compiled` `changes`: `create_slot` and one `add_table` per table. */
      readonly changes: ChangesBlock;
      readonly outcome: "applied";
      readonly targetVersion: 1;
      readonly warnings: readonly CompileWarning[];
    }
  | { readonly ok: false; readonly error: CompileError };

// --- the document, after its form is checked ---------------------------------------------------

/** A field as written; `min` / `max` are canonical decimal text. */
export interface DocField {
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
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
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly time: DocTime;
  readonly fields: readonly DocField[];
  readonly entity_key?: readonly string[];
  readonly external_key?: readonly string[];
  readonly together?: readonly (readonly string[])[];
  readonly duplicate_keys?: readonly (readonly string[])[];
}

export interface DocSlot {
  readonly slot: string;
  readonly timezone: string;
  readonly tables: readonly DocTable[];
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
