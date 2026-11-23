// The authorization server's tables and its code flow on a real database, on either backend
// (02-architecture §11 «测试矩阵»; `pnpm test:postgres` runs this file on PostgreSQL): the tables made
// once; client documents fetched, cached and fetched again; codes issued and redeemed once, with
// every way a redemption is refused; the connection instance registered only when its code is
// redeemed; one-time form tokens. Fictional IDs and clients.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpsContext, createTenant, type TenantStore } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import { sessionsFrom } from "./oauth.fixture.ts";
import { CLI_CLIENT, type FetchedDocument, type OAuthClient } from "./oauth-client.ts";
import {
  ACCESS_TOKEN_SECONDS,
  consentScopes,
  issueCode,
  type OAuthDeps,
  redeemCode,
  resolveClient,
  TokenError,
} from "./oauth-server.ts";
import { initOAuthTables, OAUTH_FORMAT, OAuthStore, openOAuthStore } from "./oauth-store.ts";
import {
  ControlPlaneError,
  initControlPlane,
  type ServerControlPlane,
} from "./server-control-plane.ts";
import { tokenHash } from "./tokens.ts";

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-oauth-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXT = "https://saveslot.example";
const TENANT = `tn_${"8".repeat(26)}` as const;
const USER = `u_${"1".repeat(26)}` as const;
const NOW = "2026-11-21T08:00:00.000Z";
const later = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();
const ID = "https://client.example/oauth/client.json";
const CLIENT: OAuthClient = {
  id: ID,
  name: "Example Agent",
  host: "client.example",
  redirectUris: ["https://client.example/callback"],
  builtIn: false,
};
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
/** The login codes are consented under, and the logins still going (ID to user). */
const LOGIN = "login-1";
const logins = new Map<string, typeof USER>();
/** Users whose account is there but not active. */
const inactive = new Set<typeof USER>();

let control: TenantStore;
let controlPlane: ServerControlPlane;
let oauth: OAuthStore;
let tenant: TenantStore;
beforeAll(async () => {
  control = await testBackend().open(
    { kind: "pglite", dir: join(root, "control") },
    { create: true },
  );
  controlPlane = await initControlPlane(control);
  await initOAuthTables(control);
  oauth = await openOAuthStore(control);
  await control.write((tx) =>
    tx.query(
      "INSERT INTO tenants (id, owner, cell, database, state) VALUES ($1, $2, 'c1', 'd1', 'active')",
      [TENANT, USER],
    ),
  );
  tenant = await testBackend().open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
  await createTenant(
    tenant,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_window: 600_000,
      idempotency_key_window: 86_400_000,
      now: NOW,
      confirmation: null,
    }),
  );
}, T);
afterAll(async () => {
  await tenant?.close();
  await control?.close();
}, T);

let fetches: URL[] = [];
let served: FetchedDocument;
const store = () => oauth;
const cp = () => controlPlane;

beforeEach(async () => {
  fetches = [];
  logins.clear();
  logins.set(LOGIN, USER);
  inactive.clear();
  served = {
    body: new TextEncoder().encode(
      JSON.stringify({
        client_id: ID,
        client_name: "Example Agent",
        redirect_uris: CLIENT.redirectUris,
      }),
    ),
    cacheControl: "max-age=600",
  };
  await control.write((tx) =>
    tx.exec(
      "DELETE FROM oauth_codes; DELETE FROM oauth_refresh_tokens; DELETE FROM oauth_grants; " +
        "DELETE FROM oauth_clients; " +
        "DELETE FROM web_forms; DELETE FROM credentials",
    ),
  );
});

let names = 0;
/** A connection name not used before in this file's tenant. */
const freshName = () => `Laptop · Agent ${names++}`;

function deps(): OAuthDeps {
  return {
    store: store(),
    control: cp(),
    identity: sessionsFrom(control, logins, new Map(), inactive),
    pool: {
      use: (id, fn) => {
        expect(id).toBe(TENANT);
        return fn({ tenant: TENANT, owner: USER, store: tenant, anchor: cp().anchors });
      },
    },
    fetchClient: async (url) => {
      fetches.push(url);
      return served;
    },
    external: EXT,
    windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
  };
}

/** A code as the page issues it after a consent. */
type CodeInput = Parameters<typeof issueCode>[1];
/** `name: null`: no name (the CLI's sign-in); no `name`: a fresh one. */
function code(o: Partial<Omit<CodeInput, "name">> & { readonly name?: string | null } = {}) {
  const { name, ...rest } = o;
  return issueCode(deps(), {
    client: CLIENT,
    redirectUri: CLIENT.redirectUris[0] as string,
    codeChallenge: CHALLENGE,
    resource: EXT,
    user: USER,
    login: LOGIN,
    tenant: TENANT,
    scopes: ["saveslot.read", "saveslot.write"],
    now: NOW,
    ...rest,
    ...(name === null ? {} : { name: name ?? freshName() }),
  });
}

/** The token request a client sends for `c`. */
const form = (c: string, o: Record<string, string | undefined> = {}) => {
  const f = new URLSearchParams();
  const all: Record<string, string | undefined> = {
    grant_type: "authorization_code",
    code: c,
    code_verifier: VERIFIER,
    client_id: ID,
    redirect_uri: CLIENT.redirectUris[0],
    ...o,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) f.append(k, v);
  return f;
};

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TokenError) return e.code;
    throw e;
  }
  throw new Error("not refused");
}

const count = async (table: string) =>
  Number(
    (await control.read((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)))
      .rows[0]?.n,
  );

/** The `principal` blocks of the tenant's `principal.registered` events for this name. */
async function registered(name: string): Promise<Record<string, unknown>[]> {
  const r = await tenant.read((tx) =>
    tx.query<{ body: string }>(
      `SELECT p.body FROM events e
         JOIN content p ON p.seq = e.seq AND p.path = 'principal'
         JOIN content n ON n.seq = e.seq AND n.path = 'name'
        WHERE e.type = 'principal.registered' AND n.body::text LIKE $1`,
      [`%${JSON.stringify(name).slice(1, -1)}%`],
    ),
  );
  return r.rows.map((x) => {
    const b = JSON.parse(String(x.body)) as { v?: unknown };
    return (b.v ?? b) as Record<string, unknown>;
  });
}

describe("tables", () => {
  it(
    "made once: a second run checks the format and changes nothing",
    async () => {
      await initOAuthTables(control);
      const f = await control.read((tx) =>
        tx.query<{ value: string }>("SELECT value FROM control_meta WHERE key = 'oauth_format'"),
      );
      expect(f.rows).toEqual([{ value: String(OAUTH_FORMAT) }]);
    },
    T,
  );

  it(
    "another format: refused",
    async () => {
      await control.write((tx) =>
        tx.query("UPDATE control_meta SET value = '99' WHERE key = 'oauth_format'"),
      );
      try {
        await expect(openOAuthStore(control)).rejects.toThrow(ControlPlaneError);
        await expect(initOAuthTables(control)).rejects.toThrow(ControlPlaneError);
      } finally {
        await control.write((tx) =>
          tx.query("UPDATE control_meta SET value = $1 WHERE key = 'oauth_format'", [
            String(OAUTH_FORMAT),
          ]),
        );
      }
    },
    T,
  );

  it(
    "opening makes nothing: a control database without them is oauth_not_initialized",
    async () => {
      const db = await testBackend().open(
        { kind: "pglite", dir: join(root, "no-oauth") },
        { create: true },
      );
      try {
        await initControlPlane(db);
        await expect(openOAuthStore(db)).rejects.toMatchObject({ code: "oauth_not_initialized" });
        const t = await db.read((tx) =>
          tx.query<{ t: string | null }>("SELECT to_regclass('oauth_grants')::text AS t"),
        );
        expect(t.rows).toEqual([{ t: null }]);
        await initOAuthTables(db);
        await openOAuthStore(db);
      } finally {
        await db.close();
      }
    },
    T,
  );

  it.each([1, 2])(
    "a database of an earlier format (%i: before refresh tokens, before device codes): refused, not upgraded",
    async (earlier) => {
      expect(OAUTH_FORMAT).toBe(3);
      await control.write((tx) =>
        tx.query("UPDATE control_meta SET value = $1 WHERE key = 'oauth_format'", [
          String(earlier),
        ]),
      );
      try {
        await expect(openOAuthStore(control)).rejects.toMatchObject({
          code: "control_format_mismatch",
          message: expect.stringContaining(`format ${earlier}`),
        });
      } finally {
        await control.write((tx) =>
          tx.query("UPDATE control_meta SET value = $1 WHERE key = 'oauth_format'", [
            String(OAUTH_FORMAT),
          ]),
        );
      }
    },
    T,
  );

  it("a store is had only through openOAuthStore", () => {
    expect(() => new OAuthStore(control, Symbol("oauth tables checked") as never)).toThrow(
      "open it with openOAuthStore",
    );
  });
});

// Two processes starting at once on a new control database: the advisory lock makes them take
// turns, so one makes the tables and the other finds them. Two connections: PostgreSQL only.
describe.runIf(TEST_BACKEND === "postgres")("two processes opening at once", () => {
  it(
    "both open; the tables are made once",
    async () => {
      const dir = join(root, "concurrent");
      const db = await testBackend().open({ kind: "pglite", dir }, { create: true });
      try {
        await initControlPlane(db);
        const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
        try {
          await Promise.all([initOAuthTables(a), initOAuthTables(b)]);
          const f = await db.read((tx) =>
            tx.query<{ value: string }>(
              "SELECT value FROM control_meta WHERE key = 'oauth_format'",
            ),
          );
          expect(f.rows).toEqual([{ value: String(OAUTH_FORMAT) }]);
        } finally {
          await a.close();
          await b.close();
        }
      } finally {
        await db.close();
      }
    },
    T,
  );
});

describe("client documents", () => {
  it(
    "fetched once, served from the cache while fresh, fetched again once stale",
    async () => {
      expect(await resolveClient(deps(), ID, NOW)).toEqual(CLIENT);
      expect(await resolveClient(deps(), ID, later(599))).toEqual(CLIENT);
      expect(fetches).toHaveLength(1);
      await resolveClient(deps(), ID, later(600));
      expect(fetches).toHaveLength(2);
    },
    T,
  );

  it(
    "a document that fails its checks is not cached",
    async () => {
      served = { body: new TextEncoder().encode(JSON.stringify({ client_id: `${ID}x` })) };
      await expect(resolveClient(deps(), ID, NOW)).rejects.toMatchObject({
        code: "client_id_mismatch",
      });
      expect(await count("oauth_clients")).toBe(0);
    },
    T,
  );

  it(
    "the CLI is built in: nothing fetched",
    async () => {
      expect(await resolveClient(deps(), "saveslot-cli", NOW)).toBe(CLI_CLIENT);
      expect(fetches).toEqual([]);
    },
    T,
  );

  it(
    "a malformed client ID is refused before any fetch",
    async () => {
      await expect(
        resolveClient(deps(), "http://client.example/c.json", NOW),
      ).rejects.toMatchObject({
        code: "client_id_malformed",
      });
      expect(fetches).toEqual([]);
    },
    T,
  );
});

describe("consent scopes", () => {
  it("saveslot.read required; nothing beyond the request, or the default when none asked", () => {
    expect(consentScopes(["saveslot.read"], undefined)).toEqual(["saveslot.read"]);
    expect(consentScopes(["saveslot.write", "saveslot.read"], undefined)).toEqual([
      "saveslot.read",
      "saveslot.write",
    ]);
    expect(consentScopes(["saveslot.write"], undefined)).toBeUndefined();
    expect(consentScopes(["saveslot.read", "saveslot.schema"], undefined)).toBeUndefined();
    expect(
      consentScopes(["saveslot.read", "saveslot.schema"], ["saveslot.read", "saveslot.schema"]),
    ).toEqual(["saveslot.read", "saveslot.schema"]);
    expect(consentScopes(["saveslot.read", "saveslot.delete"], ["saveslot.read"])).toBeUndefined();
  });
});

describe("redeeming a code", () => {
  it(
    "registers the connection instance then, with via oauth and the client",
    async () => {
      const name = freshName();
      const c = await code({ name });
      expect(await registered(name)).toEqual([]);
      const r = await redeemCode(deps(), form(c), later(5));
      expect(r).toEqual({
        access_token: expect.stringMatching(/^slt_[A-Za-z0-9_-]{43}$/),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_SECONDS,
        scope: "saveslot.read saveslot.write",
        refresh_token: expect.stringMatching(/^slr_[A-Za-z0-9_-]{43}$/),
      });
      const [p] = await registered(name);
      expect(p).toMatchObject({
        kind: "connection",
        scopes: ["saveslot.read", "saveslot.write"],
        via: "oauth",
        client: ID,
      });
      expect(p).not.toHaveProperty("slots");
      const cred = await cp().credential(tokenHash(r.access_token));
      expect(cred).toMatchObject({
        kind: "connection",
        principal: p?.["principal"],
        tenant: TENANT,
        expiresAt: later(5 + ACCESS_TOKEN_SECONDS),
      });
      const grant = await store().grant(cred?.grant as string);
      expect(grant).toMatchObject({
        kind: "connection",
        principal: p?.["principal"],
        clientId: ID,
        resource: EXT,
        createdAt: later(5),
      });
      expect(grant).not.toHaveProperty("voidedAt");
    },
    T,
  );

  it(
    "the CLI's code signs its user in: a user session with its grant, nothing registered",
    async () => {
      const c = await code({
        client: CLI_CLIENT,
        redirectUri: "http://127.0.0.1:49152/callback",
        scopes: [],
        name: null,
      });
      const r = await redeemCode(
        deps(),
        form(c, { client_id: "saveslot-cli", redirect_uri: "http://127.0.0.1:49152/callback" }),
        NOW,
      );
      expect(r.access_token).toMatch(/^sls_/);
      expect(r.scope).toBe("saveslot.read saveslot.write saveslot.schema saveslot.delete");
      const cred = await cp().credential(tokenHash(r.access_token));
      expect(cred).toMatchObject({ kind: "session", principal: USER, tenant: TENANT });
      expect(await store().grant(cred?.grant as string)).toMatchObject({
        kind: "session",
        principal: USER,
      });
    },
    T,
  );

  it(
    "the CLI's code, its login ended before the redemption: invalid_grant, no session, the grant void",
    async () => {
      const c = await code({
        client: CLI_CLIENT,
        redirectUri: "http://127.0.0.1:49152/callback",
        scopes: [],
        name: null,
      });
      // Signed out, its password changed or expired: the provider issues nothing from it.
      logins.delete(LOGIN);
      const f = form(c, {
        client_id: "saveslot-cli",
        redirect_uri: "http://127.0.0.1:49152/callback",
      });
      expect(await refused(redeemCode(deps(), f, NOW))).toBe("invalid_grant");
      expect(await count("credentials")).toBe(0);
      const g = await control.read((tx) =>
        tx.query<{ kind: string; voided_at: string | null }>(
          "SELECT kind, voided_at FROM oauth_grants",
        ),
      );
      expect(g.rows).toEqual([{ kind: "session", voided_at: NOW }]);
    },
    T,
  );

  it(
    "the CLI's code, its account disabled before the redemption: invalid_grant, the grant void",
    async () => {
      const c = await code({
        client: CLI_CLIENT,
        redirectUri: "http://127.0.0.1:49152/callback",
        scopes: [],
        name: null,
      });
      inactive.add(USER);
      const f = form(c, {
        client_id: "saveslot-cli",
        redirect_uri: "http://127.0.0.1:49152/callback",
      });
      expect(await refused(redeemCode(deps(), f, NOW))).toBe("invalid_grant");
      expect(await count("credentials")).toBe(0);
      const g = await control.read((tx) =>
        tx.query<{ voided_at: string | null }>("SELECT voided_at FROM oauth_grants"),
      );
      expect(g.rows).toEqual([{ voided_at: NOW }]);
    },
    T,
  );

  it(
    "the CLI's code is redeemed from the login it was consented under, not another of the user's",
    async () => {
      const c = await code({
        client: CLI_CLIENT,
        redirectUri: "http://127.0.0.1:49152/callback",
        scopes: [],
        name: null,
        login: "login-2",
      });
      // The user has a login going, but not the one the code names.
      const f = form(c, {
        client_id: "saveslot-cli",
        redirect_uri: "http://127.0.0.1:49152/callback",
      });
      expect(await refused(redeemCode(deps(), f, NOW))).toBe("invalid_grant");
      expect(await count("credentials")).toBe(0);
    },
    T,
  );

  it(
    "a second redemption is refused and voids what the first one gave",
    async () => {
      const c = await code();
      const first = await redeemCode(deps(), form(c), NOW);
      expect(await refused(redeemCode(deps(), form(c), later(1)))).toBe("invalid_grant");
      expect(await cp().credential(tokenHash(first.access_token))).toBeUndefined();
      const grants = await control.read((tx) =>
        tx.query<{ voided_at: string | null }>("SELECT voided_at FROM oauth_grants"),
      );
      expect(grants.rows).toEqual([{ voided_at: later(1) }]);
    },
    T,
  );

  it(
    "an expired code: refused, nothing registered",
    async () => {
      const name = freshName();
      const c = await code({ name });
      expect(await refused(redeemCode(deps(), form(c), later(60)))).toBe("invalid_grant");
      expect(await registered(name)).toEqual([]);
    },
    T,
  );

  it.each<[string, Record<string, string | undefined>, string]>([
    ["another client", { client_id: "https://other.example/c.json" }, "invalid_grant"],
    ["another redirect URI", { redirect_uri: "https://client.example/other" }, "invalid_grant"],
    ["a wrong verifier", { code_verifier: `${VERIFIER.slice(0, -1)}l` }, "invalid_grant"],
    ["another resource", { resource: "https://other.example" }, "invalid_target"],
    ["no verifier", { code_verifier: undefined }, "invalid_request"],
    ["no redirect URI", { redirect_uri: undefined }, "invalid_request"],
    ["no client_id", { client_id: undefined }, "invalid_request"],
  ])(
    "%s: refused, nothing registered",
    async (_, change, error) => {
      const name = freshName();
      const c = await code({ name });
      expect(await refused(redeemCode(deps(), form(c, change), NOW))).toBe(error);
      expect(await registered(name)).toEqual([]);
      expect(await count("credentials")).toBe(0);
    },
    T,
  );

  it(
    "a parameter given twice: invalid_request",
    async () => {
      const f = form(await code());
      f.append("code_verifier", VERIFIER);
      expect(await refused(redeemCode(deps(), f, NOW))).toBe("invalid_request");
    },
    T,
  );

  it(
    "the resource given as the MCP endpoint is the same audience",
    async () => {
      const r = await redeemCode(deps(), form(await code(), { resource: `${EXT}/mcp` }), NOW);
      expect(r.token_type).toBe("Bearer");
    },
    T,
  );

  it.each([
    ["without saveslot.read", '["saveslot.write"]'],
    ["beyond the request", '["saveslot.read","saveslot.delete"]'],
  ])(
    "scopes tampered in the stored code (%s): refused, nothing registered",
    async (_, scopes) => {
      const name = freshName();
      const c = await code({ name });
      await control.write((tx) =>
        tx.query("UPDATE oauth_codes SET scopes = $1 WHERE hash = $2", [scopes, tokenHash(c)]),
      );
      expect(await refused(redeemCode(deps(), form(c), NOW))).toBe("invalid_grant");
      expect(await registered(name)).toEqual([]);
    },
    T,
  );

  it(
    "the name taken between the page and the redemption: refused, the grant voided",
    async () => {
      const name = freshName();
      const taken = await code({ name });
      const c = await code({ name });
      await redeemCode(deps(), form(taken), NOW);
      expect(await refused(redeemCode(deps(), form(c), NOW))).toBe("invalid_grant");
      expect(await registered(name)).toHaveLength(1);
      const voided = await control.read((tx) =>
        tx.query("SELECT 1 FROM oauth_grants WHERE voided_at IS NOT NULL"),
      );
      expect(voided.rows).toHaveLength(1);
    },
    T,
  );

  it(
    "a registration that fails after the hash: the hash dropped again, the grant of no principal",
    async () => {
      // A process that stops between the two leaves the hash, which authenticates as nothing:
      // issueServerConnection's own tests pin that. Here the registration throws, and the hash goes.
      const name = freshName();
      const c = await code({ name });
      let id = "";
      await expect(
        redeemCode(deps(), form(c), NOW, {
          beforeRegistering: (x) => {
            id = x;
            throw new Error("interrupted");
          },
        }),
      ).rejects.toThrow("interrupted");
      expect(id).toMatch(/^ci_/);
      expect(await registered(name)).toEqual([]);
      const creds = await control.read((tx) => tx.query("SELECT 1 FROM credentials"));
      expect(creds.rows).toEqual([]);
      const principal = await tenant.read((tx) =>
        tx.query("SELECT 1 FROM principals WHERE id = $1", [id]),
      );
      expect(principal.rows).toEqual([]);
      const grants = await control.read((tx) =>
        tx.query<{ principal: string | null }>("SELECT principal FROM oauth_grants"),
      );
      expect(grants.rows).toEqual([{ principal: null }]);
    },
    T,
  );
});

describe("a code replayed while its first redemption is under way", () => {
  /** The connection's state in the tenant's log. */
  const stateOf = async (id: string) =>
    (
      await tenant.read((tx) =>
        tx.query<{ state: string }>("SELECT state FROM principals WHERE id = $1", [id]),
      )
    ).rows[0]?.state;
  const voided = async () =>
    (
      await control.read((tx) =>
        tx.query<{ voided_at: string | null }>("SELECT voided_at FROM oauth_grants"),
      )
    ).rows;

  it(
    "after the grant is recorded, before the credential: the first gets invalid_grant, nothing issued",
    async () => {
      const name = freshName();
      const c = await code({ name });
      let second = "";
      const first = redeemCode(deps(), form(c), NOW, {
        beforeCredential: async () => {
          second = await refused(redeemCode(deps(), form(c), later(1)));
        },
      });
      expect(await refused(first)).toBe("invalid_grant");
      expect(second).toBe("invalid_grant");
      expect(await voided()).toEqual([{ voided_at: later(1) }]);
      expect(await count("credentials")).toBe(0);
      expect(await registered(name)).toEqual([]);
    },
    T,
  );

  it(
    "the CLI's, at the same point: no user session written",
    async () => {
      const c = await code({
        client: CLI_CLIENT,
        redirectUri: "http://127.0.0.1:49152/callback",
        scopes: [],
        name: null,
      });
      const f = () =>
        form(c, { client_id: "saveslot-cli", redirect_uri: "http://127.0.0.1:49152/callback" });
      const first = redeemCode(deps(), f(), NOW, {
        beforeCredential: async () => {
          await refused(redeemCode(deps(), f(), later(1)));
        },
      });
      expect(await refused(first)).toBe("invalid_grant");
      expect(await count("credentials")).toBe(0);
    },
    T,
  );

  it(
    "the CLI's, after the session is written: the session gone, invalid_grant",
    async () => {
      const c = await code({
        client: CLI_CLIENT,
        redirectUri: "http://127.0.0.1:49152/callback",
        scopes: [],
        name: null,
      });
      const f = () =>
        form(c, { client_id: "saveslot-cli", redirect_uri: "http://127.0.0.1:49152/callback" });
      let written = -1;
      const first = redeemCode(deps(), f(), NOW, {
        afterCredential: async () => {
          written = await count("credentials");
          await refused(redeemCode(deps(), f(), later(1)));
        },
      });
      expect(await refused(first)).toBe("invalid_grant");
      expect(written).toBe(1);
      expect(await count("credentials")).toBe(0);
    },
    T,
  );

  it(
    "after the credential, before the registration: the credential gone, the connection revoked",
    async () => {
      const name = freshName();
      const c = await code({ name });
      const first = redeemCode(deps(), form(c), NOW, {
        afterCredential: async () => {
          await refused(redeemCode(deps(), form(c), later(1)));
        },
      });
      expect(await refused(first)).toBe("invalid_grant");
      expect(await count("credentials")).toBe(0);
      const [p] = await registered(name);
      expect(await stateOf(p?.["principal"] as string)).toBe("revoked");
      expect(await voided()).toEqual([{ voided_at: later(1) }]);
      const g = await control.read((tx) =>
        tx.query<{ principal: string | null }>("SELECT principal FROM oauth_grants"),
      );
      expect(g.rows).toEqual([{ principal: null }]);
    },
    T,
  );

  it(
    "the grant not naming the connection (the store fails): the connection revoked, the grant voided",
    async () => {
      const name = freshName();
      const c = await code({ name });
      const s = store();
      const failing = new Proxy(s, {
        get: (target, prop) =>
          prop === "setGrantPrincipal"
            ? async () => {
                throw new Error("the control database is gone");
              }
            : (Reflect.get(target, prop) as (...a: unknown[]) => unknown).bind(target),
      });
      await expect(redeemCode({ ...deps(), store: failing }, form(c), NOW)).rejects.toThrow(
        "the control database is gone",
      );
      const [p] = await registered(name);
      expect(await stateOf(p?.["principal"] as string)).toBe("revoked");
      expect(await voided()).toEqual([{ voided_at: NOW }]);
      expect(await count("credentials")).toBe(0);
    },
    T,
  );
});

describe("form tokens", () => {
  it(
    "a form token is used once, only with what it is bound to, only before it expires",
    async () => {
      await store().putForm("f1", "user-a", later(600));
      expect(await store().useForm("f1", "user-a", NOW)).toBe(true);
      expect(await store().useForm("f1", "user-a", NOW)).toBe(false);

      await store().putForm("f2", "user-a", later(600));
      expect(await store().useForm("f2", "user-b", NOW)).toBe(false);
      // A mismatched attempt used it up.
      expect(await store().useForm("f2", "user-a", NOW)).toBe(false);

      await store().putForm("f3", "user-a", later(600));
      expect(await store().useForm("f3", "user-a", later(600))).toBe(false);
    },
    T,
  );

  it(
    "sweep deletes what has expired and keeps the rest",
    async () => {
      await store().putForm("old", "x", later(1));
      await store().putForm("new", "x", later(100));
      await code();
      // The form token and the code (60 seconds) have expired.
      expect(await store().sweep(later(60))).toBe(2);
      expect(await store().useForm("new", "x", later(61))).toBe(true);
    },
    T,
  );
});

describe("writes refused with the control plane's codes", () => {
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof ControlPlaneError) return e.code;
      throw e;
    }
    return "written";
  };
  const entry = {
    clientId: ID,
    redirectUri: CLIENT.redirectUris[0] as string,
    codeChallenge: CHALLENGE,
    resource: EXT,
    user: USER,
    login: LOGIN,
    tenant: TENANT,
    scopes: ["saveslot.read" as const],
    expiresAt: later(60),
  };
  const grant = {
    id: "g-1",
    kind: "connection" as const,
    tenant: TENANT,
    clientId: ID,
    resource: EXT,
    createdAt: NOW,
  };

  it(
    "the same code hash, grant ID or form token hash twice: already_exists",
    async () => {
      expect(await codeOf(store().putCode("c".repeat(64), entry))).toBe("written");
      expect(await codeOf(store().putCode("c".repeat(64), entry))).toBe("already_exists");
      expect(await codeOf(store().putGrant(grant))).toBe("written");
      expect(await codeOf(store().putGrant(grant))).toBe("already_exists");
      expect(await codeOf(store().putForm("f".repeat(64), "s", later(60)))).toBe("written");
      expect(await codeOf(store().putForm("f".repeat(64), "s", later(60)))).toBe("already_exists");
    },
    T,
  );

  it(
    "a tenant not in the directory: unknown_tenant",
    async () => {
      const other = `tn_${"9".repeat(26)}` as const;
      expect(await codeOf(store().putCode("d".repeat(64), { ...entry, tenant: other }))).toBe(
        "unknown_tenant",
      );
      expect(await codeOf(store().putGrant({ ...grant, id: "g-2", tenant: other }))).toBe(
        "unknown_tenant",
      );
    },
    T,
  );
});
