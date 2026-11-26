/**
 * What went wrong, as a stable code. A code PGlite's backend has too means the same thing here.
 *
 * - `unknown_cell`, `bad_database_name`: the tenant reference cannot be opened by this backend.
 * - `connection_failed`: the database could not be reached, or refused the connection.
 * - `database_not_created`: there was no database, `create` was asked, and it could not be made:
 *   the cell's maintenance database could not be connected to, or CREATE DATABASE was refused.
 * - `store_not_found`: no database of that name, or an empty one, and `create` was not asked.
 * - `not_a_store`: the database holds something, and it is not a saveslot storage.
 * - `tenant_storage`: the database is a saveslot storage, opened as the control database.
 * - `unsupported_server_version`, `bad_encoding`, `bad_collation`, `session_settings_mismatch`:
 *   the database is not one replay would be the same on (02-architecture §8).
 * - `format_too_old`, `format_too_new`: the storage format is older than any released version
 *   wrote, or newer than the kernel's.
 * - `upgrade_failed`: a step of the upgrade to the kernel's format failed; the store is of the
 *   format of its last step done (02-architecture §8).
 * - `ownership_lost`: another opener took the tenant over; this store gave it up.
 * - `query_failed`: the database refused a statement; `sqlState` says why.
 * - `transaction_failed`: a statement of the transaction had failed, so it was rolled back.
 * - `connection_lost`: the connection ended with the transaction certainly not committed: before
 *   COMMIT was sent.
 * - `commit_unknown`: the connection ended after COMMIT was sent and before its answer, or the
 *   server answered it by ending the session: the transaction may be committed, or not.
 * - `store_closed`: the store was closed.
 * - `discard_refused`: a database to discard is neither the tenant's own staging database nor the
 *   one an import replaced, or it is the one the tenant's directory names now: nothing is dropped.
 */
export type ErrorCode =
  | "unknown_cell"
  | "bad_database_name"
  | "connection_failed"
  | "database_not_created"
  | "store_not_found"
  | "not_a_store"
  | "tenant_storage"
  | "unsupported_server_version"
  | "bad_encoding"
  | "bad_collation"
  | "session_settings_mismatch"
  | "format_too_old"
  | "format_too_new"
  | "upgrade_failed"
  | "ownership_lost"
  | "query_failed"
  | "transaction_failed"
  | "connection_lost"
  | "commit_unknown"
  | "store_closed"
  | "discard_refused";

/** An error raised by the PostgreSQL storage backend. `code` is stable; the message is for people. */
export class PostgresStoreError extends Error {
  readonly code: ErrorCode;
  /** PostgreSQL SQLSTATE, when the error came from the database. */
  readonly sqlState: string | undefined;

  constructor(code: ErrorCode, message: string, opts: { cause?: unknown; sqlState?: string } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PostgresStoreError";
    this.code = code;
    this.sqlState = opts.sqlState;
  }
}
