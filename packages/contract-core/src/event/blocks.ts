// Content block shapes of event format v1 (docs/zh-CN/spec/09-event-format.md §5).
//
// One named type per block shape. Which path carries which shape, and whether it is a metadata or
// a data block, is the vocabulary in ./vocabulary.ts; BlockShapes at the end of this file is the
// name → type map the vocabulary refers to.
//
// Conventions:
// - Keys the spec describes as "`true` 表示…" (a flag whose absence means false) are typed as the
//   literal `true`; keys written `<布尔>` are `boolean`. Absent optional keys are not encoded and are
//   never `null` (§1.2); `null` appears only as a field value (an explicit empty value, §1.3).
// - "row / entity" targets are a union: `row` (event and timeless tables) or `entity` (state tables).
// - Shapes the spec marks reserved or "not part of v = 1" are not admitted; comments say where.

import type { CompiledSchema } from "./compiled.ts";
import type {
  AutoApplyClass,
  CancelOrigin,
  CandidateCause,
  ChangeClass,
  CompileOutcome,
  ConfirmedBy,
  DeletionKind,
  DeletionOrigin,
  DeletionOutcome,
  EffectiveValueRule,
  EventDecision,
  ExistenceScope,
  FieldStatus,
  Intent,
  LiteralResult,
  MigrationFailureReason,
  PendingDeletionsMode,
  PremiseRange,
  PremiseReason,
  PremiseVerBasis,
  RestatedStatus,
  SchemaChangeCode,
  Scope,
  SourceLevel,
  SupersededReason,
  SvBasis,
  TombstoneReason,
  VerBasis,
} from "./enums.ts";
import type {
  BizInterval,
  BizPoint,
  ConnectionId,
  DateStr,
  DraftId,
  EntityId,
  FieldId,
  FieldValue,
  Hash,
  Index,
  Instant,
  ItemId,
  JsonObject,
  MigrationId,
  OpenBizInterval,
  OpNumber,
  PartitionId,
  RawFieldValue,
  RowId,
  RuleId,
  Seq,
  SlotId,
  SourceId,
  TableId,
  TenantId,
  UserId,
  VersionNumber,
} from "./values.ts";

// =============================================================================================
// Shared building blocks

/** A row (event and timeless tables) or an entity (state tables). */
export type RowOrEntity =
  | { readonly row: RowId; readonly entity?: never }
  | { readonly entity: EntityId; readonly row?: never };

/** A table plus a row or entity. */
export type TableTarget = { readonly table: TableId } & RowOrEntity;

/** One contribution of a `write.base` event to a field: item `k` of field `field`. */
export interface FieldContributionRef {
  readonly event: Seq;
  readonly field: FieldId;
  readonly k: Index;
}

/** One contribution of a `write.base` event to "existence": item `existence`. */
export interface ExistenceContributionRef {
  readonly event: Seq;
  readonly existence: Index;
}

/** A `deps` entry (§3.5) and other references to a contribution. */
export type ContributionRef = FieldContributionRef | ExistenceContributionRef;

/** `deps`: the contributions a derived block's content came from (§3.5). */
export type Deps = readonly ContributionRef[];

/** A value source entry (`sources/<f>/<k>`, results and restated blocks; §5.7). */
export type SourceEntry =
  /** The value comes from a source (`source.recorded` seq). */
  | { readonly kind: "value"; readonly source: Seq }
  /** The value was carried from another contribution (revert, take candidate, take previous). */
  | { readonly kind: "value"; readonly carried: FieldContributionRef }
  /** The value is the constant `backfill` of the switch to schema version `sv`. */
  | { readonly kind: "schema_const"; readonly sv: VersionNumber; readonly field: FieldId };

/**
 * A value source in deletion `results` and in a valued `restated/<k>` (§5.9): always `carried`
 * from an earlier contribution, or a `schema_const` entry, never a direct `source`, so that a
 * later deletion of the carried contribution's sources cascades to the block.
 */
export type CarriedSourceEntry = Exclude<SourceEntry, { readonly source: Seq }>;

/** The version an op saw (`ver` in `ops/<i>/target`). */
export interface VerRef {
  readonly op: OpNumber;
  readonly restore_count: number;
  readonly basis: VerBasis;
}

/** The version a premise declaration saw: no `external_key` basis (§6.8). */
export interface PremiseVerRef {
  readonly op: OpNumber;
  readonly restore_count: number;
  readonly basis: PremiseVerBasis;
}

/** Address of a content block, in deletion `positions` (§5.9). `path` follows §3.1. */
export interface BlockAddress {
  readonly seq: Seq;
  readonly path: string;
}

// =============================================================================================
// §5.1 blocks of head events

/** `ctx` keys of an operation in a slot. */
interface SlotCtxBase {
  readonly now: Instant;
  /** `now` in the slot's time zone. */
  readonly today: DateStr;
  readonly ruleset_version: VersionNumber;
  readonly policy_version: VersionNumber;
}

/**
 * `ctx` (meta) of `write.head`: a write always runs the literal checker, so `literal_checker`
 * (e.g. `literal@1`) is present.
 */
export interface WriteCtxBlock extends SlotCtxBase {
  readonly literal_checker: string;
}

/**
 * `ctx` (meta) of `item.resolved`: `literal_checker` only when the resolution triggers a write.
 * Whether it did is known from the operation's `write.base` events, not from this block.
 */
export interface ResolveCtxBlock extends SlotCtxBase {
  readonly literal_checker?: string;
}

/** `ctx` (meta) of the other slot head events (`schema.draft_submitted`, `deletion.*`). */
export interface SlotCtxBlock extends SlotCtxBase {
  readonly literal_checker?: never;
}

/** `ctx` (meta) of `principal.*`: no slot, so no `today` and no `policy_version`. */
export interface PrincipalCtxBlock {
  readonly now: Instant;
  readonly ruleset_version: VersionNumber;
  readonly today?: never;
  readonly policy_version?: never;
  readonly literal_checker?: never;
}

/** Any `ctx` block (§5.1). Which variant a head event carries is fixed by its type. */
export type CtxBlock = WriteCtxBlock | ResolveCtxBlock | SlotCtxBlock | PrincipalCtxBlock;

/** `task` (data): the caller's task label, a bare string. */
export type TaskBlock = string;

/** `request_key` (data). */
export interface RequestKeyBlock {
  readonly key: string;
}

/** `idempotency` (data): explicit idempotency key and the request fingerprint. */
export interface IdempotencyBlock {
  readonly key: string;
  readonly fingerprint: Hash;
}

// =============================================================================================
// §5.2 tenant

/** `tenant.genesis` `tenant` (meta). */
export interface GenesisTenantBlock {
  readonly tenant_id: TenantId;
  readonly storage_format: number;
  readonly event_format: 1;
}

/** `user` (meta) of `tenant.genesis` and `tenant.imported`. */
export interface UserPrincipalBlock {
  readonly principal: UserId;
  readonly kind: "user";
}

/** `tenant.genesis` `system` (meta). */
export interface SystemPrincipalBlock {
  readonly principal: "system";
  readonly kind: "system";
}

/** `tenant.imported` `tenant` (meta). */
export interface ImportedTenantBlock {
  readonly tenant_id: TenantId;
  readonly previous_tenant_id: TenantId;
  readonly storage_format: number;
  readonly event_format: number;
}

/** `tenant.imported` `export` (meta). */
export interface ImportedExportBlock {
  readonly exported_at: Instant;
  readonly pending_deletions: PendingDeletionsMode;
}

// =============================================================================================
// §5.3 principals

interface RegisteredPrincipalBase {
  readonly principal: ConnectionId;
  readonly kind: "connection";
  readonly scopes: readonly Scope[];
  /**
   * Slot scope: slot IDs, ascending, unique, non-empty. Absent = all slots, including slots
   * created later.
   */
  readonly slots?: readonly [SlotId, ...SlotId[]];
}

/** `principal.registered` `principal` (meta). `client` is present exactly when `via` is `oauth`. */
export type RegisteredPrincipalBlock =
  | (RegisteredPrincipalBase & { readonly via: "token"; readonly client?: never })
  | (RegisteredPrincipalBase & { readonly via: "oauth"; readonly client: string });

/** `principal.renamed` / `principal.revoked` `principal` (meta). */
export interface PrincipalRefBlock {
  readonly principal: ConnectionId;
}

/** `name` (data): the user-given connection name. */
export interface PrincipalNameBlock {
  readonly name: string;
}

// =============================================================================================
// §5.4 slot policy

/**
 * `slot.policy_set` `policy` (meta).
 * `high_impact` and `user_session_only` are always empty in v1; non-empty forms are reserved
 * shapes, not part of v = 1 (§5.4), so the types admit only the empty array.
 */
export interface PolicyBlock {
  readonly policy_version: VersionNumber;
  readonly effective_value_rule: EffectiveValueRule;
  readonly rank: {
    readonly user_stated: number;
    readonly agent_inferred: number;
    readonly miss: number;
  };
  readonly auto_apply: readonly AutoApplyClass[];
  readonly high_impact: readonly [];
  readonly user_session_only: readonly [];
}

// =============================================================================================
// §5.5 schema lifecycle

/** `schema.draft_submitted` `target` (meta). No `base_version` when the draft creates the slot. */
export type DraftSubmittedTarget =
  | { readonly draft_id: DraftId; readonly creates_slot: true; readonly base_version?: never }
  | {
      readonly draft_id: DraftId;
      readonly creates_slot: false;
      readonly base_version: VersionNumber;
    };

/** `schema.draft_submitted` `draft` (data): the submitted schema document, verbatim JSON. */
export type DraftBlock = JsonObject;

/** `schema.compiled` `target` (meta). */
export interface CompiledTarget {
  readonly draft_id: DraftId;
  readonly target_version: VersionNumber;
  readonly outcome: CompileOutcome;
}

/** `schema.compiled` `compiled` (data): see ./compiled.ts. */
export type CompiledBlock = CompiledSchema;

/** What a schema change targets: slot, table, field or derived rule (IDs, never names). */
export type ChangeTarget =
  | { readonly slot: true }
  | { readonly table: TableId }
  | { readonly table: TableId; readonly field: FieldId }
  | { readonly table: TableId; readonly rule: true };

/** One entry of `schema.compiled` `changes`: the contract's `SchemaChange` with IDs in `target`. */
export interface SchemaChangeRecord {
  readonly target: ChangeTarget;
  readonly change: SchemaChangeCode;
  readonly class: ChangeClass;
  readonly compatible_with_old_writes: boolean;
  readonly destructive: boolean;
  readonly auto: boolean;
}

/** `schema.compiled` `changes` (meta). */
export type ChangesBlock = readonly SchemaChangeRecord[];

/** `schema.confirmed` `target` (meta). */
export interface ConfirmedTarget {
  readonly draft_id: DraftId;
  readonly target_version: VersionNumber;
  readonly by: ConfirmedBy;
}

/** `schema.rejected` `target` (meta). */
export interface RejectedTarget {
  readonly draft_id: DraftId;
}

/** `schema.superseded` `target` (meta). */
export interface SchemaSupersededTarget {
  readonly draft_id: DraftId;
  readonly by_draft: DraftId;
}

/** `schema.migration_started` `target` (meta). */
export interface MigrationStartedTarget {
  readonly migration_id: MigrationId;
  readonly draft_id: DraftId;
  readonly from_version: VersionNumber;
  readonly to_version: VersionNumber;
}

/**
 * `schema.switched` `target` (meta). No `from_version` when the slot is created; no
 * `migration_id` when no migration ran.
 */
export interface SwitchedTarget {
  readonly draft_id: DraftId;
  readonly from_version?: VersionNumber;
  readonly to_version: VersionNumber;
  readonly migration_id?: MigrationId;
  readonly rebuilt_tables: readonly TableId[];
}

/** `schema.switched` `tables/<table>` (data): logical row count and result checksum (§5.13). */
export interface SwitchedTableBlock {
  readonly rows: number;
  readonly checksum: Hash;
}

/** `schema.switched` `backfill_rows/<table>/<field>/<n>` (meta): row IDs, ascending, ≤ 10,000. */
export type BackfillRowsBlock = readonly RowId[];

/** `schema.switched` `backfill/<table>/<field>/<n>` (data): one backfilled stretch of an entity. */
export interface BackfillSegmentBlock {
  readonly entity: EntityId;
  readonly valid: BizInterval;
  readonly deps: Deps;
}

/** `schema.migration_failed` `target` (meta). */
export interface MigrationFailedTarget {
  readonly migration_id: MigrationId;
  readonly reason: MigrationFailureReason;
}

// =============================================================================================
// §5.6 source data

interface SourceTargetBase {
  readonly source_id: SourceId;
  readonly level: SourceLevel;
}

/**
 * `source.recorded` `target` (meta). `op_index` exists only on a `write`'s `api_call` source;
 * a `resolve`'s `api_call` has none.
 */
export type SourceTarget =
  | (SourceTargetBase & {
      readonly kind: "user_message" | "agent_note" | "tool_result" | "file_ref";
      readonly op_index?: never;
    })
  | (SourceTargetBase & { readonly kind: "api_call"; readonly op_index?: Index });

/** `source.recorded` `text` (data): `user_message`, `agent_note`, `tool_result`. */
export interface SourceTextBlock {
  readonly text: string;
}

/** `source.recorded` `file` (data): `file_ref`. The last three keys may be absent. */
export interface SourceFileBlock {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256?: Hash;
  readonly origin?: string;
  readonly excerpt?: string;
}

/** `source.recorded` `request` (data): the request JSON of one op (write) or the resolve request. */
export type SourceRequestBlock = JsonObject;

/** `source.recorded` `stated_at` (data). */
export interface StatedAtBlock {
  readonly at: Instant;
}

// =============================================================================================
// §5.7 write.head

/** `write.head` `request` (meta). */
export interface WriteRequestBlock {
  readonly sv: VersionNumber;
  readonly sv_basis: SvBasis;
  /** All ops of the request, including those that did not enter any event. */
  readonly op_count: number;
}

/** `ops/<i>/target` (meta). */
export type OpTargetBlock = TableTarget & {
  readonly by_entity_key?: true;
  readonly by_external_key?: true;
  /** The revoked row the external key was taken over from. */
  readonly key_from?: RowId;
  readonly created?: true;
  readonly intent: Intent;
  /** Absent on inserts. */
  readonly ver?: VerRef;
};

/** `ops/<i>/set/<field>` (data): the raw value as the caller gave it, not canonicalized (§1.3). */
export type RawValueBlock = RawFieldValue;

/** `ops/<i>/noop` (meta) and `ops/<i>/named_fields` (meta): field IDs. */
export type FieldIdListBlock = readonly FieldId[];

/** One end of `ops/<i>/valid`. */
export type ValidFrom =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "now" }
  | { readonly mode: "corrected_span" };
export type ValidTo =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "open" }
  | { readonly mode: "next_change" }
  | { readonly mode: "corrected_span" };

/** `ops/<i>/valid` (data, state tables only): the raw interval parameters. */
export interface ValidParamBlock {
  readonly from: ValidFrom;
  readonly to: ValidTo;
}

/** `ops/<i>/revert` (meta). */
export interface OpRevertBlock {
  readonly undo_op: OpNumber;
  readonly include_later: boolean;
}

/** `ops/<i>/acknowledge` (meta). */
export type AcknowledgeBlock = readonly ["overwrite"];

/** `ops/<i>/refs` (data): the temporary name this op registered. */
export interface RefsBlock {
  readonly as: string;
}

/** `ops/<i>/baseline` (meta): field ID → sync baseline operation number. */
export type BaselineBlock = { readonly [field: FieldId]: OpNumber };

interface PremiseBase {
  readonly table: TableId;
  /** Declared fields; absent = the whole row. */
  readonly fields?: readonly FieldId[];
  readonly ver: PremiseVerRef;
  readonly range: PremiseRange;
}

/** `ops/<i>/premises/<j>` (meta): one premise declaration. */
export type PremiseBlock = PremiseBase &
  RowOrEntity &
  (
    | { readonly state: "current"; readonly reason?: never; readonly since?: never }
    | { readonly state: "changed"; readonly reason: PremiseReason; readonly since: OpNumber }
  );

/** `ops/<i>/premise_valid/<j>` (data): the premise's business time, aligned to the table. */
export type PremiseValidBlock =
  | { readonly at: BizPoint; readonly during?: never; readonly deps?: Deps }
  | { readonly during: BizInterval; readonly at?: never; readonly deps?: Deps };

/** `ops/<i>/premise_covers` (meta): further contributions the declarations cover. */
export type PremiseCoversBlock = readonly ContributionRef[];

/** `ops/<i>/premises_cleared` (meta): the op carried `premises: []`. */
export type PremisesClearedBlock = true;

// =============================================================================================
// §5.7 write.base

interface WriteBaseTargetBase {
  readonly table: TableId;
  readonly intent: Intent;
  readonly sv: VersionNumber;
  readonly created?: true;
}

/**
 * `write.base` `target` (meta). `op_index` for writes caused by a request; `item` for writes
 * caused by resolving an item. `cause: "ruling"` is reserved (§10), not part of v = 1.
 */
export type WriteBaseTarget = WriteBaseTargetBase &
  RowOrEntity &
  (
    | { readonly cause: "request"; readonly op_index: Index; readonly item?: never }
    | { readonly cause: "resolve"; readonly item: ItemId; readonly op_index?: never }
  );

/** `fields/<field>/<k>` (data): one contribution item to a field. */
export type FieldItemBlock =
  | {
      readonly status: FieldStatus;
      readonly value: FieldValue;
      readonly no_value?: never;
      readonly uncovered?: never;
    }
  /** Write-back of "no contribution at all" (revert and take previous only). */
  | { readonly status: FieldStatus; readonly no_value: true; readonly value?: never }
  /** Registration only: the reverted item stops counting, nothing is covered (revert only). */
  | { readonly status: FieldStatus; readonly uncovered: true; readonly value?: never };

/** `sources/<field>/<k>` (data): the item's value sources. */
export type SourcesBlock = readonly SourceEntry[];

/** `literal/<field>/<k>` (data): literal check per evidence segment. */
export interface LiteralBlock {
  readonly segments: readonly { readonly source: Seq; readonly result: LiteralResult }[];
}

/**
 * `span/<field>/<k>` (data, state tables): the item's resolved interval. Candidates carry
 * `seen_valid` instead of `valid`.
 */
export type SpanBlock =
  | { readonly valid: BizInterval; readonly seen_valid?: never; readonly deps?: Deps }
  | { readonly seen_valid: BizInterval; readonly valid?: never; readonly deps?: Deps };

/** `existence/<k>` (meta): one contribution item to "existence". */
export interface ExistenceItemBlock {
  readonly status: FieldStatus;
  readonly scope: ExistenceScope;
  /** A write-back that restores existence (reverting a revoke). */
  readonly restored?: true;
}

/** `span/existence/<k>` (data): the interval of an `interval`-scoped existence item. */
export interface ExistenceSpanBlock {
  readonly valid: BizInterval;
  readonly deps?: Deps;
}

/** `valid_sources` / `op_sources` (meta): `source.recorded` seqs. */
export type SourceSeqListBlock = readonly Seq[];

/** `duplicate` (data): the duplicate-key match, judged once at write time. */
export interface DuplicateBlock {
  /** At most 10 rows, most recently written first. */
  readonly matched: readonly RowId[];
  readonly keys: readonly FieldId[];
  readonly deps: Deps;
}

/**
 * `ack/<j>` (data): one stretch an `acknowledge` confirmed overwriting: its value and the operation
 * that wrote it, or `no_value` where it had none (the entity had no value, or the field no
 * contribution; not told apart).
 */
export type AckBlock = {
  readonly field: FieldId;
  readonly valid: BizInterval;
  readonly deps: Deps;
} & (
  | { readonly value: FieldValue; readonly op: OpNumber; readonly no_value?: never }
  | { readonly no_value: true; readonly value?: never; readonly op?: never }
);

/**
 * An entry of a revert record (§5.7): an (event, target), not an index. It covers every item of
 * that event on that target in a replay, whatever its index and its status when written.
 */
export type RevertTarget =
  | { readonly event: Seq; readonly field: FieldId; readonly existence?: never }
  | { readonly event: Seq; readonly existence: true; readonly field?: never };

/**
 * An entry of an `undo` revert record; `later` marks a later write's entry taken back through
 * `include_later`, which only `undo` has (a `take_previous` record lists plain entries).
 */
export type RevertItem = RevertTarget & { readonly later?: true };

/** An `undo` entry that was skipped when the revert was written: for history and receipts only. */
export type SkippedItem = RevertTarget & { readonly by_op: OpNumber };

/** `revert` (meta): the revert record of an `undo` or of a `take_previous`. */
export type RevertBlock =
  | {
      readonly before_op: OpNumber;
      readonly items: readonly RevertItem[];
      readonly skipped?: readonly SkippedItem[];
      readonly as_of_op?: never;
      readonly item?: never;
    }
  | {
      readonly as_of_op: OpNumber;
      readonly item: ItemId;
      readonly items: readonly RevertTarget[];
      readonly before_op?: never;
      readonly skipped?: never;
    };

/**
 * `take` (meta): the take record of a `take_candidate` (§5.8 `item.resolved`): the item, the
 * candidate taken, the merge base and the covered (event, target)s, listed as a `take_previous`
 * revert record is. Sequence numbers and targets only; it registers nothing.
 */
export interface TakeBlock {
  readonly item: ItemId;
  readonly candidate: Index;
  readonly merge_base_op: OpNumber;
  readonly items: readonly RevertTarget[];
}

// =============================================================================================
// §5.7 write.derived

/** `write.derived` `target` (meta). */
export interface DerivedTarget {
  readonly table: TableId;
  readonly rule: RuleId;
  readonly rule_version: VersionNumber;
  readonly partition: PartitionId;
  readonly read_pos: Seq;
  readonly reads: readonly { readonly table: TableId }[];
  readonly emptied: boolean;
}

/** `write.derived` `key` (data): group key values in the rule's key order. */
export interface DerivedKeyBlock {
  readonly values: readonly FieldValue[];
}

/** `checksum` (data): result checksum of a derived write (§5.13). */
export interface ChecksumBlock {
  readonly checksum: Hash;
}

// =============================================================================================
// §5.8 pending items

/** Conflict unit `unit` (§5.8): always an array; a unit on "existence" is `["existence"]`. */
export type ConflictUnit = readonly FieldId[] | readonly ["existence"];

interface ItemTargetVersions {
  readonly ruleset_version: VersionNumber;
  readonly policy_version: VersionNumber;
}

/**
 * `item.created` `target` (meta), by item type.
 * Presence per type (§5.8): `merge_base_op` only on conflicts, `draft` only on schema changes,
 * `origin_event` on write-caused items, `related_item` exactly with `restored_candidate`, `unit`
 * optional on `flagged` (the whole row is flagged).
 */
export type ItemCreatedTarget =
  | (ItemTargetVersions &
      TableTarget & {
        readonly item: ItemId;
        readonly type: "conflict";
        readonly reason: "stale_write";
        readonly unit: ConflictUnit;
        readonly merge_base_op: OpNumber;
        readonly origin_event: Seq;
        readonly related_item?: never;
      })
  | (ItemTargetVersions &
      TableTarget & {
        readonly item: ItemId;
        readonly type: "conflict";
        readonly reason: "restored_candidate";
        readonly unit: ConflictUnit;
        readonly merge_base_op: OpNumber;
        readonly origin_event: Seq;
        readonly related_item: ItemId;
      })
  | (ItemTargetVersions &
      TableTarget & {
        readonly item: ItemId;
        readonly type: "awaiting_confirmation";
        readonly reason:
          | "overwrites_change_point"
          | "referenced_row"
          | "undo_includes_later"
          | "undo_hides_later"
          | "conflict_cleared_by_deletion";
        readonly unit: ConflictUnit;
        readonly origin_event: Seq;
      })
  | (ItemTargetVersions &
      TableTarget & {
        readonly item: ItemId;
        readonly type: "flagged";
        readonly reason: "duplicate_keys";
        readonly unit?: ConflictUnit;
        readonly origin_event: Seq;
      })
  | (ItemTargetVersions & {
      readonly item: ItemId;
      readonly type: "schema_change";
      readonly reason: "schema_change";
      readonly draft: DraftId;
    });

/**
 * `scope_valid` (data, state tables): the item's business time interval as its spans, by start,
 * apart (neither overlapping nor touching), only the last one open; the whole time is `[{}]`,
 * the one span without a start. With `deps`.
 */
export interface ScopeValidBlock {
  readonly spans: readonly [BizInterval, ...BizInterval[]] | readonly [Record<string, never>];
  readonly deps: Deps;
}

/**
 * `current/<k>` (data): one stretch of the current effective value.
 * `valid` only on state tables (§5.8), likewise in `proposed`, `previous` and
 * `overwritten_segment` impacts.
 */
/**
 * An entry on the unit "existence" (§5.8): a revoked stretch, `op` the revoke, or a stretch with a
 * value, `deps` what gives it one. A stretch neither covers has no value, and not from a revoke;
 * the fields' values are not part of the item.
 */
export type RevokedEntryBlock =
  | {
      readonly field: "existence";
      readonly revoked: true;
      readonly valid?: BizInterval;
      readonly op: OpNumber;
      readonly deps: Deps;
    }
  | { readonly field: "existence"; readonly valid?: BizInterval; readonly deps: Deps };

export type CurrentEntryBlock =
  | {
      readonly field: FieldId;
      readonly value: FieldValue;
      readonly valid?: BizInterval;
      readonly op: OpNumber;
      readonly deps: Deps;
    }
  | RevokedEntryBlock;

/** One item of a candidate: a field item, or an existence item (`intent: "revoke"`). */
export type CandidateItem =
  | {
      readonly field: FieldId;
      readonly k: Index;
      readonly value: FieldValue;
      readonly valid?: BizInterval;
    }
  | { readonly existence: Index; readonly valid?: BizInterval };

/** `candidates/<k>` (data): all candidate items of one write in this conflict unit. */
export interface CandidateBlock {
  readonly event: Seq;
  readonly intent: Intent;
  readonly seen: { readonly op: OpNumber; readonly restore_count: number };
  readonly cause: CandidateCause;
  readonly items: readonly CandidateItem[];
  readonly deps: Deps;
}

/** `proposed/<k>` and `previous/<k>` (data): a value on one field, with `deps`. */
export interface FieldEntryBlock {
  readonly field: FieldId;
  readonly value: FieldValue;
  readonly valid?: BizInterval;
  readonly deps: Deps;
}

/**
 * `impact/<k>` (data).
 * `referencing_row` names the referencing row, or the entity when it is in a state table (§5.8).
 */
export type ImpactBlock =
  | {
      readonly kind: "overwritten_segment";
      readonly field: FieldId;
      readonly valid?: BizInterval;
      readonly value: FieldValue;
      /**
       * A stretch without a value (a gap filled; `value` null), apart from a value cleared to null
       * (§5.8).
       */
      readonly gap?: true;
      /** The write that gave the stretch; on a gap, the revoke that left it, if one did. */
      readonly op?: OpNumber;
      readonly deps: Deps;
    }
  | (TableTarget & { readonly kind: "referencing_row"; readonly field: FieldId })
  | { readonly kind: "reverted_write"; readonly op: OpNumber; readonly deps: Deps };

/** `matched/<k>` (data): the other row of a duplicate match. */
export interface MatchedBlock {
  readonly row: RowId;
  readonly deps: Deps;
}

/** `item.merged` `target` (meta). */
export interface ItemMergedTarget extends ItemTargetVersions {
  readonly item: ItemId;
  readonly merge_base_op: OpNumber;
  readonly origin_event: Seq;
}

/**
 * `item.refreshed` `target` (meta).
 * `by_event` is absent for `entries_deleted` and `entries_restored`; `writer_had_read` is absent
 * for `matched_changed` (flagged items do not look at reads).
 * Presence per cause (§5.8): `dropped_candidates` only with `entries_deleted`,
 * `restored_candidates` only with `entries_restored`, non-empty when present; `merge_base_op`
 * optional on every cause.
 */
export type ItemRefreshedTarget =
  | {
      readonly item: ItemId;
      readonly cause: "target_overwritten";
      readonly by_event: Seq;
      readonly writer_had_read: false;
      readonly merge_base_op?: OpNumber;
    }
  | {
      readonly item: ItemId;
      readonly cause: "references_changed";
      readonly by_event: Seq;
      readonly writer_had_read: boolean;
      readonly merge_base_op?: OpNumber;
    }
  | {
      readonly item: ItemId;
      readonly cause: "matched_changed";
      readonly by_event: Seq;
      readonly merge_base_op?: OpNumber;
    }
  | {
      /** Recomputed at the end of a request without being reached (§5.8): no reads looked at. */
      readonly item: ItemId;
      readonly cause: "entries_changed";
      readonly by_event: Seq;
      readonly merge_base_op?: OpNumber;
    }
  | {
      readonly item: ItemId;
      readonly cause: "entries_deleted";
      readonly dropped_candidates?: readonly [Index, ...Index[]];
      readonly merge_base_op?: OpNumber;
    }
  | {
      readonly item: ItemId;
      readonly cause: "entries_restored";
      readonly restored_candidates?: readonly [Index, ...Index[]];
      readonly merge_base_op?: OpNumber;
    };

/** `item.superseded` `target` (meta). `writer_had_read` only with `overwritten`. */
export type ItemSupersededTarget =
  | {
      readonly item: ItemId;
      readonly reason: "overwritten";
      readonly by_event: Seq;
      readonly writer_had_read: boolean;
    }
  | {
      readonly item: ItemId;
      readonly reason: Exclude<SupersededReason, "overwritten">;
      readonly by_event: Seq;
      readonly writer_had_read?: never;
    };

/**
 * `item.resolved` `target` (meta). `candidate` only with `take_candidate`.
 * `via: "elicitation"` is reserved (§6.8, §10), not part of v = 1.
 */
export type ItemResolvedTarget = {
  readonly item: ItemId;
  readonly item_op: OpNumber;
  readonly restore_count: number;
  readonly via: "call";
} & (
  | { readonly decision: "take_candidate"; readonly candidate: Index }
  | {
      readonly decision: Exclude<EventDecision, "take_candidate">;
      readonly candidate?: never;
    }
);

/** `item.resolved` `confirmation` (data): hash of the confirmed entry blocks. */
export interface ConfirmationBlock {
  readonly hash: Hash;
}

// =============================================================================================
// §5.9 deletion

/** `deletion.confirmed` `target` (meta). `kind: "evidence"` is reserved (§10). */
export interface DeletionConfirmedTarget {
  readonly deletion: ItemId;
  readonly kind: DeletionKind;
  readonly due_at: Instant;
  readonly sources: readonly Seq[];
  readonly origin: DeletionOrigin;
}

/** `positions` (meta): content blocks to clear (confirmed) or cleared (executed). */
export type PositionsBlock = readonly BlockAddress[];

/** `summary` (data): hash of the impact summary bound by the confirmation handle. */
export interface SummaryBlock {
  readonly hash: Hash;
}

/** `results/<k>/target` (meta): one affected row or entity. */
export type ResultTargetBlock = TableTarget & { readonly outcome: DeletionOutcome };

/**
 * `results/<k>/fields/<field>/<j>` (data): one stretch of the field after the deletion. State
 * tables add `valid` and `deps` together (`deps` always holds the carried item, §5.9). An
 * emptied field has `value: null` and `sources: []`.
 */
export type ResultFieldBlock = {
  readonly value: FieldValue;
  readonly sources: readonly CarriedSourceEntry[];
} & (
  | { readonly valid?: never; readonly deps?: never }
  | { readonly valid: BizInterval; readonly deps: Deps }
);

/** `results/<k>/existence` (data, state tables): the gaps after the deletion. */
export interface ResultExistenceBlock {
  readonly gaps: readonly OpenBizInterval[];
  readonly deps: Deps;
}

interface RestatedJudgement {
  readonly status: RestatedStatus;
  /** State tables; candidates use `seen_valid`; `dropped` has neither. */
  readonly valid?: BizInterval;
  readonly seen_valid?: BizInterval;
  readonly deps?: Deps;
}

/**
 * `restated/<k>` (data): the judgement of one contribution after the deletion replay.
 * `value` + `sources`, `no_value` and `uncovered` are mutually exclusive and only on carried items.
 */
export type RestatedBlock =
  | (FieldContributionRef &
      RestatedJudgement &
      (
        | {
            readonly value?: never;
            readonly sources?: never;
            readonly no_value?: never;
            readonly uncovered?: never;
          }
        | {
            readonly value: FieldValue;
            readonly sources: readonly CarriedSourceEntry[];
            readonly no_value?: never;
            readonly uncovered?: never;
          }
        | {
            readonly no_value: true;
            readonly value?: never;
            readonly sources?: never;
            readonly uncovered?: never;
          }
        | {
            readonly uncovered: true;
            readonly value?: never;
            readonly sources?: never;
            readonly no_value?: never;
          }
      ))
  | (ExistenceContributionRef & RestatedJudgement & { readonly restored?: true });

/** `recreated/<k>` (meta): a change of the first-creation mark of a `write.base`. */
export interface RecreatedBlock {
  readonly event: Seq;
  readonly created: boolean;
}

/** `superseded_items` / `restored_items` (meta): item IDs. */
export type ItemIdListBlock = readonly ItemId[];

/** `deletion.cancelled` `target` (meta). */
export interface DeletionCancelledTarget {
  readonly deletion: ItemId;
  readonly origin: CancelOrigin;
}

/** `kept_superseded/<k>` (meta). */
export interface KeptSupersededBlock {
  readonly item: ItemId;
  readonly by_event: Seq;
}

/** `kept_effective/<k>` (meta). */
export interface KeptEffectiveBlock {
  readonly event: Seq;
  readonly items: readonly (
    | { readonly field: FieldId; readonly k: Index }
    | { readonly existence: Index }
  )[];
  readonly by_event: Seq;
}

/** `deletion.executed` `target` (meta). */
export interface DeletionExecutedTarget {
  readonly deletion: ItemId;
  readonly reason: TombstoneReason;
}

// =============================================================================================
// §5.10 premise.changed

/** A premise declaration's identity: (operation number, op index, declaration index). */
export interface PremiseDeclRef {
  readonly op: OpNumber;
  readonly i: Index;
  readonly j: Index;
}

/** `premise.changed` `targets/<k>` (meta). The three lists are absent when empty. */
export type PremiseTargetBlock = TableTarget & {
  readonly by_event: Seq;
  readonly changed?: readonly (PremiseDeclRef & { readonly reason: PremiseReason })[];
  readonly matched?: readonly PremiseDeclRef[];
  readonly repointed?: readonly PremiseDeclRef[];
};

// =============================================================================================
// Name → type map used by the vocabulary.

export interface BlockShapes {
  WriteCtx: WriteCtxBlock;
  ResolveCtx: ResolveCtxBlock;
  SlotCtx: SlotCtxBlock;
  PrincipalCtx: PrincipalCtxBlock;
  Task: TaskBlock;
  RequestKey: RequestKeyBlock;
  Idempotency: IdempotencyBlock;
  GenesisTenant: GenesisTenantBlock;
  UserPrincipal: UserPrincipalBlock;
  SystemPrincipal: SystemPrincipalBlock;
  ImportedTenant: ImportedTenantBlock;
  ImportedExport: ImportedExportBlock;
  RegisteredPrincipal: RegisteredPrincipalBlock;
  PrincipalRef: PrincipalRefBlock;
  PrincipalName: PrincipalNameBlock;
  Policy: PolicyBlock;
  DraftSubmittedTarget: DraftSubmittedTarget;
  Draft: DraftBlock;
  CompiledTarget: CompiledTarget;
  Compiled: CompiledBlock;
  Changes: ChangesBlock;
  ConfirmedTarget: ConfirmedTarget;
  RejectedTarget: RejectedTarget;
  SchemaSupersededTarget: SchemaSupersededTarget;
  MigrationStartedTarget: MigrationStartedTarget;
  SwitchedTarget: SwitchedTarget;
  SwitchedTable: SwitchedTableBlock;
  BackfillRows: BackfillRowsBlock;
  BackfillSegment: BackfillSegmentBlock;
  MigrationFailedTarget: MigrationFailedTarget;
  SourceTarget: SourceTarget;
  SourceText: SourceTextBlock;
  SourceFile: SourceFileBlock;
  SourceRequest: SourceRequestBlock;
  StatedAt: StatedAtBlock;
  WriteRequest: WriteRequestBlock;
  OpTarget: OpTargetBlock;
  RawValue: RawValueBlock;
  FieldIdList: FieldIdListBlock;
  ValidParam: ValidParamBlock;
  OpRevert: OpRevertBlock;
  Acknowledge: AcknowledgeBlock;
  Refs: RefsBlock;
  Baseline: BaselineBlock;
  Premise: PremiseBlock;
  PremiseValid: PremiseValidBlock;
  PremiseCovers: PremiseCoversBlock;
  PremisesCleared: PremisesClearedBlock;
  WriteBaseTarget: WriteBaseTarget;
  FieldItem: FieldItemBlock;
  Sources: SourcesBlock;
  Literal: LiteralBlock;
  Span: SpanBlock;
  ExistenceItem: ExistenceItemBlock;
  ExistenceSpan: ExistenceSpanBlock;
  SourceSeqList: SourceSeqListBlock;
  Duplicate: DuplicateBlock;
  Ack: AckBlock;
  Revert: RevertBlock;
  Take: TakeBlock;
  DerivedTarget: DerivedTarget;
  DerivedKey: DerivedKeyBlock;
  Checksum: ChecksumBlock;
  ItemCreatedTarget: ItemCreatedTarget;
  ScopeValid: ScopeValidBlock;
  CurrentEntry: CurrentEntryBlock;
  Candidate: CandidateBlock;
  FieldEntry: FieldEntryBlock;
  PreviousEntry: FieldEntryBlock | RevokedEntryBlock;
  Impact: ImpactBlock;
  Matched: MatchedBlock;
  ItemMergedTarget: ItemMergedTarget;
  ItemRefreshedTarget: ItemRefreshedTarget;
  ItemSupersededTarget: ItemSupersededTarget;
  ItemResolvedTarget: ItemResolvedTarget;
  Confirmation: ConfirmationBlock;
  DeletionConfirmedTarget: DeletionConfirmedTarget;
  Positions: PositionsBlock;
  Summary: SummaryBlock;
  ResultTarget: ResultTargetBlock;
  ResultField: ResultFieldBlock;
  ResultExistence: ResultExistenceBlock;
  Restated: RestatedBlock;
  Recreated: RecreatedBlock;
  ItemIdList: ItemIdListBlock;
  DeletionCancelledTarget: DeletionCancelledTarget;
  KeptSuperseded: KeptSupersededBlock;
  KeptEffective: KeptEffectiveBlock;
  DeletionExecutedTarget: DeletionExecutedTarget;
  PremiseTarget: PremiseTargetBlock;
}

export type BlockShapeName = keyof BlockShapes;
