// An identity assertion of the external login verified (02-architecture §12): one good assertion
// for each purpose, then each way one is refused, one case each — a wrong signature, another
// `alg`, an unknown `kid`, `crit`, the wrong `iss` or `aud`, expired, valid too long, issued in the
// future, `sub` too long or with a control character, a purpose used in the other's place, a
// `nonce` of another login, and what is not an assertion at all. Fictional accounts.

import { describe, expect, it } from "vitest";
import {
  GOOD_HEADER,
  goodClaims,
  OTHER_KEY,
  signAssertion,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY,
} from "./external-assertion.fixture.ts";
import {
  ASSERTION_MAX,
  type AssertionRefusal,
  assertionKeys,
  type Purpose,
  verifyAssertion,
} from "./external-assertion.ts";

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const keys = assertionKeys([TEST_KEY.public]);

const check = (token: string, purpose: Purpose = "authorize", nonce: string | undefined = "st") =>
  verifyAssertion(token, {
    keys,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    now: NOW,
    purpose,
    ...(nonce === undefined ? {} : { nonce }),
  });

const refusal = (r: ReturnType<typeof check>): AssertionRefusal | "taken" =>
  "refused" in r ? r.refused : "taken";

/** An authorize assertion for state `st`, changed by `edit`. */
const authorize = (
  edit: (c: Record<string, unknown>) => Record<string, unknown> = (c) => c,
  header: Record<string, unknown> = GOOD_HEADER,
) => signAssertion(header, edit(goodClaims(NOW, { purpose: "authorize", nonce: "st" })));

describe("an identity assertion", () => {
  it("of the login's return is taken, with its account, session, jti, expiry and name", () => {
    const r = check(authorize((c) => ({ ...c, name: "Ada L." })));
    expect(r).toMatchObject({ subject: "acct_1", sid: "sess_1", name: "Ada L." });
    expect("jti" in r && r.exp - Math.floor(NOW / 1000)).toBe(60);
  });

  it("for a session is taken without a nonce", () => {
    const t = signAssertion(GOOD_HEADER, goodClaims(NOW, { purpose: "session" }));
    expect(refusal(check(t, "session", undefined))).toBe("taken");
  });

  it("signed by a key not configured, or changed after signing, is refused", () => {
    expect(
      refusal(
        check(
          signAssertion(
            GOOD_HEADER,
            goodClaims(NOW, { purpose: "authorize", nonce: "st" }),
            OTHER_KEY,
          ),
        ),
      ),
    ).toBe("signature");
    const [h, p, s] = authorize().split(".") as [string, string, string];
    const other = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "acct_2" }),
    ).toString("base64url");
    expect(refusal(check(`${h}.${other}.${s}`))).toBe("signature");
  });

  it("with another alg, none included, or with crit, is refused", () => {
    for (const alg of ["none", "HS256", "RS256", "ES256", "eddsa"]) {
      expect(refusal(check(authorize(undefined, { ...GOOD_HEADER, alg })))).toBe("alg");
    }
    expect(refusal(check(authorize(undefined, { ...GOOD_HEADER, crit: ["exp"] })))).toBe("alg");
  });

  it("naming a key not configured, or none, is refused", () => {
    expect(refusal(check(authorize(undefined, { ...GOOD_HEADER, kid: OTHER_KEY.kid })))).toBe(
      "kid",
    );
    expect(refusal(check(authorize(undefined, { alg: "EdDSA" })))).toBe("kid");
  });

  it("from another issuer, or for another audience, is refused", () => {
    expect(refusal(check(authorize((c) => ({ ...c, iss: "https://evil.example" }))))).toBe("iss");
    expect(refusal(check(authorize((c) => ({ ...c, aud: "https://other.example" }))))).toBe("aud");
    expect(refusal(check(authorize((c) => ({ ...c, aud: [TEST_AUDIENCE, "x"] }))))).toBe("aud");
    expect(refusal(check(authorize((c) => ({ ...c, aud: [TEST_AUDIENCE] }))))).toBe("taken");
  });

  it("expired, valid for longer than 120 s, or issued more than 30 s ahead, is refused", () => {
    const now = Math.floor(NOW / 1000);
    expect(refusal(check(authorize((c) => ({ ...c, iat: now - 60, exp: now }))))).toBe("expired");
    expect(refusal(check(authorize((c) => ({ ...c, iat: now, exp: now + 121 }))))).toBe("lifetime");
    expect(refusal(check(authorize((c) => ({ ...c, iat: now, exp: now + 120 }))))).toBe("taken");
    expect(refusal(check(authorize((c) => ({ ...c, iat: now + 31, exp: now + 90 }))))).toBe(
      "not_yet",
    );
    expect(refusal(check(authorize((c) => ({ ...c, iat: now + 30, exp: now + 90 }))))).toBe(
      "taken",
    );
  });

  it("not valid before a time more than 30 s ahead, or with an nbf that is not a time, is refused", () => {
    const now = Math.floor(NOW / 1000);
    expect(refusal(check(authorize((c) => ({ ...c, nbf: now + 31 }))))).toBe("not_yet");
    expect(refusal(check(authorize((c) => ({ ...c, nbf: now + 30 }))))).toBe("taken");
    expect(refusal(check(authorize((c) => ({ ...c, nbf: now - 60 }))))).toBe("taken");
    expect(refusal(check(authorize((c) => ({ ...c, nbf: String(now) }))))).toBe("malformed");
  });

  it("with an account ID too long, empty or with a control character, is refused", () => {
    expect(refusal(check(authorize((c) => ({ ...c, sub: "a".repeat(129) }))))).toBe("sub");
    expect(refusal(check(authorize((c) => ({ ...c, sub: "a".repeat(128) }))))).toBe("taken");
    expect(refusal(check(authorize((c) => ({ ...c, sub: "" }))))).toBe("sub");
    expect(refusal(check(authorize((c) => ({ ...c, sub: "a\nb" }))))).toBe("sub");
    expect(refusal(check(authorize((c) => ({ ...c, sub: 7 }))))).toBe("sub");
    expect(refusal(check(authorize((c) => ({ ...c, name: "n".repeat(129) }))))).toBe("name");
  });

  it("without a jti is refused", () => {
    expect(refusal(check(authorize(({ jti: _, ...c }) => c)))).toBe("jti");
  });

  it("of one purpose is refused where the other is taken", () => {
    const session = signAssertion(GOOD_HEADER, goodClaims(NOW, { purpose: "session" }));
    expect(refusal(check(session, "authorize"))).toBe("purpose");
    expect(refusal(check(authorize(), "session", undefined))).toBe("purpose");
  });

  it("answering another login's state is refused", () => {
    expect(refusal(check(authorize(), "authorize", "another state"))).toBe("nonce");
    expect(refusal(check(authorize(({ nonce: _, ...c }) => c)))).toBe("nonce");
  });

  it("that is not an assertion at all, or too long to read, is refused", () => {
    for (const t of ["", "a.b", "a.b.c.d", "!!.??.**", "e30.e30.e30"]) {
      expect(["malformed", "kid", "alg"]).toContain(refusal(check(t)));
    }
    expect(refusal(check(`${authorize()}${"A".repeat(ASSERTION_MAX)}`))).toBe("malformed");
  });

  it("takes keys only as Ed25519 public keys, each with a kid of its own", () => {
    expect(() => assertionKeys([])).toThrow();
    expect(() => assertionKeys([{ ...TEST_KEY.public, kid: undefined }])).toThrow();
    expect(() => assertionKeys([TEST_KEY.public, TEST_KEY.public])).toThrow();
    expect(() => assertionKeys([{ ...TEST_KEY.public, d: TEST_KEY.d }])).toThrow();
    expect(() => assertionKeys([{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k" }])).toThrow();
  });
});
