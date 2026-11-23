// The device authorization grant for the CLI's sign-in (RFC 8628; docs/zh-CN/spec/05-surfaces.md §15
// «远程授权», 06-cli.md §2 `saveslot login --device`): the CLI asks for a device code and a user
// code, the user enters the user code on the verification page of a browser where they are signed
// in and approves, and the CLI, polling the token endpoint, gets a user session and a refresh token,
// as the browser sign-in would give.
//
// Only the CLI (`saveslot-cli`) may use it. The device code is stored by its SHA-256, as every
// token is; the user code is short, so the page counts wrong ones (the server package). A device
// code lasts 10 minutes and is redeemed once: the redemption deletes it and records the grant in
// one transaction.

import { randomBytes, randomInt } from "node:crypto";
import { SCOPES } from "./auth.ts";
import type { TenantId, UserId } from "./control-plane.ts";
import { UserSessionError } from "./identity.ts";
import { audienceOf } from "./oauth-authorize.ts";
import { CLI_CLIENT_ID } from "./oauth-client.ts";
import {
  ACCESS_TOKEN_SECONDS,
  after,
  CLI_SIGN_IN_SECONDS,
  newRefreshToken,
  type OAuthDeps,
  singleParam,
  TokenError,
  type TokenResponse,
} from "./oauth-server.ts";
import { ControlPlaneError } from "./server-control-plane.ts";
import { tokenHash } from "./tokens.ts";

/** How long a device code waits for its approval. */
export const DEVICE_CODE_SECONDS = 10 * 60;
/** The first interval between polls, and what each poll that comes too soon adds to it. */
export const DEVICE_INTERVAL_SECONDS = 5;
/** The verification page's path. */
export const DEVICE_VERIFY_PATH = "/oauth/device/verify";

/** A user code's letters: 20 consonants, no vowels (no words), none easily taken for another. */
const USER_CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const USER_CODE = new RegExp(`^[${USER_CODE_LETTERS}]{${USER_CODE_LENGTH}}$`);

/** A new user code: 8 letters of the 20, upper case, without the dash. */
export function newUserCode(): string {
  let c = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) c += USER_CODE_LETTERS[randomInt(20)];
  return c;
}

/** A user code as shown: `BCDF-GHJK`. */
export function showUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A user code as a person typed it: case, dashes and spaces do not matter. Undefined when what is
 * left is not a user code's form.
 */
export function readUserCode(typed: string): string | undefined {
  const c = typed.toUpperCase().replace(/[\s-]/g, "");
  return USER_CODE.test(c) ? c : undefined;
}

/** The device authorization response (RFC 8628 §3.2). */
export interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
}

/**
 * `POST /oauth/device`: `client_id` must be the CLI's (else `invalid_client`); `resource`, if given,
 * the external address or one of its endpoints (else `invalid_target`); `scope` is not read (the
 * CLI signs its user in with every scope). Gives a device code and a user code.
 */
export async function startDeviceAuthorization(
  deps: Pick<OAuthDeps, "store" | "external">,
  form: URLSearchParams,
  now: string,
): Promise<DeviceAuthorizationResponse> {
  const clientId = singleParam(form, "client_id");
  const resource = singleParam(form, "resource");
  if (clientId === undefined) throw new TokenError("invalid_request", "client_id is required");
  if (clientId !== CLI_CLIENT_ID) {
    throw new TokenError("invalid_client", "only the saveslot CLI signs in with a device code");
  }
  if (resource !== undefined && audienceOf(resource, deps.external) === undefined) {
    throw new TokenError("invalid_target", "the resource is not this server's");
  }
  const deviceCode = randomBytes(32).toString("base64url");
  // A user code taken already (one in 20^8 per pending code): another one.
  for (let tries = 0; ; tries++) {
    const userCode = newUserCode();
    try {
      await deps.store.putDeviceCode({
        deviceHash: tokenHash(deviceCode),
        userCode,
        clientId,
        resource: deps.external,
        expiresAt: after(now, DEVICE_CODE_SECONDS),
        interval: DEVICE_INTERVAL_SECONDS,
      });
    } catch (e) {
      if (e instanceof ControlPlaneError && e.code === "already_exists" && tries < 3) continue;
      throw e;
    }
    const verify = `${deps.external}${DEVICE_VERIFY_PATH}`;
    return {
      device_code: deviceCode,
      user_code: showUserCode(userCode),
      verification_uri: verify,
      verification_uri_complete: `${verify}?user_code=${showUserCode(userCode)}`,
      expires_in: DEVICE_CODE_SECONDS,
      interval: DEVICE_INTERVAL_SECONDS,
    };
  }
}

/**
 * The verification page's answer: approves or denies the pending, unexpired device code of
 * `userCode` (as `readUserCode` gives it) for `user` of `tenant`, under `login` (`currentUser`'s
 * `session`: the session is issued from it). False when there is no such code: the page counts it
 * as a wrong one.
 */
export async function answerDeviceCode(
  deps: Pick<OAuthDeps, "store">,
  o: {
    readonly userCode: string;
    readonly approved: boolean;
    readonly user: UserId;
    readonly login: string;
    readonly tenant: TenantId;
    readonly now: string;
  },
): Promise<boolean> {
  return deps.store.decideDeviceCode(
    o.userCode,
    { approved: o.approved, user: o.user, login: o.login, tenant: o.tenant },
    o.now,
  );
}

/**
 * A poll of the token endpoint (`grant_type=urn:ietf:params:oauth:grant-type:device_code`):
 * `device_code` and `client_id` required; a client other than the CLI is `invalid_client`; unknown
 * `invalid_grant`; then expired `expired_token`; sooner than the interval `slow_down` (and the
 * interval grows by 5 seconds); pending `authorization_pending`; denied `access_denied`. Approved:
 * taken once, a CLI sign-in as the browser's would give — a user session issued from the login
 * that approved it, and a refresh token within the 90 days. That login ended since: `invalid_grant`,
 * the grant voided.
 */
export async function redeemDeviceCode(
  deps: OAuthDeps,
  form: URLSearchParams,
  now: string,
): Promise<TokenResponse> {
  const deviceCode = singleParam(form, "device_code");
  const clientId = singleParam(form, "client_id");
  if (deviceCode === undefined || clientId === undefined) {
    throw new TokenError("invalid_request", "device_code and client_id are required");
  }
  if (clientId !== CLI_CLIENT_ID) {
    throw new TokenError("invalid_client", "only the saveslot CLI signs in with a device code");
  }
  const hash = tokenHash(deviceCode);
  const poll = await deps.store.pollDeviceCode(hash, now, DEVICE_INTERVAL_SECONDS);
  if (poll === undefined) throw new TokenError("invalid_grant", "the device code is not valid");
  const d = poll.entry;
  if (d.expiresAt <= now) throw new TokenError("expired_token", "the device code has expired");
  if (poll.tooSoon) throw new TokenError("slow_down", "poll less often");
  if (d.state === "pending") {
    throw new TokenError("authorization_pending", "the user has not answered yet");
  }
  if (d.state === "denied") throw new TokenError("access_denied", "the user denied the sign-in");

  const grant = randomBytes(16).toString("hex");
  const refresh = newRefreshToken(grant, now, after(now, CLI_SIGN_IN_SECONDS));
  const taken = await deps.store.redeemDeviceCode(
    hash,
    { id: grant, createdAt: now },
    refresh.entry,
  );
  if (taken === undefined) throw new TokenError("invalid_grant", "the device code is not valid");
  // No one holds a token of this grant before this answer, so nothing voids it in between: unlike a
  // code's redemption, there is no replay to look for once the session is written.
  let token: string;
  try {
    token = await deps.identity.issueUserSession(taken.grant.principal as UserId, {
      from: { login: taken.login },
      grant,
      expiresAt: after(now, ACCESS_TOKEN_SECONDS),
      now,
    });
  } catch (e) {
    if (!(e instanceof UserSessionError)) throw e;
    await deps.store.voidGrant(grant, now);
    throw new TokenError("invalid_grant", "the login that approved the sign-in has ended");
  }
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    scope: SCOPES.join(" "),
    refresh_token: refresh.token,
  };
}
