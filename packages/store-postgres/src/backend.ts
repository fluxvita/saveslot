// PostgreSQL implementation of the tenant storage port (02-architecture §7, §8).
//
// A tenant is a database of a cell. An open store holds one connection to it, and one FIFO queue:
// reads and writes take turns, so exactly one transaction is open at a time on that connection,
// as on PGlite. A transaction's callback runs here; when it returns the store sends COMMIT, when
// it throws the store sends ROLLBACK and rethrows.
//
// Single writer. No opener takes a tenant from another: several may have it open at once
// (02-architecture §7). Writes are serialized by the tenant's advisory lock; every read, write and
// read's record first reads, in one statement, the storage format and the seal from `meta` (`#begin`): a format
// newer than this store's is refused (format_too_new: another version upgraded it), and a seal
// refuses a write only (tenant_sealed: an import is swapping the tenant in). The ownership epoch row a
// store was created with is kept, neither read nor written (it is the local mode's).
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
//   the format, read again under the tenant's lock             format_too_new

import {
  formatV1Ddl,
  META_KEYS,
  OLDEST_UPGRADABLE_FORMAT,
  type PurgeOutcome,
  PurgePermissionError,
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
  UPGRADE_STEPS,
  type UpgradeStep,
  upgradePath,
} from "@fluxvita/saveslot-kernel";
import { Connection, Gone, type MakeClient, type PostgresCell, Refused } from "./connection.ts";
import { PostgresStoreError } from "./errors.ts";
import { withCreationTurn } from "./maintenance.ts";
import { affectedRows } from "./values.ts";

export interface PostgresBackendOptions {
  /** The cells this backend can open tenants in, by the name a tenant reference gives. */
  readonly cells: Readonly<Record<string, PostgresCell>>;
  /**
   * Tests only: the format this backend takes for the kernel's, and the upgrade steps to it, in
   * place of STORAGE_FORMAT_VERSION and UPGRADE_STEPS.
   */
  readonly formatUpgrade?: { readonly format: number; readonly steps: readonly UpgradeStep[] };
  /** Tests only: how long the residue clean-up waits for other sessions' snapshots (default a minute). */
  readonly purgeSnapshotWaitMs?: number;
  /**
   * Where the backend reports an upgrade at open, each with the tenant's database: `upgrading`
   * (from, to) before its first step, `upgrade_step` (from, to: the step's) before each, `upgraded`
   * (from, to, ms) once done, `upgrade_failed` (step as `5->6`, and `sql_state` when the database
   * gave one) when a step failed; never the database's message, which may quote what the store
   * holds. The server writes them to its log.
   */
  readonly onEvent?: (
    event: "upgrading" | "upgrade_step" | "upgraded" | "upgrade_failed",
    fields: Readonly<Record<string, string | number>>,
  ) => void;
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
export const SERVER_DATABASES: readonly string[] = ["postgres", "template0", "template1"];

/**
 * The advisory lock of a tenant's writes. Advisory locks are a database's own and a tenant has a
 * database to itself, so the key is a constant: "SSLT", and 1 for writes.
 */
export const WRITE_LOCK = [0x53534c54, 1] as const;
const LOCK_SQL = `SELECT pg_advisory_xact_lock(${WRITE_LOCK[0]}, ${WRITE_LOCK[1]})`;
/** What each read and write checks first: the storage format and the seal, in one statement. */
const GUARD_SQL = "SELECT key, value FROM meta WHERE key = $1 OR key = $2";

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

/**
 * What a server answers `pg_control_system()` with when it will not give its system identifier:
 * no permission (42501), no such function (42883), not supported (0A000).
 */
const NO_SYSTEM_IDENTIFIER: ReadonlySet<string | undefined> = new Set(["42501", "42883", "0A000"]);

export class PostgresBackend implements StorageBackend {
  readonly #cells: Readonly<Record<string, PostgresCell>>;
  readonly #make: MakeClient | undefined;
  readonly #format: number;
  readonly #upgradeSteps: readonly UpgradeStep[];
  readonly #onEvent: PostgresBackendOptions["onEvent"];
  readonly #purgeSnapshotWaitMs: number;

  /** `make` is for tests: the driver's client is made by it instead. */
  constructor(opts: PostgresBackendOptions, make?: MakeClient) {
    this.#cells = opts.cells;
    this.#make = make;
    this.#format = opts.formatUpgrade?.format ?? STORAGE_FORMAT_VERSION;
    this.#upgradeSteps = opts.formatUpgrade?.steps ?? UPGRADE_STEPS;
    this.#onEvent = opts.onEvent;
    this.#purgeSnapshotWaitMs = opts.purgeSnapshotWaitMs ?? SNAPSHOT_WAIT_MS;
  }

  /**
   * The cluster a cell is on, for the deployment's configuration fingerprint (06-cli §4.1
   * «各进程相同的配置»): its system identifier (`pg_control_system()`), the same whatever host
   * name reaches it; when the server will not give it, the cell's address without its
   * credentials (`host:port/maintenance database`): this role may not read it (42501), or the server
   * has no such function or does not support it (42883, 0A000, as some managed or forked servers).
   * Each of these is the server's settled answer, so the way it is told apart does not change from
   * one start to the next. Any other refusal fails (`query_failed`, with its SQLSTATE). Asked on a connection to the maintenance
   * database of its own, closed before it answers. A cell that cannot be reached fails as opening
   * would (`connection_failed`).
   */
  async clusterIdentity(
    cellName: string,
  ): Promise<{ readonly by: "system_identifier" | "url"; readonly value: string }> {
    const cell = Object.hasOwn(this.#cells, cellName) ? this.#cells[cellName] : undefined;
    if (cell === undefined) {
      throw new PostgresStoreError("unknown_cell", "no cell of that name in this backend");
    }
    const maintenance = cell.maintenanceDatabase ?? "postgres";
    const url = `${cell.host}:${cell.port ?? 5432}/${maintenance}`;
    let conn: Connection;
    try {
      conn = await Connection.connect(cell, maintenance, this.#make);
    } catch (e) {
      throw storeError(e, "connection_failed");
    }
    try {
      const r = await conn.run("SELECT system_identifier::text AS id FROM pg_control_system()");
      const id = (r.rows[0] as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || id === "") throw new Error("no system identifier");
      return { by: "system_identifier", value: id };
    } catch (e) {
      if (e instanceof Refused && NO_SYSTEM_IDENTIFIER.has(e.sqlState)) {
        return { by: "url", value: url };
      }
      throw storeError(e, "connection_lost");
    } finally {
      await conn.end().catch(() => {});
    }
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
        await createStorage(conn, this.#format);
      }
      await checkFormat(conn, this.#format);
      await checkSessionSettings(conn);
      let formatVersion = await checkFormatLocked(conn, this.#format);
      if (formatVersion < this.#format) {
        // An older format, upgraded now, each step under the tenant's lock: an older process still
        // holding the tenant finds the newer format at its next read or write and refuses it
        // (format_too_new), rather than read or write with its format's code tables of this one.
        const db = tenant.database;
        this.#onEvent?.("upgrading", { database: db, from: formatVersion, to: this.#format });
        const begun = performance.now();
        const from = formatVersion;
        try {
          formatVersion = await upgrade(
            conn,
            formatVersion,
            this.#format,
            this.#upgradeSteps,
            (step) =>
              this.#onEvent?.("upgrade_step", { database: db, from: step.from, to: step.from + 1 }),
          );
        } catch (e) {
          if (e instanceof PostgresStoreError && e.code === "upgrade_failed") {
            this.#onEvent?.("upgrade_failed", {
              database: db,
              step: e.step ?? "unknown",
              ...(e.sqlState !== undefined ? { sql_state: e.sqlState } : {}),
            });
          }
          throw e;
        }
        this.#onEvent?.("upgraded", {
          database: db,
          from,
          to: formatVersion,
          ms: Math.round(performance.now() - begun),
        });
      }
      return new PostgresTenantStore({
        conn,
        formatVersion,
        residueMode: await residueModeOf(conn),
        purgeSnapshotWaitMs: this.#purgeSnapshotWaitMs,
        ...tenant,
      });
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
  // The process's one connection for creations to the maintenance database (./maintenance.ts).
  await withCreationTurn(async () => {
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
  });
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
async function createStorage(conn: Connection, format: number): Promise<void> {
  await locked(conn, async () => {
    // Made by another opener while this one waited for the lock.
    if (await hasMeta(conn)) return;
    await conn.run(formatV1Ddl());
    for (const [k, v] of [
      [META_KEYS.storageFormat, String(format)],
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

async function checkFormat(conn: Connection, format: number): Promise<number> {
  const formatVersion = Number(await metaValue(conn, META_KEYS.storageFormat));
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new PostgresStoreError("not_a_store", "the storage has no valid storage format version");
  }
  // Older than any released version wrote: a store from development, not upgraded, refused with
  // what to do. From there to the kernel's format: upgraded under the tenant's lock.
  if (formatVersion < OLDEST_UPGRADABLE_FORMAT) {
    throw new PostgresStoreError(
      "format_too_old",
      `storage format ${formatVersion} is a development format older than ${OLDEST_UPGRADABLE_FORMAT}; initialize the store anew with this version`,
    );
  }
  if (formatVersion > format) {
    throw new PostgresStoreError(
      "format_too_new",
      `storage format ${formatVersion} is newer than the supported format ${format}; upgrade saveslot`,
    );
  }
  return formatVersion;
}

/**
 * The upgrade of a store of format `from` to `to` (02-architecture §8 «格式版本、导出、导入与恢复»):
 * each step a write transaction under the tenant's lock: the format read again under the lock (a
 * step another opener did already is skipped), the step's statements, the format set last. A
 * store stopped half way is of the format of its last step done. Returns the format.
 */
async function upgrade(
  conn: Connection,
  from: number,
  to: number,
  steps: readonly UpgradeStep[],
  onStep: (step: UpgradeStep) => void,
): Promise<number> {
  let current = from;
  for (const step of upgradePath(from, to, steps)) {
    onStep(step);
    await locked(conn, async () => {
      const now = Number(await metaValue(conn, META_KEYS.storageFormat));
      if (now > step.from) return;
      try {
        if (step.sql.trim() !== "") await conn.run(step.sql);
        await conn.run("UPDATE meta SET value = $1 WHERE key = $2", [
          String(step.from + 1),
          META_KEYS.storageFormat,
        ]);
      } catch (e) {
        if (e instanceof Gone) throw e;
        const sqlState = e instanceof Refused ? e.sqlState : undefined;
        throw new PostgresStoreError(
          "upgrade_failed",
          `upgrading storage format ${step.from} to ${step.from + 1}: ${(e as Error).message}`,
          {
            cause: e,
            step: `${step.from}->${step.from + 1}`,
            ...(sqlState !== undefined ? { sqlState } : {}),
          },
        );
      }
    });
    current = step.from + 1;
  }
  return current;
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

/**
 * The format read again under the tenant's lock, after any write another opener has in progress
 * (02-architecture §7): a newer version may have upgraded the store while this opener waited on
 * the lock, and code of an older format does not open a store of a newer one (format_too_new).
 * No ownership is taken: every read and write checks the format itself (`#begin`).
 */
async function checkFormatLocked(conn: Connection, format: number): Promise<number> {
  return await locked(conn, () => checkFormat(conn, format));
}

type State = "open" | "closing" | "closed" | "failed";

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

/** What the role lacks for the in-place residue clean-up (02-architecture §7 «残留清理在 PostgreSQL 上需要的权限»). */
export type ResidueGrant = "pg_maintain" | "pg_checkpoint" | "pg_switch_wal" | "wal_recycle";

/**
 * Which residue clean-up this store can do: `in_place`, with every grant §7 lists and the instance
 * running with `wal_recycle = off`; otherwise a rebuild, and what is missing for the in-place one
 * (02-architecture §7 «残留清理的做法»: «用哪一种由启动时核对决定»). The host shows it
 * (`saveslot doctor`) and chooses.
 */
export type ResidueMode =
  | "in_place"
  | { readonly rebuild: true; readonly missing: readonly ResidueGrant[] };

/** The role's grants and the instance's `wal_recycle`, as `ResidueMode`. A superuser has every grant. */
async function residueModeOf(conn: Connection): Promise<ResidueMode> {
  const member = (role: string) =>
    `(SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
       OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')
           AND pg_has_role(current_user, '${role}', 'member'))`;
  const r = (
    await conn.run(
      `SELECT ${member("pg_maintain")} AS pg_maintain, ${member("pg_checkpoint")} AS pg_checkpoint,
         has_function_privilege(current_user, 'pg_switch_wal()', 'EXECUTE') AS pg_switch_wal,
         current_setting('wal_recycle') = 'off' AS wal_recycle`,
      [],
    )
  ).rows[0] as Record<ResidueGrant, boolean>;
  const missing = (
    ["pg_maintain", "pg_checkpoint", "pg_switch_wal", "wal_recycle"] as const
  ).filter((g) => r[g] !== true);
  return missing.length === 0 ? "in_place" : { rebuild: true, missing };
}

/**
 * Whether another session of this database, or a process of no database, holds a snapshot or a
 * transaction ID: the dead statistics rows it could still see would stay. Only `backend_xmin` and
 * `backend_xid`, shown to every role (02-architecture §7 «残留清理的做法», step 3).
 */
const SNAPSHOT_HELD_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
    AND coalesce(datname, current_database()) = current_database()
    AND (backend_xmin IS NOT NULL OR backend_xid IS NOT NULL)) AS held`;
/** How long the residue clean-up waits for those snapshots, and how often it looks. */
const SNAPSHOT_WAIT_MS = 60_000;
const SNAPSHOT_POLL_MS = 50;

export class PostgresTenantStore implements TenantStore {
  readonly formatVersion: number;
  /** PostgreSQL enforces `statement_timeout` (the kernel sets one for a `sql` call). */
  readonly enforcesStatementTimeout = true;
  readonly database: string;
  readonly cell: string;
  /** Which residue clean-up the role and the instance allow, as checked at open. */
  readonly residueMode: ResidueMode;
  readonly #purgeSnapshotWaitMs: number;
  readonly #conn: Connection;
  #state: State = "open";
  #tail: Promise<unknown> = Promise.resolve();
  #closed: Promise<void> | undefined;

  constructor(init: {
    conn: Connection;
    formatVersion: number;
    residueMode: ResidueMode;
    purgeSnapshotWaitMs?: number;
    database: string;
    cell: string;
  }) {
    this.#conn = init.conn;
    this.residueMode = init.residueMode;
    this.#purgeSnapshotWaitMs = init.purgeSnapshotWaitMs ?? SNAPSHOT_WAIT_MS;
    this.formatVersion = init.formatVersion;
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

  /** The read records only: no tenant lock, no seal; the format checked (the port's `recordReads`). */
  recordReads<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#enqueue(() => this.#transaction("reads", fn));
  }

  /**
   * The in-place residue clean-up (02-architecture §7 «残留清理的做法»; the kernel port's
   * `purgeResidue`), each statement on the store's connection between the tenant's transactions:
   * each of `tables` rewritten; ANALYZE of every table and column (autovacuum gathers statistics
   * on the content columns too, so the old ones are replaced, then cleared); a wait, at most a
   * minute, until no other session of this database holds a snapshot (`snapshot_timeout`
   * otherwise); the statistics rewritten; the write-ahead log; the check. A name that is not one of
   * this database's tables is refused before any step runs. A statement refused for want of a
   * grant throws `PurgePermissionError`; the caller turns to a rebuild (`residueMode`).
   */
  async purgeResidue(tables: readonly string[]): Promise<PurgeOutcome> {
    const names = [...new Set(tables)].sort();
    const known = new Set(
      await this.read(async (tx) =>
        (
          await tx.query<{ name: string }>(
            "SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'",
          )
        ).rows.map((r) => r.name),
      ),
    );
    const unknown = names.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      throw new Error(`purgeResidue: not tables of this database: ${unknown.join(", ")}`);
    }
    for (const t of names)
      await this.#purgeStep("rewrite", `VACUUM FULL public."${t.replaceAll('"', '""')}"`);
    await this.#purgeStep("analyze", "ANALYZE");
    const until = Date.now() + this.#purgeSnapshotWaitMs;
    for (;;) {
      const r = await this.#purgeStep("wait_snapshots", SNAPSHOT_HELD_SQL, []);
      if (r.result.rows[0]?.["held"] !== true) break;
      if (Date.now() >= until) return { ok: false, why: "snapshot_timeout" };
      await new Promise((f) => setTimeout(f, SNAPSHOT_POLL_MS));
    }
    await this.#purgeStep("rewrite_statistics", "VACUUM FULL pg_statistic");
    await this.#purgeStep("checkpoint", "CHECKPOINT");
    await this.#purgeStep("switch_wal", "SELECT pg_switch_wal()");
    await this.#purgeStep("checkpoint", "CHECKPOINT");
    await this.#purgeStep("checkpoint", "CHECKPOINT");
    const check = await this.#purgeStep("check", "VACUUM (VERBOSE) pg_statistic");
    const m = /(\d+) are dead but not yet removable/.exec(check.notices.join("\n"));
    if (m === null) throw new Error("VACUUM (VERBOSE) pg_statistic reported no count of dead rows");
    return Number(m[1]) === 0 ? { ok: true } : { ok: false, why: "dead_not_removable" };
  }

  /**
   * One statement of `purgeResidue`, queued between the tenant's transactions, with the notices it
   * gave. Refused for want of a grant (SQLSTATE 42501): `PurgePermissionError`, naming the step. So
   * is a VACUUM that skipped its table: PostgreSQL does not refuse a VACUUM of a table the role may
   * not vacuum, it warns and goes on, so the table would not be rewritten.
   */
  #purgeStep(step: string, sql: string, params?: readonly SqlValue[]) {
    return this.#enqueue(async () => {
      this.#ensureUsable();
      try {
        if (params !== undefined) return { result: await this.#conn.run(sql, params), notices: [] };
        const r = await this.#conn.runWithNotices(sql);
        const skipped = r.notices.find((n) => /^skipping "/.test(n));
        if (skipped !== undefined) {
          throw new PurgePermissionError(
            `the role may not run the residue clean-up's ${step}: ${skipped}`,
            step,
          );
        }
        return r;
      } catch (e) {
        if (e instanceof PurgePermissionError) throw e;
        if (e instanceof Gone && this.#state === "open") this.#state = "failed";
        if (e instanceof Refused && e.sqlState === "42501") {
          throw new PurgePermissionError(
            `the role may not run the residue clean-up's ${step}`,
            step,
            {
              cause: e,
            },
          );
        }
        throw storeError(e, "connection_lost");
      }
    });
  }

  async snapshot(): Promise<SnapshotRef> {
    throw new Error("snapshot is not implemented: physical snapshots are not in v1");
  }

  /** False once the connection is gone or the store closed: final (TenantStore). */
  get usable(): boolean {
    return this.#state === "open" && !this.#conn.gone;
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
      case "failed":
        throw new PostgresStoreError(
          "connection_lost",
          "the connection to the database is gone; close the store",
        );
      default:
        throw new PostgresStoreError("store_closed", "the store is closed");
    }
  }

  /**
   * Opens the transaction (02-architecture §7 «进程、单写者、串行写»). A read sees one state
   * throughout: its snapshot is taken once, so what another process commits meanwhile does not show
   * between two of its statements. A write takes the tenant's lock. Either then reads, in one
   * statement, the storage format and the seal: a format newer than this store's is refused
   * (format_too_new: this process is older than the storage, and is to be replaced), one older is
   * a defect (a store put back from an older backup goes through the restore flow, stopped); a seal
   * refuses a write (tenant_sealed: an import is in progress), not a read. The read records'
   * transaction (the port's `recordReads`) takes no lock and checks the format as a read does: a
   * read's record is part of the read, so a seal does not refuse it either.
   */
  async #begin(mode: "read" | "write" | "reads"): Promise<void> {
    await this._run(
      mode === "read"
        ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        : mode === "reads"
          ? "BEGIN ISOLATION LEVEL READ COMMITTED"
          : "BEGIN",
      undefined,
    );
    let rows: readonly { key: string; value: string }[];
    try {
      if (mode === "write") await this._run(LOCK_SQL, undefined);
      rows = (await this._run(GUARD_SQL, [META_KEYS.storageFormat, META_KEYS.sealed])).rows as {
        key: string;
        value: string;
      }[];
    } catch (e) {
      if (!this.#conn.gone) await this._run("ROLLBACK", undefined).catch(() => {});
      throw e;
    }
    const format = Number(rows.find((r) => r.key === META_KEYS.storageFormat)?.value);
    const refuse = async (e: PostgresStoreError): Promise<never> => {
      await this._run("ROLLBACK", undefined).catch(() => {});
      throw e;
    };
    if (format > this.formatVersion) {
      await refuse(
        new PostgresStoreError(
          "format_too_new",
          `storage format ${format} is newer than this version's ${this.formatVersion}`,
        ),
      );
    }
    // Older than opened: put back from an older backup under a running server, which a restore
    // forbids (it is done stopped). A defect, not guessed at.
    if (!(format === this.formatVersion)) {
      await this._run("ROLLBACK", undefined).catch(() => {});
      throw new Error(
        `storage format ${String(format)} is not the one this store opened (${this.formatVersion})`,
      );
    }
    if (mode === "write" && rows.some((r) => r.key === META_KEYS.sealed)) {
      await refuse(
        new PostgresStoreError("tenant_sealed", "the tenant is sealed by an import in progress"),
      );
    }
  }

  async #transaction<T>(mode: "read" | "write" | "reads", fn: (tx: Tx) => Promise<T>): Promise<T> {
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
    const done = await this._run("COMMIT", undefined, mode !== "read");
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
