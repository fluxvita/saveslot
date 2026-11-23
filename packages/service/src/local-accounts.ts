// The built-in local accounts of a self-hosted server (docs/zh-CN/spec/02-architecture.md §9
// «服务器自部署», §12 身份提供者): people's accounts, made by the deployer's `saveslot server user`
// commands, no sign-up. One implementation of the identity provider; the hosted service's comes from
// its own account system, and has none of these tables.
//
// The tables live in the control database, made by `initLocalAccounts` (not by the control plane's
// own init), their format recorded as `control_meta.accounts_format`:
//
//   accounts    id (u_…), name (unique), password_hash, state (active / disabled),
//               sessions_ended_at (when a password change last ended its sessions)
//   web_logins  id (the login's session ID), cookie_hash (the login cookie's SHA-256), user_id,
//               expires_at
//
// Passwords are hashed as local-passwords.ts says. The operations find an account by its name, as
// the deployer's commands give it.

import {
  type ReadTx,
  randomCrockford,
  type StorageBackend,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import type { TenantId, UserId } from "./control-plane.ts";
import {
  dummyHash,
  hashPassword,
  NAME_SHAPE,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from "./local-passwords.ts";
import { type ControlDb, isInstant, type ServerControlPlane } from "./server-control-plane.ts";
import { createServerTenant, ServerTenantError } from "./server-tenant.ts";

/** `control_meta.accounts_format`: the local accounts' tables. */
export const ACCOUNTS_FORMAT = 1;

/** The advisory lock the accounts' initializations take turns on (not the control plane's). */
const INIT_LOCK = 0x5ab0acc7;

const DDL = `
CREATE TABLE accounts (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'disabled')),
  sessions_ended_at text
);
CREATE TABLE web_logins (
  id text PRIMARY KEY,
  cookie_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES accounts (id),
  expires_at text NOT NULL
);
CREATE INDEX web_logins_user ON web_logins (user_id);`;

/** A name an account can have: letters, digits, `.`, `_`, `-`; a letter or digit first; 64 at most. */
export { NAME_SHAPE, PASSWORD_MAX, PASSWORD_MIN } from "./local-passwords.ts";

/** Why a local accounts operation was refused. Stable codes; messages carry no secrets. */
export type LocalAccountsErrorCode =
  | "accounts_format_mismatch"
  | "accounts_not_initialized"
  | "bad_name"
  | "bad_password"
  | "name_taken"
  | "unknown_user";

export class LocalAccountsError extends Error {
  override readonly name = "LocalAccountsError";
  readonly code: LocalAccountsErrorCode;
  constructor(code: LocalAccountsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The local accounts in a control database. Had only from `initLocalAccounts` or
 * `openLocalAccounts`, which check the tables' format first.
 */
export class LocalAccounts {
  /** @internal The control database the accounts are in. */
  readonly db: ControlDb;

  private constructor(db: ControlDb) {
    this.db = db;
  }

  /** @internal Over a control database whose accounts' format was checked. */
  static over(db: ControlDb): LocalAccounts {
    return new LocalAccounts(db);
  }
}

async function accountsFormat(tx: ReadTx): Promise<string | undefined> {
  const there = await tx.query<{ t: string | null }>(
    "SELECT to_regclass('control_meta')::text AS t",
  );
  if (there.rows[0]?.t == null) {
    throw new LocalAccountsError(
      "accounts_not_initialized",
      "the control database has no tables: initialize the control plane first",
    );
  }
  const f = await tx.query<{ value: string }>(
    "SELECT value FROM control_meta WHERE key = 'accounts_format'",
  );
  const format = f.rows[0]?.value;
  if (format !== undefined && format !== String(ACCOUNTS_FORMAT)) {
    throw new LocalAccountsError(
      "accounts_format_mismatch",
      `the local accounts' format is not ${ACCOUNTS_FORMAT}`,
    );
  }
  return format;
}

/**
 * Makes the local accounts' tables in the control database (made by `initControlPlane`) and records
 * their format; on one that has them, checks the format and does nothing more, so that running it
 * again is safe, and two processes running it at once take turns. Gives the accounts.
 */
export async function initLocalAccounts(db: ControlDb): Promise<LocalAccounts> {
  await db.write(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [INIT_LOCK]);
    if ((await accountsFormat(tx)) !== undefined) return;
    await tx.exec(DDL);
    await tx.query("INSERT INTO control_meta (key, value) VALUES ('accounts_format', $1)", [
      String(ACCOUNTS_FORMAT),
    ]);
  });
  return LocalAccounts.over(db);
}

/** The local accounts `initLocalAccounts` made; their format checked first, nothing made. */
export async function openLocalAccounts(db: ControlDb): Promise<LocalAccounts> {
  await db.read(async (tx) => {
    if ((await accountsFormat(tx)) === undefined) {
      throw new LocalAccountsError("accounts_not_initialized", "the local accounts have no tables");
    }
    const t = await tx.query<{ a: string | null; w: string | null }>(
      "SELECT to_regclass('accounts')::text AS a, to_regclass('web_logins')::text AS w",
    );
    if (t.rows[0]?.a == null || t.rows[0]?.w == null) {
      throw new LocalAccountsError(
        "accounts_not_initialized",
        "the local accounts' format is recorded but their tables are not there",
      );
    }
  });
  // Made now rather than at the first name without an account, which would otherwise take longer.
  await dummyHash();
  return LocalAccounts.over(db);
}

function checkName(name: string): void {
  if (!NAME_SHAPE.test(name)) {
    throw new LocalAccountsError("bad_name", "not a name an account can have");
  }
}

function checkPassword(password: string): void {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new LocalAccountsError(
      "bad_password",
      `a password is ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`,
    );
  }
}

/** The names an add is running for in this process: a second add of one of them is refused. */
const adding = new Set<string>();

/**
 * Makes a local account and its tenant (through `createServerTenant`). A name whose account has no
 * active tenant yet (an add stopped before its tenant was made) is finished: its tenant first, and
 * only then its password set to the one given this time, as `setLocalPassword` sets one, its web
 * logins and user sessions ended. A name whose account has an active tenant is taken, as is a name
 * another add in this process is making. A cell that is not one of `cells` is refused before
 * anything is written (`ServerTenantError`, `unknown_cell`).
 */
export async function addLocalUser(
  accounts: LocalAccounts,
  o: {
    readonly control: ServerControlPlane;
    readonly backend: StorageBackend;
    readonly name: string;
    readonly password: string;
    readonly cell: string;
    /** The cells this deployment has. */
    readonly cells: ReadonlySet<string>;
    readonly now: string;
  },
): Promise<{ readonly user: UserId; readonly tenant: TenantId }> {
  checkName(o.name);
  checkPassword(o.password);
  if (!o.cells.has(o.cell)) {
    throw new ServerTenantError("unknown_cell", `the deployment has no cell named ${o.cell}`);
  }
  if (adding.has(o.name)) throw new LocalAccountsError("name_taken", "an account has that name");
  adding.add(o.name);
  try {
    const hash = await hashPassword(o.password);
    const id = `u_${randomCrockford(26)}` as UserId;
    const user = await accounts.db.write(async (tx) => {
      await tx.query(
        `INSERT INTO accounts (id, name, password_hash, state) VALUES ($1, $2, $3, 'active')
           ON CONFLICT (name) DO NOTHING`,
        [id, o.name, hash],
      );
      const r = await tx.query<{ id: string }>("SELECT id FROM accounts WHERE name = $1", [o.name]);
      return r.rows[0]?.id as UserId;
    });
    if (user !== id && (await o.control.tenantOf(user))?.state === "active") {
      throw new LocalAccountsError("name_taken", "an account has that name");
    }
    const tenant = await createServerTenant({
      control: o.control,
      backend: o.backend,
      owner: user,
      cell: o.cell,
      cells: o.cells,
      now: o.now,
    });
    if (user !== id) {
      await accounts.db.write((tx) => replacePassword(tx, user, hash, o.now));
    }
    return { user, tenant: tenant.id };
  } finally {
    adding.delete(o.name);
  }
}

/**
 * A user's password replaced, in the transaction given: its web logins and its user sessions end
 * with it, and so do refreshes of sessions granted until `now`; the connections it issued keep
 * their credentials. The sessions are rows of the control plane's `credentials`, in the same
 * database, removed here so that both go in one transaction.
 */
async function replacePassword(tx: Tx, user: UserId, hash: string, now: string): Promise<void> {
  await tx.query(
    `UPDATE accounts SET password_hash = $2, sessions_ended_at = ${ENDED_AT} WHERE id = $1`,
    [user, hash, now],
  );
  await tx.query("DELETE FROM web_logins WHERE user_id = $1", [user]);
  await tx.query(
    `DELETE FROM credentials
       WHERE kind = 'session' AND principal = $1
         AND tenant IN (SELECT id FROM tenants WHERE owner = $1)`,
    [user],
  );
}

/** The local accounts, by name. */
export async function listLocalUsers(
  accounts: LocalAccounts,
): Promise<
  { readonly user: UserId; readonly name: string; readonly state: "active" | "disabled" }[]
> {
  const r = await accounts.db.read((tx) =>
    tx.query<{ id: string; name: string; state: "active" | "disabled" }>(
      "SELECT id, name, state FROM accounts ORDER BY name",
    ),
  );
  return r.rows.map((x) => ({ user: x.id as UserId, name: x.name, state: x.state }));
}

/**
 * When an account's sessions were last ended, set to `$3`: never moved back, should the clock be.
 * A refresh of a session granted at that instant or before it issues nothing.
 */
const ENDED_AT = "GREATEST(sessions_ended_at, $3)";

function checkNow(now: string): void {
  if (!isInstant(now)) throw new Error("the time is an instant as toISOString writes it");
}

/**
 * Sets an account's password. Its web logins and its user sessions end, in the same transaction,
 * and refreshes of sessions granted until `now` issue nothing; the connections it issued keep
 * authenticating.
 */
export async function setLocalPassword(
  accounts: LocalAccounts,
  o: { readonly name: string; readonly password: string; readonly now: string },
): Promise<void> {
  checkNow(o.now);
  checkPassword(o.password);
  const hash = await hashPassword(o.password);
  await accounts.db.write(async (tx) => {
    const r = await tx.query<{ id: string }>("SELECT id FROM accounts WHERE name = $1", [o.name]);
    const id = r.rows[0]?.id as UserId | undefined;
    if (id === undefined) throw new LocalAccountsError("unknown_user", "no such account");
    await replacePassword(tx, id, hash, o.now);
  });
}

/**
 * Disables an account: only its state changes. While it stays disabled, its web logins are not
 * taken and every credential of its tenant is refused at authentication; nothing is revoked in the
 * tenant's log and nothing is forgotten, so enabling it again restores them as they were.
 */
export async function disableLocalUser(
  accounts: LocalAccounts,
  o: { readonly name: string },
): Promise<void> {
  await setState(accounts, o.name, "disabled");
}

/** Enables a disabled account again; on an active one, nothing. */
export async function enableLocalUser(
  accounts: LocalAccounts,
  o: { readonly name: string },
): Promise<void> {
  await setState(accounts, o.name, "active");
}

async function setState(
  accounts: LocalAccounts,
  name: string,
  state: "active" | "disabled",
): Promise<void> {
  await accounts.db.write(async (tx) => {
    const r = await tx.query("UPDATE accounts SET state = $2 WHERE name = $1 RETURNING id", [
      name,
      state,
    ]);
    if (r.rows.length === 0) throw new LocalAccountsError("unknown_user", "no such account");
  });
}
