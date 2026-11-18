// Pending items (docs/zh-CN/spec/04-contract-types.md §4.8 `pending`), plus `Span` (§4.7), which
// item details use.

import {
  type CandidateCause,
  type DeletionKind,
  type DeletionOrigin,
  EVENT_DECISIONS,
  EVENT_ITEM_TYPES,
  type Intent,
  type ItemCreatedReason,
  type LiteralResult,
  type SourceLevel,
  type SupersededReason,
  type TombstoneReason,
} from "@fluxvita/saveslot-contract-core";
import type {
  Actor,
  CommonParams,
  CommonResult,
  DraftId,
  FieldName,
  Instant,
  Interval,
  ItemId,
  ItemVer,
  PageParams,
  PageResult,
  Seq,
  SlotName,
  Sv,
  TargetRef,
  UntrustedText,
  Value,
  Values,
  Ver,
} from "./common.ts";
import type { MigrationStatus, SchemaChange, SchemaImpact } from "./schema.ts";

/** The value sets of an item's reasons and causes (the event format's), for a client that shows them. */
export {
  CANDIDATE_CAUSES,
  DELETION_ORIGINS,
  ITEM_CREATED_REASONS,
  SUPERSEDED_REASONS,
} from "@fluxvita/saveslot-contract-core";
/**
 * 04-contract-types §4.8 `SupersededReason`, §5.1 `Intent`, §2 `SourceLevel`, §4.6
 * `TombstoneReason`: the event format's sets are the contract's without the `@later` values.
 */
export type { Intent, SourceLevel, SupersededReason, TombstoneReason };

/** 04-contract-types §4.8 `ItemType`: the event format's item types plus `deletion`. */
export const ITEM_TYPES = [...EVENT_ITEM_TYPES, "deletion"] as const;
/** 04-contract-types §4.8 `ItemType`. */
export type ItemType = (typeof ITEM_TYPES)[number];

/** 04-contract-types §4.8 `ItemStatus`. */
export const ITEM_STATUSES = ["open", "resolved", "superseded"] as const;
/** 04-contract-types §4.8 `ItemStatus`. */
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** 04-contract-types §4.8 `ItemReason`: `item.created` reasons plus the deletion origins. */
export type ItemReason = ItemCreatedReason | DeletionOrigin;

/** 04-contract-types §4.8 `Decision`: the event format's decisions plus `cancel` (deletion). */
export const DECISIONS = [...EVENT_DECISIONS, "cancel"] as const;
/** 04-contract-types §4.8 `Decision`. */
export type Decision = (typeof DECISIONS)[number];

/** 04-contract-types §4.7 `Span`: values over a span of business time; `values: null` = no value. */
export interface Span extends Interval {
  values: Values | null;
}

/** 04-contract-types §4.8 `ItemTarget`. `unit`: fields of the conflict unit, `["*"]` = existence. */
export interface ItemTarget extends TargetRef {
  unit?: Array<FieldName | "*">;
  /**
   * Spans of the item on a state table, ascending, not touching; only the first may be open at the
   * start (`valid_from` null), and the whole time is the one span with both ends null.
   */
  spans?: Interval[];
}

/** 04-contract-types §4.8 `ItemResolution`: resolved by a decision, or a deletion executed on expiry. */
export type ItemResolution =
  | {
      decision: Decision;
      /** take_candidate: the index of the candidate taken in the item's `candidates[]`. */
      candidate?: number;
      seq: Seq;
      at: Instant;
      actor: Actor;
      note?: UntrustedText;
    }
  | { executed: true; seq: Seq; at: Instant; reason: TombstoneReason };

/** 04-contract-types §4.8 `PendingParams`. With `id` it is a detail read. */
export interface PendingParams extends CommonParams, PageParams {
  id?: ItemId;
  slot?: SlotName;
  type?: ItemType;
  /** Default `open`. */
  status?: ItemStatus | "all";
}

/** 04-contract-types §4.8 one entry of `PendingListResult.items`. */
export interface PendingListItem {
  id: ItemId;
  type: ItemType;
  status: ItemStatus;
  slot: SlotName;
  target?: ItemTarget;
  reason: ItemReason;
  opened_at: Instant;
  opened_by: Actor;
  /** deletion: past due but not yet physically deleted. */
  overdue?: true;
}

/** 04-contract-types §4.8 `PendingListResult`. */
export interface PendingListResult extends CommonResult, PageResult {
  items: PendingListItem[];
}

/** 04-contract-types §4.8 `ItemBase`. */
export interface ItemBase {
  id: ItemId;
  item_ver: ItemVer;
  status: ItemStatus;
  slot: SlotName;
  reason: ItemReason;
  opened_at: Instant;
  opened_by: Actor;
  /** Decisions the current credential may use; empty when closed. */
  decisions: Decision[];
  /** status `resolved`. */
  resolution?: ItemResolution;
  /** status `superseded`. */
  superseded?: { reason: SupersededReason; by?: Seq; at: Instant };
}

/** 04-contract-types §4.8 `AwaitingImpact`: what taking effect would change. */
export interface AwaitingImpact {
  /** Segments that would be overwritten; `valid` on state tables only (other rows have none). */
  overwritten?: Array<{ field: FieldName; valid?: Interval; value: Value; seq: Seq; actor: Actor }>;
  /** Gaps without a value that would be filled; `valid` on state tables only. */
  filled_gaps?: Array<{ valid?: Interval; revoked_by?: Seq }>;
  /** Later writes that would be reverted. */
  reverted?: Array<{ seq: Seq; actor: Actor; fields: FieldName[] }>;
  /** Rows still referencing the row. */
  referrers?: TargetRef[];
}

/** 04-contract-types §4.8 `AwaitingDetail`. */
export interface AwaitingDetail extends ItemBase {
  type: "awaiting_confirmation";
  target: ItemTarget;
  /** `set` values; `set: null` a revoke; a revert gives `revert` instead of `set`. */
  proposal: {
    seq: Seq;
    actor: Actor;
    intent: Intent;
    set?: Values | null;
    revert?: { undo: Seq; include_later?: boolean };
    valid?: Interval;
  };
  current: { values?: Values; spans?: Span[] };
  impact: AwaitingImpact;
}

/** 04-contract-types §4.8 `FlaggedDetail`. */
export interface FlaggedDetail extends ItemBase {
  type: "flagged";
  target: ItemTarget;
  /** Rows suspected to duplicate it: at most 10, most recently written first. */
  related: TargetRef[];
  /** The `duplicate_keys` group that matched. */
  keys: FieldName[];
  matched_values?: Values;
}

/** 04-contract-types §4.8 `Candidate`. */
export interface Candidate {
  /** Index in the item; used by `take_candidate`. */
  index: number;
  seq: Seq;
  actor: Actor;
  /** A `revoke` candidate has no `values`. */
  intent: Intent;
  /** The version it carried. */
  ver: Ver;
  values?: Values;
  /** State tables: the candidate's interval. */
  valid?: Interval;
  cause: CandidateCause;
  level?: SourceLevel;
  literal?: LiteralResult;
}

/** 04-contract-types §4.8 `ConflictDetail`. */
export interface ConflictDetail extends ItemBase {
  type: "conflict";
  target: ItemTarget;
  /** The effective side at the item version's operation number. */
  effective: {
    seq?: Seq;
    actor?: Actor;
    values?: Values;
    spans?: Array<Span & { seq?: Seq; actor?: Actor }>;
    exists: boolean;
  };
  candidates: Candidate[];
  /** Reason `restored_candidate`: the item the candidate came from. */
  related_item?: ItemId;
  /** What `take_previous` returns to: the merge base. */
  previous: { seq: Seq; exists: boolean; values?: Values; spans?: Span[] };
  /** Writes `take_previous` would revert. */
  reverted_by_previous: Array<{ seq: Seq; actor: Actor }>;
  /** Keyed by candidate index: what a high-impact candidate would overwrite. */
  candidate_impact?: Record<string, AwaitingImpact>;
}

/** 04-contract-types §4.8 `SchemaChangeDetail`. */
export interface SchemaChangeDetail extends ItemBase {
  type: "schema_change";
  draft: DraftId;
  target_sv: Sv;
  changes: SchemaChange[];
  /** Estimate at submission. */
  impact: SchemaImpact;
  migration?: MigrationStatus;
}

/** 04-contract-types §4.8 `DeletionState`. */
export interface DeletionState {
  place: "store" | "backups";
  state: "logically_deleted" | "physically_deleted" | "retained" | "expired";
  since: Instant;
  /** When the next state is expected. */
  due?: Instant;
  overdue?: true;
  /** Local mode: deferred to the next start. */
  deferred_to_next_start?: true;
  /** backups: false = not managed by saveslot. */
  managed?: boolean;
}

/** 04-contract-types §4.8 `DeletionDetail`. */
export interface DeletionDetail extends ItemBase {
  type: "deletion";
  kind: DeletionKind;
  expires_at: Instant;
  totals: { sources: number; rows: number; derived: number };
  states: DeletionState[];
}

/** 04-contract-types §4.8 `ItemDetail`. */
export type ItemDetail =
  | AwaitingDetail
  | FlaggedDetail
  | ConflictDetail
  | SchemaChangeDetail
  | DeletionDetail;

/** 04-contract-types §4.8 `PendingDetailResult`. */
export type PendingDetailResult = CommonResult & ItemDetail;

/** 04-contract-types §4.8: the result of `pending`, a list or (with `id`) a detail. */
export type PendingResult = PendingListResult | PendingDetailResult;
