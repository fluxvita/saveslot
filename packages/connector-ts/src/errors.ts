import type { WriteResult } from "./record/slot-record.ts";

/** An error from the service (`code` is the contract's error code) or from the SDK itself. */
export class SaveslotError extends Error {
  override readonly name = "SaveslotError";
  /**
   * The contract's error code (`unauthenticated`, `unknown_table`, `validation_failed`, …), or one
   * of the SDK's own:
   * - `unreachable`: no answer; `bad_reply`: an answer that is not the contract's;
   * - `invalid_config`: the builder was set up wrong; `invalid_argument` without a `status`: a
   *   task, key, header value or record the SDK cannot send, refused before anything is sent (with
   *   a `status`, the service refused the request);
   * - `key_reused`: a `write` under a `key` already used with other records (other records, or
   *   the same in another order); `written` says what this call had applied before it;
   * - `invalid_schema`: `defineSchema` declared something unusable;
   * - `schema_mismatch`: the slot lacks a declared table or field;
   * - `schema_pending`: creating the slot waits for the user's confirmation;
   * - `not_built`: `ConnectorClient.with()` before `build()`; `already_built`: `build()` a second
   *   time;
   * - `not_initialized`: `init` has not succeeded;
   * - `unknown_table`: a record for a table not declared.
   */
  readonly code: string;
  /** The HTTP status, when the service answered. */
  readonly status: number | undefined;
  /** The service's whole error object, when it answered with one. */
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /**
   * On an error from `write` once it has started sending: what the call had applied before the
   * error. Writes it counts are applied, and stay applied.
   */
  readonly written: Readonly<WriteResult> | undefined;
  constructor(
    code: string,
    message: string,
    o: {
      status?: number;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
      written?: Readonly<WriteResult>;
    } = {},
  ) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.code = code;
    this.status = o.status;
    this.details = o.details;
    this.written = o.written;
  }
}
