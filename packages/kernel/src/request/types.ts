// Inputs and outputs of normalizing a write request (docs/zh-CN/spec/04-contract-types.md §5.1
// `write`, §7 warnings, §9 errors; 03-data-model/04-write-and-read.md «判定顺序» step 1).

import type {
  BizPoint,
  CompiledSchema,
  DateStr,
  EntityId,
  FieldId,
  FieldValue,
  Instant,
  OpNumber,
  RawFieldValue,
  RowId,
  SchemaChangeCode,
  TableId,
} from "@fluxvita/saveslot-contract-core";

// --- business time parameters (05-time «写状态：参数与默认»; the judge takes the same shapes) -------

export type FromParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "now" };
export type ToParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "open" }
  | { readonly mode: "next_change" };
/** `corrected_span`: intent correct with neither end given. */
export type ValidParam = { readonly from: FromParam; readonly to: ToParam } | "corrected_span";

// --- input ------------------------------------------------------------------------------------

export interface NormalizeWriteInput {
  /** WriteParams as the caller sent them (with `task`, `idempotency_key`): unchecked JSON. */
  readonly params: unknown;
  /** The compiled definition of the request's slot (see resolveWriteSlot). */
  readonly compiled: CompiledSchema;
  readonly currentSv: number;
  /** What changed incompatibly since a version: a request at that version may not write it. */
  readonly changedSince: (sv: number) => ChangedFields;
}

/**
 * Changes since a version, by `<table ID>/<field ID>`, or `<table ID>/*` for a table changed as a
 * whole (`restructure_unused`): the change code (04-contract-types §5.3).
 */
export type ChangedFields = ReadonlyMap<`${TableId}/${FieldId}` | `${TableId}/*`, SchemaChangeCode>;

// --- output -----------------------------------------------------------------------------------

export type Intent = "insert" | "update" | "correct" | "revoke";

export type NormalizedTarget =
  | { readonly kind: "new" }
  | { readonly kind: "row"; readonly row: RowId }
  | { readonly kind: "entity"; readonly entity: EntityId }
  | {
      readonly kind: "entity_key";
      /** By key field ID: normalized as a value of the field, with the raw value as written. */
      readonly key: Readonly<Record<FieldId, NormalizedField>>;
    };

export interface NormalizedField {
  /**
   * Normalized (10 «同值判据»): what same-value judgement compares. Text in NFC; decimals and integers
   * in canonical form, rounded to the field's scale; a quantity converted to the field's unit; a
   * zoned date-time as its UTC instant with the zone name normalized (the runtime's spelling when
   * the written name differs from it only in case; the slot's zone when none was written).
   */
  readonly value: FieldValue;
  /**
   * As the caller wrote it, of the head event's `ops/<i>/set/<field>` shape (09 §1.3): text before
   * NFC; decimals and integers as the caller's decimal text (a JsonNumber's own text, a plain
   * number's shortest round-trip text: never a number); a quantity's value text with the caller's
   * unit; a zoned date-time as its UTC instant with the zone as written (the slot's zone when none
   * was written). Strings, booleans and `null` as given.
   */
  readonly raw: RawFieldValue;
}

export interface NormalizedOp {
  readonly index: number;
  readonly table: TableId;
  /** Undefined with `revert` and no intent given: the undone write's intent, which the caller looks up. */
  readonly intent: Intent | undefined;
  readonly target: NormalizedTarget;
  readonly ver: { readonly op: OpNumber; readonly restoreCount: number } | undefined;
  readonly kind: "write" | "revoke" | "undo";
  /** By field ID. */
  readonly fields?: Readonly<Record<FieldId, NormalizedField>>;
  /** State tables only. `now` carries no value: the caller takes it from the input. */
  readonly valid?: ValidParam;
  readonly undo?: { readonly target: OpNumber; readonly includeLater: boolean };
  /** As the caller wrote it: the values given, each known (`["overwrite"]` today). */
  readonly acknowledge: readonly "overwrite"[];
  /** Request-level evidence segments this op refers to; absent = all of them. */
  readonly evidenceRefs?: readonly number[];
  /**
   * The fields the op names in `set`, then `entity_key`: field ID, its current name, and its path
   * in the request (for checkSvCompatibility).
   */
  readonly named: readonly {
    readonly field: FieldId;
    readonly name: string;
    readonly param: string;
  }[];
}

export type EvidenceSegment =
  | {
      readonly kind: "user_message" | "agent_note" | "tool_result";
      readonly text: string;
      readonly level?: "user_stated" | "agent_inferred";
      readonly stated_at?: Instant;
    }
  | {
      readonly kind: "file_ref";
      readonly name: string;
      readonly mime: string;
      readonly size: number;
      readonly sha256: string;
      readonly origin?: string;
      readonly excerpt?: string;
      readonly level?: "user_stated" | "agent_inferred";
      readonly stated_at?: Instant;
    };

/** Warnings normalization gives (04-contract-types §7), by op and field name. */
export type WriteWarning =
  | {
      readonly code: "unit_converted";
      readonly op: number;
      readonly field: string;
      readonly from: { readonly value: string; readonly unit: string };
      readonly to: { readonly value: string; readonly unit: string };
    }
  | {
      readonly code: "rounded";
      readonly op: number;
      readonly field: string;
      readonly from: string;
      readonly to: string;
      readonly scale: number;
    }
  | {
      readonly code: "timezone_assumed";
      readonly op?: number;
      readonly field?: string;
      readonly param?: string;
      readonly timezone: string;
    }
  | {
      readonly code: "time_truncated";
      readonly op?: number;
      readonly param: string;
      readonly from: Instant;
      readonly to: DateStr;
    };

export interface NormalizedWrite {
  /** As given; undefined when not given (the caller falls back). */
  readonly sv: number | undefined;
  readonly task: string | undefined;
  /** Request-level evidence. */
  readonly evidence: readonly EvidenceSegment[];
  readonly ops: readonly NormalizedOp[];
  readonly warnings: readonly WriteWarning[];
  readonly requestKey: {
    /** RFC 8785 canonical form of the request without `task` and `idempotency_key`. */
    readonly content: string;
    readonly idempotencyKey?: string;
    /** With an explicit key: SHA-256 (hex) of `content`. */
    readonly fingerprint?: string;
  };
}

/** A detail of `validation_failed` (04-contract-types §9, the write group). */
export interface WriteValidationDetail {
  /** The op; none where the request has no ops (a decision's triggered write). */
  readonly op?: number;
  /** The table's name: given with `required_in_gap`. */
  readonly table?: string;
  readonly field?: string;
  readonly code:
    | "type_mismatch"
    | "unit_missing"
    | "unit_unknown"
    | "unit_dimension"
    | "out_of_range"
    | "enum_value"
    | "required_missing"
    | "required_in_gap"
    | "ref_not_found"
    | "malformed";
  /** `required_in_gap`: the stretch the field has no value over. */
  readonly valid?: {
    readonly valid_from: string | null;
    readonly valid_to: string | null;
    readonly valid_to_inclusive?: DateStr;
  };
  readonly allowed_units?: readonly string[];
  readonly allowed_values?: readonly string[];
  readonly min?: string;
  readonly max?: string;
}

/** The error of a refused request, of the contract's ErrorObject shape (04-contract-types §9). */
export type RequestError =
  | {
      readonly code: "invalid_argument";
      readonly reason: string;
      readonly param: string;
      readonly candidates?: readonly string[];
      readonly example?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly code: "unknown_table" | "unknown_field";
      readonly param: string;
      readonly name: string;
      readonly nearest: readonly string[];
    }
  | {
      readonly code: "derived_readonly";
      readonly param: string;
      readonly table: string;
      readonly base_tables: readonly string[];
    }
  | {
      readonly code: "validation_failed";
      readonly reason: "write";
      readonly details: readonly WriteValidationDetail[];
    }
  | {
      readonly code: "schema_incompatible";
      readonly param: string;
      readonly current_sv: number;
      /** `field` is the field's current name, or `"*"` for the whole table. */
      readonly changed_fields: readonly {
        readonly field: string;
        readonly change: SchemaChangeCode;
      }[];
    }
  | {
      readonly code: "not_in_this_version";
      readonly reason: "parameter" | "value";
      readonly param: string;
    }
  | {
      readonly code: "too_large";
      readonly reason: "evidence_segment" | "request";
      readonly param: string;
      readonly limit_bytes?: number;
      readonly actual_bytes?: number;
      readonly limit?: number;
    };

export type NormalizeWriteResult =
  | { readonly ok: true; readonly request: NormalizedWrite }
  | { readonly ok: false; readonly error: RequestError };
