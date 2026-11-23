// The authorization server's HTTP routes of the server mode (docs/zh-CN/spec/05-surfaces.md §14,
// §15 «远程授权»): the two metadata documents and the token endpoint. The local mode has none of them.
//
// - `GET /.well-known/oauth-protected-resource` (RFC 9728), also under the MCP endpoint's path, and
//   `GET /.well-known/oauth-authorization-server` (RFC 8414): JSON, cacheable for a few minutes.
// - `POST /oauth/token`: a form (`application/x-www-form-urlencoded`) of at most 64 KiB;
//   `authorization_code` only in this version. Answers carry `Cache-Control: no-store`; an error is
//   `{error, error_description}` with 400 (RFC 6749 §5.2).
//
// Logged per request, as the API does: method, route name, status, milliseconds. Never a header,
// a query, a form or a token.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type IdentityProvider,
  type OAuthDeps,
  redeemCode,
  SCOPES,
  TokenError,
  type TokenErrorCode,
} from "@fluxvita/saveslot-service";
import { handleAuthorize } from "./consent.ts";

/** The token endpoint's body limit. */
export const TOKEN_BODY_MAX_BYTES = 64 * 1024;

/** The paths the authorization server answers. */
export const OAUTH_PATHS = {
  protectedResource: "/.well-known/oauth-protected-resource",
  protectedResourceMcp: "/.well-known/oauth-protected-resource/mcp",
  authorizationServer: "/.well-known/oauth-authorization-server",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
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

/** RFC 8414 §2: the authorization server's metadata. */
export function authorizationServerMetadata(external: string) {
  return {
    issuer: external,
    authorization_endpoint: `${external}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${external}${OAUTH_PATHS.token}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
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
      status = metadata(authorizationServerMetadata(external));
      break;
    case OAUTH_PATHS.token:
      name = "oauth.token";
      status = await token(req, res, ctx);
      break;
    case OAUTH_PATHS.authorize:
      name = "oauth.authorize";
      try {
        status = await handleAuthorize(req, res, ctx);
      } catch (e) {
        ctx.warn("oauth.authorize_failed", { error: e instanceof Error ? e.name : "unknown" });
        status = 500;
        if (!res.headersSent) {
          res.writeHead(500, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end("Internal error");
        } else res.end();
      }
      break;
    default:
      return false;
  }
  ctx.log({ method: req.method ?? "", route: name, status, ms: Date.now() - started });
  return true;
}

async function token(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OAuthRoutesContext,
): Promise<number> {
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
  const form = new URLSearchParams(body.toString("utf8"));
  const grants = form.getAll("grant_type");
  if (grants.length !== 1) return tokenError(res, "invalid_request", "grant_type is required once");
  if (grants[0] !== "authorization_code") {
    return tokenError(res, "unsupported_grant_type", "only authorization_code in this version");
  }
  try {
    const r = await redeemCode(ctx.deps, form, ctx.now());
    send(res, 200, r, NO_STORE);
    return 200;
  } catch (e) {
    if (e instanceof TokenError) return tokenError(res, e.code, e.message);
    ctx.warn("oauth.token_failed", { error: e instanceof Error ? e.name : "unknown" });
    send(res, 500, { error: "server_error" }, NO_STORE);
    return 500;
  }
}
