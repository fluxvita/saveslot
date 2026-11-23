// Schema documents, changes and the slot policy (docs/zh-CN/spec/04-contract-types.md §4.2
// `SchemaDocument` / `MigrationStatus`, §5.3 `schema_draft`, §8.2 `SlotPolicy`).

import type {
  AutoApplyClass,
  ChangeClass,
  CompileOutcome,
  EffectiveValueRule,
  PolicyBlock,
  SchemaChangeCode,
  SchemaChangeRecord,
} from "@fluxvita/saveslot-contract-core";

export { AUTO_APPLY_CLASSES } from "@fluxvita/saveslot-contract-core";

import type {
  Actor,
  CommonResult,
  DraftId,
  FieldName,
  Instant,
  ItemId,
  ItemVer,
  Seq,
  SlotId,
  SlotName,
  Sv,
  TableName,
  TargetRef,
  WriteCommonParams,
} from "./common.ts";
import type { ValidationDetailCode } from "./validation.ts";

/**
 * 04-contract-types §5.3 `SchemaChangeCode`, §5.3 `SchemaChange.class` (`ChangeClass`), §8.2
 * `SlotPolicy.effective_value_rule` (`EffectiveValueRule`) and `auto_apply` (`AutoApplyClass`):
 * the event format's sets are the contract's without the `@later` values.
 */
export type { AutoApplyClass, ChangeClass, EffectiveValueRule, SchemaChangeCode };

/** 04-contract-types §4.2 `SchemaDocument`; the format is defined in the data model's schema document format. */
export type SchemaDocument = Record<string, unknown>;

/** 04-contract-types §4.2 `MigrationStatus`. */
export interface MigrationStatus {
  target_sv: Sv;
  state: "building" | "failed";
  progress?: { done: number; total: number };
  /** The `schema_change` item. */
  item?: ItemId;
}

/** 04-contract-types §8.2 `PolicyGetParams`. */
export interface PolicyGetParams {
  slot: SlotName;
}

/**
 * 04-contract-types §8.2 `SlotPolicy` (read only in this version). The keys it shares with the
 * event format's policy block are that block's: `policy_version` (+1 per change),
 * `effective_value_rule`, `rank` (the source level rank table; recorded, not used yet) and
 * `auto_apply` (the schema change classes that take effect without confirmation).
 */
export interface SlotPolicy
  extends Pick<PolicyBlock, "policy_version" | "effective_value_rule" | "rank" | "auto_apply"> {
  slot: SlotName;
  set_by: Actor;
  set_at: Instant;
  seq: Seq;
}

/**
 * 04-contract-types §5.3 `SchemaChange`: one change of a draft. Its keys besides `target` are the
 * event format's change record's: `change`, `class`, `compatible_with_old_writes` (whether writes
 * carrying the old `sv` to this field are still accepted), `destructive` (loses data) and `auto`
 * (takes effect by the slot policy), and `as_never_written` (compiled as on a table never written,
 * present only then). The record names its target by IDs, the contract by names.
 */
export interface SchemaChange
  extends Pick<
    SchemaChangeRecord,
    "change" | "class" | "compatible_with_old_writes" | "destructive" | "auto" | "as_never_written"
  > {
  /** The slot, table or field by its name after the change (a renamed one by its new name). */
  target: { slot: true; name: SlotName } | { table: TableName; field?: FieldName; rule?: true };
}

/** 04-contract-types §5.3 `SchemaImpact`. */
export interface SchemaImpact {
  rows_affected: number;
  derived_changed: Array<{ table: TableName; rows: number }>;
  /**
   * Callers that recently used renamed / dropped fields by their old names. Absent where usage is
   * not computed (a change to an existing slot, in this version): not an empty list, which would
   * say nobody uses them.
   */
  consumers?: Array<{
    actor: Actor;
    field: string;
    last_used: Instant;
    used_for: "read" | "write";
  }>;
  /** Trial run of `migrate` / `backfill`. */
  trial?: {
    rows: number;
    failed: number;
    samples: Array<{ target: TargetRef; error: ValidationDetailCode }>;
  };
  /** Derived rules whose group keys come from free-text fields. */
  free_text_group_keys?: Array<{ table: TableName; field: FieldName }>;
  estimated_seconds?: number;
}

/** 04-contract-types §5.3 `SchemaDraftParams`. A new slot has `base_version: null`. */
export interface SchemaDraftParams extends WriteCommonParams {
  document: SchemaDocument;
}

/** 04-contract-types §5.3 `SchemaDraftResult`. */
export interface SchemaDraftResult extends CommonResult {
  draft: DraftId;
  slot: SlotName;
  slot_id: SlotId;
  target_sv: Sv;
  /** The document with IDs and inferred results filled in. */
  document: SchemaDocument;
  changes: SchemaChange[];
  impact: SchemaImpact;
  /** applied: in effect (a new slot, or all changes automatic). pending: a `schema_change` item. */
  outcome: CompileOutcome;
  /** New version when applied and already switched. */
  sv?: Sv;
  /** Applied but new physical tables are being built. */
  migration?: MigrationStatus;
  /** outcome `pending`: the item; this receipt counts as having read it. */
  item?: { id: ItemId; item_ver: ItemVer };
  /** The older draft this submission replaced. */
  superseded_draft?: DraftId;
  replayed?: true;
  /** Parts cut at the surface's result budget. */
  omitted?: Array<"changes" | "document">;
}
