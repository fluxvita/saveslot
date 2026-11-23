// The authorization server's steps that are not HTTP (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»;
// 04-contract.md §12): finding a client by its ID, issuing a code once the user has consented on
// the authorization page, and redeeming the code at the token endpoint.
//
// One authorization is one connection instance, registered when its code is redeemed — not when
// the user consents: a code never redeemed leaves nothing in the log and holds no name. The CLI's
// authorization signs its user in instead (a user session). Either way the access token is a
// credential of the control plane with an expiry and its grant; the scopes and the slot range stay
// the tenant log's (§12), so a revocation holds from the next request on. A user session is issued
// by the identity provider, from the login the consent was given under: a login that has ended
// since (a sign-out, a password change, its expiry) issues none.
// A redemption also gives the grant's first refresh token (exchanging it is oauth-refresh.ts).
//
// The pages, the cookies and the HTTP shapes are the server package's (oauth routes).

import { randomBytes } from "node:crypto";
import {
  createOpsContext,
  type OpsContext,
  OpsError,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { SCOPES, type Scope } from "./auth.ts";
import type {
  ConnectionId,
  ControlPlane,
  CredentialEntry,
  TenantId,
  UserId,
} from "./control-plane.ts";
import { type IdentityProvider, UserSessionError } from "./identity.ts";
import { audienceOf, pkceMatches } from "./oauth-authorize.ts";
import {
  CLI_CLIENT,
  CLI_CLIENT_ID,
  ClientError,
  type ClientFetcher,
  CONTROL,
  clientCacheSeconds,
  clientFromDocument,
  clientIdUrl,
  type OAuthClient,
} from "./oauth-client.ts";
import { type ClientFetchLimits, PROCESS_CLIENT_FETCHES } from "./oauth-client-limits.ts";
import type { Grant, OAuthStore, RefreshEntry } from "./oauth-store.ts";
import { issueServerConnection, revokeServerConnection } from "./server-connections.ts";
import type { OpenTenant } from "./tenant-pool.ts";
import { tokenHash } from "./tokens.ts";

/** How long a code may wait for its redemption. */
export const CODE_SECONDS = 60;
/** How long an access token works. */
export const ACCESS_TOKEN_SECONDS = 60 * 60;
/** How long a refresh token works unused. */
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
/** How long a CLI sign-in lasts at most, refreshed or not; a connection's grant has no limit. */
export const CLI_SIGN_IN_SECONDS = 90 * 24 * 60 * 60;
/** The scopes offered when a request asks for none (contract §12's default). */
export const DEFAULT_SCOPES: readonly Scope[] = ["saveslot.read", "saveslot.write"];

const NAME_MAX = 100;

/** What the authorization server needs from its host. */
export interface OAuthDeps {
  readonly store: OAuthStore;
  readonly control: ControlPlane;
  readonly pool: { use<T>(tenant: TenantId, fn: (t: OpenTenant) => Promise<T>): Promise<T> };
  readonly fetchClient: ClientFetcher;
  /** Issues the CLI's user sessions, from the login a code was consented under. */
  readonly identity: Pick<IdentityProvider, "issueUserSession">;
  /** The external address (configuration): the issuer and the tokens' audience. */
  readonly external: string;
  readonly windows: { readonly requestKey: number; readonly idempotencyKey: number };
  /** The bounds on fetching client documents; the process's own when not given. */
  readonly clientFetches?: ClientFetchLimits;
}

export const after = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString();

/** A refresh token's form: `slr_` and 43 base64url characters. */
export const REFRESH_TOKEN = /^slr_[A-Za-z0-9_-]{43}$/;

/**
 * A new refresh token of a grant, issued at `now`, and its entry (its hash). `grantExpiresAt` is a
 * CLI sign-in's limit, carried from token to token.
 */
export function newRefreshToken(
  grant: string,
  now: string,
  grantExpiresAt: string | undefined,
): { readonly token: string; readonly entry: RefreshEntry } {
  const token = `slr_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    entry: {
      hash: tokenHash(token),
      grant,
      issuedAt: now,
      expiresAt: after(now, REFRESH_TOKEN_SECONDS),
      ...(grantExpiresAt === undefined ? {} : { grantExpiresAt }),
    },
  };
}

/**
 * The client of a client ID: the CLI's, or a client document's, from the cache while it is fresh,
 * else fetched, checked and cached. A document that fails its checks is not cached; one that the
 * full cache has no room for is used for this request only. A fetch is bounded (`ClientFetchLimits`):
 * per `source`, the request's source address, and in how many run at once. Throws a `ClientError`.
 */
export async function resolveClient(
  deps: Pick<OAuthDeps, "store" | "fetchClient" | "clientFetches">,
  clientId: string,
  now: string,
  source: string,
): Promise<OAuthClient> {
  if (clientId === CLI_CLIENT_ID) return CLI_CLIENT;
  const url = clientIdUrl(clientId);
  const cached = await deps.store.cachedClient(clientId);
  if (cached !== undefined && cached.expiresAt > now) {
    try {
      return clientFromDocument(clientId, cached.document);
    } catch {
      // A cached document that no longer passes (the rules changed): fetched again below.
    }
  }
  const limits = deps.clientFetches ?? PROCESS_CLIENT_FETCHES;
  const place = limits.take(source, Date.parse(now));
  if (place === "busy") throw new ClientError("fetch_busy", "client: too many fetches under way");
  if (place === "limited") {
    throw new ClientError("fetch_limited", "client: too many fetches from this source");
  }
  let fetched: Awaited<ReturnType<ClientFetcher>>;
  try {
    fetched = await deps.fetchClient(url);
  } finally {
    limits.done();
  }
  const client = clientFromDocument(clientId, fetched.body);
  await deps.store.cacheClient(
    clientId,
    fetched.body,
    now,
    after(now, clientCacheSeconds(fetched.cacheControl)),
    limits.bounds.cachedRows,
  );
  return client;
}

/** Whether a connection instance of the tenant already has this name (code point equality). */
export async function connectionNameTaken(store: TenantStore, name: string): Promise<boolean> {
  const r = await store.read((tx) =>
    tx.query("SELECT 1 FROM principals WHERE kind = 'connection' AND name = $1", [name]),
  );
  return r.rows.length > 0;
}

/** A name the page may take for a connection instance: 1–100 characters, no control characters. */
export function connectionNameOk(name: string): boolean {
  return name.trim() === name && name.length > 0 && name.length <= NAME_MAX && !CONTROL.test(name);
}

/**
 * The scopes a consent may give: `saveslot.read` among them, and nothing beyond what the request
 * asked for (none asked: the default). Undefined when they are not.
 */
export function consentScopes(
  ticked: readonly string[],
  requested: readonly Scope[] | undefined,
): Scope[] | undefined {
  const offered = requested ?? DEFAULT_SCOPES;
  if (!ticked.includes("saveslot.read")) return undefined;
  if (ticked.some((s) => !(offered as readonly string[]).includes(s))) return undefined;
  return SCOPES.filter((s) => ticked.includes(s));
}

/** Issues a code for a consent the page has checked; gives the code, shown this once. */
export async function issueCode(
  deps: Pick<OAuthDeps, "store">,
  o: {
    readonly client: OAuthClient;
    readonly redirectUri: string;
    readonly codeChallenge: string;
    readonly resource: string;
    readonly user: UserId;
    /** The login the consent was given under (`currentUser`'s `session`). */
    readonly login: string;
    readonly tenant: TenantId;
    readonly requestedScopes?: readonly Scope[];
    /** For a connection: the scopes ticked (checked by `consentScopes`) and the name. */
    readonly scopes: readonly Scope[];
    readonly name?: string;
    readonly now: string;
  },
): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await deps.store.putCode(tokenHash(code), {
    clientId: o.client.id,
    redirectUri: o.redirectUri,
    codeChallenge: o.codeChallenge,
    resource: o.resource,
    user: o.user,
    login: o.login,
    tenant: o.tenant,
    ...(o.requestedScopes === undefined ? {} : { requestedScopes: o.requestedScopes }),
    scopes: o.scopes,
    ...(o.name === undefined ? {} : { name: o.name }),
    expiresAt: after(o.now, CODE_SECONDS),
  });
  return code;
}

/** A form's parameter given at most once (RFC 6749 §3.1); undefined when it is not given. */
export function singleParam(form: URLSearchParams, name: string): string | undefined {
  const all = form.getAll(name);
  if (all.length > 1) throw new TokenError("invalid_request", `${name} given more than once`);
  return all[0];
}

/** The token endpoint's errors (RFC 6749 §5.2; a device code's poll, RFC 8628 §3.5). */
export type TokenErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unsupported_grant_type"
  | "invalid_target"
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token";

export class TokenError extends Error {
  override readonly name = "TokenError";
  readonly code: TokenErrorCode;
  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A successful token response (RFC 6749 §5.1); no slot list (05 §15). */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
  readonly refresh_token: string;
}

/** Tests: points of a redemption to run something else at, or to stop at. */
export interface RedeemHooks {
  /** After the code is taken and its grant recorded, before any credential is written. */
  readonly beforeCredential?: () => Promise<void>;
  /**
   * After the access token's credential is written: before the connection is registered, or before
   * a user session's grant is looked at again.
   */
  readonly afterCredential?: () => Promise<void>;
  /** issueServerConnection's: between recording the hash and the registration. */
  readonly beforeRegistering?: (id: ConnectionId) => void;
}

/**
 * The control plane as a redemption hands it to `issueServerConnection`:
 * the same, except that a credential is written only for `grant`, and only while the grant is not
 * voided (`OAuthStore.putGrantCredential`, one statement); voided, the write is refused with
 * `invalid_grant`. A replayed code voids its grant whenever it comes; without this, a credential
 * written after the voiding would work. It wraps the control plane rather than changing those two
 * functions, which the local mode and `connections.issue` share.
 */
export function grantGuardedControl(
  control: ControlPlane,
  store: OAuthStore,
  grant: string,
  afterCredential?: () => Promise<void>,
): ControlPlane {
  return {
    anchors: control.anchors,
    tenant: (id) => control.tenant(id),
    tenantOf: (owner) => control.tenantOf(owner),
    credential: (hash) => control.credential(hash),
    removeCredentials: (tenant, principals, opts) =>
      control.removeCredentials(tenant, principals, opts),
    putCredential: async (e: CredentialEntry) => {
      if (e.grant !== grant) throw new Error("a redemption writes credentials of its grant only");
      if (!(await store.putGrantCredential({ ...e, grant }))) {
        throw new TokenError("invalid_grant", "the code was used twice: its grant is void");
      }
      await afterCredential?.();
    },
  };
}

/**
 * Redeems a code (`grant_type=authorization_code`). The code is taken and its grant recorded in
 * one transaction, after the checks — not expired, the same client and redirect URI, the verifier
 * matching its challenge, the resource if given the code's, and for a connection the stored scopes
 * still holding `saveslot.read` and within the request's; a refused code is still used up. A code
 * presented a second time voids the grant its first redemption recorded: its credentials go, and a
 * credential or a principal recorded after that is refused (`grantGuardedControl`,
 * `setGrantPrincipal`), or for a user session deleted once written. Then the CLI's user is signed
 * in from the login the code was consented under (ended: `invalid_grant`), or the connection
 * instance issued; the grant's first refresh token is recorded with the grant (the CLI's) or with
 * its connection.
 */
export async function redeemCode(
  deps: OAuthDeps,
  form: URLSearchParams,
  now: string,
  hooks: RedeemHooks = {},
): Promise<TokenResponse> {
  const one = (name: string) => singleParam(form, name);
  const code = one("code");
  const verifier = one("code_verifier");
  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  const resource = one("resource");
  if (code === undefined || verifier === undefined || clientId === undefined) {
    throw new TokenError("invalid_request", "code, code_verifier and client_id are required");
  }
  if (redirectUri === undefined)
    throw new TokenError("invalid_request", "redirect_uri is required");
  const hash = tokenHash(code);
  const id = randomBytes(16).toString("hex");
  let scopes: Scope[] = [];
  // A CLI sign-in's first refresh token is recorded with its grant; a connection's, with its
  // connection.
  const cliRefresh = newRefreshToken(id, now, after(now, CLI_SIGN_IN_SECONDS));
  const taken = await deps.store.takeCodeForGrant(
    hash,
    (c): Grant => {
      if (c.expiresAt <= now) throw new TokenError("invalid_grant", "the code has expired");
      if (c.clientId !== clientId || c.redirectUri !== redirectUri) {
        throw new TokenError(
          "invalid_grant",
          "the code was issued to another client or redirect URI",
        );
      }
      if (!pkceMatches(verifier, c.codeChallenge)) {
        throw new TokenError("invalid_grant", "the code verifier does not match");
      }
      if (resource !== undefined && audienceOf(resource, deps.external) !== c.resource) {
        throw new TokenError("invalid_target", "the resource is not the code's");
      }
      if (c.resource !== deps.external) {
        throw new TokenError("invalid_grant", "the code was issued for another address");
      }
      const cli = c.clientId === CLI_CLIENT_ID;
      if (!cli) {
        const given = consentScopes(c.scopes, c.requestedScopes);
        if (given === undefined || c.name === undefined) {
          throw new TokenError(
            "invalid_grant",
            "the code's consent is not one the page could give",
          );
        }
        scopes = given;
      }
      return {
        id,
        kind: cli ? "session" : "connection",
        // A connection's principal is recorded once it is issued.
        ...(cli ? { principal: c.user } : {}),
        tenant: c.tenant,
        clientId: c.clientId,
        resource: c.resource,
        createdAt: now,
      };
    },
    (g) => (g.kind === "session" ? cliRefresh.entry : undefined),
  );
  if (taken === undefined) {
    // Taken before: whatever its first redemption gave stops working (OAuth 2.1 §4.1.3).
    const g = await deps.store.grantOfCode(hash);
    if (g !== undefined) await deps.store.voidGrant(g.id, now);
    throw new TokenError("invalid_grant", "the code is not valid");
  }
  const c = taken.code;
  await hooks.beforeCredential?.();
  const control = grantGuardedControl(deps.control, deps.store, id, hooks.afterCredential);
  const expiresAt = after(now, ACCESS_TOKEN_SECONDS);

  if (taken.grant.kind === "session") {
    let token: string;
    try {
      token = await deps.identity.issueUserSession(c.user, {
        from: { login: c.login },
        grant: id,
        expiresAt,
        now,
      });
    } catch (e) {
      if (!(e instanceof UserSessionError)) throw e;
      await deps.store.voidGrant(id, now);
      throw new TokenError("invalid_grant", "the login the code was consented under has ended");
    }
    await hooks.afterCredential?.();
    // The provider writes the session itself, not through `grantGuardedControl`: a replay that
    // voided the grant before it was written deleted nothing. Voiding again deletes it.
    if ((await deps.store.grant(id))?.voidedAt !== undefined) {
      await deps.store.voidGrant(id, now);
      throw new TokenError("invalid_grant", "the code was used twice: its grant is void");
    }
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      scope: SCOPES.join(" "),
      refresh_token: cliRefresh.token,
    };
  }

  const ctx = createOpsContext({
    tenant: c.tenant,
    actor: c.user,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: deps.windows.requestKey,
    idempotency_key_window: deps.windows.idempotencyKey,
    now,
    confirmation: null,
  });
  return deps.pool.use(c.tenant, async (t) => {
    let issued: Awaited<ReturnType<typeof issueServerConnection>>;
    try {
      issued = await issueServerConnection({
        control,
        tenant: c.tenant,
        store: t.store,
        ctx,
        params: { name: c.name as string, scopes },
        via: "oauth",
        client: c.clientId,
        grant: id,
        expiresAt,
        ...(hooks.beforeRegistering === undefined
          ? {}
          : { beforeRegistering: hooks.beforeRegistering }),
      });
    } catch (e) {
      // The name taken between the page and the redemption.
      if (e instanceof OpsError && e.code === "invalid_argument") {
        await deps.store.voidGrant(id, now);
        throw new TokenError("invalid_grant", "the connection could not be registered");
      }
      throw e;
    }
    const { connection, token } = issued;
    // Registered: the grant must now name it. Voided meanwhile (a replay), or not recorded, the
    // connection holds no token anyone can use: revoked by the user who authorized it, the grant
    // voided, so that its name is not left taken by nothing; the revocation's clean-up drops its
    // refresh tokens.
    const refresh = newRefreshToken(id, now, undefined);
    let named: boolean;
    try {
      named = await deps.store.setGrantPrincipal(id, connection.id, refresh.entry);
    } catch (e) {
      await undo(deps, t.store, ctx, c.tenant, connection.id, id, now);
      throw e;
    }
    if (!named) {
      await undo(deps, t.store, ctx, c.tenant, connection.id, id, now);
      throw new TokenError("invalid_grant", "the code was used twice: its grant is void");
    }
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      scope: connection.scopes.join(" "),
      refresh_token: refresh.token,
    };
  });
}

/** Revokes a connection a redemption registered but cannot hand over, and voids its grant. */
async function undo(
  deps: OAuthDeps,
  store: TenantStore,
  ctx: OpsContext,
  tenant: TenantId,
  connection: ConnectionId,
  grant: string,
  now: string,
): Promise<void> {
  await revokeServerConnection({
    control: deps.control,
    oauth: deps.store,
    tenant,
    store,
    ctx,
    id: connection,
  });
  await deps.store.voidGrant(grant, now);
}
