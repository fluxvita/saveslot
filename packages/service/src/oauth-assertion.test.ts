// The console's session exchange on either backend (05-surfaces §15 «远程授权», RFC 7523): an
// assertion the external login takes exchanged for a user session of 15 minutes under a grant of
// `saveslot-console`, with no refresh token; the form checked before the provider is asked; the
// request's source passed to the provider, which counts new users by it; an assertion not taken, a
// user without a tenant or with one not active, and an account disabled between the assertion's
// acceptance and the session's issue, each refused with nothing usable left. Fictional accounts;
// the platform's side signs with fixed test keys.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomCrockford, type TenantStore } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import { SCOPES } from "./auth.ts";
import type { TenantId, UserId } from "./control-plane.ts";
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
  disableExternalUser,
  ExternalIdentity,
  type ExternalLogins,
  initExternalLogin,
  listExternalUsers,
  NEW_USERS_PER_SOURCE,
} from "./external-identity.ts";
import { type IdentityProvider, writeUserSession } from "./identity.ts";
import { ASSERTION_SESSION_SECONDS, redeemAssertion } from "./oauth-assertion.ts";
import { CONSOLE_CLIENT_ID } from "./oauth-client.ts";
import type { OAuthDeps } from "./oauth-server.ts";
import { initOAuthTables, type OAuthStore, openOAuthStore } from "./oauth-store.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";
import { tokenHash } from "./tokens.ts";

const T = 120_000;
const START = Date.parse("2026-11-20T10:00:00.000Z");
const NOW = new Date(START).toISOString();
const CELL = "cell_a";
const root = mkdtempSync(join(tmpdir(), "saveslot-oauth-assertion-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

let db: TenantStore;
let cp: ServerControlPlane;
let store: OAuthStore;
let logins: ExternalLogins;

/** A user's tenant registered and, unless `active` is false, active; its storage not made. */
async function tenantOf(owner: UserId, active = true): Promise<TenantId> {
  const id = `tn_${randomCrockford(26)}` as TenantId;
  const e = await cp.registerTenant({
    id,
    owner,
    ref: { kind: "postgres", cell: CELL, database: id.toLowerCase() },
  });
  if (active) await cp.activateTenant(e.id);
  return id;
}

/** The external login, as the server has it: its tenants registered only. */
const external = () =>
  new ExternalIdentity({
    logins,
    config: {
      issuer: TEST_ISSUER,
      loginUrl: "https://platform.example/login",
      keys: [TEST_KEY.public],
      audience: TEST_AUDIENCE,
    },
    control: cp,
    backend: {
      open: () => Promise.reject(new Error("no tenant's storage is made here")),
    },
    cell: CELL,
    cells: new Set([CELL]),
    now: () => START,
    makeTenantForTests: async (owner) => {
      if ((await cp.tenantOf(owner)) === undefined) await tenantOf(owner);
    },
  });

const deps = (identity: OAuthDeps["identity"]): OAuthDeps => ({
  store,
  control: cp,
  identity,
  pool: { use: () => Promise.reject(new Error("no tenant is opened by an exchange")) },
  fetchClient: () => Promise.reject(new Error("no client document is fetched")),
  external: TEST_AUDIENCE,
  windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
});

let accounts = 0;
const account = () => `acct_${++accounts}`;
const sessionFor = (sub: string, edit = (c: Record<string, unknown>) => c) =>
  signAssertion(GOOD_HEADER, edit(goodClaims(START, { purpose: "session", sub })));
const form = (o: Record<string, string | readonly string[]>) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    for (const x of typeof v === "string" ? [v] : v) f.append(k, x);
  }
  return f;
};
const exchange = (identity: OAuthDeps["identity"], f: URLSearchParams, remote = "198.51.100.7") =>
  redeemAssertion(deps(identity), f, remote, NOW);

const userOf = async (sub: string) =>
  (await listExternalUsers(logins)).find((u) => u.subject === sub)?.user;
const grantsOf = async (user: UserId | undefined) =>
  (
    await db.read((tx) =>
      tx.query<{ id: string; kind: string; client_id: string; tenant: string; voided: boolean }>(
        `SELECT id, kind, client_id, tenant, voided_at IS NOT NULL AS voided
           FROM oauth_grants WHERE principal = $1`,
        [user ?? ""],
      ),
    )
  ).rows;
const credentialsOf = async (grant: string) =>
  (await db.read((tx) => tx.query("SELECT 1 FROM credentials WHERE grant_id = $1", [grant]))).rows
    .length;
const allGrants = async () =>
  Number(
    (await db.read((tx) => tx.query<{ n: string }>("SELECT count(*) AS n FROM oauth_grants")))
      .rows[0]?.n,
  );

/** A provider that records whether it was asked, issuing nothing. */
function recording(): { identity: OAuthDeps["identity"]; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    identity: {
      acceptAssertion: async (a) => {
        asked.push(a);
        return undefined;
      },
      issueUserSession: async () => {
        throw new Error("no session is issued");
      },
    },
  };
}

beforeAll(async () => {
  db = await testBackend().open({ kind: "pglite", dir: join(root, "control") }, { create: true });
  cp = await initControlPlane(db);
  await initOAuthTables(db);
  store = await openOAuthStore(db);
  logins = await initExternalLogin(db);
}, T);
afterAll(async () => {
  await db?.close();
}, T);

describe("an identity assertion exchanged at the token endpoint", () => {
  it(
    "gives a user session of 15 minutes under a grant of saveslot-console, with no refresh token",
    async () => {
      const sub = account();
      for (const f of [
        form({ assertion: sessionFor(sub) }),
        form({ assertion: sessionFor(sub), client_id: CONSOLE_CLIENT_ID }),
      ]) {
        const r = await exchange(external(), f);
        expect(Object.keys(r).sort()).toEqual([
          "access_token",
          "expires_in",
          "scope",
          "token_type",
        ]);
        expect(r).toMatchObject({
          token_type: "Bearer",
          expires_in: ASSERTION_SESSION_SECONDS,
          scope: SCOPES.join(" "),
        });
        expect(r.access_token).toMatch(/^sls_/);
        const user = await userOf(sub);
        const credential = await cp.credential(tokenHash(r.access_token));
        expect(credential).toMatchObject({
          kind: "session",
          principal: user,
          expiresAt: new Date(START + 15 * 60_000).toISOString(),
        });
        const grant = (await grantsOf(user)).find((g) => g.id === credential?.grant);
        expect(grant).toMatchObject({
          kind: "session",
          client_id: CONSOLE_CLIENT_ID,
          tenant: (await cp.tenantOf(user as UserId))?.id,
          voided: false,
        });
      }
    },
    T,
  );

  it(
    "passes the request's source to the provider, which counts new users by it",
    async () => {
      const p = external();
      for (let i = 0; i < NEW_USERS_PER_SOURCE; i++) {
        await exchange(p, form({ assertion: sessionFor(account()) }), "203.0.113.9");
      }
      await expect(
        exchange(p, form({ assertion: sessionFor(account()) }), "203.0.113.9"),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const other = account();
      await exchange(p, form({ assertion: sessionFor(other) }), "203.0.113.10");
      expect(await userOf(other)).toBeDefined();
    },
    T,
  );

  it(
    "is refused as unsupported by a provider that takes no assertions",
    async () => {
      const before = await allGrants();
      await expect(
        exchange(
          { issueUserSession: () => Promise.reject(new Error("not asked")) },
          form({ assertion: sessionFor(account()) }),
        ),
      ).rejects.toMatchObject({ code: "unsupported_grant_type" });
      expect(await allGrants()).toBe(before);
    },
    T,
  );

  it(
    "checks the form before the provider is asked: one non-empty assertion, each parameter once",
    async () => {
      const r = recording();
      for (const f of [
        form({}),
        form({ assertion: "" }),
        form({ assertion: ["a", "b"] }),
        form({ assertion: "a", client_id: [CONSOLE_CLIENT_ID, CONSOLE_CLIENT_ID] }),
        form({ assertion: "a", scope: ["x", "y"] }),
      ]) {
        await expect(exchange(r.identity, f), f.toString()).rejects.toMatchObject({
          code: "invalid_request",
        });
      }
      expect(r.asked).toEqual([]);
    },
    T,
  );

  it(
    "refuses another client, without asking the provider or writing anything",
    async () => {
      const r = recording();
      const before = await allGrants();
      for (const client of ["saveslot-cli", "https://client.example/doc.json", ""]) {
        await expect(
          exchange(r.identity, form({ assertion: "a", client_id: client })),
          client,
        ).rejects.toMatchObject({ code: "invalid_client" });
      }
      expect(r.asked).toEqual([]);
      expect(await allGrants()).toBe(before);
    },
    T,
  );

  it(
    "refuses an assertion the provider does not take, with nothing written",
    async () => {
      const before = await allGrants();
      const sub = account();
      for (const assertion of [
        sessionFor(sub, (c) => ({ ...c, purpose: "authorize", nonce: "x" })),
        signAssertion(
          { ...GOOD_HEADER, kid: OTHER_KEY.kid },
          goodClaims(START, { purpose: "session", sub }),
        ),
        "not an assertion",
      ]) {
        await expect(exchange(external(), form({ assertion }))).rejects.toMatchObject({
          code: "invalid_grant",
        });
      }
      expect(await allGrants()).toBe(before);
    },
    T,
  );

  it(
    "refuses a user without a tenant, with nothing written",
    async () => {
      const user = `u_${randomCrockford(26)}` as UserId;
      const before = await allGrants();
      await expect(
        exchange(
          {
            acceptAssertion: async () => ({ user, session: "s-none" }),
            issueUserSession: () => Promise.reject(new Error("not asked")),
          },
          form({ assertion: "a" }),
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      expect(await allGrants()).toBe(before);
    },
    T,
  );

  it(
    "refuses a user whose tenant is not active, as writing the session does: the grant void",
    async () => {
      const user = `u_${randomCrockford(26)}` as UserId;
      await tenantOf(user, false);
      await expect(
        exchange(
          {
            acceptAssertion: async () => ({ user, session: "s-inactive-tenant" }),
            // As a provider writes it, once the account is found active.
            issueUserSession: (u, o) =>
              db.write((tx) =>
                writeUserSession(tx, u, {
                  expiresAt: o.expiresAt,
                  ...(o.grant === undefined ? {} : { grant: o.grant }),
                }),
              ),
          },
          form({ assertion: "a" }),
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      expect(await grantsOf(user)).toEqual([
        expect.objectContaining({ id: "s-inactive-tenant", voided: true }),
      ]);
      expect(await credentialsOf("s-inactive-tenant")).toBe(0);
    },
    T,
  );

  it(
    "refuses an account disabled between the assertion's acceptance and the session: the grant void",
    async () => {
      const p = external();
      const sub = account();
      await expect(
        exchange(
          {
            acceptAssertion: async (a, remote) => {
              const x = await p.acceptAssertion(a, remote);
              await disableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
              return x;
            },
            issueUserSession: (u, o) => p.issueUserSession(u, o),
          } satisfies Pick<IdentityProvider, "acceptAssertion" | "issueUserSession">,
          form({ assertion: sessionFor(sub) }),
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const grants = await grantsOf(await userOf(sub));
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ client_id: CONSOLE_CLIENT_ID, voided: true });
      expect(await credentialsOf(grants[0]?.id as string)).toBe(0);
    },
    T,
  );

  it(
    "lets a provider's failure through, with nothing written",
    async () => {
      const before = await allGrants();
      await expect(
        exchange(
          {
            acceptAssertion: () => Promise.reject(new Error("the provider failed")),
            issueUserSession: () => Promise.reject(new Error("not asked")),
          },
          form({ assertion: "a" }),
        ),
      ).rejects.toThrow("the provider failed");
      expect(await allGrants()).toBe(before);
    },
    T,
  );
});
