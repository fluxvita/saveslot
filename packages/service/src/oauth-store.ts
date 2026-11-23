// The authorization server's tables in the control database (docs/zh-CN/spec/02-architecture.md §5
// «控制面存储»; 05-surfaces.md §15 «远程授权»): client documents fetched (a cache), grants, codes not
// yet redeemed, refresh tokens, device codes, and the consent page's one-time form tokens. Server mode only. Who
// the user is comes from the identity provider (signing in is not the authorization server's).
// What each table holds is in §5; the SQL is here.
//
// They have a format of their own (`control_meta`'s `oauth_format`), made and checked by
// `initOAuthTables` beside `initControlPlane`, so either can change without the other. Codes, refresh
// tokens, device codes and form tokens are stored by their SHA-256 only, as credentials are. A format is not
// upgraded: a database of another format is refused, and is made again.

import type { Tx } from "@fluxvita/saveslot-kernel";
import type { Scope } from "./auth.ts";
import type { CredentialEntry, PrincipalId, TenantId, UserId } from "./control-plane.ts";
import { type ControlDb, ControlPlaneError } from "./server-control-plane.ts";

/**
 * A write that inserts a row: a key already there is `already_exists`, a tenant not in the
 * directory `unknown_tenant` — the control plane's codes, never the database's own error.
 */
async function inserting<T>(what: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    const state = (err as { sqlState?: unknown } | undefined)?.sqlState;
    if (state === "23505")
      throw new ControlPlaneError("already_exists", `${what} is there already`);
    if (state === "23503") throw new ControlPlaneError("unknown_tenant", "no such tenant");
    throw err;
  }
}

/** The OAuth tables' format: `control_meta`'s `oauth_format`. */
export const OAUTH_FORMAT = 3;

const DDL = `
CREATE TABLE oauth_clients (
  client_id text PRIMARY KEY,
  document bytea NOT NULL,
  fetched_at text NOT NULL,
  expires_at text NOT NULL
);
CREATE TABLE oauth_grants (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('connection', 'session')),
  principal text,
  tenant text NOT NULL REFERENCES tenants (id),
  client_id text NOT NULL,
  resource text NOT NULL,
  created_at text NOT NULL,
  voided_at text,
  code_hash text UNIQUE
);
CREATE INDEX oauth_grants_principal ON oauth_grants (principal);
CREATE TABLE oauth_codes (
  hash text PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  resource text NOT NULL,
  user_id text NOT NULL,
  login text NOT NULL,
  tenant text NOT NULL REFERENCES tenants (id),
  requested_scopes text,
  scopes text NOT NULL,
  name text,
  expires_at text NOT NULL
);
CREATE TABLE oauth_refresh_tokens (
  hash text PRIMARY KEY,
  grant_id text NOT NULL REFERENCES oauth_grants (id),
  issued_at text NOT NULL,
  expires_at text NOT NULL,
  grant_expires_at text,
  replaced_by text
);
CREATE INDEX oauth_refresh_tokens_grant ON oauth_refresh_tokens (grant_id);
CREATE TABLE oauth_device_codes (
  device_hash text PRIMARY KEY,
  user_code text NOT NULL UNIQUE,
  client_id text NOT NULL,
  resource text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'denied')),
  user_id text,
  login text,
  tenant text REFERENCES tenants (id),
  expires_at text NOT NULL,
  interval_s integer NOT NULL,
  last_poll_at text
);
CREATE TABLE web_forms (
  hash text PRIMARY KEY,
  bound_to text NOT NULL,
  expires_at text NOT NULL
);`;

/**
 * The advisory lock taken while the OAuth tables are made or checked: two processes starting at
 * once take turns, so one makes the tables and the other finds them. A fixed key of this module's.
 */
const INIT_LOCK = 0x5361_7665_4f41_7531n; // "SaveOAu1"

/**
 * Makes the OAuth tables and records their format; on a database that has them, checks the format
 * and changes nothing (`saveslot server init`). Runs after `initControlPlane` (the tables refer to
 * `tenants`).
 */
export async function initOAuthTables(db: ControlDb): Promise<void> {
  await db.write(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [INIT_LOCK.toString()]);
    const format = await formatOf(tx);
    if (format === undefined) {
      await tx.exec(DDL);
      await tx.query("INSERT INTO control_meta (key, value) VALUES ('oauth_format', $1)", [
        String(OAUTH_FORMAT),
      ]);
      return;
    }
    checkFormat(format);
  });
}

/**
 * The store over the OAuth tables `initOAuthTables` made, their format checked; nothing is made
 * (`runServer`): none there is `oauth_not_initialized`, another format `control_format_mismatch`.
 * The only way to a store: no caller holds tables whose format was not checked.
 */
export async function openOAuthStore(db: ControlDb): Promise<OAuthStore> {
  await db.read(async (tx) => {
    const format = await formatOf(tx);
    if (format === undefined) {
      throw new ControlPlaneError(
        "oauth_not_initialized",
        "the control database has no OAuth tables",
      );
    }
    checkFormat(format);
  });
  return new OAuthStore(db, CHECKED);
}

async function formatOf(tx: Pick<Tx, "query">): Promise<string | undefined> {
  const f = await tx.query<{ value: string }>(
    "SELECT value FROM control_meta WHERE key = 'oauth_format'",
  );
  return f.rows[0]?.value;
}

function checkFormat(format: string): void {
  if (format !== String(OAUTH_FORMAT)) {
    throw new ControlPlaneError(
      "control_format_mismatch",
      `the control database's OAuth tables are of format ${format}, not ${OAUTH_FORMAT}`,
    );
  }
}

/** What only `openOAuthStore` holds: the store's constructor refuses anyone else. */
const CHECKED = Symbol("oauth tables checked");

/** A client document in the cache. */
export interface CachedClient {
  readonly document: Uint8Array;
  readonly expiresAt: string;
}

/** One authorization: a connection instance's, or a CLI sign-in's (a user session). */
export interface Grant {
  readonly id: string;
  readonly kind: "connection" | "session";
  /**
   * The user, or the connection instance. A connection's grant is recorded before the instance is
   * issued, so that every credential names a grant that exists; its principal follows.
   */
  readonly principal?: PrincipalId;
  readonly tenant: TenantId;
  readonly clientId: string;
  readonly resource: string;
  readonly createdAt: string;
  readonly voidedAt?: string;
  /** The hash of the code redeemed for it: a second redemption of that code voids the grant. */
  readonly codeHash?: string;
}

/** A refresh token, by its hash. */
export interface RefreshEntry {
  readonly hash: string;
  readonly grant: string;
  readonly issuedAt: string;
  /** It stops working when unused until then. */
  readonly expiresAt: string;
  /** A CLI sign-in's total limit, the same for every token of the grant; none for a connection. */
  readonly grantExpiresAt?: string;
  /** The hash of the token it was exchanged for: set, it is used, and presenting it is a replay. */
  readonly replacedBy?: string;
}

/** A device code (RFC 8628), by the hash of its device code. */
export interface DeviceEntry {
  readonly deviceHash: string;
  /** Upper case, without the dash. */
  readonly userCode: string;
  readonly clientId: string;
  readonly resource: string;
  readonly state: "pending" | "approved" | "denied";
  /** Set when approved or denied: who answered, and under which login (`currentUser`'s `session`). */
  readonly user?: UserId;
  readonly login?: string;
  readonly tenant?: TenantId;
  readonly expiresAt: string;
  /** Seconds a client waits between polls. */
  readonly interval: number;
  readonly lastPollAt?: string;
}

/** What a code stands for, as the authorization page settled it. */
export interface CodeEntry {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly user: UserId;
  /** The login the consent was given under (`currentUser`'s `session`): a session is issued from it. */
  readonly login: string;
  readonly tenant: TenantId;
  /** The scopes the request asked for; none asked, the default was offered. */
  readonly requestedScopes?: readonly Scope[];
  /** The scopes the user ticked (checked against the request when the page took them). */
  readonly scopes: readonly Scope[];
  /** The connection instance's name; none for the CLI's sign-in. */
  readonly name?: string;
  readonly expiresAt: string;
}

async function insertRefresh(tx: Tx, r: RefreshEntry): Promise<void> {
  await tx.query(
    `INSERT INTO oauth_refresh_tokens (hash, grant_id, issued_at, expires_at, grant_expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
    [r.hash, r.grant, r.issuedAt, r.expiresAt, r.grantExpiresAt ?? null],
  );
}

const DEVICE_COLUMNS =
  "device_hash, user_code, client_id, resource, state, user_id, login, tenant, expires_at, interval_s, last_poll_at";

interface DeviceRow {
  device_hash: string;
  user_code: string;
  client_id: string;
  resource: string;
  state: "pending" | "approved" | "denied";
  user_id: string | null;
  login: string | null;
  tenant: string | null;
  expires_at: string;
  interval_s: number | string;
  last_poll_at: string | null;
}

function deviceEntry(row: DeviceRow): DeviceEntry {
  return {
    deviceHash: row.device_hash,
    userCode: row.user_code,
    clientId: row.client_id,
    resource: row.resource,
    state: row.state,
    ...(row.user_id === null ? {} : { user: row.user_id as UserId }),
    ...(row.login === null ? {} : { login: row.login }),
    ...(row.tenant === null ? {} : { tenant: row.tenant as TenantId }),
    expiresAt: row.expires_at,
    interval: Number(row.interval_s),
    ...(row.last_poll_at === null ? {} : { lastPollAt: row.last_poll_at }),
  };
}

async function insertGrant(tx: Tx, g: Grant): Promise<void> {
  await tx.query(
    `INSERT INTO oauth_grants (id, kind, principal, tenant, client_id, resource, created_at,
         code_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      g.id,
      g.kind,
      g.principal ?? null,
      g.tenant,
      g.clientId,
      g.resource,
      g.createdAt,
      g.codeHash ?? null,
    ],
  );
}

const scopesText = (s: readonly Scope[]) => JSON.stringify(s);
function scopesOf(text: string): Scope[] {
  const v = JSON.parse(text) as unknown;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error("oauth_codes: scopes are not a list of names");
  }
  return v as Scope[];
}

/** The authorization server's tables, over the control database. */
export class OAuthStore {
  readonly #db: ControlDb;

  /** Made by `openOAuthStore` only, once it has checked the format. */
  constructor(db: ControlDb, checked: typeof CHECKED) {
    if (checked !== CHECKED) throw new Error("OAuthStore: open it with openOAuthStore");
    this.#db = db;
  }

  /** A cached client document, expired or not: the caller compares `expiresAt`. */
  async cachedClient(clientId: string): Promise<CachedClient | undefined> {
    const r = await this.#db.read((tx) =>
      tx.query<{ document: Uint8Array; expires_at: string }>(
        "SELECT document, expires_at FROM oauth_clients WHERE client_id = $1",
        [clientId],
      ),
    );
    const row = r.rows[0];
    return row === undefined
      ? undefined
      : { document: new Uint8Array(row.document), expiresAt: row.expires_at };
  }

  async cacheClient(
    clientId: string,
    document: Uint8Array,
    fetchedAt: string,
    expiresAt: string,
  ): Promise<void> {
    await this.#db.write((tx) =>
      tx.query(
        `INSERT INTO oauth_clients (client_id, document, fetched_at, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (client_id) DO UPDATE SET document = EXCLUDED.document,
             fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [clientId, document, fetchedAt, expiresAt],
      ),
    );
  }

  /** Forgets a client document: the next request fetches it again. */
  async forgetClient(clientId: string): Promise<void> {
    await this.#db.write((tx) =>
      tx.query("DELETE FROM oauth_clients WHERE client_id = $1", [clientId]),
    );
  }

  /** Records a grant, and with it its first refresh token when given, in one transaction. */
  async putGrant(g: Grant, refresh?: RefreshEntry): Promise<void> {
    await inserting("a grant of that ID", () =>
      this.#db.write(async (tx) => {
        await insertGrant(tx, g);
        if (refresh !== undefined) await insertRefresh(tx, refresh);
      }),
    );
  }

  async grant(id: string): Promise<Grant | undefined> {
    return this.#grantWhere("id", id);
  }

  /** The grant a code was redeemed for. */
  async grantOfCode(codeHash: string): Promise<Grant | undefined> {
    return this.#grantWhere("code_hash", codeHash);
  }

  async #grantWhere(column: "id" | "code_hash", value: string): Promise<Grant | undefined> {
    const r = await this.#db.read((tx) =>
      tx.query<{
        kind: "connection" | "session";
        principal: string | null;
        tenant: string;
        client_id: string;
        resource: string;
        created_at: string;
        voided_at: string | null;
        code_hash: string | null;
        id: string;
      }>(
        `SELECT id, kind, principal, tenant, client_id, resource, created_at, voided_at, code_hash
           FROM oauth_grants WHERE ${column} = $1`,
        [value],
      ),
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      ...(row.principal === null ? {} : { principal: row.principal as PrincipalId }),
      tenant: row.tenant as TenantId,
      clientId: row.client_id,
      resource: row.resource,
      createdAt: row.created_at,
      ...(row.voided_at === null ? {} : { voidedAt: row.voided_at }),
      ...(row.code_hash === null ? {} : { codeHash: row.code_hash }),
    };
  }

  /**
   * Records the connection instance a grant issued, and with it the grant's first refresh token
   * when given, in one transaction, only while the grant is not voided: false when it is (a replay
   * of its code came first), and nothing is recorded.
   */
  async setGrantPrincipal(
    id: string,
    principal: PrincipalId,
    refresh?: RefreshEntry,
  ): Promise<boolean> {
    return inserting("a refresh token of that hash", () =>
      this.#db.write(async (tx) => {
        const r = await tx.query(
          "UPDATE oauth_grants SET principal = $2 WHERE id = $1 AND voided_at IS NULL RETURNING 1",
          [id, principal],
        );
        if (r.rows.length === 0) return false;
        if (refresh !== undefined) await insertRefresh(tx, refresh);
        return true;
      }),
    );
  }

  /**
   * Records a credential of a grant, in one statement only while the grant is not voided: false
   * when it is, and nothing is written. A replayed code voids its grant at any moment of the
   * redemption; a credential written after that would outlive the voiding.
   */
  async putGrantCredential(e: CredentialEntry & { readonly grant: string }): Promise<boolean> {
    return inserting("a credential of that hash", async () => {
      const r = await this.#db.write((tx) =>
        tx.query(
          `INSERT INTO credentials (hash, kind, principal, tenant, expires_at, grant_id)
             SELECT $1, $2, $3, $4, $5, $6
              WHERE EXISTS (SELECT 1 FROM oauth_grants WHERE id = $6 AND voided_at IS NULL)
             RETURNING 1`,
          [e.hash, e.kind, e.principal, e.tenant, e.expiresAt ?? null, e.grant],
        ),
      );
      return r.rows.length > 0;
    });
  }

  /**
   * Voids a grant: marks it, and deletes the credentials and the refresh tokens it issued, in one
   * transaction. Voiding a voided grant changes nothing. How many credentials went.
   */
  async voidGrant(id: string, at: string): Promise<number> {
    return this.#db.write(async (tx) => {
      await tx.query("UPDATE oauth_grants SET voided_at = $2 WHERE id = $1 AND voided_at IS NULL", [
        id,
        at,
      ]);
      await tx.query("DELETE FROM oauth_refresh_tokens WHERE grant_id = $1", [id]);
      const r = await tx.query<{ n: number }>(
        `WITH gone AS (DELETE FROM credentials WHERE grant_id = $1 RETURNING 1)
           SELECT count(*)::int AS n FROM gone`,
        [id],
      );
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  /** A refresh token by its hash, used or not. */
  async refreshToken(hash: string): Promise<RefreshEntry | undefined> {
    const r = await this.#db.read((tx) =>
      tx.query<{
        grant_id: string;
        issued_at: string;
        expires_at: string;
        grant_expires_at: string | null;
        replaced_by: string | null;
      }>(
        `SELECT grant_id, issued_at, expires_at, grant_expires_at, replaced_by
           FROM oauth_refresh_tokens WHERE hash = $1`,
        [hash],
      ),
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    return {
      hash,
      grant: row.grant_id,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      ...(row.grant_expires_at === null ? {} : { grantExpiresAt: row.grant_expires_at }),
      ...(row.replaced_by === null ? {} : { replacedBy: row.replaced_by }),
    };
  }

  /**
   * Exchanges a refresh token for `next`: marks `old` used by `next` only while it is unused, and
   * records `next`, in one transaction. False when `old` was used already, or is gone: of two
   * exchanges of one token at once, one wins and the other gets false.
   */
  async rotateRefreshToken(old: string, next: RefreshEntry): Promise<boolean> {
    return this.#db.write(async (tx) => {
      const r = await tx.query(
        `UPDATE oauth_refresh_tokens SET replaced_by = $2
           WHERE hash = $1 AND replaced_by IS NULL RETURNING 1`,
        [old, next.hash],
      );
      if (r.rows.length === 0) return false;
      await insertRefresh(tx, next);
      return true;
    });
  }

  /**
   * Deletes the refresh tokens of a principal's grants in a tenant (a revoked connection's); its
   * access tokens stay, so that they are refused as revoked. How many went.
   */
  async dropRefreshTokens(tenant: TenantId, principal: PrincipalId): Promise<number> {
    return this.#db.write(async (tx) => {
      const r = await tx.query<{ n: number }>(
        `WITH gone AS (DELETE FROM oauth_refresh_tokens WHERE grant_id IN
             (SELECT id FROM oauth_grants WHERE tenant = $1 AND principal = $2) RETURNING 1)
           SELECT count(*)::int AS n FROM gone`,
        [tenant, principal],
      );
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  /** Deletes one access token of a grant; whether it was there. */
  async removeAccessToken(hash: string, grant: string): Promise<boolean> {
    const r = await this.#db.write((tx) =>
      tx.query("DELETE FROM credentials WHERE hash = $1 AND grant_id = $2 RETURNING 1", [
        hash,
        grant,
      ]),
    );
    return r.rows.length > 0;
  }

  /** Records a pending device code. A user code in use already is `already_exists`. */
  async putDeviceCode(d: Omit<DeviceEntry, "state" | "user" | "login" | "tenant" | "lastPollAt">) {
    await inserting("a device code of that user code", () =>
      this.#db.write((tx) =>
        tx.query(
          `INSERT INTO oauth_device_codes (device_hash, user_code, client_id, resource, state,
               expires_at, interval_s)
             VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
          [d.deviceHash, d.userCode, d.clientId, d.resource, d.expiresAt, d.interval],
        ),
      ),
    );
  }

  /**
   * Answers a pending, unexpired device code for its user code: approved by `user` of `tenant`
   * under `login`, or denied. Whether there was such a code.
   */
  async decideDeviceCode(
    userCode: string,
    answer: {
      readonly approved: boolean;
      readonly user: UserId;
      readonly login: string;
      readonly tenant: TenantId;
    },
    now: string,
  ): Promise<boolean> {
    const r = await this.#db.write((tx) =>
      tx.query(
        `UPDATE oauth_device_codes SET state = $2, user_id = $3, login = $4, tenant = $5
           WHERE user_code = $1 AND state = 'pending' AND expires_at > $6 RETURNING 1`,
        [
          userCode,
          answer.approved ? "approved" : "denied",
          answer.user,
          answer.login,
          answer.tenant,
          now,
        ],
      ),
    );
    return r.rows.length > 0;
  }

  /**
   * A client's poll of a device code: the code as it was, and whether the poll came sooner than
   * its interval after the one before; such a poll raises the interval by `slowDownBy` seconds.
   * The poll's time is recorded either way, in the same transaction.
   */
  async pollDeviceCode(
    hash: string,
    now: string,
    slowDownBy: number,
  ): Promise<{ readonly entry: DeviceEntry; readonly tooSoon: boolean } | undefined> {
    return this.#db.write(async (tx) => {
      const r = await tx.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM oauth_device_codes WHERE device_hash = $1 FOR UPDATE`,
        [hash],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      const entry = deviceEntry(row);
      const tooSoon =
        entry.lastPollAt !== undefined &&
        Date.parse(now) < Date.parse(entry.lastPollAt) + entry.interval * 1000;
      await tx.query(
        "UPDATE oauth_device_codes SET last_poll_at = $2, interval_s = $3 WHERE device_hash = $1",
        [hash, now, entry.interval + (tooSoon ? slowDownBy : 0)],
      );
      return { entry, tooSoon };
    });
  }

  /**
   * Takes an approved device code for the grant it gives: deletes it, and records the grant (a CLI
   * sign-in of the user who approved it) with its first refresh token, in one transaction, so a
   * device code is redeemed once; with the login it was approved under. Undefined when it is not
   * there, or not approved.
   */
  async redeemDeviceCode(
    hash: string,
    grant: { readonly id: string; readonly createdAt: string },
    refresh: RefreshEntry,
  ): Promise<{ readonly grant: Grant; readonly login: string } | undefined> {
    return this.#db.write(async (tx) => {
      const r = await tx.query<DeviceRow>(
        `DELETE FROM oauth_device_codes WHERE device_hash = $1 AND state = 'approved'
           RETURNING ${DEVICE_COLUMNS}`,
        [hash],
      );
      const row = r.rows[0];
      if (row === undefined) return undefined;
      const d = deviceEntry(row);
      if (d.user === undefined || d.login === undefined || d.tenant === undefined) {
        throw new Error("oauth_device_codes: an approved code without its user");
      }
      const g: Grant = {
        id: grant.id,
        kind: "session",
        principal: d.user,
        tenant: d.tenant,
        clientId: d.clientId,
        resource: d.resource,
        createdAt: grant.createdAt,
      };
      await tx.query(
        `INSERT INTO oauth_grants (id, kind, principal, tenant, client_id, resource, created_at)
           VALUES ($1, 'session', $2, $3, $4, $5, $6)`,
        [g.id, d.user, d.tenant, g.clientId, g.resource, g.createdAt],
      );
      await insertRefresh(tx, refresh);
      return { grant: g, login: d.login };
    });
  }

  async putCode(hash: string, c: CodeEntry): Promise<void> {
    await inserting("a code of that hash", () =>
      this.#db.write((tx) =>
        tx.query(
          `INSERT INTO oauth_codes (hash, client_id, redirect_uri, code_challenge, resource, user_id,
               login, tenant, requested_scopes, scopes, name, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            hash,
            c.clientId,
            c.redirectUri,
            c.codeChallenge,
            c.resource,
            c.user,
            c.login,
            c.tenant,
            c.requestedScopes === undefined ? null : scopesText(c.requestedScopes),
            scopesText(c.scopes),
            c.name ?? null,
            c.expiresAt,
          ],
        ),
      ),
    );
  }

  /**
   * Takes a code for its grant, in one transaction: deletes the code, gives what it stood for to
   * `decide`, and records the grant `decide` returns. A code is taken once, and a code taken is
   * always found with its grant, so a replay can void what the first redemption gave. When `decide`
   * throws (the redemption is refused), the code is still deleted and no grant recorded; the error
   * comes out after the commit. A code taken again, or never issued, gives nothing.
   */
  async takeCodeForGrant(
    hash: string,
    decide: (c: CodeEntry) => Grant,
    /** The grant's first refresh token, recorded with it when given (a CLI sign-in's). */
    refreshOf?: (g: Grant) => RefreshEntry | undefined,
  ): Promise<{ readonly code: CodeEntry; readonly grant: Grant } | undefined> {
    let refused: { readonly error: unknown } | undefined;
    const taken = await inserting("a grant of that ID", () =>
      this.#db.write(async (tx) => {
        const r = await tx.query<{
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          resource: string;
          user_id: string;
          login: string;
          tenant: string;
          requested_scopes: string | null;
          scopes: string;
          name: string | null;
          expires_at: string;
        }>(
          `DELETE FROM oauth_codes WHERE hash = $1
             RETURNING client_id, redirect_uri, code_challenge, resource, user_id, login, tenant,
               requested_scopes, scopes, name, expires_at`,
          [hash],
        );
        const row = r.rows[0];
        if (row === undefined) return undefined;
        const code: CodeEntry = {
          clientId: row.client_id,
          redirectUri: row.redirect_uri,
          codeChallenge: row.code_challenge,
          resource: row.resource,
          user: row.user_id as UserId,
          login: row.login,
          tenant: row.tenant as TenantId,
          ...(row.requested_scopes === null
            ? {}
            : { requestedScopes: scopesOf(row.requested_scopes) }),
          scopes: scopesOf(row.scopes),
          ...(row.name === null ? {} : { name: row.name }),
          expiresAt: row.expires_at,
        };
        let grant: Grant;
        try {
          grant = decide(code);
        } catch (error) {
          refused = { error };
          return undefined;
        }
        await insertGrant(tx, { ...grant, codeHash: hash });
        const refresh = refreshOf?.(grant);
        if (refresh !== undefined) await insertRefresh(tx, refresh);
        return { code, grant: { ...grant, codeHash: hash } };
      }),
    );
    if (refused !== undefined) throw refused.error;
    return taken;
  }

  /** Records a one-time form token's hash, bound to what the page was shown for (its user). */
  async putForm(hash: string, boundTo: string, expiresAt: string): Promise<void> {
    await inserting("a form token of that hash", () =>
      this.#db.write((tx) =>
        tx.query("INSERT INTO web_forms (hash, bound_to, expires_at) VALUES ($1, $2, $3)", [
          hash,
          boundTo,
          expiresAt,
        ]),
      ),
    );
  }

  /**
   * Uses a form token: deletes it, and tells whether it was there, unexpired at `now` and bound to
   * `boundTo`. A token is used up by any attempt, matching or not.
   */
  async useForm(hash: string, boundTo: string, now: string): Promise<boolean> {
    const r = await this.#db.write((tx) =>
      tx.query<{ bound_to: string; expires_at: string }>(
        "DELETE FROM web_forms WHERE hash = $1 RETURNING bound_to, expires_at",
        [hash],
      ),
    );
    const row = r.rows[0];
    return row !== undefined && row.bound_to === boundTo && row.expires_at > now;
  }

  /**
   * Deletes expired codes, form tokens, client documents and refresh tokens; how many rows went.
   * A used refresh token goes when it would have expired unused: presented after that, it is
   * refused as unknown, no longer as a replay.
   */
  async sweep(now: string): Promise<number> {
    return this.#db.write(async (tx) => {
      let n = 0;
      for (const table of [
        "oauth_codes",
        "web_forms",
        "oauth_clients",
        "oauth_refresh_tokens",
        "oauth_device_codes",
      ]) {
        const r = await tx.query<{ n: number }>(
          `WITH gone AS (DELETE FROM ${table} WHERE expires_at <= $1 RETURNING 1)
             SELECT count(*)::int AS n FROM gone`,
          [now],
        );
        n += Number(r.rows[0]?.n ?? 0);
      }
      return n;
    });
  }
}
