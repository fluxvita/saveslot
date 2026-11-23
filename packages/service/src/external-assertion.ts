// An identity assertion of the hosted service's external login, verified (docs/zh-CN/spec/
// 02-architecture §12): a JWT the platform signs with Ed25519, its public keys in the server's
// configuration (no fetch). Checked in this order, each failure refusing it:
//
// - at most `ASSERTION_MAX` long, three base64url parts;
// - the header: `alg` is `EdDSA`, `kid` one of the configured keys, no `crit`;
// - the signature, with that key (node:crypto);
// - `iss` the configured issuer, `aud` this service's public origin;
// - `exp` not passed, `exp − iat` at most `LIFETIME_MAX_S`, `iat` and `nbf` (when there) not ahead
//   of the clock by more than `SKEW_S`;
// - `sub` a string of 1 to 128 characters, no control character; `name`, when there, the same;
// - `purpose` the one this use takes (`authorize` for the login's return, `session` for the
//   console's exchange), and for `authorize`, `nonce` the state of this login.
//
// That `jti` was not used before is the caller's to check, after all of this: a forged assertion
// must not use up another's `jti`. Internal to the package: not exported from it.

import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";

/** The longest assertion read at all. */
export const ASSERTION_MAX = 8192;
/** The longest an assertion may be valid for: `exp − iat`. */
export const LIFETIME_MAX_S = 120;
/** How far ahead of this clock an assertion's `iat` may be. */
export const SKEW_S = 30;
/** The longest `sub`, `name` or `jti`. */
export const CLAIM_MAX = 128;

export type Purpose = "authorize" | "session";

/** An assertion's claims, verified. */
export interface Assertion {
  readonly subject: string;
  readonly sid: string | undefined;
  readonly jti: string;
  /** When it stops being valid, in seconds since the epoch: how long its `jti` is kept. */
  readonly exp: number;
  readonly name: string | undefined;
}

/** Why an assertion was refused: for tests and logs, never shown to whoever sent it. */
export type AssertionRefusal =
  | "malformed"
  | "alg"
  | "kid"
  | "signature"
  | "iss"
  | "aud"
  | "expired"
  | "lifetime"
  | "not_yet"
  | "sub"
  | "name"
  | "jti"
  | "purpose"
  | "nonce";

/** The configured keys, by `kid`. */
export type AssertionKeys = ReadonlyMap<string, KeyObject>;

/** The configured JWKs as keys: each an Ed25519 public key (`OKP`, `Ed25519`) with a `kid`. */
export function assertionKeys(jwks: readonly JsonWebKey[]): AssertionKeys {
  const keys = new Map<string, KeyObject>();
  for (const jwk of jwks) {
    const kid = jwk["kid"];
    if (typeof kid !== "string" || kid === "" || keys.has(kid)) {
      throw new Error("each key has a kid of its own");
    }
    if (
      jwk.kty !== "OKP" ||
      jwk.crv !== "Ed25519" ||
      typeof jwk.x !== "string" ||
      jwk.d !== undefined
    ) {
      throw new Error(`key ${kid} is not an Ed25519 public key`);
    }
    keys.set(
      kid,
      createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" }),
    );
  }
  if (keys.size === 0) throw new Error("no key");
  return keys;
}

const PART = /^[A-Za-z0-9_-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function json(part: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(o, k) ? o[k] : undefined;

const text = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= CLAIM_MAX && !CONTROL.test(v);

const seconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** The assertion's claims, or why it is refused. */
export function verifyAssertion(
  token: string,
  o: {
    readonly keys: AssertionKeys;
    readonly issuer: string;
    readonly audience: string;
    /** This clock, in milliseconds since the epoch. */
    readonly now: number;
    readonly purpose: Purpose;
    /** For `authorize`: the state of the login it answers. */
    readonly nonce?: string;
  },
): Assertion | { readonly refused: AssertionRefusal } {
  const refused = (r: AssertionRefusal) => ({ refused: r }) as const;
  if (token.length > ASSERTION_MAX) return refused("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => PART.test(p))) return refused("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = json(h);
  const claims = json(p);
  if (header === undefined || claims === undefined) return refused("malformed");

  if (own(header, "alg") !== "EdDSA") return refused("alg");
  if (own(header, "crit") !== undefined) return refused("alg");
  const kid = own(header, "kid");
  const key = typeof kid === "string" ? o.keys.get(kid) : undefined;
  if (key === undefined) return refused("kid");
  if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) {
    return refused("signature");
  }

  if (own(claims, "iss") !== o.issuer) return refused("iss");
  const aud = own(claims, "aud");
  if (!(aud === o.audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === o.audience))) {
    return refused("aud");
  }
  const exp = own(claims, "exp");
  const iat = own(claims, "iat");
  if (!seconds(exp) || !seconds(iat)) return refused("malformed");
  const now = Math.floor(o.now / 1000);
  if (exp <= now) return refused("expired");
  if (exp - iat > LIFETIME_MAX_S || exp <= iat) return refused("lifetime");
  if (iat > now + SKEW_S) return refused("not_yet");
  const nbf = own(claims, "nbf");
  if (nbf !== undefined && !seconds(nbf)) return refused("malformed");
  if (nbf !== undefined && nbf > now + SKEW_S) return refused("not_yet");

  const sub = own(claims, "sub");
  if (!text(sub)) return refused("sub");
  const name = own(claims, "name");
  if (name !== undefined && !text(name)) return refused("name");
  const jti = own(claims, "jti");
  if (!text(jti)) return refused("jti");
  const sid = own(claims, "sid");
  if (sid !== undefined && !text(sid)) return refused("malformed");

  if (own(claims, "purpose") !== o.purpose) return refused("purpose");
  if (o.purpose === "authorize") {
    const nonce = own(claims, "nonce");
    if (o.nonce === undefined || typeof nonce !== "string" || nonce !== o.nonce) {
      return refused("nonce");
    }
  }
  return { subject: sub, sid, jti, exp, name };
}
