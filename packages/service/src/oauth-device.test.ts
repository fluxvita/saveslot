// The device authorization grant on a real database, on either backend (02-architecture §11
// «测试矩阵»; `pnpm test:postgres` runs this file on PostgreSQL): only the CLI starts one; a poll is
// pending until the user answers, slowed down when it comes too soon, expired after 10 minutes,
// denied when the user denies; approved, it gives a CLI sign-in once. User codes: their letters,
// and how a typed one is read. Fictional IDs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import { type OAuthTestBed, oauthTestBed } from "./oauth.fixture.ts";
import {
  answerDeviceCode,
  DEVICE_CODE_SECONDS,
  type DeviceAuthorizationResponse,
  newUserCode,
  readUserCode,
  redeemDeviceCode,
  startDeviceAuthorization,
} from "./oauth-device.ts";
import { ACCESS_TOKEN_SECONDS, CLI_SIGN_IN_SECONDS, TokenError } from "./oauth-server.ts";
import { tokenHash } from "./tokens.ts";

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-oauth-device-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXT = "https://saveslot.example";
const TENANT = `tn_${"6".repeat(26)}` as const;
const USER = `u_${"3".repeat(26)}` as const;
const NOW = "2026-11-21T08:00:00.000Z";
const later = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

let bed: OAuthTestBed;
beforeAll(async () => {
  bed = await oauthTestBed({
    backend: testBackend(),
    dir: root,
    tenant: TENANT,
    user: USER,
    now: NOW,
    external: EXT,
    fetchClient: async () => {
      throw new Error("no client document is fetched here");
    },
  });
}, T);
afterAll(async () => {
  await bed?.close();
}, T);
/** The login codes are approved under. */
const LOGIN = "login-d";
beforeEach(async () => {
  bed.logins.clear();
  bed.logins.set(LOGIN, USER);
  bed.inactive.clear();
  await bed.control.write((tx) =>
    tx.exec(
      "DELETE FROM oauth_device_codes; DELETE FROM oauth_refresh_tokens; " +
        "DELETE FROM credentials; DELETE FROM oauth_grants",
    ),
  );
});

const start = (o: Record<string, string> = {}, at = NOW) =>
  startDeviceAuthorization(bed.deps, new URLSearchParams({ client_id: "saveslot-cli", ...o }), at);
const poll = (d: DeviceAuthorizationResponse, at: string, o: Record<string, string> = {}) =>
  redeemDeviceCode(
    bed.deps,
    new URLSearchParams({
      grant_type: GRANT,
      device_code: d.device_code,
      client_id: "saveslot-cli",
      ...o,
    }),
    at,
  );
const answer = (d: DeviceAuthorizationResponse, approved: boolean, at = later(1)) =>
  answerDeviceCode(bed.deps, {
    userCode: readUserCode(d.user_code) as string,
    approved,
    user: USER,
    login: LOGIN,
    tenant: TENANT,
    now: at,
  });

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TokenError) return e.code;
    throw e;
  }
  throw new Error("not refused");
}

const interval = async (d: DeviceAuthorizationResponse) =>
  Number(
    (
      await bed.control.read((tx) =>
        tx.query<{ interval_s: number }>(
          "SELECT interval_s FROM oauth_device_codes WHERE device_hash = $1",
          [tokenHash(d.device_code)],
        ),
      )
    ).rows[0]?.interval_s,
  );

describe("user codes", () => {
  it("8 letters of the 20 consonants; read whatever the case, dashes and spaces", () => {
    for (let i = 0; i < 200; i++) expect(newUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    expect(readUserCode("bcdf-ghjk")).toBe("BCDFGHJK");
    expect(readUserCode(" BCDF GHJK ")).toBe("BCDFGHJK");
    expect(readUserCode("BCDF-GHJA")).toBeUndefined(); // a vowel
    expect(readUserCode("BCDF-GHJ")).toBeUndefined();
    expect(readUserCode("BCDF-GHJKL")).toBeUndefined();
    expect(readUserCode("")).toBeUndefined();
  });
});

describe("starting a device authorization", () => {
  it(
    "the CLI's: a device code, a user code shown with its dash, the page, 10 minutes, every 5 seconds",
    async () => {
      const d = await start({ resource: EXT });
      expect(d).toEqual({
        device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        user_code: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
        verification_uri: `${EXT}/oauth/device/verify`,
        verification_uri_complete: `${EXT}/oauth/device/verify?user_code=${d.user_code}`,
        expires_in: DEVICE_CODE_SECONDS,
        interval: 5,
      });
      // Stored by its hash only.
      const rows = await bed.control.read((tx) =>
        tx.query<{ device_hash: string; user_code: string; state: string }>(
          "SELECT device_hash, user_code, state FROM oauth_device_codes",
        ),
      );
      expect(rows.rows).toEqual([
        {
          device_hash: tokenHash(d.device_code),
          user_code: d.user_code.replace("-", ""),
          state: "pending",
        },
      ]);
    },
    T,
  );

  it(
    "another client: invalid_client; none: invalid_request; a resource not this server's: invalid_target",
    async () => {
      expect(await refused(start({ client_id: "https://client.example/c.json" }))).toBe(
        "invalid_client",
      );
      expect(await refused(startDeviceAuthorization(bed.deps, new URLSearchParams(), NOW))).toBe(
        "invalid_request",
      );
      expect(await refused(start({ resource: "https://elsewhere.example" }))).toBe(
        "invalid_target",
      );
    },
    T,
  );
});

describe("sweeping", () => {
  it(
    "the sweep deletes a device code once it has expired, not before",
    async () => {
      await start();
      const rows = async () =>
        (await bed.control.read((tx) => tx.query("SELECT 1 FROM oauth_device_codes"))).rows.length;
      await bed.oauth.sweep(later(DEVICE_CODE_SECONDS - 1));
      expect(await rows()).toBe(1);
      await bed.oauth.sweep(later(DEVICE_CODE_SECONDS));
      expect(await rows()).toBe(0);
    },
    T,
  );
});

describe("polling", () => {
  it(
    "pending until answered; too soon: slow_down, the interval 5 seconds longer each time",
    async () => {
      const d = await start();
      expect(await refused(poll(d, later(5)))).toBe("authorization_pending");
      expect(await refused(poll(d, later(6)))).toBe("slow_down");
      expect(await interval(d)).toBe(10);
      // 10 seconds after the poll before: pending again, the interval kept.
      expect(await refused(poll(d, later(16)))).toBe("authorization_pending");
      expect(await refused(poll(d, later(20)))).toBe("slow_down");
      expect(await interval(d)).toBe(15);
    },
    T,
  );

  it(
    "approved: the CLI's sign-in, once; then the device code is gone",
    async () => {
      const d = await start();
      expect(await answer(d, true)).toBe(true);
      const r = await poll(d, later(10));
      expect(r).toEqual({
        access_token: expect.stringMatching(/^sls_[A-Za-z0-9_-]{43}$/),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_SECONDS,
        scope: "saveslot.read saveslot.write saveslot.schema saveslot.delete",
        refresh_token: expect.stringMatching(/^slr_[A-Za-z0-9_-]{43}$/),
      });
      const cred = await bed.cp.credential(tokenHash(r.access_token));
      expect(cred).toMatchObject({
        kind: "session",
        principal: USER,
        tenant: TENANT,
        expiresAt: later(10 + ACCESS_TOKEN_SECONDS),
      });
      expect(await bed.oauth.grant(cred?.grant as string)).toMatchObject({
        kind: "session",
        principal: USER,
        tenant: TENANT,
        clientId: "saveslot-cli",
        resource: EXT,
        createdAt: later(10),
      });
      expect(await bed.oauth.refreshToken(tokenHash(r.refresh_token))).toMatchObject({
        grant: cred?.grant,
        grantExpiresAt: later(10 + CLI_SIGN_IN_SECONDS),
      });
      expect(await refused(poll(d, later(20)))).toBe("invalid_grant");
    },
    T,
  );

  it(
    "approved under a login that ended before the poll: invalid_grant, nothing issued, the grant void",
    async () => {
      const d = await start();
      expect(await answer(d, true)).toBe(true);
      // Signed out, its password changed or expired: the provider issues nothing from it.
      bed.logins.delete(LOGIN);
      expect(await refused(poll(d, later(10)))).toBe("invalid_grant");
      const left = await bed.control.read((tx) =>
        tx.query<{ voided_at: string | null; creds: number; refresh: number }>(
          `SELECT g.voided_at,
                  (SELECT count(*)::int FROM credentials) AS creds,
                  (SELECT count(*)::int FROM oauth_refresh_tokens) AS refresh
             FROM oauth_grants g`,
        ),
      );
      expect(left.rows).toEqual([{ voided_at: later(10), creds: 0, refresh: 0 }]);
      // The device code was taken: it does not come back.
      expect(await refused(poll(d, later(20)))).toBe("invalid_grant");
    },
    T,
  );

  it(
    "approved, then the account disabled before the poll: invalid_grant, the grant void",
    async () => {
      const d = await start();
      expect(await answer(d, true)).toBe(true);
      bed.inactive.add(USER);
      expect(await refused(poll(d, later(10)))).toBe("invalid_grant");
      const g = await bed.control.read((tx) =>
        tx.query<{ voided_at: string | null; refresh: number }>(
          "SELECT g.voided_at, (SELECT count(*)::int FROM oauth_refresh_tokens) AS refresh FROM oauth_grants g",
        ),
      );
      expect(g.rows).toEqual([{ voided_at: later(10), refresh: 0 }]);
    },
    T,
  );

  it(
    "approved under one login, the user's other login still going: the one that approved counts",
    async () => {
      const d = await start();
      expect(await answer(d, true)).toBe(true);
      bed.logins.delete(LOGIN);
      bed.logins.set("login-other", USER);
      expect(await refused(poll(d, later(10)))).toBe("invalid_grant");
    },
    T,
  );

  it(
    "denied: access_denied, and so again",
    async () => {
      const d = await start();
      expect(await answer(d, false)).toBe(true);
      expect(await refused(poll(d, later(10)))).toBe("access_denied");
      expect(await refused(poll(d, later(20)))).toBe("access_denied");
    },
    T,
  );

  it(
    "after 10 minutes: expired_token, before slow_down; and it can no longer be answered",
    async () => {
      const d = await start();
      expect(await refused(poll(d, later(DEVICE_CODE_SECONDS - 1)))).toBe("authorization_pending");
      expect(await refused(poll(d, later(DEVICE_CODE_SECONDS)))).toBe("expired_token");
      expect(await answer(d, true, later(DEVICE_CODE_SECONDS))).toBe(false);
    },
    T,
  );

  it(
    "another client: invalid_client, and the code stays pending; an unknown device code: invalid_grant",
    async () => {
      const d = await start();
      expect(await refused(poll(d, later(5), { client_id: "https://client.example/c.json" }))).toBe(
        "invalid_client",
      );
      expect(await refused(poll(d, later(10)))).toBe("authorization_pending");
      expect(await refused(poll({ ...d, device_code: "A".repeat(43) }, later(15)))).toBe(
        "invalid_grant",
      );
    },
    T,
  );
});

describe("answering", () => {
  it(
    "once: a second answer, or one for a code never given, finds nothing",
    async () => {
      const d = await start();
      expect(await answer(d, true)).toBe(true);
      expect(await answer(d, false)).toBe(false);
      expect(
        await answerDeviceCode(bed.deps, {
          userCode: "BCDFGHJK",
          approved: true,
          user: USER,
          login: LOGIN,
          tenant: TENANT,
          now: later(1),
        }),
      ).toBe(false);
      // The first answer stands.
      await poll(d, later(10));
    },
    T,
  );
});
