// Evidence (docs/zh-CN/spec/04-contract-types.md §2), the result shapes of `write` (§5.1) that
// `resolve` and `history` reuse, and `resolve` (§5.2). `write`'s own parameters are not here: this
// package does not cover the `write` operation yet.

import {
  type FieldStatus,
  type PremiseState,
  SOURCE_KINDS,
  SOURCE_LEVELS,
  type SourceKind,
  type ValidFromMode,
  type ValidToMode,
} from "@fluxvita/saveslot-contract-core";
import type {
  Actor,
  BizTime,
  CommonResult,
  FieldName,
  Instant,
  Interval,
  ItemId,
  ItemVer,
  Seq,
  SourceId,
  Sv,
  TableName,
  TargetRef,
  UntrustedText,
  Value,
  Ver,
  WriteCommonParams,
} from "./common.ts";
import type { AffectedReason, PremiseReason } from "./marks.ts";
import type {
  AwaitingImpact,
  ConflictDetail,
  Decision,
  Intent,
  ItemReason,
  ItemType,
  SourceLevel,
  SupersededReason,
} from "./pending.ts";
import type { MigrationStatus } from "./schema.ts";

/** 04-contract-types §2 `SourceKind` (same set as the event format's), and its values. */
export type { SourceKind };
export { SOURCE_KINDS, SOURCE_LEVELS };

// ---------------------------------------------------------------------------------------------
// §2 Evidence

/** 04-contract-types §2 `EvidenceKind`. */
export const EVIDENCE_KINDS = [
  "user_message",
  "agent_note",
  "tool_result",
  "file_ref",
  "source_ref",
] as const;
/** 04-contract-types §2 `EvidenceKind`. */
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** 04-contract-types §2 `TextSegment`. */
export interface TextSegment {
  kind: "user_message" | "agent_note" | "tool_result";
  /** Required, non-empty. */
  text: string;
  /** Overrides the level the kind implies. Not exposed on MCP. */
  level?: SourceLevel;
  /** When it was said / obtained; absent = unknown. */
  stated_at?: Instant;
}

/** 04-contract-types §2 `FileRefSegment`. */
export interface FileRefSegment {
  kind: "file_ref";
  name: string;
  mime: string;
  /** Bytes. */
  size: number;
  /** Hexadecimal. */
  sha256: string;
  /** URL or path. */
  origin?: string;
  /** Text excerpt. */
  excerpt?: string;
  level?: SourceLevel;
  stated_at?: Instant;
}

/** 04-contract-types §2 `SourceRefSegment`: an existing source in the same slot. */
export interface SourceRefSegment {
  kind: "source_ref";
  id: SourceId;
}

/** 04-contract-types §2 `EvidenceSegment`. */
export type EvidenceSegment = TextSegment | FileRefSegment | SourceRefSegment;

/** 04-contract-types §2 `EvidenceOnOp`: the evidence fields of an op. */
export interface EvidenceOnOp {
  /** Segments of this op only. */
  evidence?: EvidenceSegment[];
  /** Indexes into the request-level evidence. */
  evidence_refs?: number[];
  /** Field name (or `"valid"`) → indexes of the segments visible to this op. */
  evidence_by_field?: Record<FieldName | "valid", number[]>;
}

// ---------------------------------------------------------------------------------------------
// §5.1 `write` results

/** 04-contract-types §5.1 `FieldResultCode`: the event format's statuses plus `noop`. */
export type FieldResultCode = FieldStatus | "noop";

/** 04-contract-types §5.1 `TimelineResultCode`: a contribution's result code in `timeline`. */
export type TimelineResultCode = Exclude<FieldResultCode, "noop"> | "dropped";

/** 04-contract-types §5.1 `FieldResult`: a field's result in a write receipt. */
export type FieldResult =
  | {
      result: "applied";
      /** Absent for a new value. */
      before?: Value;
      /** Absent with `no_value` / `uncovered`. */
      after?: Value;
      no_value?: true;
      uncovered?: true;
      /** The carried `ver` was stale but nobody changed this field since: merged. */
      merged?: true;
      /** State tables: segments overwritten or split. */
      overwritten?: Array<{ valid: Interval; value: Value | null; seq: Seq }>;
    }
  | { result: "corroborated" }
  | { result: "noop" }
  | {
      result: "candidate";
      item: ItemId;
      valid?: Interval;
      /** The field's value on the `by` stretch (null: no value there, a revoke, or existence). */
      effective: Value | null;
      /** Current effective version; does not count as a read. */
      current_ver: Ver;
      /** As this request left the row; none when no stretch of the part had a giver. */
      by?: { seq: Seq; actor: Actor };
      previous: ConflictDetail["previous"];
      impact?: AwaitingImpact;
    }
  | { result: "awaiting"; item: ItemId; impact: AwaitingImpact };

/** 04-contract-types §5.1 `ResolvedInterval`: the interval a state-table field resolved to. */
export interface ResolvedInterval extends Interval {
  from_as: ValidFromMode;
  to_as: ValidToMode;
  /**
   * The segment starting at the end, which this write left (value null: no value there): with
   * `to_as: next_change` and a closed end, or `to_as: given` when something is recorded from the
   * end on (a value or no value). As the operation left it.
   */
  next_change?: { at: BizTime; value: Value | null };
  /** Gaps this write filled. */
  filled?: Interval[];
}

/** 04-contract-types §5.1 `EntityKeyText`: a one-field key as text, or field name → text. */
export type EntityKeyText = UntrustedText | Record<FieldName, UntrustedText>;

/** 04-contract-types §5.1 one entry of `OpResult.premises`. */
export interface OpPremiseResult {
  target: TargetRef;
  fields?: FieldName[];
  /** The seen version actually used. */
  ver: Ver;
  state: PremiseState;
  reason?: PremiseReason;
  since?: Seq;
}

/**
 * One premise of a timeline entry no longer in force (04-contract §10; 04-contract-types §4.5
 * `TimelineEntry.premises`): superseded by a later declaration on its target, or cleared. What was
 * declared, without a state of then: it marks nothing now. Only in a timeline, never in a receipt.
 */
export interface EndedOpPremiseResult {
  target: TargetRef;
  fields?: FieldName[];
  ver: Ver;
  state: "ended";
}

/**
 * One premise of a timeline entry whose target the reader cannot see (04-contract §10; 04-contract-
 * types §4.5 `TimelineEntry.premises`): its state, and since when changed; not which table, row or
 * fields, nor how it changed. Only in a timeline, never in a receipt: a writer sees what it declares
 * on.
 */
export interface HiddenOpPremiseResult {
  hidden: true;
  state: PremiseState | "ended";
  since?: Seq;
}

/** 04-contract-types §5.1 `OpResult`. */
export interface OpResult {
  target: TargetRef;
  /** Temporary name. */
  as?: string;
  intent: Intent;
  ver?: Ver;
  /** Only ops by external key. */
  outcome?: "created" | "updated" | "unchanged" | "pending" | "skipped";
  skip_reason?: "revoked" | "pending_deletion" | "ref_skipped";
  revoked_by?: Seq;
  deletion?: ItemId;
  ref_op?: number;
  created_entity?: true;
  /** With `created_entity`: existing entity keys, at most 10. */
  existing_keys?: EntityKeyText[];
  /** With `created_entity`: similar existing keys, at most 5. */
  similar_keys?: Array<{ key: EntityKeyText; match: "fold" | "affix" | "edit"; revoked?: true }>;
  /** Per field (`"*"` for existence); on state tables an array of interval results. */
  fields?: Record<
    FieldName | "*",
    | FieldResult
    | Array<
        // A noop part has no interval: it only says the field did not change (the log keeps no span).
        | Extract<FieldResult, { result: "noop" }>
        | (Exclude<FieldResult, { result: "noop" }> & { valid: Interval })
      >
  >;
  /** State tables: the interval each field resolved to. */
  resolved?: Record<FieldName | "*", ResolvedInterval>;
  undo?: {
    of: Seq;
    skipped_superseded: Array<{ field: FieldName; valid?: Interval; by: Seq; actor: Actor }>;
    reverted_later?: Array<{ seq: Seq; actor: Actor; fields: FieldName[] }>;
  };
  /** One per requested premise; `[]` when cleared. */
  premises?: OpPremiseResult[];
  premise_covered?: number;
}

/** 04-contract-types §5.1 `DerivedChange`. */
export interface DerivedChange {
  table: TableName;
  key: Record<FieldName, Value>;
  field: FieldName;
  before: Value | null;
  after: Value | null;
}

/** 04-contract-types §5.1 `PendingRef`: an item a write produced or touched. */
export interface PendingRef {
  id: ItemId;
  type: ItemType;
  reason: ItemReason;
  /** Only for items new in this receipt with full content (counts as a read). */
  item_ver?: ItemVer;
  merged?: true;
  refreshed?: true;
  /** Replayed receipts only. */
  state?: "open" | "resolved" | "superseded";
  decision?: Decision;
}

/** 04-contract-types §5.1 `AffectedReads`. */
export interface AffectedReads {
  count: number;
  by_reason: Partial<Record<AffectedReason, number>>;
  /** Reads are kept since this instant. */
  covered_since: Instant;
  possible?: number;
  not_covered?: Array<"derived_reads">;
}

/** 04-contract-types §5.1 `PremiseAffected`: premise changes on rows an operation changed. */
export interface PremiseAffected {
  /** Dependent rows newly marked. */
  count: number;
  /** Dependent rows unmarked. */
  matched: number;
  /** Dependent rows by reason; a row under two reasons counts in each, so these can sum past `count`. */
  by_reason: Partial<Record<PremiseReason, number>>;
  /** One for each declaration marked on a row (a row can appear more than once), at most 20. */
  rows: Array<{ target: TargetRef; fields: FieldName[]; declared: { seq: Seq; actor: Actor } }>;
}

/** 04-contract-types §5.1 `WriteResult.omitted` values. */
export const WRITE_OMITTED = [
  "affected_reads",
  "derived_values",
  "before_values",
  "skipped_spans",
  "deleted_content",
  "unrecorded_ops",
  "existing_keys",
  "field_results",
  "lists",
] as const;
/** 04-contract-types §5.1 a `WriteResult.omitted` value. */
export type WriteOmitted = (typeof WRITE_OMITTED)[number];

/** 04-contract-types §5.1 `WriteResult`. */
export interface WriteResult extends CommonResult {
  /** saved: all fields effective. pending: some became candidates or await confirmation. */
  status: "saved" | "pending";
  sv: Sv;
  seq?: Seq;
  /** One per requested op; a replay gives only `op_index` for unrecorded external-key ops. */
  ops: Array<OpResult | { op_index: number }>;
  /** At most 20. */
  derived: DerivedChange[];
  derived_total: number;
  pending: PendingRef[];
  superseded: Array<{ item: ItemId; type: ItemType; reason: SupersededReason }>;
  affected_reads?: AffectedReads;
  premise_affected?: PremiseAffected;
  external_key_summary?: {
    created: number;
    updated: number;
    unchanged?: number;
    pending: number;
    skipped?: number;
  };
  replayed?: true;
  omitted?: WriteOmitted[];
  original_deleted?: { deletion: ItemId };
}

// ---------------------------------------------------------------------------------------------
// §5.2 `resolve`

/** 04-contract-types §5.2 `ResolveParams`. On HTTP `id` is in the path. */
export interface ResolveParams extends WriteCommonParams, Omit<EvidenceOnOp, "evidence_refs"> {
  id: ItemId;
  decision: Decision;
  /** The item version read; not needed for a deletion's `cancel`. */
  item_ver?: ItemVer;
  /** conflict `take_candidate`: the candidate's `index`. */
  candidate?: number;
  note?: UntrustedText;
}

/** 04-contract-types §5.2 `ResolveResult`. */
export interface ResolveResult extends CommonResult {
  id: ItemId;
  type: ItemType;
  decision: Decision;
  /** New version after resolving. */
  item_ver: ItemVer;
  status: "resolved";
  /** The decision triggered a write. */
  write?: Pick<
    WriteResult,
    | "seq"
    | "sv"
    | "ops"
    | "derived"
    | "derived_total"
    | "pending"
    | "superseded"
    | "affected_reads"
    | "premise_affected"
    | "omitted"
  >;
  /**
   * `take_previous`: the writes it took back or hid, as the item's details listed them at the version
   * the decision bound (`ConflictDetail.reverted_by_previous`).
   */
  reverted_by_previous?: Array<{ seq: Seq; actor: Actor; fields: Array<FieldName | "*"> }>;
  /** schema_change `confirm`. */
  schema?: { switched: boolean; sv?: Sv; migration?: MigrationStatus };
  /** deletion `cancel`. */
  cancelled?: {
    rows: Array<{ target: TargetRef; ver: Ver }>;
    reverted: Array<{ seq: Seq; target: TargetRef }>;
    restored: ItemId[];
    kept_superseded: Array<{ item: ItemId; by: Seq }>;
    kept_effective: Array<{ seq: Seq; target: TargetRef; by: Seq }>;
    rejudged: Array<{
      seq: Seq;
      target: TargetRef;
      from_item: ItemId;
      result: "dropped" | "corroborated" | "reopened";
      item?: { id: ItemId; item_ver: ItemVer };
    }>;
    derived: DerivedChange[];
    premise_affected?: PremiseAffected;
  };
  replayed?: true;
  omitted?: WriteResult["omitted"];
}
