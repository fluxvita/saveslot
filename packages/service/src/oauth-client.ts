// Who is asking for an authorization (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»): a client is
// either saveslot's own CLI, built in, or a client ID metadata document (CIMD) — the client ID is
// an HTTPS URL on the client's own domain, and the document fetched from it says the client's name
// and where it may be sent back to. Nothing a client sends about itself is an identity: what the
// authorization page can vouch for is the client ID's host, nothing more.
//
// This file holds the rules on the URL and on the document, the cache lifetime, and the client as
// the rest of the authorization server sees it. Fetching is a port (`ClientFetcher`): the host
// gives one that pins the address it checked (oauth-fetch.ts in the server package).

/** The client ID of saveslot's own CLI: a public client, redirected to the loopback only. */
export const CLI_CLIENT_ID = "saveslot-cli";

/** At most this many bytes of a client document are read. */
export const CLIENT_DOCUMENT_MAX_BYTES = 16 * 1024;
/** A client document is kept at least this long, and at most the next; without a word, the least. */
export const CLIENT_CACHE_MIN_SECONDS = 5 * 60;
export const CLIENT_CACHE_MAX_SECONDS = 24 * 60 * 60;

const CLIENT_ID_MAX = 2048;
const NAME_MAX = 200;
const REDIRECT_URIS_MAX = 20;

/** A client as the authorization server uses it. */
export interface OAuthClient {
  readonly id: string;
  /** What the client calls itself; prefilled as the connection instance's name, never trusted. */
  readonly name: string;
  /** The host of a CIMD client's ID: the part the page can vouch for. None for the CLI. */
  readonly host?: string;
  readonly redirectUris: readonly string[];
  /** Saveslot's CLI: it signs a user in (a user session), with no scopes or slot range to pick. */
  readonly builtIn: boolean;
}

/** The built-in client of saveslot's CLI. */
export const CLI_CLIENT: OAuthClient = {
  id: CLI_CLIENT_ID,
  name: "saveslot CLI",
  redirectUris: [],
  builtIn: true,
};

/** Why a client cannot be used. Stable codes; messages carry nothing the client sent. */
export type ClientProblem =
  | "client_id_malformed"
  | "fetch_failed"
  | "document_too_large"
  | "document_malformed"
  | "client_id_mismatch"
  | "redirect_uris_missing"
  | "redirect_uri_malformed"
  | "auth_method_unsupported"
  | "grant_type_unsupported"
  | "address_refused"
  /** Too many fetches from this request's source lately (`ClientFetchLimits`). */
  | "fetch_limited"
  /** As many fetches under way as allowed: try again shortly. */
  | "fetch_busy";

export class ClientError extends Error {
  override readonly name = "ClientError";
  readonly code: ClientProblem;
  constructor(code: ClientProblem, message: string) {
    super(message);
    this.code = code;
  }
}

const bad = (code: ClientProblem, what: string) => new ClientError(code, `client: ${what}`);

/** A control character (C0, DEL, C1). */
export const CONTROL = /\p{Cc}/u;

/**
 * Checks a client ID that is not the CLI's: an absolute HTTPS URL with a host and a path, no user
 * information, no fragment, no dot segments, at most 2048 characters. Gives the parsed URL.
 */
export function clientIdUrl(clientId: string): URL {
  const no = () => bad("client_id_malformed", "the client ID is not a client document URL");
  if (clientId.length === 0 || clientId.length > CLIENT_ID_MAX || CONTROL.test(clientId))
    throw no();
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    throw no();
  }
  // The URL as written must be the URL as parsed: no normalising one client into another.
  if (u.href !== clientId) throw no();
  if (u.protocol !== "https:" || u.hostname === "") throw no();
  if (u.username !== "" || u.password !== "" || u.hash !== "" || clientId.includes("#")) throw no();
  if (u.pathname === "/" || u.pathname === "") throw no();
  if (/(^|\/)\.\.?(\/|$)/.test(u.pathname)) throw no();
  return u;
}

/** A loopback IP literal as a redirect host (RFC 8252 §7.3): `localhost` is not one (§8.3). */
export function isLoopbackLiteral(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Schemes a browser must never be sent to. */
const NEVER = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

/**
 * Whether a redirect URI is one a client document may list: HTTPS; HTTP to a loopback IP literal
 * or `localhost` (a native app's, matched exactly); or a private-use scheme in reverse-domain form
 * (RFC 8252 §7.1). No fragment.
 */
function redirectUriProblem(uri: string): boolean {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > CLIENT_ID_MAX) return true;
  if (CONTROL.test(uri) || uri.includes("#")) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return true;
  }
  if (NEVER.has(u.protocol)) return true;
  if (u.protocol === "https:") return u.hostname === "";
  if (u.protocol === "http:") return !(isLoopbackLiteral(u.hostname) || u.hostname === "localhost");
  // A private-use scheme: reverse domain, so at least one dot (RFC 8252 §7.1).
  return !/^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The client a fetched document describes, after every check: it is a JSON object of at most
 * 16 KiB; its `client_id` is the URL it came from, character for character; it lists redirect
 * URIs; it can authenticate at the token endpoint with nothing (`none`: public clients only in
 * this version), as its preferred method or one in its list; it may use the authorization code.
 * `client_name` is optional: without one, the host.
 */
export function clientFromDocument(clientId: string, body: Uint8Array): OAuthClient {
  const url = clientIdUrl(clientId);
  if (body.byteLength > CLIENT_DOCUMENT_MAX_BYTES) {
    throw bad("document_too_large", "the client document is too large");
  }
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw bad("document_malformed", "the client document is not JSON");
  }
  if (!isObject(v)) throw bad("document_malformed", "the client document is not an object");
  if (v["client_id"] !== clientId) {
    throw bad("client_id_mismatch", "the document's client_id is not the URL it came from");
  }
  const uris = v["redirect_uris"];
  if (!Array.isArray(uris) || uris.length === 0) {
    throw bad("redirect_uris_missing", "the client document lists no redirect URIs");
  }
  if (uris.length > REDIRECT_URIS_MAX || uris.some(redirectUriProblem)) {
    throw bad("redirect_uri_malformed", "a redirect URI of the client document is not usable");
  }
  // A public client: `none` is its preferred method (or it names none), or `none` is among the
  // methods it lists (MCP SEP-3149). It is taken on PKCE and the redirect URI compared character
  // for character, never on client authentication.
  const methods = v["token_endpoint_auth_methods_supported"];
  if (
    methods !== undefined &&
    (!Array.isArray(methods) || methods.some((m) => typeof m !== "string"))
  ) {
    throw bad(
      "document_malformed",
      "token_endpoint_auth_methods_supported is not a list of strings",
    );
  }
  const method = v["token_endpoint_auth_method"];
  if (method !== undefined && method !== "none" && !(methods ?? []).includes("none")) {
    throw bad("auth_method_unsupported", "only public clients (none) are taken");
  }
  const grants = v["grant_types"];
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes("authorization_code"))) {
    throw bad("grant_type_unsupported", "the client document does not use the authorization code");
  }
  const responses = v["response_types"];
  if (responses !== undefined && (!Array.isArray(responses) || !responses.includes("code"))) {
    throw bad("grant_type_unsupported", "the client document does not use the authorization code");
  }
  const raw = v["client_name"];
  const named = typeof raw === "string" ? raw.trim() : "";
  const name =
    named !== "" && named.length <= NAME_MAX && !CONTROL.test(named) ? named : url.hostname;
  return {
    id: clientId,
    name,
    host: url.hostname,
    redirectUris: uris as string[],
    builtIn: false,
  };
}

/**
 * How long a fetched document is kept, in seconds, from its `Cache-Control`: `max-age` clamped to
 * five minutes … a day; `no-store`, `no-cache`, no `max-age` or no header: five minutes.
 */
export function clientCacheSeconds(cacheControl: string | undefined): number {
  if (cacheControl === undefined) return CLIENT_CACHE_MIN_SECONDS;
  const directives = cacheControl
    .toLowerCase()
    .split(",")
    .map((d) => d.trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache")) return CLIENT_CACHE_MIN_SECONDS;
  const m = directives.map((d) => /^max-age=(\d{1,10})$/.exec(d)).find((x) => x !== null);
  if (m === undefined || m === null) return CLIENT_CACHE_MIN_SECONDS;
  return Math.min(CLIENT_CACHE_MAX_SECONDS, Math.max(CLIENT_CACHE_MIN_SECONDS, Number(m[1])));
}

/** What a fetch of a client document gives: the body, cut off past the limit, and its caching. */
export interface FetchedDocument {
  readonly body: Uint8Array;
  readonly cacheControl?: string;
}

/**
 * Fetches a client document: HTTPS only, no redirects followed, a time limit, at most
 * `CLIENT_DOCUMENT_MAX_BYTES + 1` bytes read, and only from an address that is not loopback,
 * private or link-local — the address checked being the address connected to. Throws a
 * `ClientError` (`fetch_failed`, `address_refused`, `document_too_large`).
 */
export type ClientFetcher = (url: URL) => Promise<FetchedDocument>;
