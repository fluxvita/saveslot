// Refresh tokens and the revocation endpoint on a real database, on either backend (02-architecture
// §11 «测试矩阵»; `pnpm test:postgres` runs this file on PostgreSQL): a redemption gives a refresh
// token; exchanging it gives the same principal a new pair and uses it up; a used one presented
// again revokes the connection as `system` and voids the grant (log first, then void, and what
// holds when stopped in between); two exchanges at once; expiries, the client, the principal's
// state; and RFC 7009 revocation both ways. Fictional IDs and clients.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpsContext, revokeConnection } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import { principalFromRow, principalRow } from "./auth.ts";
import type { ConnectionId } from "./control-plane.ts";
import { type OAuthTestBed, oauthTestBed } from "./oauth.fixture.ts";
import { CLI_CLIENT, type OAuthClient } from "./oauth-client.ts";
import { exchangeRefreshToken, revokeToken } from "./oauth-refresh.ts";
import {
  ACCESS_TOKEN_SECONDS,
  CLI_SIGN_IN_SECONDS,
  issueCode,
  type OAuthDeps,
  REFRESH_TOKEN_SECONDS,
  redeemCode,
  TokenError,
  type TokenResponse,
} from "./oauth-server.ts";
import { openOAuthStore } from "./oauth-store.ts";
import { revokeServerConnection } from "./server-connections.ts";
import { openControlPlane } from "./server-control-plane.ts";
import { tokenHash } from "./tokens.ts";

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-oauth-refresh-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXT = "https://saveslot.example";
const TENANT = `tn_${"7".repeat(26)}` as const;
const USER = `u_${"2".repeat(26)}` as const;
const NOW = "2026-11-21T08:00:00.000Z";
const later = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();
const DAY = 24 * 60 * 60;
const ID = "https://client.example/oauth/client.json";
const OTHER = "https://other.example/oauth/client.json";
const CLIENT: OAuthClient = {
  id: ID,
  name: "Example Agent",
  host: "client.example",
  redirectUris: ["https://client.example/callback"],
  builtIn: false,
};
const CLI_REDIRECT = "http://127.0.0.1:49152/callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

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

/** The login the CLI's codes are consented under. */
const LOGIN = "login-r";
beforeEach(async () => {
  bed.logins.clear();
  bed.logins.set(LOGIN, USER);
  bed.sessionsEnded.clear();
  bed.inactive.clear();
  await bed.control.write((tx) =>
    tx.exec(
      "DELETE FROM oauth_codes; DELETE FROM oauth_refresh_tokens; DELETE FROM oauth_grants; " +
        "DELETE FROM credentials",
    ),
  );
});

const deps = (): OAuthDeps => bed.deps;
let names = 0;

/** A redeemed authorization: a connection instance's, or the CLI's sign-in. */
async function signedIn(o: { readonly cli?: boolean; readonly at?: string } = {}) {
  const at = o.at ?? NOW;
  const cli = o.cli === true;
  const c = await issueCode(deps(), {
    client: cli ? CLI_CLIENT : CLIENT,
    redirectUri: cli ? CLI_REDIRECT : (CLIENT.redirectUris[0] as string),
    codeChallenge: CHALLENGE,
    resource: EXT,
    user: USER,
    login: LOGIN,
    tenant: TENANT,
    scopes: cli ? [] : ["saveslot.read", "saveslot.write"],
    ...(cli ? {} : { name: `Phone · Agent ${names++}` }),
    now: at,
  });
  const f = new URLSearchParams({
    grant_type: "authorization_code",
    code: c,
    code_verifier: VERIFIER,
    client_id: cli ? "saveslot-cli" : ID,
    redirect_uri: cli ? CLI_REDIRECT : (CLIENT.redirectUris[0] as string),
  });
  const r = await redeemCode(deps(), f, at);
  const cred = await bed.cp.credential(tokenHash(r.access_token));
  return { ...r, principal: cred?.principal as string, grant: cred?.grant as string };
}

const refreshForm = (token: string, o: Record<string, string> = {}) =>
  new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: ID, ...o });
const cliForm = (token: string) => refreshForm(token, { client_id: "saveslot-cli" });

const exchange = (
  form: URLSearchParams,
  at: string,
  hooks: Parameters<typeof exchangeRefreshToken>[3] = {},
  d: OAuthDeps = deps(),
) => exchangeRefreshToken(d, form, at, hooks);

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TokenError) return e.code;
    throw e;
  }
  throw new Error("not refused");
}

/** How an access token authenticates now: the principal, or why not. */
async function authenticates(token: string): Promise<string> {
  const cred = await bed.cp.credential(tokenHash(token));
  if (cred === undefined) return "invalid";
  const row = await principalRow(bed.tenant, cred.principal);
  const p = principalFromRow(cred.kind, cred.principal, row);
  return "code" in p ? p.reason : p.actor;
}

/** The headers of the tenant's `principal.revoked` events for this principal, in order. */
async function revocations(principal: string): Promise<Record<string, unknown>[]> {
  const r = await bed.tenant.read((tx) =>
    tx.query<{ header: string }>(
      `SELECT e.header FROM events e JOIN content p ON p.seq = e.seq AND p.path = 'principal'
        WHERE e.type = 'principal.revoked' AND p.body::text LIKE $1 ORDER BY e.seq`,
      [`%${principal}%`],
    ),
  );
  return r.rows.map((x) => JSON.parse(String(x.header)) as Record<string, unknown>);
}

const refreshRows = async (grant: string) =>
  Number(
    (
      await bed.control.read((tx) =>
        tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE grant_id = $1",
          [grant],
        ),
      )
    ).rows[0]?.n,
  );

const voidedAt = async (grant: string) => (await bed.oauth.grant(grant))?.voidedAt;

const userCtx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: later(10),
    confirmation: null,
  });

describe("a redemption gives a refresh token", () => {
  it(
    "recorded with the grant: 30 days unused; a connection's has no total limit",
    async () => {
      const s = await signedIn();
      expect(s.refresh_token).toMatch(/^slr_[A-Za-z0-9_-]{43}$/);
      expect(await bed.oauth.refreshToken(tokenHash(s.refresh_token))).toEqual({
        hash: tokenHash(s.refresh_token),
        grant: s.grant,
        issuedAt: NOW,
        expiresAt: later(REFRESH_TOKEN_SECONDS),
      });
    },
    T,
  );

  it(
    "the CLI's: its sign-in lasts 90 days at most",
    async () => {
      const s = await signedIn({ cli: true });
      expect(await bed.oauth.refreshToken(tokenHash(s.refresh_token))).toMatchObject({
        grant: s.grant,
        grantExpiresAt: later(CLI_SIGN_IN_SECONDS),
      });
    },
    T,
  );
});

describe("exchanging a refresh token", () => {
  it(
    "the same connection instance and grant, a new pair; the old refresh token used up",
    async () => {
      const s = await signedIn();
      const r = await exchange(refreshForm(s.refresh_token), later(60));
      expect(r).toEqual({
        access_token: expect.stringMatching(/^slt_[A-Za-z0-9_-]{43}$/),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_SECONDS,
        scope: "saveslot.read saveslot.write",
        refresh_token: expect.stringMatching(/^slr_[A-Za-z0-9_-]{43}$/),
      });
      expect(await bed.cp.credential(tokenHash(r.access_token))).toEqual({
        hash: tokenHash(r.access_token),
        kind: "connection",
        principal: s.principal,
        tenant: TENANT,
        expiresAt: later(60 + ACCESS_TOKEN_SECONDS),
        grant: s.grant,
      });
      expect(await bed.oauth.refreshToken(tokenHash(s.refresh_token))).toMatchObject({
        replacedBy: tokenHash(r.refresh_token),
      });
      expect(await bed.oauth.refreshToken(tokenHash(r.refresh_token))).toEqual({
        hash: tokenHash(r.refresh_token),
        grant: s.grant,
        issuedAt: later(60),
        expiresAt: later(60 + REFRESH_TOKEN_SECONDS),
      });
      // The first access token still works: an exchange is not a revocation.
      expect(await authenticates(s.access_token)).toBe(s.principal);
      expect(await authenticates(r.access_token)).toBe(s.principal);
    },
    T,
  );

  it(
    "the CLI's: the same user signed in again, the limit carried forward",
    async () => {
      const s = await signedIn({ cli: true });
      const r = await exchange(cliForm(s.refresh_token), later(60));
      expect(r.access_token).toMatch(/^sls_/);
      expect(r.scope).toBe("saveslot.read saveslot.write saveslot.schema saveslot.delete");
      expect(await bed.cp.credential(tokenHash(r.access_token))).toMatchObject({
        kind: "session",
        principal: USER,
        grant: s.grant,
      });
      expect(await bed.oauth.refreshToken(tokenHash(r.refresh_token))).toMatchObject({
        grantExpiresAt: later(CLI_SIGN_IN_SECONDS),
      });
    },
    T,
  );

  it(
    "unknown, or not of a refresh token's form: invalid_grant",
    async () => {
      expect(await refused(exchange(refreshForm(`slr_${"A".repeat(43)}`), NOW))).toBe(
        "invalid_grant",
      );
      expect(await refused(exchange(refreshForm("not a token"), NOW))).toBe("invalid_grant");
      expect(
        await refused(exchange(new URLSearchParams({ grant_type: "refresh_token" }), NOW)),
      ).toBe("invalid_request");
    },
    T,
  );

  it(
    "unused for 30 days: invalid_grant; the day before, it works",
    async () => {
      const a = await signedIn();
      expect(
        await refused(exchange(refreshForm(a.refresh_token), later(REFRESH_TOKEN_SECONDS))),
      ).toBe("invalid_grant");
      const b = await signedIn();
      await exchange(refreshForm(b.refresh_token), later(REFRESH_TOKEN_SECONDS - DAY));
    },
    T,
  );

  it(
    "a CLI sign-in past its 90 days: invalid_grant, though each token was used within 30",
    async () => {
      const s = await signedIn({ cli: true });
      let token = s.refresh_token;
      for (const day of [29, 58, 87]) {
        token = (await exchange(cliForm(token), later(day * DAY))).refresh_token;
      }
      expect(await refused(exchange(cliForm(token), later(CLI_SIGN_IN_SECONDS)))).toBe(
        "invalid_grant",
      );
    },
    T,
  );

  it(
    "another client_id: invalid_grant, and the token still good for its own client",
    async () => {
      const s = await signedIn();
      expect(
        await refused(exchange(refreshForm(s.refresh_token, { client_id: OTHER }), later(1))),
      ).toBe("invalid_grant");
      await exchange(refreshForm(s.refresh_token), later(2));
    },
    T,
  );

  it(
    "a resource not the grant's: invalid_target; the grant's, with a trailing slash, or its /mcp, accepted",
    async () => {
      const s = await signedIn();
      expect(
        await refused(
          exchange(refreshForm(s.refresh_token, { resource: "https://elsewhere.example" }), NOW),
        ),
      ).toBe("invalid_target");
      const t = await exchange(refreshForm(s.refresh_token, { resource: `${EXT}/` }), later(1));
      await exchange(refreshForm(t.refresh_token, { resource: `${EXT}/mcp` }), later(2));
    },
    T,
  );

  it(
    "a connection revoked with its refresh token left behind (a clean-up that failed): invalid_grant",
    async () => {
      const s = await signedIn();
      await revokeConnection(bed.tenant, userCtx(), { id: s.principal as ConnectionId });
      expect(await refreshRows(s.grant)).toBe(1);
      expect(await refused(exchange(refreshForm(s.refresh_token), later(20)))).toBe(
        "invalid_grant",
      );
      // Nothing issued, nothing exchanged.
      expect(await bed.oauth.refreshToken(tokenHash(s.refresh_token))).not.toHaveProperty(
        "replacedBy",
      );
      const creds = await bed.control.read((tx) =>
        tx.query("SELECT 1 FROM credentials WHERE grant_id = $1", [s.grant]),
      );
      expect(creds.rows).toHaveLength(1);
    },
    T,
  );

  it(
    "a CLI user whose sessions were ended since the sign-in (a password change): invalid_grant, the grant void",
    async () => {
      const s = await signedIn({ cli: true });
      // Ended after the grant was made, before this refresh.
      bed.sessionsEnded.set(USER, later(5));
      expect(await refused(exchange(cliForm(s.refresh_token), later(10)))).toBe("invalid_grant");
      expect(await voidedAt(s.grant)).toBe(later(10));
      expect(await refreshRows(s.grant)).toBe(0);
      expect(await authenticates(s.access_token)).toBe("invalid");
    },
    T,
  );

  it(
    "a CLI user disabled: invalid_grant while disabled, the grant kept; enabled, the same token works",
    async () => {
      const s = await signedIn({ cli: true });
      bed.inactive.add(USER);
      expect(await refused(exchange(cliForm(s.refresh_token), later(10)))).toBe("invalid_grant");
      expect(await voidedAt(s.grant)).toBeUndefined();
      expect(await refreshRows(s.grant)).toBe(1);
      bed.inactive.delete(USER);
      const r = await exchange(cliForm(s.refresh_token), later(20));
      expect(r.access_token).toMatch(/^sls_/);
      expect(await authenticates(r.access_token)).toBe(USER);
    },
    T,
  );

  it(
    "a CLI sign-in made after its user's sessions were ended refreshes as usual",
    async () => {
      bed.sessionsEnded.set(USER, NOW);
      const s = await signedIn({ cli: true, at: later(1) });
      const r = await exchange(cliForm(s.refresh_token), later(10));
      expect(r.access_token).toMatch(/^sls_/);
      expect(await voidedAt(s.grant)).toBeUndefined();
    },
    T,
  );

  it(
    "a refresh token of a voided grant, its row left behind by a race: invalid_grant, nothing issued",
    async () => {
      const s = await signedIn({ cli: true });
      const row = await bed.control.read((tx) =>
        tx.query<{ issued_at: string; expires_at: string; grant_expires_at: string | null }>(
          "SELECT issued_at, expires_at, grant_expires_at FROM oauth_refresh_tokens WHERE hash = $1",
          [tokenHash(s.refresh_token)],
        ),
      );
      await bed.oauth.voidGrant(s.grant, later(1));
      // The row as a write in flight could have put it back after the void deleted the others.
      const r0 = row.rows[0] as NonNullable<(typeof row.rows)[number]>;
      await bed.control.write((tx) =>
        tx.query(
          `INSERT INTO oauth_refresh_tokens (hash, grant_id, issued_at, expires_at, grant_expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
          [tokenHash(s.refresh_token), s.grant, r0.issued_at, r0.expires_at, r0.grant_expires_at],
        ),
      );
      expect(await refused(exchange(cliForm(s.refresh_token), later(2)))).toBe("invalid_grant");
      const creds = await bed.control.read((tx) =>
        tx.query("SELECT 1 FROM credentials WHERE grant_id = $1", [s.grant]),
      );
      expect(creds.rows).toEqual([]);
    },
    T,
  );

  it(
    "a CLI sign-in signed out while its refresh is under way: no access token left, invalid_grant",
    async () => {
      const s = await signedIn({ cli: true });
      const r = exchange(cliForm(s.refresh_token), later(1), {
        // The revocation endpoint voids the grant after the checks, before the session is written.
        beforeAccess: async () => {
          await bed.oauth.voidGrant(s.grant, later(1));
        },
      });
      expect(await refused(r)).toBe("invalid_grant");
      const creds = await bed.control.read((tx) =>
        tx.query("SELECT 1 FROM credentials WHERE grant_id = $1", [s.grant]),
      );
      expect(creds.rows).toEqual([]);
    },
    T,
  );

  it(
    "a connection's grant voided before its access token is written: none is written, not even for a moment",
    async () => {
      const s = await signedIn();
      const creds = async () =>
        (
          await bed.control.read((tx) =>
            tx.query("SELECT 1 FROM credentials WHERE grant_id = $1 AND hash <> $2", [
              s.grant,
              tokenHash(s.access_token),
            ]),
          )
        ).rows.length;
      let atRotation: number | undefined;
      const r = exchange(refreshForm(s.refresh_token), later(1), {
        beforeAccess: async () => {
          await bed.oauth.voidGrant(s.grant, later(1));
        },
        beforeRotating: async () => {
          atRotation = await creds();
        },
      });
      expect(await refused(r)).toBe("invalid_grant");
      expect(atRotation).toBeUndefined();
      expect(await creds()).toBe(0);
    },
    T,
  );

  it(
    "the sweep deletes a refresh token once it has expired, not before",
    async () => {
      const s = await signedIn();
      const entry = await bed.oauth.refreshToken(tokenHash(s.refresh_token));
      const expiresAt = entry?.expiresAt as string;
      const before = new Date(Date.parse(expiresAt) - 1000).toISOString();
      await bed.oauth.sweep(before);
      expect(await refreshRows(s.grant)).toBe(1);
      await bed.oauth.sweep(expiresAt);
      expect(await refreshRows(s.grant)).toBe(0);
    },
    T,
  );

  it(
    "after connections.revoke, the connection's refresh tokens are gone and its access says revoked",
    async () => {
      const s = await signedIn();
      await revokeServerConnection({
        control: bed.cp,
        oauth: bed.oauth,
        tenant: TENANT,
        store: bed.tenant,
        ctx: userCtx(),
        id: s.principal as ConnectionId,
      });
      expect(await refreshRows(s.grant)).toBe(0);
      expect(await authenticates(s.access_token)).toBe("revoked");
      expect(await refused(exchange(refreshForm(s.refresh_token), later(20)))).toBe(
        "invalid_grant",
      );
    },
    T,
  );

  it(
    "stopped after the new access token, before the exchange: the old refresh token works once",
    async () => {
      const s = await signedIn();
      await expect(
        exchange(refreshForm(s.refresh_token), later(1), {
          beforeRotating: async () => {
            throw new Error("stopped");
          },
        }),
      ).rejects.toThrow("stopped");
      const r = await exchange(refreshForm(s.refresh_token), later(2));
      expect(await authenticates(r.access_token)).toBe(s.principal);
      expect(await revocations(s.principal)).toEqual([]);
      expect(await refused(exchange(refreshForm(s.refresh_token), later(3)))).toBe("invalid_grant");
    },
    T,
  );
});

describe("a used refresh token presented again (a replay)", () => {
  it(
    "invalid_grant; the connection revoked by system for the replay; every token of the grant gone",
    async () => {
      const s = await signedIn();
      const r = await exchange(refreshForm(s.refresh_token), later(60));
      expect(await refused(exchange(refreshForm(s.refresh_token), later(120)))).toBe(
        "invalid_grant",
      );
      const [h, ...more] = await revocations(s.principal);
      expect(more).toEqual([]);
      expect(h).toMatchObject({ actor: "system", trigger: "oauth_refresh_replay" });
      expect(await voidedAt(s.grant)).toBe(later(120));
      expect(await refreshRows(s.grant)).toBe(0);
      expect(await authenticates(s.access_token)).toBe("invalid");
      expect(await authenticates(r.access_token)).toBe("invalid");
      expect(await refused(exchange(refreshForm(r.refresh_token), later(180)))).toBe(
        "invalid_grant",
      );
    },
    T,
  );

  it(
    "stopped after the revocation is logged, before the voiding: both tokens refused already",
    async () => {
      const s = await signedIn();
      const r = await exchange(refreshForm(s.refresh_token), later(60));
      await expect(
        exchange(refreshForm(s.refresh_token), later(120), {
          beforeVoiding: () => {
            throw new Error("stopped");
          },
        }),
      ).rejects.toThrow("stopped");
      expect(await revocations(s.principal)).toHaveLength(1);
      expect(await voidedAt(s.grant)).toBeUndefined();
      expect(await authenticates(r.access_token)).toBe("revoked");
      expect(await refused(exchange(refreshForm(r.refresh_token), later(180)))).toBe(
        "invalid_grant",
      );
    },
    T,
  );

  it(
    "a used token presented after it would have expired: still a replay, checked before the expiry",
    async () => {
      const s = await signedIn();
      await exchange(refreshForm(s.refresh_token), later(60));
      expect(
        await refused(exchange(refreshForm(s.refresh_token), later(REFRESH_TOKEN_SECONDS + DAY))),
      ).toBe("invalid_grant");
      expect(await revocations(s.principal)).toHaveLength(1);
      expect(await voidedAt(s.grant)).toBe(later(REFRESH_TOKEN_SECONDS + DAY));
    },
    T,
  );

  it(
    "on a connection revoked already: no second revocation, the grant voided",
    async () => {
      const s = await signedIn();
      await exchange(refreshForm(s.refresh_token), later(60));
      await revokeConnection(bed.tenant, userCtx(), { id: s.principal as ConnectionId });
      expect(await refused(exchange(refreshForm(s.refresh_token), later(120)))).toBe(
        "invalid_grant",
      );
      const all = await revocations(s.principal);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ actor: USER });
      expect(await voidedAt(s.grant)).toBe(later(120));
    },
    T,
  );

  it(
    "a CLI sign-in's: voided, nothing in the log",
    async () => {
      const s = await signedIn({ cli: true });
      const r = await exchange(cliForm(s.refresh_token), later(60));
      expect(await refused(exchange(cliForm(s.refresh_token), later(120)))).toBe("invalid_grant");
      expect(await voidedAt(s.grant)).toBe(later(120));
      expect(await authenticates(r.access_token)).toBe("invalid");
      expect(await revocations(USER)).toEqual([]);
    },
    T,
  );
});

describe("two exchanges of one refresh token at once", () => {
  it(
    "one wins; the other is a replay: the grant voided, the winner's pair refused, one revocation by system",
    async () => {
      const s = await signedIn();
      let winner: TokenResponse | undefined;
      // The second exchange runs whole while the first stands between its new access token and
      // the exchange of the refresh token.
      const first = exchange(refreshForm(s.refresh_token), later(60), {
        beforeRotating: async () => {
          winner = await exchange(refreshForm(s.refresh_token), later(61));
        },
      });
      expect(await refused(first)).toBe("invalid_grant");
      expect(winner).toBeDefined();
      const w = winner as TokenResponse;
      expect(await voidedAt(s.grant)).toBe(later(60));
      expect(await authenticates(w.access_token)).toBe("invalid");
      expect(await refused(exchange(refreshForm(w.refresh_token), later(120)))).toBe(
        "invalid_grant",
      );
      const all = await revocations(s.principal);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ actor: "system", trigger: "oauth_refresh_replay" });
      // The access token the loser made before losing went with the grant.
      const creds = await bed.control.read((tx) =>
        tx.query("SELECT 1 FROM credentials WHERE grant_id = $1", [s.grant]),
      );
      expect(creds.rows).toEqual([]);
    },
    T,
  );
});

// Two processes exchanging the same token over two connections: PostgreSQL only.
describe.runIf(TEST_BACKEND === "postgres")("two processes exchanging at once", () => {
  it(
    "exactly one succeeds, the grant ends voided, one revocation by system",
    async () => {
      const s = await signedIn();
      const second = await secondConnection(join(root, "control"));
      try {
        const other: OAuthDeps = {
          ...deps(),
          store: await openOAuthStore(second),
          control: await openControlPlane(second),
        };
        const results = await Promise.allSettled([
          exchange(refreshForm(s.refresh_token), later(60)),
          exchange(refreshForm(s.refresh_token), later(60), {}, other),
        ]);
        expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
        const lost = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
        expect(lost.reason).toMatchObject({ code: "invalid_grant" });
        expect(await voidedAt(s.grant)).toBe(later(60));
        const all = await revocations(s.principal);
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({ actor: "system", trigger: "oauth_refresh_replay" });
      } finally {
        await second.close();
      }
    },
    T,
  );
});

describe("the revocation endpoint (RFC 7009)", () => {
  const revokeForm = (token: string, clientId = ID) =>
    new URLSearchParams({ token, client_id: clientId });

  it(
    "a connection's refresh token: the connection revokes itself; its access then says revoked",
    async () => {
      const s = await signedIn();
      await revokeToken(deps(), revokeForm(s.refresh_token), later(30));
      const [h, ...more] = await revocations(s.principal);
      expect(more).toEqual([]);
      expect(h).toMatchObject({ actor: s.principal });
      expect(h).not.toHaveProperty("trigger");
      expect(await authenticates(s.access_token)).toBe("revoked");
      expect(await refreshRows(s.grant)).toBe(0);
    },
    T,
  );

  it(
    "an inactive connection's refresh token: voided only, no event",
    async () => {
      const s = await signedIn();
      await revokeConnection(bed.tenant, userCtx(), { id: s.principal as ConnectionId });
      await revokeToken(deps(), revokeForm(s.refresh_token), later(30));
      expect(await revocations(s.principal)).toHaveLength(1);
      expect(await voidedAt(s.grant)).toBe(later(30));
      expect(await refreshRows(s.grant)).toBe(0);
    },
    T,
  );

  it(
    "a CLI sign-in's refresh token: its grant voided, its access gone, nothing in the log",
    async () => {
      const s = await signedIn({ cli: true });
      await revokeToken(deps(), revokeForm(s.refresh_token, "saveslot-cli"), later(30));
      expect(await voidedAt(s.grant)).toBe(later(30));
      expect(await authenticates(s.access_token)).toBe("invalid");
      expect(await revocations(USER)).toEqual([]);
    },
    T,
  );

  it(
    "one access token: only that one goes; the connection and its other tokens stay",
    async () => {
      const s = await signedIn();
      const r = await exchange(refreshForm(s.refresh_token), later(10));
      await revokeToken(deps(), revokeForm(s.access_token), later(30));
      expect(await authenticates(s.access_token)).toBe("invalid");
      expect(await authenticates(r.access_token)).toBe(s.principal);
      expect(await revocations(s.principal)).toEqual([]);
      await exchange(refreshForm(r.refresh_token), later(40));
    },
    T,
  );

  it(
    "unknown tokens, and another client's refresh or access token: nothing done, no error",
    async () => {
      const s = await signedIn();
      const snapshot = async () => ({
        refresh: await bed.oauth.refreshToken(tokenHash(s.refresh_token)),
        grant: await bed.oauth.grant(s.grant),
        access: await authenticates(s.access_token),
        events: await revocations(s.principal),
      });
      const before = await snapshot();
      await revokeToken(deps(), revokeForm(`slr_${"B".repeat(43)}`), later(30));
      await revokeToken(deps(), revokeForm(`slt_${"B".repeat(43)}`), later(30));
      await revokeToken(deps(), revokeForm("anything"), later(30));
      await revokeToken(deps(), revokeForm(s.refresh_token, OTHER), later(30));
      await revokeToken(deps(), revokeForm(s.access_token, OTHER), later(30));
      expect(await snapshot()).toEqual(before);
      await expect(
        revokeToken(deps(), new URLSearchParams({ client_id: ID }), later(30)),
      ).rejects.toMatchObject({ code: "invalid_request" });
    },
    T,
  );
});
