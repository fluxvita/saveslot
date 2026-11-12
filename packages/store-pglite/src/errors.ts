import type { ErrorCode } from "./protocol.ts";

export type { ErrorCode } from "./protocol.ts";

/** An error raised by the PGlite storage backend. `code` is stable; the message is for people. */
export class PgliteStoreError extends Error {
  readonly code: ErrorCode;
  /** PostgreSQL SQLSTATE, when the error came from the database. */
  readonly sqlState: string | undefined;

  constructor(code: ErrorCode, message: string, opts: { cause?: unknown; sqlState?: string } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PgliteStoreError";
    this.code = code;
    this.sqlState = opts.sqlState;
  }
}
