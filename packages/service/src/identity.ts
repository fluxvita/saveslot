// The identity provider (docs/zh-CN/spec/02-architecture.md §12 «身份提供者»): who a person in a
// browser is, for the server mode's pages that need one (the OAuth authorization page, the device
// code page). Those pages depend on this interface only. The self-hosted server's built-in local
// accounts are one implementation (local-identity.ts); the hosted service's external login is
// another. Which tenant a user owns stays the control plane's (`tenantOf`); a user's tenant is
// created by the implementation that first knows the user (`addLocalUser`, the external login's
// first identity claim).
//
// A request's headers, cookies, query and form are maps, never plain objects: a name such as
// `__proto__` is a name like any other. Each name has one value: whoever builds an
// `IdentityRequest` keeps the first value of a name that comes more than once, so that a provider
// never meets a repeated name. A caller that needs every value (an OAuth request's repeated
// parameters) parses the raw query or body itself.

import { isIPv4, isIPv6 } from "node:net";
import type { Tx } from "@fluxvita/saveslot-kernel";
import type { UserId } from "./control-plane.ts";
import { isInstant } from "./server-control-plane.ts";
import { newToken, tokenHash } from "./tokens.ts";

/** Names to values, one a name (the first, when a name came more than once); header names in lower case. */
export type Fields = ReadonlyMap<string, string>;

export interface IdentityRequest {
  readonly method: string;
  /** The path of this service, without host or query. */
  readonly path: string;
  readonly query: Fields;
  readonly headers: Fields;
  readonly cookies: Fields;
  /** Where the request came from, as the service layer works it out; counts failed logins only. */
  readonly remote: string;
  /** An `application/x-www-form-urlencoded` body, parsed. */
  readonly form?: Fields;
}

/** A cookie to set: always `HttpOnly`; written by `setCookieHeader` only. */
export interface SetCookie {
  readonly name: string;
  readonly value: string;
  /** 0 clears it. */
  readonly maxAgeSeconds: number;
  readonly path: string;
  readonly secure: boolean;
  /** `Lax` when not given. */
  readonly sameSite?: "Lax" | "Strict";
}

/** A cookie's name: a token of RFC 6265, no separators. */
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A cookie's value: no space, quote, comma, semicolon, backslash or control character. */
const COOKIE_VALUE = /^[!#-+\--:<-[\]-~]*$/;

/**
 * The one way a `Set-Cookie` header's value is written. A `__Host-` cookie must be secure with path
 * `/`; a name or value a cookie cannot carry, or a path with `;` or a control character, is refused
 * rather than written.
 */
export function setCookieHeader(c: SetCookie): string {
  if (!COOKIE_NAME.test(c.name)) throw new Error("not a name a cookie can have");
  if (!COOKIE_VALUE.test(c.value)) throw new Error("not a value a cookie can carry");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
  if (!c.path.startsWith("/") || /[;\u0000-\u001f\u007f]/.test(c.path)) {
    throw new Error("not a path a cookie can have");
  }
  if (!Number.isSafeInteger(c.maxAgeSeconds) || c.maxAgeSeconds < 0) {
    throw new Error("a cookie's age is a whole number of seconds, 0 or more");
  }
  if (c.name.startsWith("__Host-") && !(c.secure && c.path === "/")) {
    throw new Error("a __Host- cookie is secure, with path /");
  }
  return [
    `${c.name}=${c.value}`,
    `Path=${c.path}`,
    `Max-Age=${c.maxAgeSeconds}`,
    "HttpOnly",
    `SameSite=${c.sameSite ?? "Lax"}`,
    ...(c.secure ? ["Secure"] : []),
  ].join("; ");
}

export type IdentityResponse =
  | {
      readonly kind: "redirect";
      readonly location: string;
      readonly headers?: readonly (readonly [string, string])[];
      readonly cookies?: readonly SetCookie[];
    }
  | {
      readonly kind: "page";
      readonly status: number;
      readonly html: string;
      readonly headers?: readonly (readonly [string, string])[];
      readonly cookies?: readonly SetCookie[];
    };

/** The person a browser's request is from. */
export interface CurrentUser {
  readonly user: UserId;
  /**
   * This login's ID: stable while it lasts, opaque, not the cookie (a consent form's token is bound
   * to it).
   */
  readonly session: string;
  /** What the person is called, to show ("signed in as …"); escaped wherever it is written. */
  readonly name: string;
  /** When this login expires, an instant in `toISOString` form. */
  readonly expiresAt: string;
}

export interface IdentityProvider {
  /** The person this browser's request is from, by the provider's own login state. */
  currentUser(req: IdentityRequest): Promise<CurrentUser | undefined>;
  /**
   * Sends a browser with no person to sign in, coming back to `returnTo` (a path of this service,
   * checked by `safeReturnTo`).
   */
  beginLogin(req: IdentityRequest, returnTo: string): Promise<IdentityResponse>;
  /**
   * The paths the provider answers. The server reads a request's form body only for these (a body
   * can be read once: another route's, such as the token endpoint's, is left alone) and calls
   * `handle` only with them.
   */
  readonly paths: ReadonlySet<string>;
  /**
   * Answers a request to one of `paths`; undefined for a path that is not its, as a fallback (the
   * server sends it no other).
   */
  handle(req: IdentityRequest): Promise<IdentityResponse | undefined>;
  /** The account's state: disabled refuses every credential of its tenant; unknown is refused too. */
  userState(user: UserId): Promise<"active" | "disabled" | "unknown">;
  /**
   * An identity assertion for a session (the hosted console's), verified: its user and a session ID;
   * undefined when it does not verify. Only the external login has it.
   */
  acceptAssertion?(
    assertion: string,
    /** Where the request came from: a user first seen this way gets a tenant, counted by source. */
    remote: string,
  ): Promise<{ user: UserId; session: string } | undefined>;
  /**
   * Issues a user session for `user`: its token, shown this once; the control plane keeps only its
   * hash. `grant` names the authorization it came from, when it came from one. In one transaction of
   * the control database, the account's row is locked and then the login's, the order every path
   * that changes them keeps (a password change, a disable, a sign-out). Nothing is issued, from any
   * source, for an account that exists but is not active (`account_inactive`: not now, it may be
   * enabled again; the account's row is checked first); nor for an account the provider does not
   * know, from a login that has ended or expired, or for a refresh of a session granted before the
   * account's sessions were last ended (by a password change; all `login_ended`: for good); nor for
   * a user whose account is active but who has no active tenant (`unknown_user`,
   * `tenant_not_active`). The writing itself is `writeUserSession`'s.
   */
  issueUserSession(
    user: UserId,
    o: {
      /**
       * What it is issued from: a login (`currentUser`'s `session`), an assertion
       * `acceptAssertion` has just taken (only a provider that has it takes this), or a refresh of
       * a session whose grant was made at `grantedAt` (an instant in `toISOString` form), which has
       * no login left to lock.
       */
      readonly from:
        | { readonly login: string }
        | { readonly assertion: true }
        | { readonly refresh: { readonly grantedAt: string } };
      readonly grant?: string;
      /** When the session expires, and the time now: instants as `toISOString` writes them. */
      readonly expiresAt: string;
      readonly now: string;
    },
  ): Promise<string>;
}

/** Why a user session was not issued. */
export type UserSessionErrorCode =
  | "account_inactive"
  | "login_ended"
  | "tenant_not_active"
  | "unknown_user";

export class UserSessionError extends Error {
  override readonly name = "UserSessionError";
  readonly code: UserSessionErrorCode;
  constructor(code: UserSessionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * A user session written for `user` in the transaction given, which has taken the provider's locks:
 * its token. The user's tenant must be active (else `unknown_user`, `tenant_not_active`); the
 * session is a row of the control plane's `credentials`, in the same database.
 */
export async function writeUserSession(
  tx: Tx,
  user: UserId,
  o: { readonly grant?: string; readonly expiresAt: string },
): Promise<string> {
  if (!isInstant(o.expiresAt)) {
    throw new Error("a session's expiry is an instant as toISOString writes it");
  }
  const t = await tx.query<{ id: string; state: string }>(
    "SELECT id, state FROM tenants WHERE owner = $1",
    [user],
  );
  const tenant = t.rows[0];
  if (tenant === undefined) throw new UserSessionError("unknown_user", "the user has no tenant");
  // One more line of defence: authentication refuses such a session anyway.
  if (tenant.state !== "active") {
    throw new UserSessionError("tenant_not_active", "the user's tenant is not active yet");
  }
  const token = newToken("session");
  await tx.query(
    `INSERT INTO credentials (hash, kind, principal, tenant, expires_at, grant_id)
       VALUES ($1, 'session', $2, $3, $4, $5)`,
    [tokenHash(token), user, tenant.id, o.expiresAt, o.grant ?? null],
  );
  return token;
}

/** Where a login may send the browser back to: no longer, and never cut short. */
export const RETURN_TO_MAX = 4096;

/**
 * `v` when it is a path a login may return to, else undefined: one leading `/` (not `//` or `/\`),
 * no scheme, no backslash, printable ASCII only (so it goes into a `Location` header as it is),
 * under `/oauth/`, at most `RETURN_TO_MAX` long. Its path has no `.` or `..` segment and no `%2e`,
 * `%2f`, `%5c` or `%25` in any case (so no decoding, however often repeated, makes one), and
 * resolved against this service it is still under `/oauth/`: a return cannot climb out of it.
 */
export function safeReturnTo(v: string | undefined): string | undefined {
  if (v === undefined || v.length > RETURN_TO_MAX) return undefined;
  if (!v.startsWith("/oauth/")) return undefined;
  if (v.includes("\\")) return undefined;
  if (/[^\x21-\x7e]/.test(v)) return undefined;
  const path = v.split(/[?#]/, 1)[0] as string;
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return undefined;
  if (/%(2e|2f|5c|25)/i.test(path)) return undefined;
  const base = "http://return.invalid";
  const resolved = new URL(v, base);
  if (resolved.origin !== base || !resolved.pathname.startsWith("/oauth/")) return undefined;
  return v;
}

/** An IPv6 address's eight groups, written out; undefined for what is not one. */
function ipv6Groups(v: string): number[] | undefined {
  if (!isIPv6(v)) return undefined;
  let s = v.split("%")[0] as string;
  // A trailing IPv4 part is the last two groups.
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4 !== null) {
    const [a, b, c, d] = (v4[2] as string).split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? (s.split("::") as [string, string]) : [s, undefined];
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * The source a request is counted under: an IPv4 address as it is (an IPv4-mapped IPv6 address
 * as its IPv4 address), an IPv6 address by its /64, which one subscriber usually holds whole.
 */
export function sourceKey(remote: string): string {
  if (isIPv4(remote)) return remote;
  const g = ipv6Groups(remote);
  if (g === undefined) return remote;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] as number, g[7] as number].flatMap((x) => [x >> 8, x & 0xff]).join(".");
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

/**
 * The wider source an IPv6 request is also counted under: its /48, what one site usually holds,
 * so that someone with many /64s of one /48 still meets a limit. None for IPv4 (an IPv4-mapped
 * address included).
 */
export function wideSourceKey(remote: string): string | undefined {
  if (isIPv4(remote)) return undefined;
  const g = ipv6Groups(remote);
  if (g === undefined) return undefined;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return undefined;
  return `${g
    .slice(0, 3)
    .map((x) => x.toString(16))
    .join(":")}::/48`;
}

/** Text made safe to write inside HTML, in text and in quoted attributes. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A page's language: Chinese when the first choice of `Accept-Language` starts with `zh`. */
export function pageLanguage(acceptLanguage: string | undefined): "en" | "zh" {
  const first = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("zh") ? "zh" : "en";
}

/**
 * Headers every page of a provider carries: it loads nothing from anywhere (no script, style, image
 * or frame), posts its forms only to this service, may not be framed, is not sniffed as another
 * type, sends a referrer only to this service and is not cached. Not `no-referrer`: under it a
 * browser sends `Origin: null` with a form posted to the same origin, and the sign-in refuses that.
 */
export const PAGE_HEADERS: readonly (readonly [string, string])[] = [
  [
    "content-security-policy",
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  ],
  ["x-frame-options", "DENY"],
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "same-origin"],
  ["cache-control", "no-store"],
];
