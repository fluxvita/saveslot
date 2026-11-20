// The tenant storage port (docs/zh-CN/spec/02-architecture.md §8 "租户存储").
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
   * Opens a tenant's storage: takes the single-writer lock, increments the ownership epoch,
   * checks the storage format version (a higher version than the kernel supports is refused).
   */
  open(tenant: TenantRef, opts: { readonly create?: boolean }): Promise<TenantStore>;
}

export interface TenantStore {
  /** Serial write transaction; checks the ownership epoch at the start. */
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
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
  close(): Promise<void>;
}

/** The SQLSTATE of an error a statement threw, by the ports' convention (`sqlState`). */
export function sqlStateOf(e: unknown): string | undefined {
  if (e === null || typeof e !== "object") return undefined;
  const s = (e as { sqlState?: unknown }).sqlState;
  return typeof s === "string" ? s : undefined;
}
