// Errors (docs/zh-CN/spec/04-contract-types.md §9). On HTTP an error is the `ErrorEnvelope`
// `{"error": {...}}` with a status code by `code` (docs/zh-CN/spec/05-surfaces.md §13, §14).

import {
  DOMAIN_ERROR_REASONS,
  type SchemaChangeCode,
  type Scope,
} from "@fluxvita/saveslot-contract-core";
import type {
  Actor,
  FieldName,
  Instant,
  ItemId,
  RowId,
  Seq,
  SlotName,
  SourceId,
  Sv,
  TableName,
  TargetRef,
} from "./common.ts";
import type { ItemBase, ItemDetail, ItemResolution } from "./pending.ts";
import type { MigrationStatus } from "./schema.ts";
import type { ValidationDetail } from "./validation.ts";

/**
 * 04-contract-types §9: the outer error codes (the surfaces' own; 02-architecture §11) and the
 * reasons each gives (none: `[]`). The domain codes' are contract-core's.
 */
export const OUTER_ERROR_REASONS = {
  unauthenticated: ["missing", "invalid", "revoked", "expired"],
  insufficient_scope: [],
  rate_limited: ["quota", "busy"],
  handle_expired: ["expired", "restored", "executed", "derived_changed"],
  not_in_this_version: ["parameter", "value", "operation", "table_written", "not_implemented"],
  unavailable: ["busy", "restoring", "importing", "reconciling", "starting"],
  internal: [],
  import_rejected: [
    "unsupported_format",
    "not_from_start",
    "segment_order",
    "chain_broken",
    "checksum_mismatch",
    "incomplete",
    "replay_failed",
  ],
} as const satisfies Record<string, readonly string[]>;

/** 04-contract-types §9: every error code this version gives, with its reasons. */
export const ERROR_REASONS = { ...DOMAIN_ERROR_REASONS, ...OUTER_ERROR_REASONS } as const;

/** 04-contract-types §9 `ErrorCode` (the `@later` codes left out). */
export const ERROR_CODES = Object.keys(ERROR_REASONS) as ErrorCode[];
/** 04-contract-types §9 `ErrorCode` (the `@later` codes left out). */
export type ErrorCode = keyof typeof ERROR_REASONS;

/** The reasons an error of code `C` may give (04-contract-types §9, the "reason" column). */
export type ErrorReason<C extends ErrorCode = ErrorCode> = (typeof ERROR_REASONS)[C][number];

/**
 * 04-contract-types §9 the extra fields of an error, per code (the "其余附带字段" column), all
 * optional here: which ones appear depends on `code` and `reason`.
 */
export interface ErrorDetails {
  // invalid_argument
  /** `ambiguous_table`: candidate table names. */
  candidates?: string[];
  /** `candidate_required`: the item's candidates. */
  candidate_choices?: Array<{ index: number; seq: Seq; actor: Actor }>;
  /** A complete correct example of the mode or parameter. */
  example?: Record<string, unknown>;
  /** `duplicate_external_key`: indexes of the two ops with the same key. */
  ops?: number[];
  /** `external_key_*`: the row holding the key. */
  holder?: RowId;
  /** `external_key_in_use` (key frozen); `not_found` (row removed by pending deletions). */
  deletions?: ItemId[];

  // unknown_table / unknown_field
  name?: string;
  /** At most 3 visible names. */
  nearest?: string[];

  // not_found
  sources?: Array<{
    id: SourceId;
    state: "unknown" | "pending_deletion" | "removed";
    deletion?: ItemId;
  }>;

  // revoked; read_first; too_large (premise_fan_in)
  /** `revoked` and `premise_fan_in`: a `TargetRef`; `read_first`: what must be read first. */
  target?: TargetRef | "row" | "item" | "slot" | "table";
  /** `revoked`: the operation that revoked it. */
  revoked_by?: Seq;

  // derived_readonly
  table?: TableName;
  base_tables?: TableName[];

  // validation_failed, schema_incompatible, draft_outdated
  current_sv?: Sv;

  // read_first
  ref?: TargetRef | ItemId | SlotName;
  /** `task_mismatch`: the task of the read found; `null`: that read had none. */
  read_task?: string | null;
  /** `task_mismatch`: this call's task; `null`: it has none. */
  task?: string | null;

  // schema_incompatible
  /** `field: "*"`: the whole table was restructured. */
  changed_fields?: Array<{ field: FieldName | "*"; change: SchemaChangeCode }>;

  // too_large
  limit_bytes?: number;
  actual_bytes?: number;
  /** `admission`. */
  estimated_rows?: number;
  /** `admission`. */
  suggested_batch?: number;
  /** `result_budget`. */
  narrow_by?: string[];
  /** `premise_fan_in`: valid declarations pointing at the target. */
  count?: number;

  // sql_rejected
  line?: number;
  /** No physical names. */
  node?: string;
  use?: "history";

  // sql_timeout
  elapsed_ms?: number;

  // draft_outdated
  /** `migrating`. */
  migration?: MigrationStatus;

  // field_unmatched
  fields?: Array<{ table: TableName; id: string; name: FieldName }>;

  // confirmation_mismatch
  /** The item's current detail, with the new `item_ver`. */
  current?: ItemDetail;

  // item_closed
  resolution?: ItemResolution;
  superseded?: ItemBase["superseded"];
  /** `expired`, not yet executed. */
  expires_at?: Instant;

  // preview_outdated
  /** The new `deletion_preview` result (with a new `dc_`); not typed by this package yet. */
  preview?: Record<string, unknown>;

  // insufficient_scope
  /** `user_session`: only the user's own session; `all_slots`: a credential whose range is every
   * slot (creating a slot). */
  required_scope?: Scope | "user_session" | "all_slots";

  // handle_expired
  /** An executed `dc_`: the deletion ID. */
  deletion?: ItemId;

  // not_in_this_version
  value?: unknown;
  operation?: string;

  // internal
  /** Incident number for investigation; no content. */
  incident?: string;

  // import_rejected
  seq?: number;
  path?: string;
}

/** 04-contract-types §9 `ErrorObject`, with the per-code fields of `ErrorDetails`. */
export interface ErrorObject extends ErrorDetails {
  code: ErrorCode;
  /**
   * A sentence for people. Untrusted text (05-surfaces §5): it may carry what the caller sent;
   * programs go by `code` and `reason` and do not parse it.
   */
  message?: string;
  /** Finer reason; values per code in §9 (`ERROR_REASONS`). */
  reason?: ErrorReason;
  /** The offending parameter as a JSON-pointer-like path: `"ops/0/valid_to"`. */
  param?: string;
  /** Validation errors: one item each. */
  details?: ValidationDetail[];
  /** Seconds until a retry may succeed. */
  retry_after?: number;
  [extra: string]: unknown;
}

/** 04-contract-types §9 `ErrorEnvelope`: the HTTP error body (05-surfaces §13). */
export interface ErrorEnvelope {
  error: ErrorObject;
}
