// Requests from a page of another site (docs/zh-CN/spec/05-surfaces.md §13, §14): a request to
// `/mcp` or `/v1` of the server mode that carries an `Origin`, and not the external address's, is
// refused with 403 before it reaches the MCP adapter or an operation (the MCP transport's guard
// against DNS rebinding). The hosts call from their servers and send no `Origin`. The answer is
// plain text: no contract error fits a request that never reaches the contract.
//
// The origins the deployment lists (`SAVESLOT_ALLOWED_ORIGINS`) are let through on `/v1` and
// answered with CORS (`/v1/`, `/oauth/token`, `/oauth/revoke`): the response names the origin, a
// preflight is answered, and no response allows credentials, the token going in `Authorization`.
// While any origin is listed, every response on those paths carries `Vary: Origin`.
// `/mcp` takes none of them.

import type { IncomingMessage } from "node:http";

export interface OriginRefusal {
  readonly status: 403;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const REFUSAL: OriginRefusal = {
  status: 403,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: "Requests from this origin are not taken.\n",
};

/** The `Origin`s the request carries, as they are written. */
function origins(req: IncomingMessage): string[] {
  const raw = req.rawHeaders;
  const given: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if ((raw[i] as string).toLowerCase() === "origin") given.push(raw[i + 1] as string);
  }
  return given;
}

/**
 * Undefined when the request may go on; the 403 to send when it carries an `Origin` other than
 * `externalOrigin` (an origin as `URL.origin` writes it: scheme, host and a port other than the
 * default) and not one of `allowed`. An `Origin` given twice, or `null`, is neither.
 */
export function originGuard(
  req: IncomingMessage,
  externalOrigin: string,
  allowed: ReadonlySet<string> = new Set(),
): OriginRefusal | undefined {
  const given = origins(req);
  if (given.length === 0) return undefined;
  const one = given.length === 1 ? (given[0] as string) : undefined;
  return one !== undefined && (one === externalOrigin || allowed.has(one)) ? undefined : REFUSAL;
}

/** A path a listed origin's page may call (05-surfaces §13): `/v1/`, `/oauth/token`, `/oauth/revoke`. */
export const crossOriginPath = (path: string): boolean =>
  path.startsWith("/v1/") || path === "/oauth/token" || path === "/oauth/revoke";

/** The request's one `Origin` when it is one of `allowed`, compared as written; else undefined. */
export function allowedOrigin(
  req: IncomingMessage,
  allowed: ReadonlySet<string>,
): string | undefined {
  const given = origins(req);
  return given.length === 1 && allowed.has(given[0] as string) ? given[0] : undefined;
}

/** What a listed origin's page reads of a response: when to retry, and why it was refused. */
const EXPOSE = { "access-control-expose-headers": "Retry-After, WWW-Authenticate" };

/**
 * The CORS headers of a response on a path a listed origin may call: none while no origin is
 * listed; otherwise `Vary: Origin` on every one (what it carries depends on the `Origin`), and the
 * origin itself, with the headers its page may read, when it is listed. Never `Access-Control-Allow-Credentials`.
 */
export function corsHeaders(
  req: IncomingMessage,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  if (allowed.size === 0) return {};
  const origin = allowedOrigin(req, allowed);
  return origin === undefined
    ? { vary: "Origin" }
    : { "access-control-allow-origin": origin, vary: "Origin", ...EXPOSE };
}

/**
 * The answer to a listed origin's preflight: the methods of the routes (05-surfaces §14) and the
 * request headers the HTTP surface defines (§13).
 */
export const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-methods": "GET, POST, PATCH, DELETE",
  "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, X-Task-Id",
  "content-length": "0",
};
