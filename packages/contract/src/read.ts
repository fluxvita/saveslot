// Read operations (docs/zh-CN/spec/04-contract-types.md §4): the row of a read result (§4.1),
// `catalog` (§4.2), `query` (§4.3) and `history` (§4.5).

import type {
  CompiledPrecision,
  FieldType,
  Granularity,
  LiteralResult,
  PremiseState,
  RefTarget,
  Rounding,
  TableKind,
  TimeDependency,
  TimeType,
  VersionIntent,
} from "@fluxvita/saveslot-contract-core";
import type {
  Actor,
  BizTime,
  CommonParams,
  CommonResult,
  Cursor,
  DateStr,
  DraftId,
  EntityId,
  FieldName,
  HistoricalVer,
  Instant,
  Interval,
  ItemId,
  PageParams,
  PageResult,
  ReadId,
  RecordPoint,
  RowId,
  Seq,
  SlotId,
  SlotName,
  SourceId,
  Sv,
  TableName,
  Target,
  TargetRef,
  UntrustedText,
  Value,
  Values,
  Ver,
} from "./common.ts";
import type { InputMarks, Marks, PremiseReason } from "./marks.ts";
import type { Decision, SourceLevel } from "./pending.ts";
import type { MigrationStatus, SchemaDocument, SlotPolicy } from "./schema.ts";
import type { DerivedChange, OpResult, SourceKind, TimelineResultCode } from "./write.ts";

/** The value sets of the types below, for a client that writes them (the CLI's renderers). */
export {
  COMPILE_OUTCOMES,
  FIELD_TYPES,
  GRANULARITIES,
  REF_TARGETS,
  ROUNDINGS,
  TABLE_KINDS,
  TIME_DEPENDENCIES,
  TIME_TYPES,
  VERSION_INTENTS,
} from "@fluxvita/saveslot-contract-core";

/**
 * 04-contract-types §4.2 `FieldType`, `Rounding`, table `kind` (`TableKind`), time `granularity`,
 * rule `time_dependency`, `ref.target`; §4.1 `literal` (`LiteralResult`); §5.1 `VersionIntent`:
 * the same value sets as the event format's.
 */
export type {
  FieldType,
  Granularity,
  LiteralResult,
  RefTarget,
  Rounding,
  TableKind,
  TimeDependency,
  VersionIntent,
};

// ---------------------------------------------------------------------------------------------
// §4.1 A row of a read result

/** 04-contract-types §4.1 `RowDetail`, with `detail: "detailed"`. */
export interface RowDetail {
  /** Last operation that changed it. */
  seq: Seq;
  recorded_at: Instant;
  fields: Record<
    FieldName,
    {
      field_id: string;
      level?: SourceLevel;
      literal: LiteralResult;
      /** ref fields: a summary of the referenced row. */
      ref?: { values: Values };
    }
  >;
  /** All premise declarations in effect on this row. */
  premises?: Array<{
    premise: TargetRef;
    premise_fields?: FieldName[];
    seen: Ver;
    state: PremiseState;
    reason?: PremiseReason;
    since?: Seq;
    fields: FieldName[];
    declared: { seq: Seq; actor: Actor };
  }>;
}

/** 04-contract-types §4.1 `Row`. */
export interface Row extends TargetRef {
  /** Base rows always; derived rows too unless computed at read time. */
  ver?: Ver | HistoricalVer;
  /** Read by `as_of`. */
  historical?: true;
  values: Values;
  /** State tables: this segment's interval. */
  valid_from?: BizTime;
  valid_to?: BizTime | null;
  valid_to_inclusive?: DateStr;
  marks?: Marks;
  /** Derived rows only. */
  input_marks?: InputMarks;
  /** With `detail: "detailed"`. */
  detail?: RowDetail;
}

// ---------------------------------------------------------------------------------------------
// §4.2 `catalog`

/** 04-contract-types §4.2 `CatalogParams`. */
export interface CatalogParams extends CommonParams {
  /** Default `list`. */
  level?: "list" | "table" | "schema";
  /** list: only this slot. schema: required. */
  slot?: SlotName;
  /** schema only: read this draft's compiled document. */
  draft?: DraftId;
  /** table: required, 1–10. */
  tables?: TableName[];
  /** list only: default 50, at most 200 (tables). */
  limit?: number;
  cursor?: Cursor;
}

/** 04-contract-types §4.2 `CatalogList`. */
export interface CatalogList extends CommonResult, PageResult {
  level: "list";
  slots: Array<{
    slot: SlotName;
    slot_id: SlotId;
    sv: Sv;
    timezone: string;
    /** While a migration runs. */
    migration?: MigrationStatus;
    tables: Array<{
      table: TableName;
      kind: TableKind;
      description: UntrustedText;
      aliases?: UntrustedText[];
    }>;
  }>;
}

/** 04-contract-types §4.2 one field of `CatalogTables.tables[].fields`. */
export interface CatalogField {
  name: FieldName;
  type: FieldType;
  description: UntrustedText;
  /** At most 8; not used for name resolution. */
  aliases?: UntrustedText[];
  required?: true;
  unit?: string;
  min?: string;
  max?: string;
  values?: string[];
  ref?: { table: TableName; target: RefTarget };
  /** decimal, quantity: scale and rounding. */
  precision?: CompiledPrecision;
  /** Last K distinct values. */
  examples?: UntrustedText[];
}

/** A table's `time` of one of the event format's time types (`TimeType`). */
type TimeOf<T extends TimeType, X = unknown> = { type: T } & X;

/** 04-contract-types §4.2 one table of `CatalogTables.tables`. */
export interface CatalogTable {
  table: TableName;
  slot: SlotName;
  sv: Sv;
  timezone: string;
  kind: TableKind;
  description: UntrustedText;
  /** At most 8; not used for name resolution. */
  aliases?: UntrustedText[];
  /** Absent for a derived table, which none of the three fits. */
  time?:
    | TimeOf<"none">
    | TimeOf<"event", { field: FieldName }>
    | TimeOf<"state", { granularity: Granularity }>;
  entity_key?: FieldName[];
  /** Event tables and timeless tables. */
  external_key?: FieldName[];
  duplicate_keys?: FieldName[][];
  /** Field groups that form one conflict unit. */
  together?: FieldName[][];
  fields: CatalogField[];
  /** `depends_on` items are `"table.field"` within the slot. */
  rule?: {
    id: string;
    version: number;
    sql: UntrustedText;
    time_dependency: TimeDependency;
    depends_on: string[];
  };
  profile?: {
    rows: number;
    time_range?: { from: BizTime; to: BizTime };
    scale?: { level: "large" | "beyond_tested"; comfortable_rows: number; tested_rows: number };
  };
  described_by?: { actor: Actor; sv: Sv };
}

/** 04-contract-types §4.2 `CatalogTables`. */
export interface CatalogTables extends CommonResult {
  level: "table";
  tables: CatalogTable[];
}

/** 04-contract-types §4.2 `CatalogSchema`. */
export interface CatalogSchema extends CommonResult {
  level: "schema";
  slot: SlotName;
  /** With `draft`: the version it would become; otherwise the current one. */
  sv: Sv;
  draft?: DraftId;
  document: SchemaDocument;
  /** The policy in effect. */
  policy: SlotPolicy;
}

/** 04-contract-types §4.2 `CatalogResult`. */
export type CatalogResult = CatalogList | CatalogTables | CatalogSchema;

// ---------------------------------------------------------------------------------------------
// §4.3 `query`

/** 04-contract-types §4.3 `WhereOp`. */
export const WHERE_OPS = ["=", "!=", "<", "<=", ">", ">=", "in", "contains", "is_null"] as const;
/** 04-contract-types §4.3 `WhereOp`. */
export type WhereOp = (typeof WHERE_OPS)[number];

/** 04-contract-types §4.3 `QueryParams`. */
export interface QueryParams extends CommonParams, PageParams {
  table: TableName;
  /** Conditions are ANDed. */
  where?: Array<{
    field: FieldName | "valid_from" | "valid_to";
    op: WhereOp;
    value?: Value | Value[] | boolean;
  }>;
  order?: Array<{ field: FieldName; dir?: "asc" | "desc" }>;
  fields?: FieldName[];
  /** State tables only. */
  valid_at?: BizTime;
  /** [a, b). */
  valid_during?: [BizTime, BizTime | null];
  /** Default false. */
  clip?: boolean;
  /** Default true. */
  coalesce?: boolean;
  /** Evaluation instant; default the entry instant. */
  at?: Instant;
  /** Default false. */
  include_revoked?: boolean;
  /** Default `concise`. */
  detail?: "concise" | "detailed";
}

/** 04-contract-types §4.3 `QueryResult`. */
export interface QueryResult extends CommonResult, PageResult {
  table: TableName;
  slot: SlotName;
  sv: Sv;
  rows: Row[];
}

// ---------------------------------------------------------------------------------------------
// §4.5 `history`

/** 04-contract-types §4.5 `TimelineParams`. */
export interface TimelineParams extends CommonParams, PageParams, Target {
  /** Default. */
  mode?: "timeline";
  /** Attach source text excerpts. */
  expand_sources?: boolean;
}

/** 04-contract-types §4.5 `AsOfParams`. */
export interface AsOfParams extends CommonParams, PageParams, Target {
  mode: "as_of";
  /** Record time: an operation number, an instant, or "at that read". */
  as_of: RecordPoint | { read: ReadId } | { task: string };
  valid_at?: BizTime;
  detail?: "concise" | "detailed";
}

/** 04-contract-types §4.5 `ChangesParams`. */
export interface ChangesParams extends CommonParams, PageParams {
  mode: "changes";
  /** A base table. */
  table: TableName;
  row?: RowId;
  entity?: EntityId;
  entity_key?: Record<FieldName, Value>;
  /** Exclusive. */
  since: RecordPoint | "my_last_read";
  /** Inclusive; default latest. */
  until?: RecordPoint;
}

/** 04-contract-types §4.5 `HistoryParams`. */
export type HistoryParams = TimelineParams | AsOfParams | ChangesParams;

/**
 * 04-contract-types §4.5: every `mode` of `history`, `composition` too (a later version's: §0.1,
 * refused as `not_in_this_version`). A refusal names its mode from this list (§9).
 */
export const HISTORY_MODES = ["timeline", "as_of", "changes", "composition"] as const;
// Every mode of this version's params is listed.
const _modes: readonly (typeof HISTORY_MODES)[number][] = [] as NonNullable<
  HistoryParams["mode"]
>[];

/** 04-contract-types §4.5 `SourceRef`. */
export interface SourceRef {
  id: SourceId;
  kind: SourceKind;
  correction?: true;
  level?: SourceLevel;
  literal?: LiteralResult;
  /** With `expand_sources: true`; not for removed sources. */
  text?: UntrustedText;
  removed?: true;
}

/** 04-contract-types §4.5 `TimelineField`. */
export interface TimelineField {
  result: TimelineResultCode;
  no_value?: true;
  uncovered?: true;
  before?: Value;
  after?: Value;
  /** State tables: the interval of this item. */
  valid?: Interval;
  /** Content removed by a deletion. */
  removed?: true;
  sources?: { value: SourceRef[]; operation: SourceRef[]; schema_const?: { sv: Sv } };
}

/** 04-contract-types §4.5 `TimelineEntry`. */
export interface TimelineEntry {
  seq: Seq;
  recorded_at: Instant;
  actor: Actor;
  intent: VersionIntent;
  /** How the write came about; absent for a plain write. */
  via?:
    | { resolve: ItemId; decision: Decision }
    | { deletion: ItemId; action: "confirm" | "cancel" }
    | { undo: Seq }
    | { schema: { sv: Sv } };
  /** State tables: the widest interval this write touched. */
  valid?: Interval;
  fields: Record<FieldName | "*", TimelineField | TimelineField[]>;
  /** Premises declared by this write; `state` is the current one. */
  premises?: OpResult["premises"];
  affected?: { derived: DerivedChange[]; reads: number };
}

/** 04-contract-types §4.5 `TimelineResult`. */
export interface TimelineResult extends CommonResult, PageResult {
  mode: "timeline";
  target: TargetRef;
  sv: Sv;
  /** The slot's time zone (as in `catalog`): the instants of the result are shown in it. */
  timezone: string;
  /** The current version: the only one usable for writes. */
  ver: Ver;
  /** Newest first. */
  entries: TimelineEntry[];
  /** Reads of the versions; first page only. */
  reads?: Array<{ read: ReadId; seq: Seq; at: Instant; actor: Actor; task?: string }>;
}

/** 04-contract-types §4.5 `AsOfResult`. */
export interface AsOfResult extends CommonResult, PageResult {
  /** Before the first operation: `seq` 0 and no `recorded_at`. */
  mode: "as_of";
  as_of: { seq: Seq; recorded_at?: Instant };
  /** The schema version then. */
  sv: Sv;
  /** The slot's time zone now (as in `catalog`): the instants of the result are shown in it. */
  timezone: string;
  rows: Row[];
  /** `as_of: {task}`: the task's other reads of this target. */
  other_reads?: Array<{ read: ReadId; seq: Seq; at: Instant }>;
}

/** 04-contract-types §4.5 `ChangedField`. */
export interface ChangedField {
  /** `*`: whether the row exists, true for existing. */
  before?: Value;
  after?: Value;
}

/** 04-contract-types §4.5 `ChangesResult`. */
export interface ChangesResult extends CommonResult, PageResult {
  mode: "changes";
  /** The table, or the row or entity, asked about. */
  target: TargetRef;
  /** The slot's time zone (as in `catalog`): the instants of the result are shown in it. */
  timezone: string;
  /** As resolved: the operations after `since` up to `until`. */
  since: Seq;
  until: Seq;
  /** Newest first. */
  changes: Array<{
    seq: Seq;
    recorded_at: Instant;
    actor: Actor;
    intent: VersionIntent;
    target: TargetRef;
    fields: Record<FieldName | "*", ChangedField | Array<ChangedField & { valid: Interval }>>;
  }>;
}

/** 04-contract-types §4.5: the result of `history`, by `mode`. */
export type HistoryResult = TimelineResult | AsOfResult | ChangesResult;
