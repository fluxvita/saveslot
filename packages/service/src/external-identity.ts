// The external login: the hosted service's identity provider (docs/zh-CN/spec/02-architecture.md
// §5, §12). People sign in on the platform; the server takes the platform's signed identity
// assertions (external-assertion.ts) and keeps its own short login state.
//
// - `beginLogin` keeps a random state (its hash, the path to return to, ten minutes), binds it to
//   the browser with a `__Host-` cookie holding another random secret (its hash kept with the
//   state: the state itself is in the platform's addresses, the secret only in this browser), and
//   sends the browser to the configured login address with the state and nothing else: the
//   platform returns to the address it is configured with.
// - `/oauth/identity/callback` takes the state back with an assertion of purpose `authorize` whose
//   `nonce` is that state; the state must be unexpired and this browser's (its cookie's secret
//   matching), and is used once, taken whether or not the secret matched. The login
//   it makes lasts ten minutes, enough for one consent: each authorization goes by the platform
//   again. Its answers send a referrer only to this service and are not cached.
// - `acceptAssertion` takes an assertion of purpose `session`, for the console's user session.
// - An assertion's `jti` is used once: kept in the control database until its `exp`, so a restart
//   still refuses it again. It is recorded only after every other check passed.
// - Rows past their expiry are deleted by the next write to their table, by an index on
//   `expires_at`; the states anyone can make are bounded by the proxy's limit on `/oauth/`.
// - (issuer, account) → user is the table `external_users`, with the account's state. An account
//   first seen gets a new user and, through `createServerTenant`, its tenant; two of its assertions
//   at once meet at that table's key and get the same user. New users are counted per source (an
//   IPv6 one by its /64, and by its /48 too): at most `NEW_USERS_PER_SOURCE` an hour per source and
//   `NEW_USERS_PER_WIDE_SOURCE` per /48, in this process, each counted before it is made; a count
//   table full of live counts refuses a new source.
// - A user session is issued from a login while it lasts, from an assertion just taken, or from a
//   refresh, for an account still active: the account's row in `external_users` locked, then the
//   login's, the order a disable keeps too. A disabled account is `account_inactive` (enabled
//   again, it is issued as before); nothing but a disable stops its refreshes.
// - Every failure answers alike: what failed is not said.

import { createHash, type JsonWebKey, randomBytes, timingSafeEqual } from "node:crypto";
import { type ReadTx, randomCrockford, type StorageBackend } from "@fluxvita/saveslot-kernel";
import type { UserId } from "./control-plane.ts";
import { Counts } from "./expiring.ts";
import {
  type Assertion,
  type AssertionKeys,
  assertionKeys,
  verifyAssertion,
} from "./external-assertion.ts";
import {
  type CurrentUser,
  type IdentityProvider,
  type IdentityRequest,
  type IdentityResponse,
  PAGE_HEADERS,
  type SetCookie,
  safeReturnTo,
  sourceKey,
  UserSessionError,
  wideSourceKey,
  writeUserSession,
} from "./identity.ts";
import { type ControlDb, isInstant, type ServerControlPlane } from "./server-control-plane.ts";
import { createServerTenant, ServerTenantError } from "./server-tenant.ts";

/** `control_meta.external_format`: the external login's tables. */
export const EXTERNAL_FORMAT = 1;

/** The advisory lock the external login's initializations take turns on. */
const INIT_LOCK = 0x5ab0e7a1;

/** How long a state, and a login made from it, last. */
export const STATE_MS = 10 * 60_000;
export const LOGIN_MS = 10 * 60_000;
/** New users a source may bring in an hour (an initial value). */
export const NEW_USERS_PER_SOURCE = 5;
/** New users one IPv6 /48 may bring in an hour, whatever its /64s (an initial value). */
export const NEW_USERS_PER_WIDE_SOURCE = 20;
const NEW_USERS_WINDOW_MS = 60 * 60_000;

/** The path the platform sends a browser back to. */
export const CALLBACK_PATH = "/oauth/identity/callback";
const STATE_COOKIE = "saveslot_identity_state";
const LOGIN_COOKIE = "saveslot_identity_login";

const DDL = `
CREATE TABLE external_users (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('active', 'disabled')),
  PRIMARY KEY (issuer, subject)
);
CREATE TABLE external_logins (
  id text PRIMARY KEY,
  cookie_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES external_users (user_id),
  sid text,
  name text,
  expires_at text NOT NULL
);
CREATE TABLE external_states (
  state_hash text PRIMARY KEY,
  secret_hash text NOT NULL,
  return_to text NOT NULL,
  expires_at text NOT NULL
);
CREATE TABLE external_jti (
  issuer text NOT NULL,
  jti text NOT NULL,
  expires_at text NOT NULL,
  PRIMARY KEY (issuer, jti)
);
CREATE INDEX external_logins_expires_at ON external_logins (expires_at);
CREATE INDEX external_states_expires_at ON external_states (expires_at);
CREATE INDEX external_jti_expires_at ON external_jti (expires_at);`;

/** Why an external login operation was refused. Stable codes; messages carry no secrets. */
export type ExternalLoginErrorCode =
  | "external_format_mismatch"
  | "external_not_initialized"
  | "bad_config"
  | "unknown_user";

export class ExternalLoginError extends Error {
  override readonly name = "ExternalLoginError";
  readonly code: ExternalLoginErrorCode;
  constructor(code: ExternalLoginErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The external login's configuration: set, it is the server's identity provider. */
export interface ExternalLoginConfig {
  /** The platform's origin, as its assertions' `iss`. */
  readonly issuer: string;
  /** Where a browser is sent to sign in; the state is added to its query. */
  readonly loginUrl: string;
  /** The platform's public keys: Ed25519, each with its `kid`. */
  readonly keys: readonly JsonWebKey[];
  /** This service's public origin, as the assertions' `aud`. */
  readonly audience: string;
}

/**
 * The external login's tables in a control database. Had only from `initExternalLogin` or
 * `openExternalLogin`, which check their format first.
 */
export class ExternalLogins {
  /** @internal The control database the tables are in. */
  readonly db: ControlDb;

  private constructor(db: ControlDb) {
    this.db = db;
  }

  /** @internal Over a control database whose external login format was checked. */
  static over(db: ControlDb): ExternalLogins {
    return new ExternalLogins(db);
  }
}

async function externalFormat(tx: ReadTx): Promise<string | undefined> {
  const there = await tx.query<{ t: string | null }>(
    "SELECT to_regclass('control_meta')::text AS t",
  );
  if (there.rows[0]?.t == null) {
    throw new ExternalLoginError(
      "external_not_initialized",
      "the control database has no tables: initialize the control plane first",
    );
  }
  const f = await tx.query<{ value: string }>(
    "SELECT value FROM control_meta WHERE key = 'external_format'",
  );
  const format = f.rows[0]?.value;
  if (format !== undefined && format !== String(EXTERNAL_FORMAT)) {
    throw new ExternalLoginError(
      "external_format_mismatch",
      `the external login's format is not ${EXTERNAL_FORMAT}`,
    );
  }
  return format;
}

/**
 * Makes the external login's tables in the control database (made by `initControlPlane`) and
 * records their format; on one that has them, checks the format and does nothing more, so that
 * running it again is safe, and two processes running it at once take turns.
 */
export async function initExternalLogin(db: ControlDb): Promise<ExternalLogins> {
  await db.write(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [INIT_LOCK]);
    if ((await externalFormat(tx)) !== undefined) return;
    await tx.exec(DDL);
    await tx.query("INSERT INTO control_meta (key, value) VALUES ('external_format', $1)", [
      String(EXTERNAL_FORMAT),
    ]);
  });
  return ExternalLogins.over(db);
}

/** The tables `initExternalLogin` made; their format checked first, nothing made. */
export async function openExternalLogin(db: ControlDb): Promise<ExternalLogins> {
  await db.read(async (tx) => {
    if ((await externalFormat(tx)) === undefined) {
      throw new ExternalLoginError("external_not_initialized", "the external login has no tables");
    }
  });
  return ExternalLogins.over(db);
}

const hashOf = (v: string): string => createHash("sha256").update(v).digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();
const random = (): string => randomBytes(32).toString("base64url");
/** Two hashes of `hashOf` the same, compared in constant time. */
const sameHash = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Why an assertion did not make a user: none is told to whoever sent it. */
type ClaimRefusal = "replayed" | "disabled" | "limited";

export class ExternalIdentity implements IdentityProvider {
  readonly paths: ReadonlySet<string> = new Set([CALLBACK_PATH]);
  readonly #db: ControlDb;
  readonly #config: ExternalLoginConfig;
  readonly #keys: AssertionKeys;
  readonly #now: () => number;
  readonly #secure: boolean;
  readonly #stateCookie: string;
  readonly #loginCookie: string;
  readonly #newUsers: Counts;
  readonly #newUsersWide: Counts;
  readonly #makeTenant: (owner: UserId, now: string) => Promise<unknown>;

  constructor(o: {
    readonly logins: ExternalLogins;
    readonly config: ExternalLoginConfig;
    readonly control: ServerControlPlane;
    readonly backend: StorageBackend;
    /** The cell new users' tenants are made in; one of `cells`, or the provider is refused. */
    readonly cell: string;
    /** The cells this deployment has. */
    readonly cells: ReadonlySet<string>;
    readonly now?: () => number;
    /** Tests only: how many sources the count of new users holds at most. */
    readonly countCapForTests?: number;
    /** Tests only: makes a user's tenant in place of `createServerTenant`. */
    readonly makeTenantForTests?: (owner: UserId, now: string) => Promise<unknown>;
  }) {
    if (!o.cells.has(o.cell)) {
      throw new ServerTenantError("unknown_cell", `the deployment has no cell named ${o.cell}`);
    }
    this.#db = o.logins.db;
    this.#newUsers = new Counts(NEW_USERS_WINDOW_MS, o.countCapForTests);
    this.#newUsersWide = new Counts(NEW_USERS_WINDOW_MS, o.countCapForTests);
    this.#config = o.config;
    this.#keys = assertionKeys(o.config.keys);
    this.#now = o.now ?? Date.now;
    this.#secure = o.config.audience.startsWith("https://");
    this.#stateCookie = this.#secure ? `__Host-${STATE_COOKIE}` : STATE_COOKIE;
    this.#loginCookie = this.#secure ? `__Host-${LOGIN_COOKIE}` : LOGIN_COOKIE;
    this.#makeTenant =
      o.makeTenantForTests ??
      ((owner, now) =>
        createServerTenant({
          control: o.control,
          backend: o.backend,
          owner,
          cell: o.cell,
          cells: o.cells,
          now,
        }));
  }

  async currentUser(req: IdentityRequest): Promise<CurrentUser | undefined> {
    const cookie = req.cookies.get(this.#loginCookie);
    if (cookie === undefined) return undefined;
    const r = await this.#db.read((tx) =>
      tx.query<{
        id: string;
        user_id: string;
        name: string | null;
        subject: string;
        expires_at: string;
      }>(
        `SELECT l.id, l.user_id, l.name, u.subject, l.expires_at FROM external_logins l
           JOIN external_users u ON u.user_id = l.user_id
           WHERE l.cookie_hash = $1 AND l.expires_at > $2 AND u.state = 'active'`,
        [hashOf(cookie), iso(this.#now())],
      ),
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    return {
      user: row.user_id as UserId,
      session: row.id,
      name: row.name ?? row.subject,
      expiresAt: row.expires_at,
    };
  }

  async beginLogin(_req: IdentityRequest, returnTo: string): Promise<IdentityResponse> {
    const to = safeReturnTo(returnTo);
    if (to === undefined) return this.#failed(400);
    const state = random();
    const secret = random();
    const now = this.#now();
    await this.#db.write(async (tx) => {
      await tx.query("DELETE FROM external_states WHERE expires_at <= $1", [iso(now)]);
      await tx.query(
        `INSERT INTO external_states (state_hash, secret_hash, return_to, expires_at)
           VALUES ($1, $2, $3, $4)`,
        [hashOf(state), hashOf(secret), to, iso(now + STATE_MS)],
      );
    });
    const url = new URL(this.#config.loginUrl);
    url.searchParams.set("state", state);
    return {
      kind: "redirect",
      location: url.toString(),
      headers: [["cache-control", "no-store"]],
      cookies: [this.#cookie(this.#stateCookie, secret, STATE_MS)],
    };
  }

  async handle(req: IdentityRequest): Promise<IdentityResponse | undefined> {
    if (req.path !== CALLBACK_PATH) return undefined;
    if (req.method !== "GET") return this.#failed(405);
    return this.#callback(req);
  }

  /**
   * The account's state as this server keeps it: one row of `external_users` in the control
   * database, no call to the platform. Nothing is synced from the platform; the state changes only
   * through `disableExternalUser` / `enableExternalUser`. A user the table does not have is
   * `unknown` (authentication refuses it as invalid); a read that fails throws, and authentication
   * with it.
   */
  async userState(user: UserId): Promise<"active" | "disabled" | "unknown"> {
    const r = await this.#db.read((tx) =>
      tx.query<{ state: "active" | "disabled" }>(
        "SELECT state FROM external_users WHERE user_id = $1",
        [user],
      ),
    );
    return r.rows[0]?.state ?? "unknown";
  }

  /**
   * A user session from a login (`currentUser`'s `session`), or from an assertion `acceptAssertion`
   * has just taken: the account's row locked, then the login's; none for an account not active or
   * from a login that has expired.
   */
  async issueUserSession(
    user: UserId,
    o: Parameters<IdentityProvider["issueUserSession"]>[1],
  ): Promise<string> {
    if (!isInstant(o.now)) throw new Error("the time is an instant as toISOString writes it");
    const from = o.from;
    if ("refresh" in from && !isInstant(from.refresh.grantedAt)) {
      throw new Error("a grant's time is an instant as toISOString writes it");
    }
    return this.#db.write(async (tx) => {
      const ended = new UserSessionError("login_ended", "the login has ended");
      const u = await tx.query<{ state: string }>(
        "SELECT state FROM external_users WHERE user_id = $1 FOR SHARE",
        [user],
      );
      const state = u.rows[0]?.state;
      if (state === undefined) throw ended;
      if (state !== "active") {
        throw new UserSessionError("account_inactive", "the account is not active");
      }
      if ("login" in from) {
        const l = await tx.query(
          `SELECT 1 FROM external_logins WHERE id = $1 AND user_id = $2 AND expires_at > $3
             FOR SHARE`,
          [from.login, user, o.now],
        );
        if (l.rows.length === 0) throw ended;
      }
      return writeUserSession(tx, user, {
        expiresAt: o.expiresAt,
        ...(o.grant === undefined ? {} : { grant: o.grant }),
      });
    });
  }

  async acceptAssertion(
    assertion: string,
    remote: string,
  ): Promise<{ user: UserId; session: string } | undefined> {
    const a = verifyAssertion(assertion, this.#verifying("session"));
    if ("refused" in a) return undefined;
    const claimed = await this.#claim(a, remote);
    if (typeof claimed === "string") return undefined;
    return { user: claimed.user, session: random() };
  }

  async #callback(req: IdentityRequest): Promise<IdentityResponse> {
    const state = req.query.get("state");
    const assertion = req.query.get("assertion");
    const secret = req.cookies.get(this.#stateCookie);
    if (state === undefined || assertion === undefined || secret === undefined) {
      return this.#failed(400);
    }
    const now = this.#now();
    // The state is used once, taken whatever its secret and the assertion turn out to be.
    const taken = await this.#db.write((tx) =>
      tx.query<{ secret_hash: string; return_to: string }>(
        `DELETE FROM external_states WHERE state_hash = $1 AND expires_at > $2
           RETURNING secret_hash, return_to`,
        [hashOf(state), iso(now)],
      ),
    );
    const row = taken.rows[0];
    if (row === undefined || !sameHash(hashOf(secret), row.secret_hash)) return this.#failed(400);
    const to = row.return_to;
    const a = verifyAssertion(assertion, { ...this.#verifying("authorize"), nonce: state });
    if ("refused" in a) return this.#failed(400);
    const claimed = await this.#claim(a, req.remote);
    if (claimed === "limited") return this.#failed(429);
    if (typeof claimed === "string") return this.#failed(400);
    const cookie = random();
    await this.#db.write(async (tx) => {
      await tx.query("DELETE FROM external_logins WHERE expires_at <= $1", [iso(now)]);
      await tx.query(
        `INSERT INTO external_logins (id, cookie_hash, user_id, sid, name, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          random(),
          hashOf(cookie),
          claimed.user,
          a.sid ?? null,
          a.name ?? null,
          iso(now + LOGIN_MS),
        ],
      );
    });
    return {
      kind: "redirect",
      location: to,
      headers: this.#callbackHeaders(),
      cookies: [
        this.#cookie(this.#stateCookie, "", 0),
        this.#cookie(this.#loginCookie, cookie, LOGIN_MS),
      ],
    };
  }

  #verifying(purpose: "authorize" | "session") {
    return {
      keys: this.#keys,
      issuer: this.#config.issuer,
      audience: this.#config.audience,
      now: this.#now(),
      purpose,
    } as const;
  }

  /**
   * The user of a verified assertion: its `jti` used up, its account's user found or made with a
   * tenant (counted against the source when made).
   */
  async #claim(a: Assertion, remote: string): Promise<{ user: UserId } | ClaimRefusal> {
    const now = this.#now();
    const issuer = this.#config.issuer;
    const fresh = await this.#db.write(async (tx) => {
      await tx.query("DELETE FROM external_jti WHERE expires_at <= $1", [iso(now)]);
      const r = await tx.query(
        `INSERT INTO external_jti (issuer, jti, expires_at) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING 1`,
        [issuer, a.jti, iso(a.exp * 1000)],
      );
      return r.rows.length === 1;
    });
    if (!fresh) return "replayed";

    let row = await this.#mapping(a.subject);
    if (row === undefined) {
      // Counted before the user is made, so assertions sent at once see each other's; taken back
      // when another assertion of the account made it first. A full table refuses a new source.
      // An IPv6 source's /48 is checked, and counted, before its /64.
      const wide = wideSourceKey(remote);
      const counts: [Counts, string, number][] = [
        ...(wide === undefined
          ? []
          : [[this.#newUsersWide, wide, NEW_USERS_PER_WIDE_SOURCE] as [Counts, string, number]]),
        [this.#newUsers, sourceKey(remote), NEW_USERS_PER_SOURCE],
      ];
      if (counts.some(([c, key, limit]) => c.get(key, now) >= limit)) return "limited";
      const added: [Counts, string][] = [];
      for (const [c, key] of counts) {
        if (!c.add(key, now)) {
          for (const [d, k] of added) d.takeBack(k, now);
          return "limited";
        }
        added.push([c, key]);
      }
      const takeBack = () => {
        for (const [c, key] of added) c.takeBack(key, now);
      };
      let made: boolean;
      try {
        made = await this.#db.write(async (tx) => {
          const r = await tx.query(
            `INSERT INTO external_users (issuer, subject, user_id, state) VALUES ($1, $2, $3, 'active')
               ON CONFLICT DO NOTHING RETURNING 1`,
            [issuer, a.subject, `u_${randomCrockford(26)}`],
          );
          return r.rows.length === 1;
        });
      } catch (e) {
        takeBack();
        throw e;
      }
      if (!made) takeBack();
      row = await this.#mapping(a.subject);
      if (row === undefined) throw new Error("an external user made is not there");
    }
    if (row.state !== "active") return "disabled";
    // Made if it is not there yet: the account's first assertion, or one after a stop half-way.
    await this.#makeTenant(row.user, iso(now));
    return { user: row.user };
  }

  async #mapping(
    subject: string,
  ): Promise<{ user: UserId; state: "active" | "disabled" } | undefined> {
    const r = await this.#db.read((tx) =>
      tx.query<{ user_id: string; state: "active" | "disabled" }>(
        "SELECT user_id, state FROM external_users WHERE issuer = $1 AND subject = $2",
        [this.#config.issuer, subject],
      ),
    );
    const x = r.rows[0];
    return x === undefined ? undefined : { user: x.user_id as UserId, state: x.state };
  }

  #callbackHeaders(): readonly (readonly [string, string])[] {
    // PAGE_HEADERS already sends a referrer only to this service, and keeps the answer out of every
    // cache.
    return PAGE_HEADERS;
  }

  #failed(status: number): IdentityResponse {
    return {
      kind: "page",
      status,
      html: "",
      headers: this.#callbackHeaders(),
      cookies: [this.#cookie(this.#stateCookie, "", 0)],
    };
  }

  #cookie(name: string, value: string, ms: number): SetCookie {
    return { name, value, maxAgeSeconds: Math.floor(ms / 1000), path: "/", secure: this.#secure };
  }
}

/** The users the external login knows, by issuer and account. */
export async function listExternalUsers(logins: ExternalLogins): Promise<
  {
    readonly user: UserId;
    readonly issuer: string;
    readonly subject: string;
    readonly state: "active" | "disabled";
  }[]
> {
  const r = await logins.db.read((tx) =>
    tx.query<{ user_id: string; issuer: string; subject: string; state: "active" | "disabled" }>(
      "SELECT user_id, issuer, subject, state FROM external_users ORDER BY issuer, subject",
    ),
  );
  return r.rows.map((x) => ({
    user: x.user_id as UserId,
    issuer: x.issuer,
    subject: x.subject,
    state: x.state,
  }));
}

/**
 * Disables an account of the platform: only its state changes. While it stays disabled its logins
 * are not taken, its assertions make nothing, and every credential of its tenant is refused at
 * authentication; enabled again, they are as they were.
 */
export async function disableExternalUser(
  logins: ExternalLogins,
  o: { readonly issuer: string; readonly subject: string },
): Promise<void> {
  await setState(logins, o, "disabled");
}

/** Enables a disabled account again; on an active one, nothing. */
export async function enableExternalUser(
  logins: ExternalLogins,
  o: { readonly issuer: string; readonly subject: string },
): Promise<void> {
  await setState(logins, o, "active");
}

async function setState(
  logins: ExternalLogins,
  o: { readonly issuer: string; readonly subject: string },
  state: "active" | "disabled",
): Promise<void> {
  await logins.db.write(async (tx) => {
    const r = await tx.query(
      "UPDATE external_users SET state = $3 WHERE issuer = $1 AND subject = $2 RETURNING 1",
      [o.issuer, o.subject, state],
    );
    if (r.rows.length === 0) throw new ExternalLoginError("unknown_user", "no such account");
  });
}
