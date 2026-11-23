// The external login's configuration (06-cli §4.1): none of the three settings is the local
// accounts; all three, the external login; some is refused, as is a login address off HTTPS and a
// key file that is not a JWK Set of Ed25519 public keys, a private key in it above all.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_AUDIENCE, TEST_ISSUER, TEST_KEY } from "./external-assertion.fixture.ts";
import { readExternalLoginConfig } from "./external-config.ts";

const dir = mkdtempSync(join(tmpdir(), "saveslot-external-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
const file = (content: string): string => {
  const p = join(dir, `keys-${++files}.json`);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
};
const GOOD = file(JSON.stringify({ keys: [TEST_KEY.public] }));
const LOGIN = "https://platform.example/login";

const read = (o: { issuer?: string; loginUrl?: string; keysFile?: string }) =>
  readExternalLoginConfig({
    issuer: o.issuer,
    loginUrl: o.loginUrl,
    keysFile: o.keysFile,
    audience: TEST_AUDIENCE,
  });

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return `${(e as { code?: string }).code}: ${(e as Error).message}`;
  }
  return "taken";
};

describe("the external login's configuration", () => {
  it("is none when none of the three is set, empty ones included", async () => {
    expect(await read({})).toBeUndefined();
    expect(await read({ issuer: "", loginUrl: "", keysFile: "" })).toBeUndefined();
  });

  it("is taken with all three set", async () => {
    expect(await read({ issuer: TEST_ISSUER, loginUrl: LOGIN, keysFile: GOOD })).toEqual({
      issuer: TEST_ISSUER,
      loginUrl: LOGIN,
      keys: [TEST_KEY.public],
      audience: TEST_AUDIENCE,
    });
  });

  it("with some set and not all is refused, naming what is missing", async () => {
    expect(await refusal(read({ issuer: TEST_ISSUER, loginUrl: LOGIN }))).toMatch(
      /^bad_config: .*missing: SAVESLOT_IDENTITY_KEYS_FILE$/,
    );
    expect(await refusal(read({ keysFile: GOOD }))).toMatch(
      /missing: SAVESLOT_IDENTITY_ISSUER, SAVESLOT_IDENTITY_LOGIN_URL$/,
    );
  });

  it("takes a login address on HTTPS, or on a loopback host over HTTP, only", async () => {
    for (const loginUrl of ["http://platform.example/login", "ftp://x/", "not a url"]) {
      expect(await refusal(read({ issuer: TEST_ISSUER, loginUrl, keysFile: GOOD }))).toMatch(
        /^bad_config: SAVESLOT_IDENTITY_LOGIN_URL/,
      );
    }
    for (const loginUrl of [
      "http://127.0.0.1:8081/login",
      "http://localhost/login",
      "http://[::1]/",
    ]) {
      expect(await refusal(read({ issuer: TEST_ISSUER, loginUrl, keysFile: GOOD }))).toBe("taken");
    }
  });

  it("refuses a key file holding a private key, saying so", async () => {
    const withD = file(JSON.stringify({ keys: [{ ...TEST_KEY.public, d: TEST_KEY.d }] }));
    const r = await refusal(read({ issuer: TEST_ISSUER, loginUrl: LOGIN, keysFile: withD }));
    expect(r).toMatch(/^bad_config: .*private key \(d\)/);
    expect(r).not.toContain(TEST_KEY.d);
  });

  it("refuses a key file open to others, or not a file, as a secret file", async () => {
    const open = file(JSON.stringify({ keys: [TEST_KEY.public] }));
    chmodSync(open, 0o604);
    expect(await refusal(read({ issuer: TEST_ISSUER, loginUrl: LOGIN, keysFile: open }))).toMatch(
      /^bad_config: SAVESLOT_IDENTITY_KEYS_FILE: .*\(open_to_others\)$/,
    );
    const folder = join(dir, "a folder");
    mkdirSync(folder);
    expect(await refusal(read({ issuer: TEST_ISSUER, loginUrl: LOGIN, keysFile: folder }))).toMatch(
      /\(not_a_file\)$/,
    );
    // Readable by its group is fine, as for every secret file.
    const group = file(JSON.stringify({ keys: [TEST_KEY.public] }));
    chmodSync(group, 0o640);
    expect(await refusal(read({ issuer: TEST_ISSUER, loginUrl: LOGIN, keysFile: group }))).toBe(
      "taken",
    );
  });

  it("refuses a key file missing, not JSON, not a JWK Set, or not of Ed25519 public keys", async () => {
    const cases = [
      join(dir, "no such file"),
      file("not json"),
      file(JSON.stringify([TEST_KEY.public])),
      file(JSON.stringify({ keys: [] })),
      file(JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k" }] })),
      file(JSON.stringify({ keys: [TEST_KEY.public, TEST_KEY.public] })),
    ];
    for (const keysFile of cases) {
      expect(await refusal(read({ issuer: TEST_ISSUER, loginUrl: LOGIN, keysFile }))).toMatch(
        /^bad_config: SAVESLOT_IDENTITY_KEYS_FILE/,
      );
    }
  });
});
