// Errors (docs/zh-CN/spec/04-contract-types.md §9). On HTTP an error is the `ErrorEnvelope`
// `{"error": {...}}` with a status code by `code` (docs/zh-CN/spec/05-surfaces.md §13, §14).

import type { SchemaChangeCode, Scope } from "@fluxvita/saveslot-contract-core";
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

/** 04-contract-types §9 `ErrorCode`. */
export const ERROR_CODES = [
  // domain errors
  "invalid_argument",
  "unknown_table",
  "unknown_field",
  "not_found",
  "revoked",
  "derived_readonly",
  "validation_failed",
  "read_first",
  "schema_incompatible",
  "too_large",
  "sql_rejected",
  "sql_timeout",
  "draft_outdated",
  "field_unmatched",
  "confirmation_mismatch",
  "item_closed",
  "preview_outdated",
  // outer errors
  "unauthenticated",
  "insufficient_scope",
  "rate_limited",
  "handle_expired",
  "not_in_this_version",
  "unavailable",
  "internal",
  "import_rejected",
] as const;
/** 04-contract-types §9 `ErrorCode`. */
export type ErrorCode = (typeof ERROR_CODES)[number];

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
  /** `task_mismatch`. */
  read_task?: string;
  /** `task_mismatch`. */
  task?: string;

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
   * slot (creating a slot; in the first version, a scoped credential writing in range). */
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
  /** Finer reason; values per code in §9. */
  reason?: string;
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
