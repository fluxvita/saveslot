// Messages between the main thread (PgliteTenantStore) and the DB Worker (db-worker.ts).
//
// The worker owns the PGlite instance; the main thread never touches it. A transaction callback
// runs on the main thread; it talks to a transaction session in the worker:
//
//   begin(mode, epoch) → query / exec … → commit | rollback
//
// Each message is one request with an id; the worker answers every request in arrival order and
// handles one request at a time, so the statements of a transaction run in the order they were
// issued. Only one session is open at a time (the main thread queues transactions; the worker
// refuses a second `begin`).

import type { SqlValue, UpgradeStep } from "@fluxvita/saveslot-kernel";

/** How PGlite is configured to reach stable storage. See durability.ts. */
export type Durability = "host-fsync" | "pglite-default";

export interface OpenParams {
  /** The PGlite data directory (PGDATA). */
  readonly pgdata: string;
  readonly durability: Durability;
  /** Statements applied to the connection after start (fixed session settings). */
  readonly sessionSettings: readonly string[];
  /** Highest storage format version this kernel supports. */
  readonly supportedFormat: number;
  /** The oldest format upgraded to `supportedFormat`; older ones are refused (format_too_old). */
  readonly oldestFormat: number;
  /** The steps of the upgrade (kernel `UPGRADE_STEPS`, or a test's). */
  readonly upgradeSteps: readonly UpgradeStep[];
  readonly metaKeys: {
    readonly storageFormat: string;
    readonly ownershipEpoch: string;
    readonly sessionSettings: string;
  };
  /** PGlite contrib extensions to load, by module name (diagnostics and experiments only). */
  readonly contrib: readonly string[];
  /** WAL since the last checkpoint, in bytes, past which a `checkpoint` request runs one. */
  readonly checkpointAfterBytes: number;
  /**
   * When an `analyze` request (and the one at open) runs ANALYZE: when the statistics are stale
   * (db-worker.ts `stale`), or every time (tests looking for an order a query does not fix).
   */
  readonly analyze: AnalyzeMode;
}

/** See OpenParams `analyze`. */
export type AnalyzeMode = "stale" | "always";

/** What an `analyze` request did: nothing (the statistics are current), or ANALYZE, how long. */
export type AnalyzeReply = { readonly ran: false } | { readonly ran: true; readonly ms: number };

export interface CreateParams {
  readonly pgdata: string;
  readonly durability: Durability;
  readonly sessionSettings: readonly string[];
  /** The whole DDL script of the storage format, then the initial `meta` rows. */
  readonly ddl: string;
  readonly metaRows: readonly (readonly [string, string])[];
}

export type Request =
  | { readonly kind: "create"; readonly params: CreateParams }
  | { readonly kind: "open"; readonly params: OpenParams }
  | { readonly kind: "begin"; readonly mode: "read" | "write"; readonly epoch: number }
  | { readonly kind: "query"; readonly sql: string; readonly params: readonly SqlValue[] }
  | { readonly kind: "exec"; readonly sql: string }
  | { readonly kind: "commit" }
  | { readonly kind: "rollback" }
  | { readonly kind: "checkpoint" }
  | { readonly kind: "analyze" }
  | { readonly kind: "upgrade" }
  | { readonly kind: "stats" }
  | { readonly kind: "close" };

export interface OpenResult {
  readonly formatVersion: number;
  readonly epoch: number;
  /**
   * The ANALYZE at open: what it did, or the error it gave (`{ failed: code }`). It does not fail
   * the open: statistics are not data, and the next check finds them stale again.
   */
  readonly analyzed: AnalyzeReply | { readonly failed: string };
  /**
   * The store is of an older format, to be upgraded (an `upgrade` request) before it is used: from
   * and to which format. No ANALYZE at open then: the one after the upgrade takes its place.
   */
  readonly upgrade?: { readonly from: number; readonly to: number };
}

/**
 * What an `upgrade` did (its next step): the format the store is now of, and, after the last step,
 * the ANALYZE that follows it.
 */
export interface UpgradeReply {
  readonly formatVersion: number;
  readonly analyzed?: AnalyzeReply | { readonly failed: string };
}

export interface HostSyncStats {
  /** fsync requests PostgreSQL made that were passed to the host (`fs.fsyncSync`). */
  readonly total: number;
  /** Of these, on files under pg_wal. */
  readonly wal: number;
  /** fsync requests not passed on: the file unchanged since its last host fsync (durability.ts). */
  readonly skipped: number;
}

export interface QueryReply {
  readonly rows: readonly Record<string, unknown>[];
  readonly affectedRows?: number;
}

export type ErrorCode =
  | "store_locked"
  | "store_not_found"
  | "not_a_store"
  | "format_too_new"
  | "format_too_old"
  | "upgrade_failed"
  | "session_settings_mismatch"
  | "bad_encoding"
  | "durability_not_applied"
  | "ownership_lost"
  | "transaction_failed"
  | "query_failed"
  | "store_closed"
  | "worker_failed";

export interface WireError {
  readonly message: string;
  readonly code?: ErrorCode;
  /** PostgreSQL SQLSTATE, when the error came from the database. */
  readonly sqlState?: string;
}

export type Reply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireError };

export interface Envelope {
  readonly id: number;
  readonly request: Request;
}
