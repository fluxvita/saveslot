// The hosted console's session exchange (RFC 7523 §2.1, the `jwt-bearer` grant; docs/zh-CN/spec/
// 05-surfaces.md §15 «远程授权»): the console sends the platform's identity assertion to the token
// endpoint and gets a user session of 15 minutes, with no refresh token: for another, it asks the
// platform for a new assertion and exchanges that.
//
// Taken only when the identity provider takes assertions (`acceptAssertion`, the external login);
// the provider verifies the assertion, and makes the user and its tenant when it first sees the
// account, counted against the request's source. This file checks the form before the provider is
// asked: each parameter at most once, one non-empty `assertion`, and a `client_id`, when given,
// that is the console's. The session belongs to a grant of the client `saveslot-console` whose ID is
// the provider's session ID, so that the console revokes it with that client ID (RFC 7009), and
// voiding the grant ends the session. The grant is recorded first; a session the provider then
// refuses to issue (the account disabled in between, the tenant not active) voids it.

import { SCOPES } from "./auth.ts";
import { type IdentityProvider, UserSessionError } from "./identity.ts";
import { CONSOLE_CLIENT_ID } from "./oauth-client.ts";
import { after, type OAuthDeps, singleParam, TokenError } from "./oauth-server.ts";

/** RFC 7523 §2.1: the grant type of an identity assertion exchanged for a token. */
export const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** How long a user session from an assertion lasts; it is not refreshed, the console asks again. */
export const ASSERTION_SESSION_SECONDS = 15 * 60;

/** The token endpoint's answer to an assertion: no refresh token. */
export interface AssertionTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
}

/** Whether the identity provider takes assertions, so the token endpoint takes `jwt-bearer`. */
export function takesAssertions(identity: Pick<IdentityProvider, "acceptAssertion">): boolean {
  return identity.acceptAssertion !== undefined;
}

/**
 * An identity assertion exchanged for a user session of `ASSERTION_SESSION_SECONDS`. `remote` is the
 * request's source, which a user first seen is counted against. Throws a `TokenError`.
 */
export async function redeemAssertion(
  deps: OAuthDeps,
  form: URLSearchParams,
  remote: string,
  now: string,
): Promise<AssertionTokenResponse> {
  const accept = deps.identity.acceptAssertion?.bind(deps.identity);
  if (accept === undefined) {
    throw new TokenError("unsupported_grant_type", "this server takes no identity assertions");
  }
  for (const key of new Set(form.keys())) singleParam(form, key);
  const client = form.get("client_id");
  if (client !== null && client !== CONSOLE_CLIENT_ID) {
    throw new TokenError("invalid_client", `an assertion is exchanged by ${CONSOLE_CLIENT_ID}`);
  }
  const assertion = form.get("assertion");
  if (assertion === null || assertion === "") {
    throw new TokenError("invalid_request", "assertion is required");
  }
  const accepted = await accept(assertion, remote);
  if (accepted === undefined) throw new TokenError("invalid_grant", "the assertion is not valid");
  const tenant = await deps.control.tenantOf(accepted.user);
  if (tenant === undefined) {
    throw new TokenError("invalid_grant", "the assertion's user has no tenant");
  }
  await deps.store.putGrant({
    id: accepted.session,
    kind: "session",
    principal: accepted.user,
    tenant: tenant.id,
    clientId: CONSOLE_CLIENT_ID,
    resource: deps.external,
    createdAt: now,
  });
  let token: string;
  try {
    token = await deps.identity.issueUserSession(accepted.user, {
      from: { assertion: true },
      grant: accepted.session,
      expiresAt: after(now, ASSERTION_SESSION_SECONDS),
      now,
    });
  } catch (e) {
    if (!(e instanceof UserSessionError)) throw e;
    await deps.store.voidGrant(accepted.session, now);
    throw new TokenError("invalid_grant", "no session is issued for the assertion's user");
  }
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: ASSERTION_SESSION_SECONDS,
    scope: SCOPES.join(" "),
  };
}
