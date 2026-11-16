// Local credentials' tokens (docs/zh-CN/spec/04-contract.md §12; 06-cli.md §2 «用户会话凭证», §3.2):
// a user session token (`sls_`) and connection instance tokens (`slt_`). A token is its prefix and
// 32 random bytes in base64url, 43 characters. The control plane keeps only its SHA-256: a token has
// 256 bits of entropy, so a fast hash leaves nothing to guess.
//
// A token never goes into a log, an error message or a result; it is shown once, where it is made.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type TokenKind = "session" | "connection";

const PREFIX: Readonly<Record<TokenKind, string>> = { session: "sls_", connection: "slt_" };
const BODY = 43;

/** A token's form: its prefix and 43 base64url characters, nothing else. */
const FORM = /^(sls|slt)_[A-Za-z0-9_-]{43}$/;

/** A new token of `kind`. */
export function newToken(kind: TokenKind): string {
  const body = randomBytes(32).toString("base64url");
  if (body.length !== BODY) throw new Error("unexpected token length");
  return `${PREFIX[kind]}${body}`;
}

/** The hash the control plane keeps of a token: SHA-256, lower-case hex. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The token of an `Authorization` header, read strictly: `Bearer `, one space, then a token of its
 * form. Anything else is no token (no hash is computed of it).
 */
export function bearerToken(
  header: string | undefined,
): { readonly kind: TokenKind; readonly token: string } | undefined {
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length);
  if (!FORM.test(token)) return undefined;
  return { kind: token.startsWith("sls_") ? "session" : "connection", token };
}

/** Two hashes (hex of the same length) compared in time independent of where they differ. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
