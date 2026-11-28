// The domain errors and their reasons (docs/zh-CN/spec/04-contract-types.md §9 `ErrorCode`, the
// "reason" column; 02-architecture §11: domain errors in contract-core, the surfaces' own in
// contract). One list of reasons per code: the kernel types the errors it raises by them, and the
// contract adds the outer codes' to give every layer the same table.
//
// The kernel raises four outer codes too. Their reasons are listed here as the kernel's
// (`KERNEL_OUTER_ERROR_REASONS`); the service layer pins them, at compile time, to the contract's
// table for the same codes, except `internal`, whose reasons are the kernel's own: the service
// layer never passes them on (04-contract §16).

/** Why a rule's or a query's SQL was refused (04-contract-types §9 `sql_rejected`, `sql_reason`). */
export const SQL_REASONS = [
  "syntax",
  "not_select",
  "function",
  "node",
  "system_time",
  "unknown_name",
  "type",
  "limit",
  "runtime",
] as const;
export type SqlReason = (typeof SQL_REASONS)[number];

/**
 * 04-contract-types §9: the domain error codes and the reasons each gives (none: `[]`). The
 * `@later` codes (`referenced`, `lease_expired`) are not listed: this version gives neither.
 */
export const DOMAIN_ERROR_REASONS = {
  invalid_argument: [
    "missing",
    "malformed",
    "ambiguous_table",
    "mode_mismatch",
    "mutually_exclusive",
    "not_this_target",
    "content_deleted",
    "undo_target",
    "event_table_valid_at",
    "no_value_now",
    "no_time_table",
    "not_state_table",
    "state_table",
    "granularity",
    "key_field_changed",
    "insert_with_entity_key",
    "candidate_required",
    "derived_table",
    "pending_deletion_source",
    "pending_deletion_target",
    "cross_slot",
    "idempotency_key_reuse",
    "index_out_of_range",
    "empty_mapping",
    "operator_type",
    "missing_read_scope",
    "empty_slots",
    "slot_not_empty",
    "duplicate_name",
    "tenant_not_empty",
    "insert_with_external_key",
    "no_external_key",
    "duplicate_external_key",
    "external_key_in_use",
    "external_key_not_transferable",
    "external_key_transferred",
    "premises_with_external_key",
    "premise_self",
    "premises_with_revert",
    "premises_with_revoke",
    "premise_historical_ver",
    "premise_duplicate_target",
    "premise_target_pending",
    "no_change",
  ],
  unknown_table: [],
  unknown_field: [],
  not_found: ["row", "entity", "item", "source", "draft", "connection", "read", "slot", "route"],
  revoked: [],
  derived_readonly: [],
  validation_failed: ["write", "schema"],
  read_first: ["no_read", "task_mismatch"],
  schema_incompatible: [],
  too_large: [
    "evidence_segment",
    "request",
    "ops",
    "evidence_segments",
    "request_body",
    "admission",
    "result_budget",
    "premise_entries",
    "premise_fan_in",
    "import_line",
  ],
  sql_rejected: SQL_REASONS,
  sql_timeout: [],
  draft_outdated: [
    "base_version",
    "migrating",
    "table_written",
    "migrate_failed",
    "name_taken",
    "backfill_required",
  ],
  field_unmatched: [],
  confirmation_mismatch: ["changed", "restored"],
  item_closed: ["resolved", "superseded", "expired"],
  preview_outdated: [],
} as const satisfies Record<string, readonly string[]>;

export type DomainErrorCode = keyof typeof DOMAIN_ERROR_REASONS;
export const DOMAIN_ERROR_CODES = Object.keys(DOMAIN_ERROR_REASONS) as DomainErrorCode[];

/**
 * The outer codes the kernel raises, with the reasons it gives them. All but `internal`'s are
 * the contract's for the same code (the service layer checks it at compile time). `internal`'s are
 * the kernel's own: `not_implemented` (a path this version stops on; the service layer gives it
 * as `not_in_this_version`) and `inconsistent` (the log or the storage contradicts itself; the
 * service layer gives an `internal` with an incident and no reason).
 */
export const KERNEL_OUTER_ERROR_REASONS = {
  internal: ["not_implemented", "inconsistent"],
  not_in_this_version: ["parameter", "value", "operation", "table_written", "not_implemented"],
  handle_expired: ["expired", "restored", "executed", "derived_changed", "deletion_changed"],
  insufficient_scope: [],
} as const satisfies Record<string, readonly string[]>;

export type KernelOuterErrorCode = keyof typeof KERNEL_OUTER_ERROR_REASONS;

/** Every code an error the kernel raises to a caller may carry. */
export type KernelErrorCode = DomainErrorCode | KernelOuterErrorCode;

type KernelReasons = typeof DOMAIN_ERROR_REASONS & typeof KERNEL_OUTER_ERROR_REASONS;

/** The reasons a kernel error of code `C` may give. */
export type KernelErrorReason<C extends KernelErrorCode> = KernelReasons[C][number];

/**
 * What a kernel error carries beside its code and message: the reason, typed by the code, and the
 * code's other fields (04-contract-types §9 "Other accompanying fields", not typed here).
 */
export type KernelErrorDetail<C extends KernelErrorCode> = {
  readonly reason?: KernelErrorReason<C>;
  readonly param?: string;
} & Readonly<Record<string, unknown>>;
