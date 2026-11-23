// Refresh tokens and revocation (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»; 02-architecture.md
// §4 `revokeOnRefreshReplay`; 09-event-format.md §5.3): exchanging a refresh token for a new access
// token and a new refresh token (`grant_type=refresh_token`), and the revocation endpoint (RFC 7009).
//
// A refresh token is good once. Exchanged, it is marked used by the one it was exchanged for, in
// the same transaction that records the new one, and only while it is unused: of two exchanges at
// once, one wins. A used token presented again is taken as stolen (a replay): the connection
// instance of its grant is revoked by `system`, then every token of the grant is deleted. The
// revocation is logged first, as `connections.revoke` does: stopped in between, the tokens left
// are refused already (the access token as revoked, the refresh token by the principal's state).
//
// What an exchange gives is the same connection instance, or the same user signed in: a new
// credential of the same principal and grant. A user's is issued by the identity provider, as a
// refresh of a grant made when it was: none for an account whose sessions were ended since (a
// password change), and the grant is voided; none for an account not active now (disabled), the
// grant kept, so that the same refresh token works again once it is enabled.

import { createOpsContext, revokeConnection } from "@fluxvita/saveslot-kernel";
import { principalFromRow, principalRow, SCOPES } from "./auth.ts";
import type { ConnectionId, UserId } from "./control-plane.ts";
import { UserSessionError } from "./identity.ts";
import { audienceOf } from "./oauth-authorize.ts";
import {
  ACCESS_TOKEN_SECONDS,
  after,
  grantGuardedControl,
  newRefreshToken,
  type OAuthDeps,
  REFRESH_TOKEN,
  singleParam,
  TokenError,
  type TokenResponse,
} from "./oauth-server.ts";
import type { Grant } from "./oauth-store.ts";
import { revokeServerConnection } from "./server-connections.ts";
import { newToken, tokenHash } from "./tokens.ts";

/** An access token's form: a user session's or a connection instance's. */
const ACCESS_TOKEN = /^(sls|slt)_[A-Za-z0-9_-]{43}$/;

/** Tests: points of an exchange to stop at, or to run something else at. */
export interface ExchangeHooks {
  /** After the checks, before the new access token is written. */
  readonly beforeAccess?: () => Promise<void>;
  /** After the new access token is recorded, before the refresh token is exchanged. */
  readonly beforeRotating?: () => Promise<void>;
  /** Between a replay's revocation in the log and the voiding of the grant. */
  readonly beforeVoiding?: () => void;
}

const opsContext = (deps: OAuthDeps, g: Grant, actor: string, now: string) =>
  createOpsContext({
    tenant: g.tenant,
    actor,
    trigger: actor === "system" ? "revokeOnRefreshReplay" : null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: deps.windows.requestKey,
    idempotency_key_window: deps.windows.idempotencyKey,
    now,
    confirmation: null,
  });

/**
 * A used refresh token presented again: the grant's connection instance revoked by `system` (no
 * event when it is no longer active), then the grant voided. A CLI sign-in's grant: voided only.
 */
async function replayed(
  deps: OAuthDeps,
  g: Grant,
  now: string,
  hooks: ExchangeHooks,
): Promise<void> {
  if (g.kind === "connection" && g.principal !== undefined) {
    const id = g.principal;
    await deps.pool.use(g.tenant, (t) =>
      revokeConnection(t.store, opsContext(deps, g, "system", now), {
        id: id as ConnectionId,
      }),
    );
  }
  hooks.beforeVoiding?.();
  await deps.store.voidGrant(g.id, now);
}

/**
 * Exchanges a refresh token (`grant_type=refresh_token`): checked in this order — known; not used
 * before (else a replay); unexpired, the CLI's sign-in within its limit, the grant not voided and
 * the same client; the resource, if given, the grant's; the principal still active in the tenant's
 * log. Then a new access token of the same principal and grant — a user's issued by the identity
 * provider, which refuses it (`invalid_grant`) for an account whose sessions were ended since the
 * grant (the grant voided) or that is not active now (the grant kept) — and the refresh token
 * exchanged for a new one. `scope` in
 * the request is not read: the answer gives the scopes the grant has.
 */
export async function exchangeRefreshToken(
  deps: OAuthDeps,
  form: URLSearchParams,
  now: string,
  hooks: ExchangeHooks = {},
): Promise<TokenResponse> {
  const token = singleParam(form, "refresh_token");
  const clientId = singleParam(form, "client_id");
  const resource = singleParam(form, "resource");
  if (token === undefined || clientId === undefined) {
    throw new TokenError("invalid_request", "refresh_token and client_id are required");
  }
  const hash = tokenHash(token);
  const entry = REFRESH_TOKEN.test(token) ? await deps.store.refreshToken(hash) : undefined;
  if (entry === undefined) throw new TokenError("invalid_grant", "the refresh token is not valid");
  const g = await deps.store.grant(entry.grant);
  if (g === undefined) throw new TokenError("invalid_grant", "the refresh token is not valid");
  if (entry.replacedBy !== undefined) {
    await replayed(deps, g, now, hooks);
    throw new TokenError("invalid_grant", "the refresh token was used before");
  }
  if (
    entry.expiresAt <= now ||
    (entry.grantExpiresAt !== undefined && entry.grantExpiresAt <= now)
  ) {
    throw new TokenError("invalid_grant", "the refresh token has expired");
  }
  if (g.voidedAt !== undefined || g.principal === undefined) {
    throw new TokenError("invalid_grant", "the refresh token is not valid");
  }
  if (g.clientId !== clientId) {
    throw new TokenError("invalid_grant", "the refresh token was issued to another client");
  }
  if (resource !== undefined && audienceOf(resource, deps.external) !== g.resource) {
    throw new TokenError("invalid_target", "the resource is not the grant's");
  }
  if (g.resource !== deps.external) {
    throw new TokenError("invalid_grant", "the grant is for another address");
  }

  const principal = g.principal;
  const kind = g.kind === "connection" ? "connection" : "session";
  const row = await deps.pool.use(g.tenant, (t) => principalRow(t.store, principal));
  const p = principalFromRow(kind, principal, row);
  if ("code" in p) {
    throw new TokenError("invalid_grant", "the authorization is no longer active");
  }

  // The access token first: an exchange that loses below leaves it to the voiding, and one that
  // fails leaves it unreturned, with the old refresh token still good. A connection's is written
  // only while the grant is not voided, as at a code's redemption. A user's is written by the
  // provider: a grant voided before that deleted the old refresh token, so the exchange below
  // fails and voids it again, which deletes the new access token.
  await hooks.beforeAccess?.();
  const expiresAt = after(now, ACCESS_TOKEN_SECONDS);
  let access: string;
  if (kind === "session") {
    try {
      access = await deps.identity.issueUserSession(principal as UserId, {
        from: { refresh: { grantedAt: g.createdAt } },
        grant: g.id,
        expiresAt,
        now,
      });
    } catch (e) {
      if (!(e instanceof UserSessionError)) throw e;
      // A disabled account is refused for now only: an enable restores its sign-ins as they were.
      if (e.code === "login_ended") await deps.store.voidGrant(g.id, now);
      throw new TokenError("invalid_grant", "the sign-in has ended, or its account is not active");
    }
  } else {
    const control = grantGuardedControl(deps.control, deps.store, g.id);
    access = newToken("connection");
    await control.putCredential({
      hash: tokenHash(access),
      kind: "connection",
      principal,
      tenant: g.tenant,
      expiresAt,
      grant: g.id,
    });
  }
  await hooks.beforeRotating?.();
  const next = newRefreshToken(g.id, now, entry.grantExpiresAt);
  if (!(await deps.store.rotateRefreshToken(hash, next.entry))) {
    // Exchanged by someone else since it was read: a replay as well.
    await replayed(deps, g, now, hooks);
    throw new TokenError("invalid_grant", "the refresh token was used before");
  }
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    scope: (kind === "session" ? SCOPES : p.scopes).join(" "),
    refresh_token: next.token,
  };
}

/**
 * The revocation endpoint (RFC 7009): `token` and `client_id` are required (else `invalid_request`);
 * anything else ends in nothing done and no error, as for a token unknown or another client's.
 * - A connection instance's refresh token: the connection revokes itself (logged with it as the
 *   actor, then the clean-up of `connections.revoke`); one no longer active is only voided.
 * - A CLI sign-in's refresh token: its grant voided. Nothing in the log.
 * - An access token of a grant: that one deleted. Its principal is not revoked.
 */
export async function revokeToken(
  deps: OAuthDeps,
  form: URLSearchParams,
  now: string,
): Promise<void> {
  const token = singleParam(form, "token");
  const clientId = singleParam(form, "client_id");
  if (token === undefined || clientId === undefined) {
    throw new TokenError("invalid_request", "token and client_id are required");
  }
  const hash = tokenHash(token);
  if (REFRESH_TOKEN.test(token)) {
    const entry = await deps.store.refreshToken(hash);
    const g = entry === undefined ? undefined : await deps.store.grant(entry.grant);
    if (g === undefined || g.clientId !== clientId || g.voidedAt !== undefined) return;
    if (g.kind === "connection" && g.principal !== undefined) {
      const id = g.principal as ConnectionId;
      const revoked = await deps.pool.use(g.tenant, async (t) => {
        const row = await principalRow(t.store, id);
        if (row?.state !== "active") return false;
        await revokeServerConnection({
          control: deps.control,
          oauth: deps.store,
          tenant: g.tenant,
          store: t.store,
          ctx: opsContext(deps, g, id, now),
          id,
        });
        return true;
      });
      if (revoked) return;
    }
    await deps.store.voidGrant(g.id, now);
    return;
  }
  if (!ACCESS_TOKEN.test(token)) return;
  const cred = await deps.control.credential(hash);
  if (cred?.grant === undefined) return;
  const g = await deps.store.grant(cred.grant);
  if (g === undefined || g.clientId !== clientId) return;
  await deps.store.removeAccessToken(hash, g.id);
}
