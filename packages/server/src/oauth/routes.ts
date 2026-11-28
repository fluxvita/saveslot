// The authorization server's HTTP routes of the server mode (docs/zh-CN/spec/05-surfaces.md §14,
// §15 «远程授权»): the two metadata documents, the token endpoint, the revocation endpoint and the
// device authorization endpoint. The local mode has none of them.
//
// - `GET /.well-known/oauth-protected-resource` (RFC 9728), also under the MCP endpoint's path, and
//   `GET /.well-known/oauth-authorization-server` (RFC 8414): JSON, cacheable for a few minutes.
// - `POST /oauth/token`: a form (`application/x-www-form-urlencoded`) of at most 64 KiB;
//   `authorization_code`, `refresh_token` and the device code's, and `jwt-bearer` (RFC 7523) when the
//   identity provider takes assertions: the hosted console's session exchange. Answers carry
//   `Cache-Control: no-store`; an error is `{error, error_description}` with 400, 401 for
//   `invalid_client` (RFC 6749 §5.2).
// - `POST /oauth/revoke` (RFC 7009): a form of the same kind and limit; 200 with an empty body
//   whether or not the token was one to revoke, an error only for a request missing what it needs.
// - `POST /oauth/device` (RFC 8628 §3.1): a form of the same kind and limit; the CLI's only.
//
// Logged per request, as the API does: method, route name, status, milliseconds. Never a header,
// a query, a form or a token.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type AssertionTokenResponse,
  ContractError,
  creatingBusy,
  DEVICE_VERIFY_PATH,
  exchangeRefreshToken,
  type IdentityProvider,
  JWT_BEARER,
  type OAuthDeps,
  poolContractError,
  redeemAssertion,
  redeemCode,
  redeemDeviceCode,
  revokeToken,
  SCOPES,
  startDeviceAuthorization,
  storageRefusal,
  TenantPoolError,
  TokenError,
  type TokenErrorCode,
  type TokenResponse,
  takesAssertions,
} from "@fluxvita/saveslot-service";
import { handleAuthorize } from "./consent.ts";
import { type DeviceTries, handleDeviceVerify } from "./device-page.ts";

/** The device code's grant type (RFC 8628 §3.4). */
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The token endpoint's body limit. */
export const TOKEN_BODY_MAX_BYTES = 64 * 1024;

/** The paths the authorization server answers. */
export const OAUTH_PATHS = {
  protectedResource: "/.well-known/oauth-protected-resource",
  protectedResourceMcp: "/.well-known/oauth-protected-resource/mcp",
  authorizationServer: "/.well-known/oauth-authorization-server",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  revoke: "/oauth/revoke",
  device: "/oauth/device",
  deviceVerify: DEVICE_VERIFY_PATH,
} as const;

/** RFC 9728 §2: the protected resource's metadata. `resource` is the address the client used. */
export function protectedResourceMetadata(external: string, resource: string) {
  return {
    resource,
    authorization_servers: [external],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/**
 * RFC 8414 §2: the authorization server's metadata. `jwt-bearer` is among the grant types only when
 * the identity provider takes assertions.
 */
export function authorizationServerMetadata(external: string, o: { readonly jwtBearer: boolean }) {
  return {
    issuer: external,
    authorization_endpoint: `${external}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${external}${OAUTH_PATHS.token}`,
    revocation_endpoint: `${external}${OAUTH_PATHS.revoke}`,
    revocation_endpoint_auth_methods_supported: ["none"],
    device_authorization_endpoint: `${external}${OAUTH_PATHS.device}`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      DEVICE_GRANT,
      ...(o.jwtBearer ? [JWT_BEARER] : []),
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export interface OAuthRoutesContext {
  readonly deps: OAuthDeps;
  /** Who is signed in, for the authorization page. */
  readonly identity: IdentityProvider;
  /** The source address of a request (behind trusted proxies). */
  readonly remote: (req: IncomingMessage) => string;
  readonly now: () => string;
  readonly log: (fields: Readonly<Record<string, string | number>>) => void;
  /** Internal errors, without request content. */
  readonly warn: (event: string, fields: Readonly<Record<string, string>>) => void;
  /** The verification page's counts of wrong codes; the process's own when not given. */
  readonly deviceTries?: DeviceTries;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function tokenError(res: ServerResponse, code: TokenErrorCode, description: string): number {
  // invalid_client is 401 (RFC 6749 §5.2); public clients authenticate with nothing, so it is the
  // client ID that does not fit.
  const status = code === "invalid_client" ? 401 : 400;
  send(res, status, { error: code, error_description: description }, NO_STORE);
  return status;
}

/** Reads a body of at most `max` bytes; undefined when it is larger. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > max) return undefined;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * Answers a request when its path is one of the authorization server's, and says whether it did.
 * The authorization page is in consent.ts.
 */
export async function handleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthRoutesContext,
): Promise<boolean> {
  const started = Date.now();
  /** What a handler adds to this request's log line (the authorization page: why its client). */
  const extra: Record<string, string | number> = {};
  // The path as parsed, as `/v1/` and `/mcp` are matched: an absolute-form target is taken the
  // same way.
  const path = new URL(req.url ?? "/", "http://local").pathname;
  const external = ctx.deps.external;
  let name: string;
  let status: number;
  const metadata = (body: unknown) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      return 405;
    }
    send(res, 200, body, { "cache-control": "public, max-age=300" });
    return 200;
  };
  switch (path) {
    case OAUTH_PATHS.protectedResource:
      name = "oauth.protected_resource";
      status = metadata(protectedResourceMetadata(external, external));
      break;
    case OAUTH_PATHS.protectedResourceMcp:
      name = "oauth.protected_resource";
      status = metadata(protectedResourceMetadata(external, `${external}/mcp`));
      break;
    case OAUTH_PATHS.authorizationServer:
      name = "oauth.authorization_server";
      status = metadata(
        authorizationServerMetadata(external, { jwtBearer: takesAssertions(ctx.deps.identity) }),
      );
      break;
    case OAUTH_PATHS.token:
      name = "oauth.token";
      status = await token(req, res, ctx);
      break;
    case OAUTH_PATHS.revoke:
      name = "oauth.revoke";
      status = await revoke(req, res, ctx);
      break;
    case OAUTH_PATHS.device:
      name = "oauth.device";
      status = await device(req, res, ctx);
      break;
    case OAUTH_PATHS.authorize:
      name = "oauth.authorize";
      status = await pageOrError(res, ctx, "oauth.authorize_failed", () =>
        handleAuthorize(req, res, ctx, (f) => Object.assign(extra, f)),
      );
      break;
    case OAUTH_PATHS.deviceVerify:
      name = "oauth.device_verify";
      status = await pageOrError(res, ctx, "oauth.device_verify_failed", () =>
        handleDeviceVerify(req, res, ctx),
      );
      break;
    default:
      return false;
  }
  ctx.log({ method: req.method ?? "", route: name, status, ms: Date.now() - started, ...extra });
  return true;
}

/**
 * The form of a POST to the token or revocation endpoint; else the error answered, by its status.
 */
async function postedForm(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<URLSearchParams | number> {
  if (req.method !== "POST") {
    send(res, 405, { error: "method_not_allowed" }, { allow: "POST", ...NO_STORE });
    return 405;
  }
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    return tokenError(
      res,
      "invalid_request",
      "the body is a form (application/x-www-form-urlencoded)",
    );
  }
  const body = await readBody(req, TOKEN_BODY_MAX_BYTES);
  if (body === undefined) return tokenError(res, "invalid_request", "the body is too large");
  return new URLSearchParams(body.toString("utf8"));
}

/** Answers a step's error: a `TokenError` as itself, anything else as a server error. */
function failed(res: ServerResponse, ctx: OAuthRoutesContext, event: string, e: unknown): number {
  if (e instanceof TokenError) return tokenError(res, e.code, e.message);
  // A user's tenant that waited past its turn to be created (02-architecture §7 «连接»): a retry in
  // a moment, as a sign-in the server cannot take now.
  if (creatingBusy(e)) {
    send(res, 503, { error: "temporarily_unavailable" }, { ...NO_STORE, "retry-after": "1" });
    return 503;
  }
  // The user's tenant refused this process (02-architecture §7 «进程、单写者、串行写»): its storage
  // upgraded by a newer version, or sealed by an import. A retry in a moment, as above.
  const refused = refusedBy(ctx, e);
  if (refused !== undefined) {
    send(res, 503, { error: "temporarily_unavailable" }, { ...NO_STORE, "retry-after": refused });
    return 503;
  }
  ctx.warn(event, { error: e instanceof Error ? e.name : "unknown" });
  send(res, 500, { error: "server_error" }, NO_STORE);
  return 500;
}

/**
 * The `Retry-After` of an error that is the tenant's storage refusing this process, logged as a
 * call's is (`tenant_format_too_new`), or the pool not lending the tenant now; undefined for any
 * other error.
 */
function refusedBy(ctx: OAuthRoutesContext, e: unknown): string | undefined {
  const refused = storageRefusal(e);
  if (refused === "format_too_new") ctx.warn("tenant_format_too_new", {});
  if (refused !== undefined) return "1";
  // The pool's refusals the contract answers `unavailable` (an import or a restore holding the
  // tenant, here or in another process; no connection free yet): a retry later, as a request's.
  if (e instanceof TenantPoolError) {
    const c = poolContractError(e);
    if (c instanceof ContractError && (c.code === "unavailable" || c.code === "rate_limited")) {
      const after = c.detail["retry_after"];
      return String(typeof after === "number" ? after : 1);
    }
  }
  return undefined;
}

/** A page's answer; an internal error is a plain 500, without anything of it. */
async function pageOrError(
  res: ServerResponse,
  ctx: OAuthRoutesContext,
  event: string,
  answer: () => Promise<number>,
): Promise<number> {
  try {
    return await answer();
  } catch (e) {
    const refused = refusedBy(ctx, e);
    if (refused !== undefined) {
      if (!res.headersSent) {
        res.writeHead(503, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "retry-after": refused,
        });
        res.end("Temporarily unavailable; try again in a moment");
      } else res.end();
      return 503;
    }
    ctx.warn(event, { error: e instanceof Error ? e.name : "unknown" });
    if (!res.headersSent) {
      res.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end("Internal error");
    } else res.end();
    return 500;
  }
}

async function token(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthRoutesContext,
): Promise<number> {
  const form = await postedForm(req, res);
  if (typeof form === "number") return form;
  const grants = form.getAll("grant_type");
  if (grants.length !== 1) return tokenError(res, "invalid_request", "grant_type is required once");
  try {
    let r: TokenResponse | AssertionTokenResponse;
    switch (grants[0]) {
      case "authorization_code":
        r = await redeemCode(ctx.deps, form, ctx.now());
        break;
      case "refresh_token":
        r = await exchangeRefreshToken(ctx.deps, form, ctx.now());
        break;
      case DEVICE_GRANT:
        r = await redeemDeviceCode(ctx.deps, form, ctx.now());
        break;
      case JWT_BEARER:
        r = await redeemAssertion(ctx.deps, form, ctx.remote(req), ctx.now());
        break;
      default:
        return tokenError(res, "unsupported_grant_type", "the grant type is not supported");
    }
    send(res, 200, r, NO_STORE);
    return 200;
  } catch (e) {
    return failed(res, ctx, "oauth.token_failed", e);
  }
}

async function revoke(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthRoutesContext,
): Promise<number> {
  const form = await postedForm(req, res);
  if (typeof form === "number") return form;
  try {
    await revokeToken(ctx.deps, form, ctx.now());
  } catch (e) {
    return failed(res, ctx, "oauth.revoke_failed", e);
  }
  res.writeHead(200, { "content-length": 0, ...NO_STORE });
  res.end();
  return 200;
}

async function device(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthRoutesContext,
): Promise<number> {
  const form = await postedForm(req, res);
  if (typeof form === "number") return form;
  try {
    send(res, 200, await startDeviceAuthorization(ctx.deps, form, ctx.now()), NO_STORE);
    return 200;
  } catch (e) {
    return failed(res, ctx, "oauth.device_failed", e);
  }
}
