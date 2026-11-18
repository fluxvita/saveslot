// Enumerations of event format v1 (docs/zh-CN/spec/09-event-format.md §6, plus the enums of §5,
// §7 and §8 that §6.8 indexes). Each is an `as const` array, so the value set exists at runtime
// for strict parsing (§1.6: an unknown enum value stops `apply`), plus the derived union type.
//
// Reserved values (§6 "保留值") are NOT members of these arrays: v = 1 neither produces nor accepts
// them. They are listed in RESERVED_ENUM_VALUES only so that error messages can say "reserved"
// instead of "unknown"; both are rejected.
//
// Names follow docs/zh-CN/spec/04-contract-types.md where the contract has the same enum with the
// same v1 value set (the contract marks reserved values `@later`; this package omits them).
// Where the event format's set differs from the contract's, the type has its own name, noted below.

/** §6.1 event types produced by v1. */
export const EVENT_TYPES = [
  "tenant.genesis",
  "tenant.restored",
  "tenant.imported",
  "principal.registered",
  "principal.renamed",
  "principal.revoked",
  "slot.policy_set",
  "schema.draft_submitted",
  "schema.compiled",
  "schema.confirmed",
  "schema.rejected",
  "schema.superseded",
  "schema.migration_started",
  "schema.switched",
  "schema.migration_failed",
  "source.recorded",
  "write.head",
  "write.base",
  "write.derived",
  "item.created",
  "item.merged",
  "item.refreshed",
  "item.superseded",
  "item.resolved",
  "deletion.confirmed",
  "deletion.cancelled",
  "deletion.executed",
  "premise.changed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** §6.2 write intent. Contract `Intent` without `applied_by_rule` (reserved). */
export const INTENTS = ["insert", "update", "correct", "revoke"] as const;
export type Intent = (typeof INTENTS)[number];

/** §6.2 intents of versions in the version table (not in `write.base`). Contract `VersionIntent`. */
export const VERSION_INTENTS = [
  ...INTENTS,
  "deletion",
  "deletion_cancelled",
  "schema_switch",
] as const;
export type VersionIntent = (typeof VERSION_INTENTS)[number];

/**
 * §6.3 status of a contribution item in `write.base` (`fields/<f>/<k>`, `existence/<k>`).
 * The contract's `FieldResultCode` adds `noop`, which never appears in events.
 * `applied_by_rule` is reserved (§6.3, §10), not part of v = 1.
 */
export const FIELD_STATUSES = ["applied", "candidate", "awaiting", "corroborated"] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/** §6.3 status in a deletion event's `restated/<k>`: the write statuses plus `dropped`. */
export const RESTATED_STATUSES = [...FIELD_STATUSES, "dropped"] as const;
export type RestatedStatus = (typeof RESTATED_STATUSES)[number];

/**
 * §6.4 item types that `item.*` events carry. The contract's `ItemType` also has `deletion`
 * (deletion items are not expressed by `item.*` events), hence a separate name.
 */
export const EVENT_ITEM_TYPES = [
  "conflict",
  "awaiting_confirmation",
  "flagged",
  "schema_change",
] as const;
export type EventItemType = (typeof EVENT_ITEM_TYPES)[number];

/**
 * §6.5 decisions recorded in `item.resolved`. The contract's `Decision` also has `cancel`
 * (expressed by `deletion.cancelled`, not `item.resolved`), hence a separate name.
 */
export const EVENT_DECISIONS = [
  "keep_effective",
  "take_candidate",
  "take_previous",
  "confirm",
  "reject",
  "keep",
  "revoke",
] as const;
export type EventDecision = (typeof EVENT_DECISIONS)[number];

/** §6.5 decisions allowed per item type. */
export const DECISIONS_BY_ITEM_TYPE = {
  conflict: ["keep_effective", "take_candidate", "take_previous"],
  awaiting_confirmation: ["confirm", "reject"],
  flagged: ["keep", "revoke"],
  schema_change: ["confirm", "reject"],
} as const satisfies Record<EventItemType, readonly EventDecision[]>;

/**
 * §6.6 `item.created` reason. The contract's `ItemReason` also has the deletion origins
 * (`request`, `restored_*`), hence a separate name.
 */
export const ITEM_CREATED_REASONS = [
  "stale_write",
  "overwrites_change_point",
  "referenced_row",
  "undo_includes_later",
  "undo_hides_later",
  "conflict_cleared_by_deletion",
  "restored_candidate",
  "duplicate_keys",
  "schema_change",
] as const;
export type ItemCreatedReason = (typeof ITEM_CREATED_REASONS)[number];

/** §6.6 `item.superseded` reason. Contract `SupersededReason`. */
export const SUPERSEDED_REASONS = [
  "overwritten",
  "schema_switched",
  "deleted",
  "draft_replaced",
  "deletion_cancelled",
  "matched_changed",
  "nothing_to_revert",
] as const;
export type SupersededReason = (typeof SUPERSEDED_REASONS)[number];

/** §6.7 why a write became a candidate. */
export const CANDIDATE_CAUSES = ["stale_write"] as const;
export type CandidateCause = (typeof CANDIDATE_CAUSES)[number];

/** §6.8 `source.recorded` kind. Contract `SourceKind`. */
export const SOURCE_KINDS = [
  "user_message",
  "agent_note",
  "tool_result",
  "file_ref",
  "api_call",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** §6.8 source level. Contract `SourceLevel`. */
export const SOURCE_LEVELS = ["user_stated", "agent_inferred"] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];

/** §6.8 literal check result. */
export const LITERAL_RESULTS = ["hit", "miss", "na"] as const;
export type LiteralResult = (typeof LITERAL_RESULTS)[number];

/** §6.8 `ver.basis` in `ops/<i>/target`. */
export const VER_BASES = ["explicit", "fallback", "same_request", "external_key"] as const;
export type VerBasis = (typeof VER_BASES)[number];

/** §6.8 `ver.basis` in a premise declaration (no `external_key`). */
export const PREMISE_VER_BASES = ["explicit", "fallback", "same_request"] as const;
export type PremiseVerBasis = (typeof PREMISE_VER_BASES)[number];

/** §6.8 premise declaration `range`. */
export const PREMISE_RANGES = ["whole", "from_now", "row_time", "given"] as const;
export type PremiseRange = (typeof PREMISE_RANGES)[number];

/** §6.8 premise declaration `state`. */
export const PREMISE_STATES = ["current", "changed"] as const;
export type PremiseState = (typeof PREMISE_STATES)[number];

/** §6.8 premise reason. Contract `PremiseReason`. */
export const PREMISE_REASONS = [
  "correct",
  "update",
  "revoke",
  "retroactive",
  "plan_changed",
  "deleted",
] as const;
export type PremiseReason = (typeof PREMISE_REASONS)[number];

/** §5.7 / §6.8 `ops/<i>/valid` modes, per end. */
export const VALID_FROM_MODES = ["given", "now", "corrected_span"] as const;
export type ValidFromMode = (typeof VALID_FROM_MODES)[number];
export const VALID_TO_MODES = ["given", "open", "next_change", "corrected_span"] as const;
export type ValidToMode = (typeof VALID_TO_MODES)[number];
/** §6.8 all `valid` modes. */
export const VALID_MODES = ["given", "now", "open", "next_change", "corrected_span"] as const;
export type ValidMode = (typeof VALID_MODES)[number];

/** §6.8 `write.base` target `cause`. */
export const WRITE_CAUSES = ["request", "resolve"] as const;
export type WriteCause = (typeof WRITE_CAUSES)[number];

/** §6.8 `existence/<k>` scope. */
export const EXISTENCE_SCOPES = ["whole", "interval"] as const;
export type ExistenceScope = (typeof EXISTENCE_SCOPES)[number];

/** §6.8 `deletion.confirmed` kind. */
export const DELETION_KINDS = ["privacy"] as const;
export type DeletionKind = (typeof DELETION_KINDS)[number];

/** §6.8 `deletion.confirmed` origin. */
export const DELETION_ORIGINS = [
  "request",
  "restored_unconfirmed",
  "restored_pending",
  "restored_executed",
] as const;
export type DeletionOrigin = (typeof DELETION_ORIGINS)[number];

/** §6.8 `deletion.cancelled` origin. */
export const CANCEL_ORIGINS = ["request", "restore_cancel"] as const;
export type CancelOrigin = (typeof CANCEL_ORIGINS)[number];

/** §6.8 `deletion.executed` reason. Contract `TombstoneReason`. */
export const TOMBSTONE_REASONS = ["expiry", "restore_backfill", "import_placeholder"] as const;
export type TombstoneReason = (typeof TOMBSTONE_REASONS)[number];

/** §6.8 / §8 export `pending_deletions` (manifest and `tenant.imported` `export`). */
export const PENDING_DELETIONS_MODES = ["placeholder", "included"] as const;
export type PendingDeletionsMode = (typeof PENDING_DELETIONS_MODES)[number];

/** §6.8 deletion result `outcome`. */
export const DELETION_OUTCOMES = [
  "deleted",
  "kept_fields_cleared",
  "fields_reverted",
  "resegmented",
  "sources_changed",
] as const;
export type DeletionOutcome = (typeof DELETION_OUTCOMES)[number];

/** §6.8 `schema.compiled` outcome. */
export const COMPILE_OUTCOMES = ["applied", "pending"] as const;
export type CompileOutcome = (typeof COMPILE_OUTCOMES)[number];

/** §6.8 schema change class. */
export const CHANGE_CLASSES = ["create", "metadata", "deterministic"] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];

/** §6.8 `schema.migration_failed` reason. */
export const MIGRATION_FAILURE_REASONS = ["build_failed", "verify_failed"] as const;
export type MigrationFailureReason = (typeof MIGRATION_FAILURE_REASONS)[number];

/** §6.8 `item.refreshed` cause. */
export const REFRESH_CAUSES = [
  "target_overwritten",
  "references_changed",
  "entries_deleted",
  "entries_restored",
  "matched_changed",
  "entries_changed",
] as const;
export type RefreshCause = (typeof REFRESH_CAUSES)[number];

/** §6.8 `item.resolved` via. */
export const RESOLVE_VIAS = ["call"] as const;
export type ResolveVia = (typeof RESOLVE_VIAS)[number];

/** §6.8 principal kind. */
export const PRINCIPAL_KINDS = ["user", "connection", "system"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** §6.8 `write.head` `request.sv_basis`. */
export const SV_BASES = ["explicit", "fallback"] as const;
export type SvBasis = (typeof SV_BASES)[number];

/** §6.8 `schema.confirmed` by. */
export const CONFIRMED_BY = ["auto", "resolve"] as const;
export type ConfirmedBy = (typeof CONFIRMED_BY)[number];

/** §6.8 `principal.registered` via. */
export const PRINCIPAL_VIAS = ["token", "oauth"] as const;
export type PrincipalVia = (typeof PRINCIPAL_VIAS)[number];

/** §6.8 `impact/<k>` kind. */
export const IMPACT_KINDS = ["overwritten_segment", "referencing_row", "reverted_write"] as const;
export type ImpactKind = (typeof IMPACT_KINDS)[number];

/** §6.8 `sources/…` entry kind. */
export const SOURCE_ENTRY_KINDS = ["value", "schema_const"] as const;
export type SourceEntryKind = (typeof SOURCE_ENTRY_KINDS)[number];

/** §5.4 `effective_value_rule`. */
export const EFFECTIVE_VALUE_RULES = ["keep_current"] as const;
export type EffectiveValueRule = (typeof EFFECTIVE_VALUE_RULES)[number];

/** §5.4 `auto_apply` classes (the contract's `SlotPolicy.auto_apply` element type). */
export const AUTO_APPLY_CLASSES = [
  "add_table",
  "add_derived_table",
  "add_optional_field",
  "description",
  "rename_unused",
  "loosen_constraint",
  "duplicate_keys",
  "restructure_unused",
] as const;
export type AutoApplyClass = (typeof AUTO_APPLY_CLASSES)[number];

/** §6.9 header `trigger`. */
export const TRIGGERS = [
  "deletion_expiry",
  "migration",
  "restore",
  "restore_backfill",
  "import",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Connection scopes (`principal.registered` `scopes`). Contract `Scope`. */
export const SCOPES = [
  "saveslot.read",
  "saveslot.write",
  "saveslot.schema",
  "saveslot.delete",
] as const;
export type Scope = (typeof SCOPES)[number];

/** Schema change codes (`schema.compiled` `changes[].change`). Contract `SchemaChangeCode` without `reextract`. */
export const SCHEMA_CHANGE_CODES = [
  "create_slot",
  "rename_slot",
  "change_timezone",
  "add_table",
  "add_derived_table",
  "drop_table",
  "rename_table",
  "change_duplicate_keys",
  "change_together",
  "change_time_field",
  "add_external_key",
  "drop_external_key",
  "change_time_type",
  "change_entity_key",
  "change_granularity",
  "change_table_kind",
  "change_external_key",
  "add_optional_field",
  "add_required_field",
  "drop_field",
  "rename_field",
  "loosen_constraint",
  "tighten_constraint",
  "change_precision",
  "change_unit",
  "change_dimension",
  "change_type",
  "change_ref",
  "change_rule",
  "change_description",
  "change_aliases",
] as const;
export type SchemaChangeCode = (typeof SCHEMA_CHANGE_CODES)[number];

// §7 compiled schema enums.

/** Field types. Contract `FieldType`. */
export const FIELD_TYPES = [
  "text",
  "integer",
  "decimal",
  "boolean",
  "enum",
  "date",
  "zoned_datetime",
  "quantity",
  "ref",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const TABLE_KINDS = ["base", "derived"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

export const TIME_TYPES = ["none", "event", "state"] as const;
export type TimeType = (typeof TIME_TYPES)[number];

export const GRANULARITIES = ["date", "instant"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const TIME_DEPENDENCIES = ["none", "bucketed", "now"] as const;
export type TimeDependency = (typeof TIME_DEPENDENCIES)[number];

export const RULE_SCOPE_KINDS = ["group", "tenant"] as const;
export type RuleScopeKind = (typeof RULE_SCOPE_KINDS)[number];

export const ROUNDINGS = ["half_up", "half_even"] as const;
export type Rounding = (typeof ROUNDINGS)[number];

export const REF_TARGETS = ["row", "entity"] as const;
export type RefTarget = (typeof REF_TARGETS)[number];

/**
 * Reserved values (§6, §10): names held for later versions. Not part of v = 1; an event of
 * v = 1 carrying one is invalid exactly like an unknown value.
 */
export const RESERVED_ENUM_VALUES = {
  intent: ["applied_by_rule"],
  field_status: ["applied_by_rule"],
  effective_value_rule: ["by_rank"],
  item_type: ["migration_diff", "sync_rejected"],
  decision: ["accept_all", "rows", "keep_rest_and_switch", "abandon"],
  item_created_reason: ["policy_high_impact"],
  superseded_reason: ["evidence_deleted", "migration_failed"],
  candidate_cause: ["displaced_by_rule"],
  source_level: ["external_authority"],
  change_class: ["reextract"],
  resolve_via: ["elicitation"],
  trigger: ["job", "retired_purge", "rejudge", "ruling"],
  schema_change_code: ["reextract"],
  write_cause: ["ruling"],
  deletion_kind: ["evidence"],
} as const;
