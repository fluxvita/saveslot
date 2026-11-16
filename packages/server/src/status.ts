// The HTTP status of each contract error code (docs/zh-CN/spec/05-surfaces.md §14 «错误的状态码»).
// A synchronous result is always 200 (202 only for `delete`, later); errors carry `{error}` and
// these codes. `not_in_this_version` is 501: a parameter or value of a later version, and also a
// path the kernel has not implemented yet in this one (the service layer turns those into it).

import type { ErrorCode } from "@fluxvita/saveslot-service";

export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_argument: 400,
  unauthenticated: 401,
  insufficient_scope: 403,
  unknown_table: 404,
  unknown_field: 404,
  not_found: 404,
  derived_readonly: 409,
  revoked: 409,
  read_first: 409,
  schema_incompatible: 409,
  draft_outdated: 409,
  confirmation_mismatch: 409,
  item_closed: 409,
  preview_outdated: 409,
  referenced: 409,
  handle_expired: 410,
  lease_expired: 410,
  too_large: 413,
  validation_failed: 422,
  sql_rejected: 422,
  field_unmatched: 422,
  sql_timeout: 422,
  import_rejected: 422,
  rate_limited: 429,
  internal: 500,
  not_in_this_version: 501,
  unavailable: 503,
};
