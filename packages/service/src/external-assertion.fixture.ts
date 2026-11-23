// Identity assertions for tests, signed with fixed test keys: the platform's side of the external
// login, without the platform.

import { createHash, createPrivateKey, createPublicKey, type JsonWebKey, sign } from "node:crypto";

/**
 * A fixed test key: its private part, an Ed25519 seed, is the SHA-256 of `phrase`, so the same key
 * every run and no key material in the repository.
 */
function testKey(kid: string, phrase: string) {
  const seed = createHash("sha256").update(phrase).digest();
  // PKCS #8 for an Ed25519 private key: this fixed prefix, then the 32-byte seed (RFC 8410).
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const { kty, crv, x } = createPublicKey(priv).export({ format: "jwk" });
  return {
    kid,
    public: { kty, crv, x, kid } as JsonWebKey,
    d: seed.toString("base64url"),
  } as const;
}

/** The platform's signing key in the tests, as the server is configured with it. */
export const TEST_KEY = testKey("test-1", "saveslot external login test key 1");

/** A second key: not in the configuration (a signature it makes is a wrong one). */
export const OTHER_KEY = testKey("test-2", "saveslot external login test key 2");

export const TEST_ISSUER = "https://platform.example";
export const TEST_AUDIENCE = "https://saveslot.example";

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

/**
 * An assertion signed with `key` (the test key unless said): `header` and `claims` are written as
 * given, so a test can make any of them wrong.
 */
export function signAssertion(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: { readonly public: JsonWebKey; readonly d: string } = TEST_KEY,
): string {
  const input = `${b64(header)}.${b64(claims)}`;
  const priv = createPrivateKey({ key: { ...key.public, d: key.d }, format: "jwk" });
  return `${input}.${sign(null, Buffer.from(input), priv).toString("base64url")}`;
}

let jtis = 0;

/** The claims of a good assertion at `nowMs`, for a purpose; `nonce` given for `authorize`. */
export function goodClaims(
  nowMs: number,
  o: { readonly purpose: "authorize" | "session"; readonly nonce?: string; readonly sub?: string },
): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: o.sub ?? "acct_1",
    sid: "sess_1",
    iat,
    exp: iat + 60,
    jti: `jti-${++jtis}-${iat}`,
    purpose: o.purpose,
    ...(o.nonce === undefined ? {} : { nonce: o.nonce }),
  };
}

export const GOOD_HEADER = { alg: "EdDSA", kid: TEST_KEY.kid, typ: "JWT" } as const;
