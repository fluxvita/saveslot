// The tenant storage port (docs/zh-CN/spec/02-architecture.md §8 «租户存储»).
// The kernel depends only on these interfaces; backends (PGlite, PostgreSQL) implement them.

/** Where a tenant's storage lives. Given by the host; the kernel never hard-codes a path. */
export type TenantRef =
  /** Local mode: the data directory configured for saveslot; embedded: the path the host gives. */
  | { readonly kind: "pglite"; readonly dir: string }
  /** Server mode: derived from control plane routing. */
  | { readonly kind: "postgres"; readonly database: string; readonly cell: string };

/** A value bound to a SQL parameter. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface QueryResult<R> {
  readonly rows: readonly R[];
  /** Rows changed by an INSERT, UPDATE or DELETE; undefined for other statements. */
  readonly affectedRows?: number;
}

/**
 * A read-only transaction. On PGlite it shares the single queue with writes.
 *
 * A statement the database refuses throws an error carrying the SQLSTATE as a string property
 * `sqlState` (every backend gives it): the kernel tells a data error (class 22) from others by it
 * alone (`sqlStateOf`).
 */
export interface ReadTx {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<QueryResult<R>>;
}

/** A write transaction. Opened only by `ops`; lower modules receive it and never open their own. */
export interface Tx extends ReadTx {
  /** Runs one or more statements without parameters (DDL, multi-statement scripts). */
  exec(sql: string): Promise<void>;
}

/** Reference to a physical snapshot. Used only to speed things up; treated as a backup. Not in v1. */
export interface SnapshotRef {
  readonly id: string;
}

export interface StorageBackend {
  /**
   * Opens a tenant's storage: checks the storage format version (a higher version than the kernel
   * supports is refused; a lower one upgraded). PGlite also takes the single-writer lock and
   * increments the ownership epoch; PostgreSQL takes no ownership (02-architecture §7).
   */
  open(tenant: TenantRef, opts: { readonly create?: boolean }): Promise<TenantStore>;
}

export interface TenantStore {
  /**
   * Serial write transaction. At its start PGlite checks the ownership epoch; PostgreSQL takes the
   * tenant's lock and checks the storage format and the seal (02-architecture §7).
   */
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * A write transaction for the read records only (`read_log`, `read_log_rows`, `last_read`), and
   * for nothing else: it takes no tenant lock and checks no seal, so it neither waits for the
   * tenant's writes nor makes them wait; it checks the storage format as a read does
   * (02-architecture §7 «read_log 的持久性»). Every other write goes through `write`. Present: a read's record is written before the read answers
   * (the server mode, PostgreSQL); absent: it is kept in the read buffer (the local mode, PGlite).
   */
  recordReads?<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Step ④ of an import, the server mode's (PostgreSQL; 02-architecture §8 «格式版本、导出、导入与恢复»):
   * one write transaction that takes the tenant's lock, checks the log holds the genesis event
   * only, and records the seal in `meta`. From its commit every write of the tenant is refused, in
   * any process, until the swap replaces the storage or `unseal` lifts it. `not_empty` when the log
   * holds more: nothing written. Absent (PGlite): the local mode has one process, and ④ checks the
   * log with a read.
   */
  seal?(importId: string): Promise<"sealed" | "not_empty">;
  /** Lifts the seal (an import rolled back before its swap); nothing when there is none. */
  unseal?(): Promise<void>;
  /** Read transaction; on PGlite it goes through the same queue as writes. */
  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T>;
  /** Removes plaintext residue after a physical deletion. Each backend's method is set by experiment 7. */
  purgeResidue(): Promise<void>;
  /** Physical snapshot, only to speed things up; treated as a backup. Not in v1. */
  snapshot(): Promise<SnapshotRef>;
  readonly formatVersion: number;
  /**
   * Whether a statement's `statement_timeout` is enforced (PostgreSQL). On PGlite it is not: a
   * timeout can only end the whole DB Worker (02-architecture §7), so the kernel sets none there.
   */
  readonly enforcesStatementTimeout?: boolean;
  /**
   * Whether the store can still be used. `false` is final: this store object does not come back
   * (its connection is gone, or another opener took its storage over); it is only to be closed and
   * the storage opened again (02-architecture §7 «连接»). Absent means usable.
   */
  readonly usable?: boolean;
  close(): Promise<void>;
}

/** The SQLSTATE of an error a statement threw, by the ports' convention (`sqlState`). */
export function sqlStateOf(e: unknown): string | undefined {
  if (e === null || typeof e !== "object") return undefined;
  const s = (e as { sqlState?: unknown }).sqlState;
  return typeof s === "string" ? s : undefined;
}
