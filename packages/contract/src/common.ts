// Common types of the operation contract (docs/zh-CN/spec/04-contract-types.md §1, §7): names,
// identifiers, handles, time, values, targets, principals, the parameters and result fields every
// operation has, and the warnings and notices results carry.
//
// Identifiers that the event format defines the same way come from contract-core, and with them
// its template literal types (`pi_${string}`, `ci_${string}`, ...) where the spec writes `string`:
// a deliberate narrowing, so that an ID of one kind cannot be passed where another is meant. The
// version tokens and handles stay `string`, as written. Instants differ:
// the contract writes RFC 3339 with any offset, the event format UTC with milliseconds, so the
// contract's `Instant` (and `BizTime`) is its own type here.

import type {
  ConnectionId,
  DateStr,
  DraftId,
  EntityId,
  ItemId,
  PrincipalKind,
  RowId,
  Seq,
  SlotId,
  SourceId,
} from "@fluxvita/saveslot-contract-core";

/** Identifiers of 04-contract-types §1.1 and `Seq` (§1.2), as the event format defines them. */
export type { ConnectionId, DateStr, DraftId, EntityId, ItemId, RowId, Seq, SlotId, SourceId };

// ---------------------------------------------------------------------------------------------
// §1.1 Names and handles

/** 04-contract-types §1.1 `SlotName`: unique per user; a `slot_id` is accepted too. */
export type SlotName = string;
/** 04-contract-types §1.1 `TableName`: `"ledger.expenses"`, or `"expenses"` when unambiguous. */
export type TableName = string;
/** 04-contract-types §1.1 `FieldName`. */
export type FieldName = string;
/** 04-contract-types §1.1 `ReadId`: one read (`rd_…`). */
export type ReadId = string;
/** 04-contract-types §1.1 `DeleteConfirm`: signed delete confirmation handle (`dc_…`). */
export type DeleteConfirm = string;
/** 04-contract-types §1.1 `Cursor`: signed paging handle (`cur_…`). */
export type Cursor = string;

// ---------------------------------------------------------------------------------------------
// §1.2 Versions

/** 04-contract-types §1.2 `Ver`: `"v57.0"` = (operation number, tenant restore count). */
export type Ver = string;
/** 04-contract-types §1.2 `HistoricalVer`: `"h41.0"`, returned by `history` `as_of`; never written. */
export type HistoricalVer = string;
/** 04-contract-types §1.2 `Sv`: a slot's schema version, from 1. */
export type Sv = number;
/** 04-contract-types §1.2 `ItemVer`: version token of a pending item (`iv_…`). */
export type ItemVer = string;

// ---------------------------------------------------------------------------------------------
// §1.3 Time

/** 04-contract-types §1.3 `Instant`: RFC 3339 with an offset (`"2026-11-10T12:31:00+08:00"`). */
export type Instant = string;
/** 04-contract-types §1.3 `ZonedDateTime`: RFC 9557 (`"2026-11-10T12:31:00+08:00[Asia/Shanghai]"`). */
export type ZonedDateTime = string;
/** 04-contract-types §1.3 `BizTime`: a date on `date`-granularity tables, an instant on `instant` ones. */
export type BizTime = DateStr | Instant;
/** 04-contract-types §1.3 `RecordPoint`: an operation number, or an instant. */
export type RecordPoint = Seq | Instant;

/** 04-contract-types §1.3 `Interval`: business time interval, left-closed, right-open. */
export interface Interval {
  /**
   * `null`: open at the start. The whole time line (then `valid_to` is `null` too) in item spans
   * and the details' spans, and in a write receipt's part over the whole time (a whole revoke, its
   * undo, a candidate of an undo with include_later); a stretch open at the start (a write-back
   * over the whole time cut by another item) as the first of an item's spans, in the details, the
   * receipt and the timeline. A read's rows, and the marks cut to them, always have a start.
   */
  valid_from: BizTime | null;
  /** `null` = continues. */
  valid_to: BizTime | null;
  /** Only on `date` granularity with a non-null `valid_to`: the last day in the interval. */
  valid_to_inclusive?: DateStr;
}

// ---------------------------------------------------------------------------------------------
// §1.4 Values

/** 04-contract-types §1.4 `Quantity`. `value` is a decimal string (`"45"`, `"5.2"`). */
export interface Quantity {
  value: string;
  unit: string;
}

/**
 * 04-contract-types §1.4 `Value`: a field value by its declared type. integer / decimal are decimal
 * strings in results (JSON numbers are accepted on writes); `null` clears an optional field.
 */
export type Value = string | number | boolean | Quantity | null;

/** 04-contract-types §1.4 `Values`: field name → value. */
export type Values = Record<FieldName, Value>;

/** 04-contract-types §1.4 `UntrustedText`: text from user content or callers; may hold instructions. */
export type UntrustedText = string;

// ---------------------------------------------------------------------------------------------
// §1.5 Targets

/** 04-contract-types §1.5 `Target`: locates a row, an entity or a derived row; besides `table`, exactly one. */
export interface Target {
  table: TableName;
  /** Event tables and timeless tables. */
  row?: RowId;
  /** State tables. */
  entity?: EntityId;
  /** State tables with a declared `entity_key`. */
  entity_key?: Record<FieldName, Value>;
  /** Event tables and timeless tables with a declared `external_key`; writes only. */
  external_key?: Record<FieldName, Value>;
  /** Derived tables: the group key (`{}` for an ungrouped aggregate). Read only. */
  key?: Record<FieldName, Value>;
}

/** 04-contract-types §1.5 `TargetRef`: a row identity in results; IDs always, keys when they exist. */
export interface TargetRef {
  table: TableName;
  row?: RowId;
  entity?: EntityId;
  entity_key?: Record<FieldName, Value>;
  external_key?: Record<FieldName, Value>;
  key?: Record<FieldName, Value>;
}

// ---------------------------------------------------------------------------------------------
// §1.6 Principals

/** 04-contract-types §1.6 `Actor`. */
export interface Actor {
  kind: PrincipalKind;
  /** ConnectionId, user ID, or `"system"`. */
  id: string;
  /** Connection instance name, user name, or `"system"`. */
  name: string;
  /** Given only when the principal is revoked or disabled by an import. */
  state?: "revoked" | "disabled";
}

// ---------------------------------------------------------------------------------------------
// §1.7 Parameters and result fields every operation has

/** 04-contract-types §1.7 `CommonParams`. On HTTP `task` travels in the `X-Task-Id` header. */
export interface CommonParams {
  /** Optional self-reported task identifier. */
  task?: string;
}

/** 04-contract-types §1.7 `WriteCommonParams`. On HTTP the key travels in `Idempotency-Key`. */
export interface WriteCommonParams extends CommonParams {
  /** Explicit idempotency key; 24-hour window. */
  idempotency_key?: string;
}

/** 04-contract-types §1.7 `PageParams`. */
export interface PageParams {
  /** Default 20, at most 200. */
  limit?: number;
  cursor?: Cursor;
}

/** 04-contract-types §1.7 `CommonResult`. */
export interface CommonResult {
  warnings?: Warning[];
  /** At most 3. */
  notices?: Notice[];
}

/** 04-contract-types §1.7 `PageResult`. */
export interface PageResult {
  /** Number of matches in total. */
  total: number;
  /** Absent on the last page. */
  next_cursor?: Cursor;
  /** Given when a surface cut the result early at its result budget; the cut is a page boundary. */
  truncated?: { shown: number; total: number };
}

// ---------------------------------------------------------------------------------------------
// §7 Warnings and notices

/** 04-contract-types §7 `FallbackOrigin`: where a fallback `ver` / `sv` came from; exactly one. */
export type FallbackOrigin =
  | { read: ReadId; from_write?: never }
  | { from_write: Seq; read?: never };

/** 04-contract-types §7 `Warning`: structured warnings about a part of this call. `op` indexes `ops`. */
export type Warning =
  | { code: "unit_converted"; op: number; field: FieldName; from: Quantity; to: Quantity }
  | { code: "rounded"; op: number; field: FieldName; from: string; to: string; scale: number }
  | { code: "timezone_assumed"; op?: number; field?: FieldName; param?: string; timezone: string }
  | { code: "time_truncated"; op?: number; param: string; from: Instant; to: DateStr }
  | ({ code: "ver_fallback"; op: number; ver: Ver } & FallbackOrigin)
  | ({ code: "sv_fallback"; sv: Sv } & FallbackOrigin)
  | { code: "item_ver_fallback"; item_ver: ItemVer; read?: ReadId }
  | { code: "renamed"; op?: number; table?: TableName; from: string; to: string }
  | { code: "multi_segment_unmapped"; op: number; fields: FieldName[] }
  | { code: "evidence_unreferenced"; evidence: number[] }
  | {
      code: "overwrote_corroborated";
      op: number;
      field: FieldName;
      valid: Interval;
      sources: SourceId[];
    }
  | { code: "pending_deletion_on_target"; op?: number; item: ItemId }
  | { code: "clock_behind_log"; behind_seconds: number }
  | ({ code: "premise_ver_fallback"; op: number; premise: number; ver: Ver } & FallbackOrigin)
  | { code: "premise_already_changed"; op: number; premise: number; since: Seq }
  | {
      code: "evidence_not_stored";
      evidence: number[];
      /** Inline segments of ops that entered no event, by op index and the op's `evidence` index. */
      op_evidence?: Array<{ op: number; evidence: number[] }>;
    }
  | { code: "external_key_skipped"; ops: number[] }
  | { code: "external_key_resync"; rows: TargetRef[]; rows_total: number }
  | { code: "single_field_external_key"; table: TableName }
  | { code: "group_key_free_text"; table: TableName };

/** 04-contract-types §7 the `Warning` codes. */
export const WARNING_CODES = [
  "unit_converted",
  "rounded",
  "timezone_assumed",
  "time_truncated",
  "ver_fallback",
  "sv_fallback",
  "item_ver_fallback",
  "renamed",
  "multi_segment_unmapped",
  "evidence_unreferenced",
  "overwrote_corroborated",
  "pending_deletion_on_target",
  "clock_behind_log",
  "premise_ver_fallback",
  "premise_already_changed",
  "evidence_not_stored",
  "external_key_skipped",
  "external_key_resync",
  "single_field_external_key",
  "group_key_free_text",
] as const satisfies readonly Warning["code"][];

/** 04-contract-types §7 `Notice`: hints about this call, at most 3, within the caller's visible slots. */
export type Notice =
  | { code: "pending_items"; slot: SlotName; count: number; oldest_opened_at: Instant }
  | { code: "schema_updated"; slot: SlotName; from: Sv; to: Sv; changed: string[] }
  | {
      code: "migration_progress";
      slot: SlotName;
      target_sv: Sv;
      done: number;
      total: number;
      item?: ItemId;
    }
  | { code: "deletion_overdue"; slot: SlotName; item: ItemId };

/** 04-contract-types §7 the `Notice` codes. */
export const NOTICE_CODES = [
  "pending_items",
  "schema_updated",
  "migration_progress",
  "deletion_overdue",
] as const satisfies readonly Notice["code"][];
