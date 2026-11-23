// The server mode's control plane (docs/zh-CN/spec/02-architecture.md §5 «控制面存储»: a PostgreSQL
// database of its own, apart from every tenant's): the tenant directory and routing, the
// credentials, and the anchor store (§8) of every tenant. The tables and what their columns mean
// are in §5; the SQL is here.
//
// Every statement goes through a `ControlDb`, a port the host gives (the daemon opens the control
// database): the service holds no driver (§11). Each call of the anchor store is one write
// transaction of the control database, committed before the call returns, and never part of a
// transaction of a tenant's storage: a deletion entry is on disk before the tenant transaction that
// confirms the deletion commits (§8 «持久性要求»).

import {
  type Anchor,
  type AnchorStore,
  AnchorStoreError,
  anchorProblem,
  copyAnchor,
  copyEntry,
  type DeletionEntry,
  EMPTY_ANCHOR,
  entriesProblem,
  entryProblem,
  isCount,
  isName,
  type ReadTx,
  type TenantRef,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import type {
  CredentialEntry,
  PrincipalId,
  ServerControl,
  TenantEntry,
  TenantId,
  UserId,
} from "./control-plane.ts";

/**
 * The control database as the service needs it: read and write transactions, as a tenant's, each
 * committed (or rolled back) before the call returns. Two things are assumed of the opener:
 *
 * - a write runs at READ COMMITTED: two connections' first writes of one tenant then take turns on
 *   its row's lock; at REPEATABLE READ one of them fails with a serialization error instead;
 * - a read sees one snapshot (REPEATABLE READ, read only): an anchor is read by two statements, and
 *   must not be half before and half after another connection's write.
 */
export interface ControlDb {
  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T>;
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** The control database's format: `control_meta`'s `format`. */
export const CONTROL_FORMAT = 1;

const DDL = `
CREATE TABLE control_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE tenants (
  id text PRIMARY KEY,
  owner text NOT NULL UNIQUE,
  cell text NOT NULL,
  database text NOT NULL,
  state text NOT NULL CHECK (state IN ('creating', 'active')),
  staging_database text,
  UNIQUE (cell, database),
  UNIQUE (cell, staging_database)
);
CREATE TABLE credentials (
  hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('session', 'connection')),
  principal text NOT NULL,
  tenant text NOT NULL REFERENCES tenants (id),
  expires_at text,
  grant_id text
);
CREATE INDEX credentials_principal ON credentials (tenant, principal);
CREATE TABLE anchors (
  tenant text PRIMARY KEY,
  high_water bigint NOT NULL,
  restore_count bigint NOT NULL,
  restore_id text,
  import_id text
);
CREATE TABLE anchor_deletions (
  tenant text NOT NULL REFERENCES anchors (tenant),
  position integer NOT NULL,
  entry text NOT NULL,
  PRIMARY KEY (tenant, position)
);`;

/**
 * Why the control plane refused. Stable codes; messages carry no stored content.
 * - `control_format_mismatch`: the control database is of another format.
 * - `control_not_initialized`: it has no control plane's tables.
 * - `invalid_credential`: a credential not of its form (a hash not 64 lower-case hex digits, an
 *   expiry not a canonical instant).
 * - `already_exists`: a credential of that hash is there already.
 * - `unknown_tenant`: no tenant of that ID in the directory.
 * - `tenant_taken`: another owner's tenant has that ID, or the database is one a tenant of that cell
 *   has, as its own or as staging.
 * - `invalid_database`: a database name not of a PostgreSQL database's shape, or the server's own.
 * - `no_staging`: a swap asked of a tenant with no staging database.
 */
export type ControlPlaneErrorCode =
  | "control_format_mismatch"
  | "control_not_initialized"
  | "invalid_credential"
  | "already_exists"
  | "unknown_tenant"
  | "tenant_taken"
  | "invalid_database"
  | "no_staging";

export class ControlPlaneError extends Error {
  override readonly name = "ControlPlaneError";
  readonly code: ControlPlaneErrorCode;
  constructor(code: ControlPlaneErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The advisory lock initializations take turns on: two processes starting at once. */
export const INIT_LOCK = 0x5ab05107;
/**
 * The advisory lock the directory's writes of database names take turns on: a name is looked for
 * among the tenants' databases and staging databases, then written, and two such writes at once
 * must not both find it free (READ COMMITTED sees no row another has not committed).
 */
const NAMES_LOCK = 0x5ab05108;

/**
 * A database's name as the PostgreSQL backend takes it: the same as store-postgres's
 * DATABASE_NAME, which this package may not import (02-architecture §11); a test compares the two.
 */
export const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** The server's own databases: never a tenant's. */
const SERVER_DATABASES: ReadonlySet<string> = new Set(["postgres", "template0", "template1"]);

function checkDatabase(name: string): void {
  if (!DATABASE_NAME.test(name) || SERVER_DATABASES.has(name)) {
    throw new ControlPlaneError(
      "invalid_database",
      `${JSON.stringify(name)} is not a tenant's database`,
    );
  }
}

/** A tenant of that cell has that database, as its own or as staging (`but` left out of the latter). */
async function databaseTaken(
  tx: ReadTx,
  cell: string,
  database: string,
  but: TenantId | null,
): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM tenants WHERE cell = $1
       AND (database = $2 OR (staging_database = $2 AND id IS DISTINCT FROM $3))`,
    [cell, database, but],
  );
  return r.rows.length > 0;
}

const HASH = /^[0-9a-f]{64}$/;
/** An instant as `Date.prototype.toISOString` writes it. */
export const isInstant = (v: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString() === v;

const sqlStateOf = (e: unknown): string | undefined =>
  (e as { sqlState?: unknown })?.sqlState as string | undefined;

async function checkFormat(tx: ReadTx): Promise<void> {
  const f = await tx.query<{ value: string }>(
    "SELECT value FROM control_meta WHERE key = 'format'",
  );
  if (f.rows[0]?.value !== String(CONTROL_FORMAT)) {
    throw new ControlPlaneError(
      "control_format_mismatch",
      `the control database's format is not ${CONTROL_FORMAT}`,
    );
  }
}

/**
 * Whether `control_meta` is there, in a schema of the search path, as an unqualified name finds it.
 * Read from the catalog with this statement's snapshot, not with `to_regclass`: that answers from
 * the connection's catalog cache, which can keep a "no such table" from an earlier lookup (a
 * refused `openControlPlane`, say) after another process made the tables while this one waited for
 * `INIT_LOCK`.
 */
async function hasControlMeta(tx: ReadTx): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ANY (current_schemas(false)) AND c.relname = 'control_meta'
     ) AS ok`,
  );
  return r.rows[0]?.ok === true;
}

/**
 * Makes the control database's tables and records its format; on a database that has them, checks
 * the format and does nothing more, so that running it again is safe, and two processes running it
 * at once take turns. Gives the control plane over it.
 */
export async function initControlPlane(db: ControlDb): Promise<ServerControlPlane> {
  await db.write(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [INIT_LOCK]);
    if (!(await hasControlMeta(tx))) {
      await tx.exec(DDL);
      await tx.query("INSERT INTO control_meta (key, value) VALUES ('format', $1)", [
        String(CONTROL_FORMAT),
      ]);
      return;
    }
    await checkFormat(tx);
  });
  return ServerControlPlane.over(db);
}

/** The control plane over a control database `initControlPlane` made; its format checked first. */
export async function openControlPlane(db: ControlDb): Promise<ServerControlPlane> {
  await db.read(async (tx) => {
    if (!(await hasControlMeta(tx))) {
      throw new ControlPlaneError("control_not_initialized", "the control database has no tables");
    }
    await checkFormat(tx);
  });
  return ServerControlPlane.over(db);
}

interface TenantRow {
  id: string;
  owner: string;
  cell: string;
  database: string;
  state: "creating" | "active";
  staging_database: string | null;
}

const tenantEntry = (r: TenantRow): TenantEntry => ({
  id: r.id as TenantId,
  owner: r.owner as UserId,
  ref: { kind: "postgres", cell: r.cell, database: r.database },
  state: r.state,
  ...(r.staging_database === null ? {} : { staging: r.staging_database }),
});

/**
 * The server mode's control plane over the control database. Had only from `initControlPlane` or
 * `openControlPlane`, which check the database's format first.
 */
export class ServerControlPlane implements ServerControl {
  readonly #db: ControlDb;
  readonly anchors: AnchorStore;

  private constructor(db: ControlDb) {
    this.#db = db;
    this.anchors = new ControlAnchorStore(db);
  }

  /** @internal Over a control database whose format was checked. */
  static over(db: ControlDb): ServerControlPlane {
    return new ServerControlPlane(db);
  }

  async tenant(id: TenantId): Promise<TenantEntry | undefined> {
    const r = await this.#db.read((tx) =>
      tx.query<TenantRow>(
        "SELECT id, owner, cell, database, state, staging_database FROM tenants WHERE id = $1",
        [id],
      ),
    );
    return r.rows[0] === undefined ? undefined : tenantEntry(r.rows[0]);
  }

  async tenantOf(owner: UserId): Promise<TenantEntry | undefined> {
    const r = await this.#db.read((tx) =>
      tx.query<TenantRow>(
        "SELECT id, owner, cell, database, state, staging_database FROM tenants WHERE owner = $1",
        [owner],
      ),
    );
    return r.rows[0] === undefined ? undefined : tenantEntry(r.rows[0]);
  }

  async registerTenant(e: {
    readonly id: TenantId;
    readonly owner: UserId;
    readonly ref: TenantRef;
  }): Promise<TenantEntry> {
    if (e.ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    const { cell, database } = e.ref;
    checkDatabase(database);
    return this.#db.write(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [NAMES_LOCK]);
      const own = await tx.query<TenantRow>(
        "SELECT id, owner, cell, database, state, staging_database FROM tenants WHERE owner = $1",
        [e.owner],
      );
      if (own.rows[0] !== undefined) return tenantEntry(own.rows[0]);
      // Another tenant's staging database is not in the unique constraint on databases.
      if (await databaseTaken(tx, cell, database, null)) {
        throw new ControlPlaneError("tenant_taken", "the database is another tenant's");
      }
      // An owner, an ID or a database taken: nothing inserted. The owner's row is then its tenant;
      // none means the ID or the database is another owner's.
      await tx.query(
        `INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, $3, $4, 'creating')
           ON CONFLICT DO NOTHING`,
        [e.id, e.owner, cell, database],
      );
      const r = await tx.query<TenantRow>(
        "SELECT id, owner, cell, database, state, staging_database FROM tenants WHERE owner = $1",
        [e.owner],
      );
      if (r.rows[0] === undefined) {
        throw new ControlPlaneError("tenant_taken", "the tenant ID or database is another's");
      }
      return tenantEntry(r.rows[0]);
    });
  }

  async activateTenant(id: TenantId): Promise<void> {
    await this.#updateTenant(id, "UPDATE tenants SET state = 'active' WHERE id = $1 RETURNING id", [
      id,
    ]);
  }

  async setStaging(id: TenantId, database: string | null): Promise<void> {
    if (database === null) {
      await this.#updateTenant(
        id,
        "UPDATE tenants SET staging_database = NULL WHERE id = $1 RETURNING id",
        [id],
      );
      return;
    }
    checkDatabase(database);
    await this.#db.write(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [NAMES_LOCK]);
      const t = await tx.query<{ cell: string }>("SELECT cell FROM tenants WHERE id = $1", [id]);
      if (t.rows[0] === undefined) throw new ControlPlaneError("unknown_tenant", `no tenant ${id}`);
      // An import writes into its staging database before the swap: never a database in use.
      if (await databaseTaken(tx, t.rows[0].cell, database, id)) {
        throw new ControlPlaneError("tenant_taken", "the database is a tenant's of that cell");
      }
      await tx.query("UPDATE tenants SET staging_database = $2 WHERE id = $1", [id, database]);
    });
  }

  async forgetStaging(id: TenantId, database: string): Promise<void> {
    await this.#db.write((tx) =>
      tx.query(
        "UPDATE tenants SET staging_database = NULL WHERE id = $1 AND staging_database = $2",
        [id, database],
      ),
    );
  }

  async swapInStaging(id: TenantId): Promise<void> {
    await this.#db.write(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [NAMES_LOCK]);
      const clash = await tx.query(
        `SELECT 1 FROM tenants t JOIN tenants o ON o.cell = t.cell AND o.id <> t.id
           WHERE t.id = $1 AND o.database = t.staging_database`,
        [id],
      );
      if (clash.rows.length > 0) {
        throw new ControlPlaneError("tenant_taken", "the staging database is another tenant's");
      }
      const r = await tx.query(
        // The two exchanged: the database replaced stays recorded until it is dropped.
        `UPDATE tenants SET database = staging_database, staging_database = database
           WHERE id = $1 AND staging_database IS NOT NULL RETURNING id`,
        [id],
      );
      if (r.rows.length > 0) return;
      const t = await tx.query("SELECT 1 FROM tenants WHERE id = $1", [id]);
      throw t.rows.length === 0
        ? new ControlPlaneError("unknown_tenant", "no such tenant")
        : new ControlPlaneError("no_staging", "the tenant has no staging database");
    });
  }

  /** Runs an UPDATE of one tenant's row, `RETURNING id`; refuses a tenant not there. */
  async #updateTenant(
    id: TenantId,
    sql: string,
    params: readonly (string | null)[],
  ): Promise<void> {
    await this.#db.write(async (tx) => {
      const r = await tx.query(sql, params);
      if (r.rows.length === 0) throw new ControlPlaneError("unknown_tenant", `no tenant ${id}`);
    });
  }

  async credential(hash: string): Promise<CredentialEntry | undefined> {
    const r = await this.#db.read((tx) =>
      tx.query<{
        kind: "session" | "connection";
        principal: string;
        tenant: string;
        expires_at: string | null;
        grant_id: string | null;
      }>("SELECT kind, principal, tenant, expires_at, grant_id FROM credentials WHERE hash = $1", [
        hash,
      ]),
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    return {
      hash,
      kind: row.kind,
      principal: row.principal as PrincipalId,
      tenant: row.tenant as TenantId,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.grant_id === null ? {} : { grant: row.grant_id }),
    };
  }

  async putCredential(e: CredentialEntry): Promise<void> {
    if (!HASH.test(e.hash)) {
      throw new ControlPlaneError("invalid_credential", "a hash is 64 lower-case hex digits");
    }
    if (e.expiresAt !== undefined && !isInstant(e.expiresAt)) {
      throw new ControlPlaneError("invalid_credential", "an expiry is a canonical instant");
    }
    try {
      await this.#db.write((tx) =>
        tx.query(
          `INSERT INTO credentials (hash, kind, principal, tenant, expires_at, grant_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
          [e.hash, e.kind, e.principal, e.tenant, e.expiresAt ?? null, e.grant ?? null],
        ),
      );
    } catch (err) {
      const state = sqlStateOf(err);
      if (state === "23505") {
        throw new ControlPlaneError("already_exists", "a credential of that hash is there");
      }
      if (state === "23503") throw new ControlPlaneError("unknown_tenant", "no such tenant");
      throw err;
    }
  }

  async removeCredentials(
    tenant: TenantId,
    principals: ReadonlySet<PrincipalId>,
    opts: { readonly kind?: "session" | "connection" } = {},
  ): Promise<number> {
    const list: string[] = [...principals];
    if (list.length === 0) return 0;
    const params = [tenant, ...list, ...(opts.kind === undefined ? [] : [opts.kind])];
    const ofKind = opts.kind === undefined ? "" : ` AND kind = $${list.length + 2}`;
    return this.#db.write(async (tx) => {
      const r = await tx.query<{ n: number }>(
        `WITH gone AS (DELETE FROM credentials WHERE tenant = $1 AND principal IN (${list
          .map((_, i) => `$${i + 2}`)
          .join(", ")})${ofKind} RETURNING 1) SELECT count(*)::int AS n FROM gone`,
        params,
      );
      return Number(r.rows[0]?.n ?? 0);
    });
  }
}

interface AnchorRow {
  high_water: number | string | bigint;
  restore_count: number | string | bigint;
  restore_id: string | null;
  import_id: string | null;
}

const corrupt = (what: string) => new AnchorStoreError("corrupt", `control anchor store: ${what}`);

const reject = (what: string): Promise<never> =>
  Promise.reject(new AnchorStoreError("invalid_entry", `not a valid ${what}`));

const notInProgress = (what: string, current: string | undefined) =>
  new AnchorStoreError(
    "not_in_progress",
    current === undefined ? `no ${what} in progress` : `another ${what} is in progress`,
  );

/**
 * The anchor store in the control database: `anchors` holds a tenant's high water, restore count
 * and markers; `anchor_deletions` its entries, in order. Each operation reads the tenant's anchor
 * under its row's lock, makes the change the port defines (as the file implementation does), and
 * writes the anchor back, in one transaction.
 */
class ControlAnchorStore implements AnchorStore {
  readonly #db: ControlDb;

  constructor(db: ControlDb) {
    this.#db = db;
  }

  async #load(tx: ReadTx, tenant: TenantId, lock: boolean): Promise<Anchor> {
    const row = await tx.query<AnchorRow>(
      `SELECT high_water, restore_count, restore_id, import_id FROM anchors WHERE tenant = $1${
        lock ? " FOR UPDATE" : ""
      }`,
      [tenant],
    );
    const a = row.rows[0];
    if (a === undefined) return EMPTY_ANCHOR;
    const entries = await tx.query<{ entry: string }>(
      "SELECT entry FROM anchor_deletions WHERE tenant = $1 ORDER BY position",
      [tenant],
    );
    let deletions: unknown[];
    try {
      deletions = entries.rows.map((r) => JSON.parse(r.entry) as unknown);
    } catch {
      throw corrupt("a deletion entry is not JSON");
    }
    const anchor = {
      deletions,
      highWater: Number(a.high_water),
      restoreCount: Number(a.restore_count),
      ...(a.restore_id === null ? {} : { restoreInProgress: a.restore_id }),
      ...(a.import_id === null ? {} : { importInProgress: a.import_id }),
    };
    const p = anchorProblem(anchor);
    if (p !== undefined) throw corrupt(`a tenant's anchor: ${p}`);
    return copyAnchor(anchor as Anchor);
  }

  async #save(tx: Tx, tenant: TenantId, a: Anchor): Promise<void> {
    await tx.query(
      `INSERT INTO anchors (tenant, high_water, restore_count, restore_id, import_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant) DO UPDATE SET high_water = EXCLUDED.high_water,
           restore_count = EXCLUDED.restore_count, restore_id = EXCLUDED.restore_id,
           import_id = EXCLUDED.import_id`,
      [
        tenant,
        a.highWater,
        a.restoreCount,
        a.restoreInProgress ?? null,
        a.importInProgress ?? null,
      ],
    );
    await tx.query("DELETE FROM anchor_deletions WHERE tenant = $1", [tenant]);
    for (const [i, e] of a.deletions.entries()) {
      await tx.query("INSERT INTO anchor_deletions (tenant, position, entry) VALUES ($1, $2, $3)", [
        tenant,
        i,
        JSON.stringify(e),
      ]);
    }
  }

  /** Reads the tenant's anchor under lock, applies `change`, writes it when it gives a new one. */
  #update<T>(tenant: TenantId, change: (a: Anchor) => { anchor?: Anchor; result: T }): Promise<T> {
    if (!isName(tenant)) return reject("tenant ID");
    return this.#db.write(async (tx) => {
      // The row is made first, so that two first writes of a tenant take turns on its lock.
      await tx.query(
        `INSERT INTO anchors (tenant, high_water, restore_count) VALUES ($1, 0, 0)
           ON CONFLICT (tenant) DO NOTHING`,
        [tenant],
      );
      const { anchor, result } = change(await this.#load(tx, tenant, true));
      if (anchor !== undefined) await this.#save(tx, tenant, anchor);
      return result;
    });
  }

  read(tenant: TenantId): Promise<Anchor> {
    if (!isName(tenant)) return reject("tenant ID");
    return this.#db.read((tx) => this.#load(tx, tenant, false));
  }

  putDeletion(tenant: TenantId, entry: DeletionEntry): Promise<void> {
    const p = entryProblem(entry);
    if (p !== undefined) return reject(`deletion entry: ${p}`);
    const e = copyEntry(entry);
    return this.#update(tenant, (a) => {
      const i = a.deletions.findIndex((x) => x.deletion === e.deletion);
      const deletions = i < 0 ? [...a.deletions, e] : a.deletions.with(i, e);
      return { anchor: { ...a, deletions }, result: undefined };
    });
  }

  removeDeletion(tenant: TenantId, deletion: string): Promise<void> {
    return this.#update(tenant, (a) =>
      a.deletions.some((x) => x.deletion === deletion)
        ? {
            anchor: { ...a, deletions: a.deletions.filter((x) => x.deletion !== deletion) },
            result: undefined,
          }
        : { result: undefined },
    );
  }

  advanceHighWater(tenant: TenantId, seq: number): Promise<void> {
    if (!isCount(seq)) return reject("high water mark");
    return this.#update(tenant, (a) =>
      seq > a.highWater
        ? { anchor: { ...a, highWater: seq }, result: undefined }
        : { result: undefined },
    );
  }

  beginRestore(tenant: TenantId, restore: string): Promise<Anchor> {
    if (!isName(restore)) return reject("restore ID");
    return this.#update(tenant, (a) => {
      if (a.restoreInProgress !== undefined) return { result: copyAnchor(a) };
      const next = { ...a, restoreInProgress: restore, restoreCount: a.restoreCount + 1 };
      return { anchor: next, result: copyAnchor(next) };
    });
  }

  endRestore(tenant: TenantId, restore: string, highWater: number): Promise<void> {
    if (!isCount(highWater)) return reject("high water mark");
    return this.#update(tenant, (a) => {
      if (a.restoreInProgress !== restore) throw notInProgress("restore", a.restoreInProgress);
      const { restoreInProgress: _, ...rest } = a;
      return {
        anchor: { ...rest, highWater: Math.max(a.highWater, highWater) },
        result: undefined,
      };
    });
  }

  beginImport(tenant: TenantId, importId: string): Promise<void> {
    if (!isName(importId)) return reject("import ID");
    return this.#update(tenant, (a) => {
      if (
        a.deletions.length > 0 ||
        a.restoreCount !== 0 ||
        a.restoreInProgress !== undefined ||
        a.importInProgress !== undefined
      ) {
        throw new AnchorStoreError("import_refused", "the anchor is not empty");
      }
      return { anchor: { ...a, importInProgress: importId }, result: undefined };
    });
  }

  endImport(
    tenant: TenantId,
    importId: string,
    r: {
      readonly deletions: readonly DeletionEntry[];
      readonly highWater: number;
      readonly restoreCount: number;
    },
  ): Promise<void> {
    const p = entriesProblem(r.deletions);
    if (p !== undefined) return reject(`deletion entries${p.startsWith("[") ? "" : ": "}${p}`);
    if (!isCount(r.highWater)) return reject("high water mark");
    if (!isCount(r.restoreCount)) return reject("restore count");
    const deletions = r.deletions.map(copyEntry);
    return this.#update(tenant, (a) => {
      if (a.importInProgress !== importId) throw notInProgress("import", a.importInProgress);
      const { importInProgress: _, ...rest } = a;
      return {
        anchor: {
          ...rest,
          deletions,
          highWater: Math.max(a.highWater, r.highWater),
          restoreCount: r.restoreCount,
        },
        result: undefined,
      };
    });
  }

  abortImport(tenant: TenantId, importId: string): Promise<void> {
    return this.#update(tenant, (a) => {
      if (a.importInProgress === undefined) return { result: undefined };
      if (a.importInProgress !== importId) throw notInProgress("import", a.importInProgress);
      const { importInProgress: _, ...rest } = a;
      return { anchor: rest, result: undefined };
    });
  }
}
