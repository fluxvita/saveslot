// An authorization request (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»; OAuth 2.1 §4.1; RFC
// 7636; RFC 8707), checked in a fixed order:
//   1. the client: saveslot's CLI, or a client document that can be fetched and passes its checks;
//   2. the redirect URI, one the client lists, a loopback one at any port (the CLI: a loopback IP
//      literal at /callback);
// until both pass, the user sees an error page and is never sent anywhere (OAuth 2.1 §4.1.2.1);
//   3. the rest, an error sent back to the client's redirect URI with `state`: the response type,
//      PKCE (S256 only), the scopes, the resource.
// A parameter given twice is an error at whichever step reads it.

import { createHash, timingSafeEqual } from "node:crypto";
import { SCOPES, type Scope } from "./auth.ts";
import {
  CLI_CLIENT,
  CLI_CLIENT_ID,
  ClientError,
  isLoopbackLiteral,
  type OAuthClient,
} from "./oauth-client.ts";

/** The path the CLI receives the code on, at a loopback IP literal and a port of its choosing. */
export const CLI_REDIRECT_PATH = "/callback";

/** RFC 7636 §4.1: 43 to 128 unreserved characters (a challenge of S256 is 43). */
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636 §4.6: `BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge`. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!PKCE_VALUE.test(verifier) || !PKCE_VALUE.test(challenge)) return false;
  const made = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"));
  const given = Buffer.from(challenge);
  return made.length === given.length && timingSafeEqual(made, given);
}

/**
 * The audience a `resource` names: the service's external address, given as itself or as its MCP
 * or HTTP endpoint (a client commonly sends the MCP endpoint's URL). The address with an empty path
 * and with the path `/` are the same URL (RFC 3986 §6.2.3), and a client that takes the protected
 * resource metadata's `resource` through a URL parser sends the latter. Anything else names nothing.
 */
export function audienceOf(resource: string, external: string): string | undefined {
  return [external, `${external}/`, `${external}/mcp`, `${external}/v1`].includes(resource)
    ? external
    : undefined;
}

/** An authorization request that passed every check. */
export interface AuthorizationRequest {
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeChallenge: string;
  /** The scopes asked for; none asked, the default is offered (contract §12). */
  readonly scopes?: readonly Scope[];
  /** The audience the tokens are for: the external address. */
  readonly resource: string;
}

/** A request the page refuses without sending the user anywhere. */
export interface PageRefusal {
  readonly kind: "page";
  readonly reason: "client" | "redirect_uri";
  /** The client's problem, when it was the client document. */
  readonly client?: ClientError["code"];
}

/** A request refused back to the client (RFC 6749 §4.1.2.1 codes; RFC 8707 `invalid_target`). */
export interface RedirectRefusal {
  readonly kind: "redirect";
  readonly to: string;
}

/** The error codes sent back to a client's redirect URI. */
export type AuthorizeErrorCode =
  | "invalid_request"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied";

/**
 * The redirect URI with these parameters added to its query, keeping what it had: the code or the
 * error, `state` as given, and `iss` (RFC 9207), the issuer.
 */
export function redirectWith(
  redirectUri: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.append(k, v);
  return u.href;
}

/** The one value of a parameter: undefined when absent, `null` when given more than once. */
function one(query: URLSearchParams, name: string): string | undefined | null {
  const all = query.getAll(name);
  return all.length === 0 ? undefined : all.length === 1 ? all[0] : null;
}

/** Whether `uri` is one of the client's redirect URIs. */
function redirectAllowed(client: OAuthClient, uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash !== "" || uri.includes("#")) return false;
  // A loopback redirect has a port of its own, chosen by the app at run time (RFC 8252 §7.3): plain
  // HTTP, no user information, to a loopback IP literal or, for a client document, to `localhost`
  // exactly (05 «远程授权»: clients list it so; reaching another host by it takes changing this
  // machine's resolution, and the code is bound to PKCE). The CLI: an IP literal only.
  const plain = (x: URL) => x.protocol === "http:" && x.username === "" && x.password === "";
  if (client.builtIn) {
    return (
      plain(u) &&
      isLoopbackLiteral(u.hostname) &&
      u.pathname === CLI_REDIRECT_PATH &&
      u.search === ""
    );
  }
  if (client.redirectUris.includes(uri)) return true;
  const loopback = (x: URL) =>
    plain(x) && (isLoopbackLiteral(x.hostname) || x.hostname === "localhost");
  if (!loopback(u)) return false;
  // The same as a listed loopback redirect but for the port: the host as written, so `localhost`
  // and an IP literal never stand for each other.
  const portless = (x: URL) => `${x.protocol}//${x.hostname}${x.pathname}${x.search}`;
  return client.redirectUris.some((r) => {
    try {
      const listed = new URL(r);
      return loopback(listed) && portless(listed) === portless(u);
    } catch {
      return false;
    }
  });
}

/**
 * Checks an authorization request's query, in the order above. `resolveClient` gives a client
 * document's client (fetched or cached) or throws a `ClientError`.
 */
export async function checkAuthorizationRequest(o: {
  readonly query: URLSearchParams;
  readonly external: string;
  readonly resolveClient: (clientId: string) => Promise<OAuthClient>;
}): Promise<AuthorizationRequest | PageRefusal | RedirectRefusal> {
  const q = o.query;
  const clientId = one(q, "client_id");
  if (typeof clientId !== "string") return { kind: "page", reason: "client" };
  let client: OAuthClient;
  if (clientId === CLI_CLIENT_ID) {
    client = CLI_CLIENT;
  } else {
    try {
      client = await o.resolveClient(clientId);
    } catch (e) {
      if (e instanceof ClientError) return { kind: "page", reason: "client", client: e.code };
      throw e;
    }
  }

  const redirectUri = one(q, "redirect_uri");
  if (typeof redirectUri !== "string" || !redirectAllowed(client, redirectUri)) {
    return { kind: "page", reason: "redirect_uri" };
  }

  const stateParam = one(q, "state");
  const state = typeof stateParam === "string" ? stateParam : undefined;
  const refuse = (error: AuthorizeErrorCode): RedirectRefusal => ({
    kind: "redirect",
    to: redirectWith(redirectUri, { error, state, iss: o.external }),
  });
  // `state` given twice is itself a malformed request, sent back without a state.
  if (stateParam === null) return refuse("invalid_request");

  const responseType = one(q, "response_type");
  if (responseType === null || responseType === undefined) return refuse("invalid_request");
  if (responseType !== "code") return refuse("unsupported_response_type");

  const challenge = one(q, "code_challenge");
  const method = one(q, "code_challenge_method");
  // No method means `plain` (RFC 7636 §4.3), which is not taken.
  if (typeof challenge !== "string" || !PKCE_VALUE.test(challenge) || method !== "S256") {
    return refuse("invalid_request");
  }

  const scopeParam = one(q, "scope");
  if (scopeParam === null) return refuse("invalid_scope");
  let scopes: Scope[] | undefined;
  if (scopeParam !== undefined && !client.builtIn) {
    const asked = scopeParam.split(" ").filter((s) => s !== "");
    if (asked.length === 0 || asked.some((s) => !(SCOPES as readonly string[]).includes(s))) {
      return refuse("invalid_scope");
    }
    scopes = SCOPES.filter((s) => asked.includes(s));
  }

  const resourceParam = one(q, "resource");
  if (resourceParam === null) return refuse("invalid_target");
  const resource = resourceParam === undefined ? o.external : audienceOf(resourceParam, o.external);
  if (resource === undefined) return refuse("invalid_target");

  return {
    client,
    redirectUri,
    ...(state === undefined ? {} : { state }),
    codeChallenge: challenge,
    ...(scopes === undefined ? {} : { scopes }),
    resource,
  };
}
