// The external login's configuration (docs/zh-CN/spec/06-cli.md §4.1): the platform's issuer, its
// login address and a file of its public keys. All three set, the server's identity provider is
// the external login; none set, the built-in local accounts; some set and not others is a mistake,
// refused rather than taken as either.
//
// - The login address is `https://`, or `http://` on a loopback host only.
// - The key file is read as a secret file (secret-file.ts: a regular file, nothing for others) and
//   holds a JWK Set
//   of Ed25519 public keys, each with its `kid`. A key with a private part (`d`) refuses the
//   start: the platform's signing key was put on the verifying side.

import type { JsonWebKey } from "node:crypto";
import { assertionKeys } from "./external-assertion.ts";
import { type ExternalLoginConfig, ExternalLoginError } from "./external-identity.ts";
import { readSecretFile, SecretFileError } from "./secret-file.ts";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

const bad = (message: string) => new ExternalLoginError("bad_config", message);

/** Whether `v` is an `https://` URL, or an `http://` one on a loopback host. */
function secureUrl(v: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && LOOPBACK.test(u.hostname)) return u;
  return undefined;
}

/**
 * The external login's configuration from the three settings and this service's public origin;
 * undefined when none of the three is set. Refused (`bad_config`, saying which and why, never a
 * key): some set and not all, a login address not on HTTPS, a key file that cannot be read or is
 * not a JWK Set of Ed25519 public keys.
 */
export async function readExternalLoginConfig(o: {
  /** `SAVESLOT_IDENTITY_ISSUER`. */
  readonly issuer: string | undefined;
  /** `SAVESLOT_IDENTITY_LOGIN_URL`. */
  readonly loginUrl: string | undefined;
  /** `SAVESLOT_IDENTITY_KEYS_FILE`. */
  readonly keysFile: string | undefined;
  /** This service's public origin (`SAVESLOT_PUBLIC_URL`). */
  readonly audience: string;
}): Promise<ExternalLoginConfig | undefined> {
  const set = {
    SAVESLOT_IDENTITY_ISSUER: o.issuer,
    SAVESLOT_IDENTITY_LOGIN_URL: o.loginUrl,
    SAVESLOT_IDENTITY_KEYS_FILE: o.keysFile,
  };
  const given = Object.entries(set).filter(([, v]) => v !== undefined && v !== "");
  if (given.length === 0) return undefined;
  if (given.length < 3) {
    const missing = Object.entries(set)
      .filter(([, v]) => v === undefined || v === "")
      .map(([k]) => k);
    throw bad(
      `the external login takes all of SAVESLOT_IDENTITY_ISSUER, SAVESLOT_IDENTITY_LOGIN_URL and SAVESLOT_IDENTITY_KEYS_FILE, or none; missing: ${missing.join(", ")}`,
    );
  }
  const issuer = o.issuer as string;
  const loginUrl = o.loginUrl as string;
  if (secureUrl(loginUrl) === undefined) {
    throw bad("SAVESLOT_IDENTITY_LOGIN_URL is https://, or http:// on a loopback host only");
  }

  let text: string;
  try {
    text = await readSecretFile(o.keysFile as string);
  } catch (e) {
    if (e instanceof SecretFileError) {
      throw bad(`SAVESLOT_IDENTITY_KEYS_FILE: ${e.message} (${e.code})`);
    }
    throw bad("SAVESLOT_IDENTITY_KEYS_FILE cannot be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw bad("SAVESLOT_IDENTITY_KEYS_FILE is not JSON");
  }
  const keys = (parsed as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "object" || k === null)) {
    throw bad('SAVESLOT_IDENTITY_KEYS_FILE is not a JWK Set ({"keys": [...]})');
  }
  if ((keys as JsonWebKey[]).some((k) => Object.hasOwn(k, "d"))) {
    throw bad(
      "SAVESLOT_IDENTITY_KEYS_FILE holds a private key (d): the platform's signing key belongs on the platform; give the server its public keys only",
    );
  }
  try {
    assertionKeys(keys as JsonWebKey[]);
  } catch (e) {
    throw bad(`SAVESLOT_IDENTITY_KEYS_FILE: ${(e as Error).message}`);
  }
  return { issuer, loginUrl, keys: keys as JsonWebKey[], audience: o.audience };
}
