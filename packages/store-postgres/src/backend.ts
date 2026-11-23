// PostgreSQL implementation of the tenant storage port (02-architecture §7, §8).
//
// A tenant is a database of a cell. An open store holds one connection to it, and one FIFO queue:
// reads and writes take turns, so exactly one transaction is open at a time on that connection,
// as on PGlite. A transaction's callback runs here; when it returns the store sends COMMIT, when
// it throws the store sends ROLLBACK and rethrows.
//
// Single writer. Routing gives a tenant to one process; what holds when routing is wrong is the
// ownership epoch in `meta`: opening adds 1 to it, and every write transaction, under the
// tenant's advisory lock, reads it and gives the tenant up when it is no longer the one this
// store opened with. The database's value is the one that counts here: another connection's
// commit is seen, so there is no owner file and no lock file as PGlite has.
//
// What is checked when a store is opened, in this order, and the code each gives when it fails:
//
//   the tenant reference names a cell this backend has         unknown_cell
//   the database's name is one this backend takes, and not     bad_database_name
//     the server's own or the cell's maintenance database
//   the connection is made                                     connection_failed
//     (no such database, and `create` not asked)               store_not_found
//     (no such database, `create` asked, and it could not      database_not_created
//      be made: no maintenance database, or CREATE refused)
//   the server is PostgreSQL 18 (asked by itself, first: the   unsupported_server_version
//     later questions are not ones an older server knows)
//   (this backend's own settings and the fixed session
//    settings are set on the connection)
//   the database's encoding is UTF8                            bad_encoding
//   its locale is the builtin provider's C.UTF-8, and the      bad_collation
//     C library's collation and character type are C
//   the `meta` table is there                                  store_not_found (empty database),
//                                                              not_a_store (other tables)
//   the storage format is the kernel's                         not_a_store, format_too_old,
//                                                              format_too_new
//   the session settings it was created with are the kernel's  session_settings_mismatch
//   the ownership epoch is taken (+ 1)

import {
  formatV1Ddl,
  META_KEYS,
  type QueryResult,
  type ReadTx,
  SESSION_SETTINGS,
  type SnapshotRef,
  type SqlValue,
  STORAGE_FORMAT_VERSION,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import { Connection, Gone, type MakeClient, type PostgresCell, Refused } from "./connection.ts";
import { PostgresStoreError } from "./errors.ts";
import { affectedRows } from "./values.ts";

export interface PostgresBackendOptions {
  /** The cells this backend can open tenants in, by the name a tenant reference gives. */
  readonly cells: Readonly<Record<string, PostgresCell>>;
}

/** The server version this backend opens (02-architecture §8: 18.x). */
export const SERVER_MAJOR = 18;

/** The major version of a `server_version_num` (180007 is 18). */
export const serverMajor = (versionNum: number): number => Math.floor(versionNum / 10_000);

/**
 * A database name this backend takes: lower-case letters, digits and `_`, a letter first, 63
 * bytes at most (an identifier's limit). It is written into statements quoted all the same.
 */
export const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** The databases every server has: never a tenant's, whatever a reference says. */
const SERVER_DATABASES = ["postgres", "template0", "template1"];

/**
 * The advisory lock of a tenant's writes. Advisory locks are a database's own and a tenant has a
 * database to itself, so the key is a constant: "SSLT", and 1 for writes.
 */
export const WRITE_LOCK = [0x53534c54, 1] as const;
const LOCK_SQL = `SELECT pg_advisory_xact_lock(${WRITE_LOCK[0]}, ${WRITE_LOCK[1]})`;

/** The locale a tenant's database is created with and must have (02-architecture §8). */
export const BUILTIN_LOCALE = "C.UTF-8";

/**
 * Set on every connection besides the kernel's fixed session settings, and before them: what a
 * server, a database or a role may have set otherwise. They are this backend's defence against
 * its installation, not part of the fixed settings replay depends on.
 *
 * - `search_path`: the kernel's tables are made and found without a schema's name, and this
 *   backend looks for them in `public`; a role's or a database's own path would put them elsewhere.
 * - `bytea_output`: the bytes of a result are read as the hex output.
 * - `lc_*`: the formats `to_char` localizes.
 * - `default_transaction_isolation`: a transaction begun without a level (a write, `locked`) is
 *   READ COMMITTED, whatever the database's or the role's default. A write takes the tenant's lock
 *   and then reads: each statement after the wait must see what was committed during it, where a
 *   REPEATABLE READ or SERIALIZABLE snapshot is the lock statement's, taken before the wait. A read
 *   names its own level.
 */
const OWN_SETTINGS = [
  "SET search_path = public",
  "SET bytea_output = 'hex'",
  "SET lc_numeric = 'C'",
  "SET lc_monetary = 'C'",
  "SET lc_time = 'C'",
  "SET default_transaction_isolation = 'read committed'",
];

const SESSION_SETTINGS_TEXT = JSON.stringify(SESSION_SETTINGS);

const quoted = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/**
 * An error of the connection, as the store's: `gone` is the code when the connection is gone.
 * `commit_unknown` is for a COMMIT that was sent: one that was not, because the connection was
 * known to be gone, committed nothing, and is `connection_lost`.
 */
function storeError(
  e: unknown,
  gone: "connection_failed" | "connection_lost" | "commit_unknown" | "database_not_created",
): unknown {
  if (e instanceof Refused) {
    const code = gone === "database_not_created" ? gone : "query_failed";
    return new PostgresStoreError(code, e.message, { sqlState: e.sqlState, cause: e });
  }
  if (e instanceof Gone) {
    const code = gone === "commit_unknown" && !e.sent ? "connection_lost" : gone;
    return new PostgresStoreError(code, e.message, {
      cause: e,
      ...(e.sqlState !== undefined ? { sqlState: e.sqlState } : {}),
    });
  }
  return e;
}

export class PostgresBackend implements StorageBackend {
  readonly #cells: Readonly<Record<string, PostgresCell>>;
  readonly #make: MakeClient | undefined;

  /** `make` is for tests: the driver's client is made by it instead. */
  constructor(opts: PostgresBackendOptions, make?: MakeClient) {
    this.#cells = opts.cells;
    this.#make = make;
  }

  async open(
    tenant: TenantRef,
    opts: { readonly create?: boolean } = {},
  ): Promise<PostgresTenantStore> {
    if (tenant.kind !== "postgres") {
      throw new TypeError(`PostgresBackend cannot open a ${tenant.kind} tenant`);
    }
    const cell = Object.hasOwn(this.#cells, tenant.cell) ? this.#cells[tenant.cell] : undefined;
    if (cell === undefined) {
      throw new PostgresStoreError("unknown_cell", `no cell named ${tenant.cell} is configured`);
    }
    if (!DATABASE_NAME.test(tenant.database)) {
      throw new PostgresStoreError(
        "bad_database_name",
        "a tenant's database name is lower-case letters, digits and _, a letter first, 63 at most",
      );
    }
    const maintenance = cell.maintenanceDatabase ?? "postgres";
    if ([...SERVER_DATABASES, maintenance].includes(tenant.database)) {
      throw new PostgresStoreError(
        "bad_database_name",
        `${tenant.database} is the server's own or the cell's maintenance database, not a tenant's`,
      );
    }
    const where = `database ${tenant.database} of cell ${tenant.cell}`;

    let conn: Connection;
    try {
      conn = await this.#connect(cell, tenant.database, opts.create === true);
    } catch (e) {
      if (e instanceof PostgresStoreError) throw e;
      if (e instanceof Gone && e.sqlState === "3D000") {
        throw new PostgresStoreError("store_not_found", `no ${where}`, { cause: e });
      }
      throw storeError(e, "connection_failed");
    }
    try {
      await checkVersion(conn);
      for (const s of [...OWN_SETTINGS, ...SESSION_SETTINGS]) await conn.run(s);
      await checkDatabase(conn, where);
      if (!(await hasMeta(conn))) {
        if (!(await isEmpty(conn))) {
          throw new PostgresStoreError(
            "not_a_store",
            `the ${where} holds no saveslot storage (no meta table)`,
          );
        }
        if (opts.create !== true) {
          throw new PostgresStoreError("store_not_found", `the ${where} is empty`);
        }
        await createStorage(conn);
      }
      const formatVersion = await checkFormat(conn);
      await checkSessionSettings(conn);
      const epoch = await takeOwnership(conn);
      return new PostgresTenantStore({ conn, formatVersion, epoch, ...tenant });
    } catch (e) {
      await conn.end();
      throw storeError(e, "connection_failed");
    }
  }

  /** Connects to the tenant's database; with `create`, makes the database first when there is none. */
  #connect(cell: PostgresCell, database: string, create: boolean): Promise<Connection> {
    return connectOrCreate(cell, database, create, this.#make);
  }
}

/**
 * Connects to a database of the cell; with `create`, makes the database first when there is none
 * (UTF8, the builtin provider's locale: §8). A tenant's storage and the control database open
 * through it.
 */
export async function connectOrCreate(
  cell: PostgresCell,
  database: string,
  create: boolean,
  make?: MakeClient,
): Promise<Connection> {
  try {
    return await Connection.connect(cell, database, make);
  } catch (e) {
    if (!(create && e instanceof Gone && e.sqlState === "3D000")) throw e;
  }
  const maintenance = cell.maintenanceDatabase ?? "postgres";
  let admin: Connection;
  try {
    admin = await Connection.connect(cell, maintenance, make);
  } catch (e) {
    throw new PostgresStoreError(
      "database_not_created",
      `the maintenance database ${maintenance} could not be connected to: ${(e as Error).message}`,
      {
        cause: e,
        ...(e instanceof Gone && e.sqlState !== undefined ? { sqlState: e.sqlState } : {}),
      },
    );
  }
  try {
    // template0: the only template another encoding or locale than the cluster's can be given
    // with. LOCALE is the libc one, for what the builtin provider does not cover.
    await admin.run(
      `CREATE DATABASE ${quoted(database)} TEMPLATE template0 ENCODING 'UTF8'
         LOCALE_PROVIDER builtin BUILTIN_LOCALE '${BUILTIN_LOCALE}' LOCALE 'C'`,
    );
  } catch (e) {
    // Made by another opener in between (42P04, or 23505 on the catalog's index when the two
    // ran at once): opened below like any that exists.
    if (!(e instanceof Refused && ["42P04", "23505"].includes(e.sqlState))) {
      throw storeError(e, "database_not_created");
    }
  } finally {
    await admin.end();
  }
  return await Connection.connect(cell, database, make);
}

async function one<R>(conn: Connection, sql: string, params: readonly SqlValue[] = []): Promise<R> {
  return (await conn.run(sql, params)).rows[0] as R;
}

/**
 * The server's version, asked by itself: the questions after it use what only this version's
 * catalogs have, and an older server would refuse them with an error that names a column.
 */
export async function checkVersion(conn: Connection): Promise<void> {
  const { version } = await one<{ version: number }>(
    conn,
    "SELECT current_setting('server_version_num')::int4 AS version",
  );
  if (serverMajor(version) !== SERVER_MAJOR) {
    throw new PostgresStoreError(
      "unsupported_server_version",
      `the server is PostgreSQL ${serverMajor(version)} (${version}), not ${SERVER_MAJOR}`,
    );
  }
}

/** The database's encoding and its locale (§8). */
async function checkDatabase(conn: Connection, where: string): Promise<void> {
  const db = await one<{
    encoding: string;
    provider: string;
    locale: string | null;
    collate: string | null;
    ctype: string | null;
  }>(
    conn,
    `SELECT current_setting('server_encoding') AS encoding,
            d.datlocprovider::text AS provider, d.datlocale AS locale,
            d.datcollate AS collate, d.datctype AS ctype
     FROM pg_catalog.pg_database d WHERE d.datname = current_database()`,
  );
  // The encoding cannot be set per session; it must be UTF8 (02-architecture §8).
  if (db.encoding !== "UTF8") {
    throw new PostgresStoreError("bad_encoding", `database encoding is ${db.encoding}, not UTF8`);
  }
  // The builtin provider's locale orders and classifies text; the C library's two are what is
  // left to it (a database made elsewhere may have the first and not these).
  if (
    db.provider !== "b" ||
    db.locale !== BUILTIN_LOCALE ||
    db.collate !== "C" ||
    db.ctype !== "C"
  ) {
    throw new PostgresStoreError(
      "bad_collation",
      `the ${where} does not have the builtin locale ${BUILTIN_LOCALE} with the C library's C (provider ${db.provider}, locale ${db.locale ?? "none"}, collate ${db.collate ?? "none"}, ctype ${db.ctype ?? "none"})`,
    );
  }
}

/**
 * Whether the `meta` table is there, read from the catalog with this statement's snapshot. Not
 * `to_regclass`: it answers from the connection's catalog cache, which keeps a "no such table" from
 * an earlier lookup until the connection takes in other sessions' invalidations, and waiting for an
 * advisory lock does not make it do so; under `createStorage`'s lock it would miss a storage
 * another opener made meanwhile.
 */
export async function hasMeta(conn: Connection): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    conn,
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'meta'
     ) AS ok`,
  );
  return r.ok;
}

/** Whether the public schema holds no table, view or sequence. */
async function isEmpty(conn: Connection): Promise<boolean> {
  const r = await one<{ n: number }>(
    conn,
    `SELECT count(*)::int4 AS n
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'`,
  );
  return r.n === 0;
}

/**
 * Runs `f` in a transaction under the tenant's write lock. READ COMMITTED whatever the database's
 * default: each statement after the lock then sees what another opener committed while this one
 * waited; at REPEATABLE READ or SERIALIZABLE the snapshot is taken at the lock's statement, before
 * the wait, and `createStorage` would not see a storage made meanwhile.
 */
async function locked<T>(conn: Connection, f: () => Promise<T>): Promise<T> {
  await conn.run("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await conn.run(LOCK_SQL);
    const r = await f();
    await conn.run("COMMIT");
    return r;
  } catch (e) {
    if (!conn.gone) await conn.run("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** The kernel's tables and the first rows of `meta`, in one transaction: all of it or none. */
async function createStorage(conn: Connection): Promise<void> {
  await locked(conn, async () => {
    // Made by another opener while this one waited for the lock.
    if (await hasMeta(conn)) return;
    await conn.run(formatV1Ddl());
    for (const [k, v] of [
      [META_KEYS.storageFormat, String(STORAGE_FORMAT_VERSION)],
      [META_KEYS.ownershipEpoch, "0"],
      [META_KEYS.sessionSettings, SESSION_SETTINGS_TEXT],
    ] as const) {
      await conn.run("INSERT INTO meta (key, value) VALUES ($1, $2)", [k, v]);
    }
  });
}

async function metaValue(conn: Connection, key: string): Promise<string | undefined> {
  const r = await conn.run("SELECT value FROM meta WHERE key = $1", [key]);
  return (r.rows[0] as { value: string } | undefined)?.value;
}

async function checkFormat(conn: Connection): Promise<number> {
  const formatVersion = Number(await metaValue(conn, META_KEYS.storageFormat));
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new PostgresStoreError("not_a_store", "the storage has no valid storage format version");
  }
  // An older format is a store from development (no data has been published in one): not
  // migrated, refused with what to do.
  if (formatVersion < STORAGE_FORMAT_VERSION) {
    throw new PostgresStoreError(
      "format_too_old",
      `storage format ${formatVersion} is a development format older than ${STORAGE_FORMAT_VERSION}; initialize the store anew with this version`,
    );
  }
  if (formatVersion > STORAGE_FORMAT_VERSION) {
    throw new PostgresStoreError(
      "format_too_new",
      `storage format ${formatVersion} is newer than the supported format ${STORAGE_FORMAT_VERSION}; upgrade saveslot`,
    );
  }
  return formatVersion;
}

/** The settings the storage was created with are the ones this kernel sets (§8). */
async function checkSessionSettings(conn: Connection): Promise<void> {
  if ((await metaValue(conn, META_KEYS.sessionSettings)) !== SESSION_SETTINGS_TEXT) {
    throw new PostgresStoreError(
      "session_settings_mismatch",
      "the storage was created with other fixed session settings than this version's",
    );
  }
}

/** Ownership epoch + 1 (02-architecture §7), after any write another opener has in progress. */
async function takeOwnership(conn: Connection): Promise<number> {
  return await locked(conn, async () => {
    const r = await one<{ value: string }>(
      conn,
      `INSERT INTO meta (key, value) VALUES ($1, '1')
       ON CONFLICT (key) DO UPDATE SET value = (meta.value::bigint + 1)::text
       RETURNING value`,
      [META_KEYS.ownershipEpoch],
    );
    return Number(r.value);
  });
}

type State = "open" | "closing" | "closed" | "lost" | "failed";

class TxHandle implements Tx {
  readonly #store: PostgresTenantStore;
  #active = true;
  /** A statement of this transaction was refused: the database has aborted it. */
  failed = false;

  constructor(store: PostgresTenantStore) {
    this.#store = store;
  }

  end(): void {
    this.#active = false;
  }

  #check(): void {
    if (!this.#active) throw new Error("the transaction has already finished");
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<R>> {
    this.#check();
    try {
      const r = await this.#store._run(sql, params);
      return { rows: r.rows as R[], affectedRows: affectedRows(r.command, r.rowCount) };
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }

  async exec(sql: string): Promise<void> {
    this.#check();
    try {
      await this.#store._run(sql, undefined);
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
}

export class PostgresTenantStore implements TenantStore {
  readonly formatVersion: number;
  /** PostgreSQL enforces `statement_timeout` (the kernel sets one for a `sql` call). */
  readonly enforcesStatementTimeout = true;
  /** The ownership epoch this store took at open. */
  readonly epoch: number;
  readonly database: string;
  readonly cell: string;
  readonly #conn: Connection;
  #state: State = "open";
  #tail: Promise<unknown> = Promise.resolve();
  #closed: Promise<void> | undefined;

  constructor(init: {
    conn: Connection;
    formatVersion: number;
    epoch: number;
    database: string;
    cell: string;
  }) {
    this.#conn = init.conn;
    this.formatVersion = init.formatVersion;
    this.epoch = init.epoch;
    this.database = init.database;
    this.cell = init.cell;
  }

  /**
   * @internal One statement on the store's connection. A connection that is gone fails the store:
   * `commit_unknown` when the statement was the COMMIT, `connection_lost` for any other, which
   * the database had not committed.
   */
  async _run(sql: string, params: readonly SqlValue[] | undefined, commit = false) {
    try {
      return await this.#conn.run(sql, params);
    } catch (e) {
      if (e instanceof Gone && this.#state === "open") this.#state = "failed";
      throw storeError(e, commit ? "commit_unknown" : "connection_lost");
    }
  }

  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#enqueue(() => this.#transaction("write", fn));
  }

  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    return this.#enqueue(() => this.#transaction("read", fn));
  }

  async purgeResidue(): Promise<void> {
    throw new Error("purgeResidue is not implemented in v1 P0: its method is set by experiment 7");
  }

  async snapshot(): Promise<SnapshotRef> {
    throw new Error("snapshot is not implemented: physical snapshots are not in v1");
  }

  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    if (this.#state === "open") this.#state = "closing";
    this.#closed = this.#tail
      .catch(() => {})
      .then(async () => {
        await this.#conn.end();
        if (this.#state === "closing") this.#state = "closed";
      });
    return this.#closed;
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(job, job);
    this.#tail = run.catch(() => {});
    return run;
  }

  #ensureUsable(): void {
    switch (this.#state) {
      case "open":
        return;
      case "lost":
        throw new PostgresStoreError(
          "ownership_lost",
          "another opener took over this storage; this store gave it up",
        );
      case "failed":
        throw new PostgresStoreError(
          "connection_lost",
          "the connection to the database is gone; close the store",
        );
      default:
        throw new PostgresStoreError("store_closed", "the store is closed");
    }
  }

  /** Gives the tenant up: nothing more is sent to the database by this store (§7). */
  #abandon(): void {
    if (this.#state === "lost") return;
    this.#state = "lost";
    void this.#conn.end();
  }

  /**
   * Opens the transaction. A read sees one state throughout: its snapshot is taken once, so what
   * another process commits meanwhile (a new owner's writes) does not show between two of its
   * statements. A write takes the tenant's lock, then checks the ownership epoch under it.
   */
  async #begin(mode: "read" | "write"): Promise<void> {
    if (mode === "read") {
      await this._run("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", undefined);
      return;
    }
    await this._run("BEGIN", undefined);
    let stored: number;
    try {
      await this._run(LOCK_SQL, undefined);
      const r = await this._run("SELECT value FROM meta WHERE key = $1 FOR UPDATE", [
        META_KEYS.ownershipEpoch,
      ]);
      stored = Number((r.rows[0] as { value: string } | undefined)?.value);
    } catch (e) {
      if (!this.#conn.gone) await this._run("ROLLBACK", undefined).catch(() => {});
      throw e;
    }
    if (stored !== this.epoch) {
      await this._run("ROLLBACK", undefined).catch(() => {});
      this.#abandon();
      throw new PostgresStoreError(
        "ownership_lost",
        `ownership epoch is ${stored}, this store opened it as ${this.epoch}: another opener took over`,
      );
    }
  }

  async #transaction<T>(mode: "read" | "write", fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.#ensureUsable();
    await this.#begin(mode);
    const tx = new TxHandle(this);
    let result: T;
    try {
      result = await fn(tx);
    } catch (e) {
      tx.end();
      if (!this.#conn.gone) await this._run("ROLLBACK", undefined).catch(() => {});
      throw e;
    }
    tx.end();
    // The connection went away under a statement whose error the callback swallowed.
    if (this.#state === "failed") this.#ensureUsable();
    if (tx.failed) {
      // PostgreSQL would turn COMMIT into ROLLBACK silently; make it an error instead.
      await this._run("ROLLBACK", undefined).catch(() => {});
      throw new PostgresStoreError(
        "transaction_failed",
        "a statement in this transaction failed; the transaction was rolled back",
      );
    }
    // Only a write's COMMIT leaves anything in doubt when the connection ends under it.
    const done = await this._run("COMMIT", undefined, mode === "write");
    if (done.command === "ROLLBACK") {
      // The server answers COMMIT in an aborted transaction with ROLLBACK and no error: a
      // statement failed whose error the callback never waited for.
      throw new PostgresStoreError(
        "transaction_failed",
        "a statement in this transaction failed; the transaction was rolled back",
      );
    }
    return result;
  }
}
