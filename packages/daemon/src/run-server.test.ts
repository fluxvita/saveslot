// The server mode's process (06-cli §4.1 `saveslot server start`; 02-architecture §5, §9; 05-surfaces
// §14, §15) on a real control database and tenants, on either backend (`pnpm test:postgres` runs this
// file on PostgreSQL): what answers each request, in which order, what it refuses to start on, and
// how it closes. Fictional names.
//
// New passwords are hashed with cheap scrypt parameters (useScryptForTests): this file is not about
// the hash's cost. The real parameters are covered by service's local-accounts.test.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join } from "node:path";
import {
  addLocalUser,
  CALL_RECORD_FIELDS,
  CLIENT_FETCH_BOUNDS,
  CursorKeys,
  type DiscardDatabase,
  databaseOf,
  initControlPlane,
  initExternalLogin,
  initLocalAccounts,
  initOAuthTables,
  openOAuthStore,
  type ServerControlPlane,
  stagingDatabaseOf,
  type TenantId,
  type TenantPoolOptions,
  tokenHash,
  type UserId,
  writeUserSession,
} from "@fluxvita/saveslot-service";
import { useScryptForTests } from "@fluxvita/saveslot-service/testing";
import {
  type ControlDatabase,
  checkDiscard,
  openControlDatabase,
  PostgresBackend,
} from "@fluxvita/saveslot-store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_KEY } from "../../service/src/external-assertion.fixture.ts";
import { cellFromEnv } from "../../store-postgres/src/testing/server.fixture.ts";
import { testPostgres } from "../../store-postgres/src/testing/test-postgres.fixture.ts";
import {
  dropTestStorage,
  TEST_BACKEND,
  testBackend,
} from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import { SAMPLE_SLOT } from "./format-sample.fixture.ts";
import {
  cellBackend,
  cellDiscarder,
  type RunningServer,
  type RunServerOptions,
  ServerAlreadyRunning,
  ServerStartRefused,
  runServer as startServer,
} from "./run-server.ts";
import type { ServerConfig } from "./server-config.ts";
import { IdentityTablesRefused } from "./server-identity.ts";
import { SERVER_LOCK } from "./server-lock.ts";
import { serverRestore } from "./server-restore-command.ts";
import { testRoot } from "./test-root.fixture.ts";

/** A store the test backend opens: the control database of these tests. */
type Store = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;

const T = 120_000;
const NOW = "2026-11-21T08:00:00.000Z";
const PUBLIC = "http://127.0.0.1:8080";
const CELL = "main";
// First: its removal runs after every other hook of the file.
const tmp = testRoot("saveslot-run-server-", T);
const root = tmp.root;

let n = 0;
const stores: Store[] = [];
// Cheap scrypt for new passwords (see the head of the file); each hash records its own parameters.
beforeAll(() => useScryptForTests({ N: 2 ** 10, r: 8, p: 1 }));
afterAll(() => useScryptForTests(undefined));

afterAll(async () => {
  for (const s of stores) await tmp.closeWarned("a control database", s);
}, T);

/** A server, named as still open until it is closed. */
const runServer = async (o: RunServerOptions) => {
  const s = await startServer(o);
  return tmp.track(`the server on port ${s.address.port}`, s);
};

/** A server tenant's database is a directory of the test backend; `gate` holds an open back. */
function tenants(gate?: { opened?: () => void; release?: Promise<void> }) {
  const dir = join(root, `tenants${n++}`);
  let closed = 0;
  const backend: TenantPoolOptions["backend"] = {
    open: async (ref, opts) => {
      if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
      gate?.opened?.();
      await gate?.release;
      const s = await testBackend().open(
        { kind: "pglite", dir: join(dir, ref.cell, ref.database) },
        opts,
      );
      const close = s.close.bind(s);
      return tmp.track(
        `the tenant database ${ref.database}`,
        Object.assign(s, {
          close: async () => {
            closed++;
            await close();
          },
        }),
      );
    },
  };
  return { backend, dir, closed: () => closed };
}

/**
 * A control database with the tables `server init` makes for the local accounts, or for the
 * external login with `external`; told to, it leaves the provider's, the authorization server's
 * or every table out.
 */
async function controlDb(
  o: { provider?: boolean; external?: boolean; control?: boolean; oauth?: boolean } = {},
) {
  const dir = join(root, `control${n++}`);
  const store = tmp.track(
    `the control database ${dir}`,
    await testBackend().open({ kind: "pglite", dir }, { create: true }),
  );
  stores.push(store);
  const cp = o.control === false ? undefined : await initControlPlane(store);
  if (cp !== undefined && o.oauth !== false) await initOAuthTables(store);
  const made = o.provider !== false && cp !== undefined;
  if (made && o.external === true) await initExternalLogin(store);
  const accounts = made && o.external !== true ? await initLocalAccounts(store) : undefined;
  let closes = 0;
  // Closing it is counted, not done: the test reads the store after.
  const db: ControlDatabase = {
    read: store.read.bind(store),
    write: store.write.bind(store),
    close: async () => {
      closes++;
    },
    onLost: () => {},
  };
  return { store, cp, accounts, db, dir, closes: () => closes };
}

/** A user session's token for `user`, written as an identity provider writes one. */
const sessionFor = (store: Store, user: UserId) =>
  store.write((tx) => writeUserSession(tx, user, { expiresAt: "2099-01-01T00:00:00.000Z" }));

/** The control database's tables, by name. */
const tableNames = (store: Store) =>
  store.read(async (tx) =>
    (
      await tx.query<{ t: string }>(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
      )
    ).rows.map((r) => r.t),
  );

/** The external login's settings, with a key file of the test platform's public key. */
function externalSettings(): NonNullable<ServerConfig["identity"]> {
  const keysFile = join(root, `platform-keys${n++}.json`);
  writeFileSync(keysFile, JSON.stringify({ keys: [TEST_KEY.public] }), { mode: 0o600 });
  return {
    issuer: "https://platform.example",
    loginUrl: "https://platform.example/login",
    keysFile,
  };
}

function config(over: Partial<ServerConfig> = {}): ServerConfig {
  const keys = join(root, `keys${n++}`);
  mkdirSync(keys, { mode: 0o700 });
  return {
    control: { cell: { host: "unused", user: "unused" }, database: "unused" },
    cell: { host: "unused", user: "unused" },
    cellName: CELL,
    publicUrl: PUBLIC,
    handleKeyFile: join(keys, "handle-key"),
    listen: { host: "127.0.0.1", port: 0 },
    trustedProxies: ["127.0.0.1"],
    allowedOrigins: [],
    // No drain: a test that closes a server does not wait for a load balancer.
    shutdown: { drainSeconds: 0, timeoutSeconds: 30 },
    tenants: { maxOpen: 50, idleSeconds: 300 },
    ...over,
  };
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(
  s: RunningServer,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: s.address.host,
        port: s.address.port,
        method: o.method ?? "GET",
        path: o.path,
        headers: o.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** The hosted console's origin, as its browser sends it. */
const CONSOLE = "https://console.example";

/** A reply's CORS headers (and `Vary`), by name. */
const corsOf = (r: Reply) =>
  Object.fromEntries(
    Object.entries(r.headers).filter(([k]) => k.startsWith("access-control-") || k === "vary"),
  );

const FORM = { "content-type": "application/x-www-form-urlencoded" };
/** The login page, as an authorization page sends a browser there (05-surfaces §15). */
const LOGIN_PAGE = "/account/login?return_to=%2Foauth%2F";

/** A login form for a source: its token and the cookie it is bound to. */
async function loginForm(s: RunningServer, source: string) {
  const r = await send(s, { path: LOGIN_PAGE, headers: { "x-forwarded-for": source } });
  const token = /name="form_token" value="([^"]+)"/.exec(r.body)?.[1];
  const cookie = [r.headers["set-cookie"]].flat()[0]?.split(";")[0];
  if (token === undefined || cookie === undefined) throw new Error("no login form");
  return { token, cookie };
}

/** One login with a wrong password from `source`: its status. */
async function failedLogin(s: RunningServer, source: string, name: string): Promise<number> {
  const f = await loginForm(s, source);
  const r = await send(s, {
    method: "POST",
    path: "/account/login",
    headers: { ...FORM, cookie: f.cookie, "x-forwarded-for": source },
    body: new URLSearchParams({
      form_token: f.token,
      return_to: "/oauth/",
      name,
      password: "not-the-password",
    }).toString(),
  });
  return r.status;
}

describe("runServer: what answers which request", () => {
  let s: RunningServer;
  let session = "";
  let c: Awaited<ReturnType<typeof controlDb>>;
  let user: UserId;
  let tenantId: TenantId;
  beforeAll(async () => {
    c = await controlDb();
    const t = tenants();
    const cfg = config();
    await CursorKeys.createFile(cfg.handleKeyFile);
    const accounts = c.accounts as NonNullable<typeof c.accounts>;
    const cp = c.cp as ServerControlPlane;
    ({ user } = await addLocalUser(accounts, {
      control: cp,
      backend: t.backend,
      name: "alex",
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    }));
    tenantId = (await cp.tenantOf(user))?.id as TenantId;
    session = await sessionFor(c.store, user);
    s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      now: () => NOW,
    });
  }, T);
  afterAll(async () => {
    await s?.close();
  }, T);

  it("GET /health takes no token", async () => {
    const r = await send(s, { path: "/health" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ state: "ready", version: "0.0.0-test" });
  });

  it("GET /ready takes no token, nor a trusted proxy: 200 while ready, the body /health's", async () => {
    // From a source no proxy vouches for: /ready is answered before the request's source is read.
    const r = await send(s, { path: "/ready", headers: { "x-forwarded-for": "not an address" } });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(r.body)).toMatchObject({ state: "ready", version: "0.0.0-test" });
    // GET only: another method goes where any other path does.
    expect((await send(s, { method: "POST", path: "/ready" })).status).toBe(404);
  });

  it("a path nothing answers: 404 with no body", async () => {
    expect(await send(s, { path: "/elsewhere" })).toMatchObject({ status: 404, body: "" });
  });

  it("/v1/ with no token: 401, the challenge naming the protected resource's metadata", async () => {
    const r = await send(s, { path: "/v1/slots" });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toContain(
      `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`,
    );
  });

  it(
    "a user session's token reaches its tenant",
    async () => {
      const r = await send(s, {
        path: "/v1/slots",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(r.status).toBe(200);
    },
    T,
  );

  it("the authorization server's metadata: the external address is the issuer and the resource", async () => {
    const as = await send(s, { path: "/.well-known/oauth-authorization-server" });
    expect(as.status).toBe(200);
    expect(JSON.parse(as.body)).toMatchObject({
      issuer: PUBLIC,
      token_endpoint: `${PUBLIC}/oauth/token`,
    });
    const pr = await send(s, { path: "/.well-known/oauth-protected-resource" });
    expect(JSON.parse(pr.body)).toMatchObject({
      resource: PUBLIC,
      authorization_servers: [PUBLIC],
    });
  });

  it("a page of another site: 403 before /v1/ and /mcp, plain text; the external origin goes on", async () => {
    const auth = { authorization: `Bearer ${session}` };
    for (const path of ["/v1/slots", "/mcp"]) {
      const r = await send(s, { path, headers: { ...auth, origin: "https://evil.example" } });
      expect(r.status).toBe(403);
      expect(r.headers["content-type"]).toContain("text/plain");
    }
    // Matched on the parsed path, as the adapters are: an absolute-form target is no way around it.
    const abs = await send(s, {
      path: "http://elsewhere.example/v1/slots",
      headers: { ...auth, origin: "https://evil.example" },
    });
    expect(abs.status).toBe(403);
    const ok = await send(s, { path: "/v1/slots", headers: { ...auth, origin: PUBLIC } });
    expect(ok.status).toBe(200);
    // The identity provider's and the authorization server's pages have checks of their own.
    const page = await send(s, { path: LOGIN_PAGE, headers: { origin: "https://evil.example" } });
    expect(page.status).toBe(200);
    // Nor is any other path the guard's: what nothing answers is still 404.
    const elsewhere = await send(s, {
      path: "/elsewhere",
      headers: { origin: "https://evil.example" },
    });
    expect(elsewhere.status).toBe(404);
  });

  it("no origins listed (the default): another site's page gets no CORS headers, its preflight no answer", async () => {
    const from = { origin: CONSOLE };
    const api = await send(s, {
      path: "/v1/slots",
      headers: { ...from, authorization: `Bearer ${session}` },
    });
    expect(api.status).toBe(403);
    for (const path of ["/oauth/token", "/oauth/revoke"]) {
      const r = await send(s, { method: "POST", path, headers: { ...from, ...FORM }, body: "" });
      expect(r.status).toBe(400);
      expect(corsOf(r)).toEqual({});
      expect((await send(s, { method: "OPTIONS", path, headers: from })).status).toBe(405);
    }
    expect(corsOf(api)).toEqual({});
    const preflight = await send(s, { method: "OPTIONS", path: "/v1/slots", headers: from });
    expect([preflight.status, corsOf(preflight)]).toEqual([403, {}]);
    // Nor does any response vary with Origin while none is listed.
    const none = await send(s, { path: "/v1/slots" });
    expect([none.status, corsOf(none)]).toEqual([401, {}]);
  });

  it(
    "a token of an authorization is good only at the address it was issued for",
    async () => {
      const oauth = await openOAuthStore(c.store);
      const grantFor = async (id: string, resource: string) => {
        await oauth.putGrant({
          id,
          kind: "session",
          principal: user,
          tenant: tenantId,
          clientId: "saveslot-cli",
          resource,
          createdAt: NOW,
        });
        return c.store.write((tx) =>
          writeUserSession(tx, user, { grant: id, expiresAt: "2099-01-01T00:00:00.000Z" }),
        );
      };
      const here = await grantFor("g-here", PUBLIC);
      const there = await grantFor("g-there", "https://elsewhere.example");
      const status = async (t: string) =>
        (await send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${t}` } })).status;
      expect(await status(here)).toBe(200);
      expect(await status(there)).toBe(401);
    },
    T,
  );

  it("the CLI's device sign-in starts here, its verification page at the external address", async () => {
    const r = await send(s, {
      method: "POST",
      path: "/oauth/device",
      headers: FORM,
      body: new URLSearchParams({ client_id: "saveslot-cli", resource: PUBLIC }).toString(),
    });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.body) as { device_code: string; verification_uri: string };
    expect(d.device_code).toBeTruthy();
    expect(d.verification_uri.startsWith(`${PUBLIC}/`)).toBe(true);
    const page = await send(s, { path: d.verification_uri.slice(PUBLIC.length) });
    expect(page.status).not.toBe(404);
  });

  it("/account/login is the local accounts' page, with its form cookie", async () => {
    const r = await send(s, { path: LOGIN_PAGE });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toContain('name="form_token"');
    expect(String(r.headers["set-cookie"])).toContain("saveslot_login_form=");
  });

  it(
    "a local login lasts 12 hours: its cookie's Max-Age (05-surfaces §15)",
    async () => {
      const f = await loginForm(s, "203.0.113.9");
      const r = await send(s, {
        method: "POST",
        path: "/account/login",
        headers: { ...FORM, cookie: f.cookie, "x-forwarded-for": "203.0.113.9" },
        body: new URLSearchParams({
          form_token: f.token,
          return_to: "/oauth/",
          name: "alex",
          password: "correct horse battery",
        }).toString(),
      });
      expect(r.status).toBe(303);
      const login = [r.headers["set-cookie"]].flat().find((c) => c?.startsWith("saveslot_login="));
      expect(login).toContain("Max-Age=43200");
    },
    T,
  );

  it("an absolute-form target goes where its path does, on every route", async () => {
    const abs = (path: string) => `http://elsewhere.example${path}`;
    expect((await send(s, { path: abs("/health") })).status).toBe(200);
    const page = await send(s, { path: abs(LOGIN_PAGE) });
    expect(page.status).toBe(200);
    expect(page.body).toContain('name="form_token"');
    expect((await send(s, { path: abs("/v1/slots") })).status).toBe(401);
    expect((await send(s, { path: abs("/.well-known/oauth-authorization-server") })).status).toBe(
      200,
    );
    expect((await send(s, { method: "POST", path: abs("/oauth/token") })).status).toBe(400);
    expect((await send(s, { path: abs("/elsewhere") })).status).toBe(404);
    const mcp = (path: string) =>
      send(s, {
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    const relative = await mcp("/mcp");
    expect(relative.status).not.toBe(404);
    expect((await mcp(abs("/mcp"))).status).toBe(relative.status);
  });

  it(
    "behind a trusted proxy, X-Forwarded-For's address is the source failed logins count by",
    async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push(await failedLogin(s, "203.0.113.5", "alex"));
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      // Another source behind the same proxy is not held back with it.
      expect(await failedLogin(s, "203.0.113.6", "alex")).toBe(401);
    },
    T,
  );
});

describe("runServer: no trusted proxy", () => {
  it(
    "X-Forwarded-For counts for nothing: every request's source is its connection's",
    async () => {
      const c = await controlDb();
      const t = tenants();
      const cfg = config({ trustedProxies: [] });
      await CursorKeys.createFile(cfg.handleKeyFile);
      await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: c.cp as ServerControlPlane,
        backend: t.backend,
        name: "devon",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: t.backend,
        now: () => NOW,
      });
      try {
        const statuses: number[] = [];
        // Each from a source of its own, as written: all are the one connection's address.
        for (let i = 0; i < 6; i++)
          statuses.push(await failedLogin(s, `203.0.113.${20 + i}`, "devon"));
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

describe("runServer: a trusted proxy range", () => {
  it(
    "a connection inside the range is a trusted proxy: X-Forwarded-For's address is the source",
    async () => {
      const c = await controlDb();
      const t = tenants();
      // The loopback connection is inside 127.0.0.0/8, not a single address listed.
      const cfg = config({ trustedProxies: ["127.0.0.0/8"] });
      await CursorKeys.createFile(cfg.handleKeyFile);
      await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: c.cp as ServerControlPlane,
        backend: t.backend,
        name: "kai",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: t.backend,
        now: () => NOW,
      });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) statuses.push(await failedLogin(s, "203.0.113.40", "kai"));
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
        // Another source behind the same range is not held back with it.
        expect(await failedLogin(s, "203.0.113.41", "kai")).toBe(401);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

// A deployment's listed origins (05-surfaces §13): a browser page of the hosted console calls
// /v1/, /oauth/token and /oauth/revoke directly; another site's page gets no CORS headers, and /mcp
// takes no page of another site, listed or not. No response allows credentials.
describe("runServer: origins a deployment lists", () => {
  let s: RunningServer;
  let session = "";
  const LISTED = { origin: CONSOLE };
  const OTHER = { origin: "https://evil.example" };
  beforeAll(async () => {
    const c = await controlDb();
    const t = tenants();
    const cfg = config({ allowedOrigins: ["https://elsewhere.example", CONSOLE] });
    await CursorKeys.createFile(cfg.handleKeyFile);
    const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
      control: c.cp as ServerControlPlane,
      backend: t.backend,
      name: "robin",
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    });
    session = await sessionFor(c.store, user);
    s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      now: () => NOW,
    });
  }, T);
  afterAll(async () => {
    await s?.close();
  }, T);

  it("a listed origin's preflight is answered on /v1/, /oauth/token and /oauth/revoke", async () => {
    for (const path of ["/v1/writes", "/v1/connections/c_1", "/oauth/token", "/oauth/revoke"]) {
      const r = await send(s, {
        method: "OPTIONS",
        path,
        headers: {
          ...LISTED,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type, idempotency-key",
        },
      });
      expect(r.status).toBe(204);
      expect(corsOf(r)).toEqual({
        "access-control-allow-origin": CONSOLE,
        vary: "Origin",
        "access-control-expose-headers": "Retry-After, WWW-Authenticate, Saveslot-Call",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE",
        "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, X-Task-Id",
      });
    }
  });

  it(
    "a listed origin's calls are taken, each response naming it; none allows credentials",
    async () => {
      const api = await send(s, {
        path: "/v1/slots",
        headers: { ...LISTED, authorization: `Bearer ${session}` },
      });
      expect(api.status).toBe(200);
      // A refusal carries them too: the page reads why.
      const unauthenticated = await send(s, { path: "/v1/slots", headers: LISTED });
      expect(unauthenticated.status).toBe(401);
      const token = await send(s, {
        method: "POST",
        path: "/oauth/token",
        headers: { ...LISTED, ...FORM },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "x" }).toString(),
      });
      expect(token.status).toBe(400);
      const revoke = await send(s, {
        method: "POST",
        path: "/oauth/revoke",
        headers: { ...LISTED, ...FORM },
        body: new URLSearchParams({ token: "not-a-token", client_id: "saveslot-cli" }).toString(),
      });
      expect(revoke.status).toBe(200);
      for (const r of [api, unauthenticated, token, revoke]) {
        expect(corsOf(r)).toEqual({
          "access-control-allow-origin": CONSOLE,
          vary: "Origin",
          "access-control-expose-headers": "Retry-After, WWW-Authenticate, Saveslot-Call",
        });
      }
    },
    T,
  );

  it("an origin not listed: processed as before, its origin named nowhere", async () => {
    const api = await send(s, {
      path: "/v1/slots",
      headers: { ...OTHER, authorization: `Bearer ${session}` },
    });
    expect(api.status).toBe(403);
    const token = await send(s, {
      method: "POST",
      path: "/oauth/token",
      headers: { ...OTHER, ...FORM },
      body: "",
    });
    expect(token.status).toBe(400);
    const preflight = await send(s, { method: "OPTIONS", path: "/oauth/revoke", headers: OTHER });
    expect(preflight.status).toBe(405);
    // Compared as written: the console's origin in capitals, or with a port, is not it.
    const near: Reply[] = [];
    for (const origin of ["https://Console.example", `${CONSOLE}:443`]) {
      const r = await send(s, {
        path: "/v1/slots",
        headers: { origin, authorization: `Bearer ${session}` },
      });
      expect(r.status).toBe(403);
      near.push(r);
    }
    for (const r of [api, token, preflight, ...near]) expect(corsOf(r)).toEqual({ vary: "Origin" });
  });

  it("a listed origin's page may send X-Task-Id, every header the HTTP surface defines", async () => {
    const r = await send(s, {
      method: "OPTIONS",
      path: "/v1/writes",
      headers: { ...LISTED, "access-control-request-headers": "x-task-id" },
    });
    const allowed = String(r.headers["access-control-allow-headers"]).toLowerCase().split(", ");
    expect(allowed).toEqual(
      expect.arrayContaining(["authorization", "content-type", "idempotency-key", "x-task-id"]),
    );
  });

  it("a listed origin's page reads why it was refused and when to retry: WWW-Authenticate exposed", async () => {
    const r = await send(s, { path: "/v1/slots", headers: LISTED });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBeDefined();
    const exposed = String(r.headers["access-control-expose-headers"]).toLowerCase().split(", ");
    expect(exposed).toEqual(expect.arrayContaining(["www-authenticate", "retry-after"]));
  });

  it("while origins are listed, every response on /v1/ and the token endpoints varies with Origin", async () => {
    const replies = [
      await send(s, { path: "/v1/slots", headers: OTHER }),
      await send(s, { path: "/v1/slots" }),
      await send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${session}` } }),
      await send(s, { method: "POST", path: "/oauth/token", headers: FORM, body: "" }),
      await send(s, { method: "POST", path: "/oauth/revoke", headers: FORM, body: "" }),
    ];
    expect(replies.map((r) => r.status)).toEqual([403, 401, 200, 400, 400]);
    for (const r of replies) expect(corsOf(r)).toEqual({ vary: "Origin" });
  });

  it("the other pages take no listed origin: no CORS headers, no preflight answered", async () => {
    for (const [method, path] of [
      ["GET", "/oauth/authorize?client_id=x"],
      ["GET", LOGIN_PAGE],
      ["POST", "/oauth/device"],
      ["GET", "/oauth/device/verify"],
      ["GET", "/.well-known/oauth-authorization-server"],
    ] as const) {
      const r = await send(s, {
        method,
        path,
        headers: { ...LISTED, ...(method === "POST" ? FORM : {}) },
        ...(method === "POST" ? { body: "" } : {}),
      });
      expect(r.status).not.toBe(404);
      expect(corsOf(r)).toEqual({});
      const preflight = await send(s, { method: "OPTIONS", path, headers: LISTED });
      expect(preflight.status).not.toBe(204);
      expect(corsOf(preflight)).toEqual({});
    }
  });

  it("/mcp takes no page of another site, listed or not, and answers none of its preflights", async () => {
    for (const from of [LISTED, OTHER]) {
      const r = await send(s, {
        method: "POST",
        path: "/mcp",
        headers: {
          ...from,
          authorization: `Bearer ${session}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(r.status).toBe(403);
      expect(corsOf(r)).toEqual({});
      const preflight = await send(s, { method: "OPTIONS", path: "/mcp", headers: from });
      expect([preflight.status, corsOf(preflight)]).toEqual([403, {}]);
    }
  });
});

// Remote MCP end to end (05-surfaces §14, §15 «远程授权»), through the server itself: a host that
// knows only the MCP endpoint's address finds the authorization server from the 401, reads both
// metadata documents, sends its user through the local accounts' login and the authorization page
// with PKCE, redeems the code, then initializes, lists the tools, reads and writes (a new slot); a
// page of another site is refused before MCP; once the user revokes the connection through /v1, its
// refresh tokens are gone and the same token gets 401. Raw JSON-RPC, as a host sends it.
describe("runServer: remote MCP, end to end", () => {
  const CLIENT_ID = "https://host.example/oauth/client.json";
  const REDIRECT = "https://host.example/callback";
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const PROTOCOL = "2025-11-25";
  let s: RunningServer;
  let c: Awaited<ReturnType<typeof controlDb>>;
  let base = "";
  let session = "";
  let token = "";
  let refresh = "";
  let connection = "";
  beforeAll(async () => {
    c = await controlDb();
    const t = tenants();
    const cfg = config();
    await CursorKeys.createFile(cfg.handleKeyFile);
    const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
      control: c.cp as ServerControlPlane,
      backend: t.backend,
      name: "robin",
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    });
    session = await sessionFor(c.store, user);
    s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      now: () => NOW,
      // The host's client document, as its address would give it: nothing goes to the network.
      fetchClient: async () => ({
        body: new TextEncoder().encode(
          JSON.stringify({
            client_id: CLIENT_ID,
            client_name: "Example Host",
            redirect_uris: [REDIRECT],
          }),
        ),
      }),
    });
    base = `http://${s.address.host}:${s.address.port}`;
  }, T);
  afterAll(async () => {
    await s?.close();
  }, T);

  /** An address of the external one, as this test's server answers it. */
  const local = (url: string) => {
    expect(url.startsWith(PUBLIC)).toBe(true);
    return `${base}${url.slice(PUBLIC.length)}`;
  };
  let ids = 0;
  const rpc = (t: string | undefined, method: string, params: unknown, more = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(t === undefined ? {} : { authorization: `Bearer ${t}` }),
        ...more,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++ids, method, params }),
    });
  /** A JSON-RPC result, sent as JSON or as one SSE message (a host takes either). */
  const result = async (r: Response) => {
    expect(r.status).toBe(200);
    const text = await r.text();
    const json = (r.headers.get("content-type") ?? "").startsWith("text/event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      : text;
    const body = JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown };
    expect(body.error).toBeUndefined();
    return body.result as Record<string, unknown>;
  };
  const initialize = (t: string | undefined, more = {}) =>
    rpc(
      t,
      "initialize",
      {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "example-host", version: "1" },
      },
      more,
    );

  it(
    "finds the authorization server from the 401, signs in, and authorizes with PKCE",
    async () => {
      const first = await initialize(undefined);
      expect(first.status).toBe(401);
      const challenge = first.headers.get("www-authenticate") as string;
      const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] as string;
      expect(prmUrl).toBe(`${PUBLIC}/.well-known/oauth-protected-resource`);
      const prm = (await (await fetch(local(prmUrl))).json()) as {
        authorization_servers: string[];
      };
      const issuer = prm.authorization_servers[0] as string;
      const asm = (await (
        await fetch(local(`${issuer}/.well-known/oauth-authorization-server`))
      ).json()) as { authorization_endpoint: string; token_endpoint: string };

      const q = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        response_type: "code",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "saveslot.read saveslot.write saveslot.schema",
        resource: `${PUBLIC}/mcp`,
        state: "st-e2e",
      }).toString();
      const pageUrl = `${local(asm.authorization_endpoint)}?${q}`;
      // Signed out: sent to the local accounts' login, which comes back to the page.
      const out = await fetch(pageUrl, { redirect: "manual" });
      expect(out.status).toBe(302);
      const loginAt = new URL(out.headers.get("location") as string, base);
      const form = await fetch(`${base}${loginAt.pathname}${loginAt.search}`);
      const formToken = /name="form_token" value="([^"]+)"/.exec(await form.text())?.[1] as string;
      const formCookie = (form.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const login = await fetch(`${base}/account/login`, {
        method: "POST",
        redirect: "manual",
        headers: { ...FORM, cookie: formCookie },
        body: new URLSearchParams({
          form_token: formToken,
          return_to: loginAt.searchParams.get("return_to") as string,
          name: "robin",
          password: "correct horse battery",
        }).toString(),
      });
      expect(login.status).toBe(303);
      const cookie = login.headers
        .getSetCookie()
        .find((x) => x.startsWith("saveslot_login="))
        ?.split(";")[0] as string;

      const page = await (await fetch(pageUrl, { headers: { cookie } })).text();
      const consentToken = /name="form_token" value="([^"]+)"/.exec(page)?.[1] as string;
      const answer = await fetch(pageUrl, {
        method: "POST",
        redirect: "manual",
        headers: { ...FORM, cookie },
        body: new URLSearchParams([
          ["form_token", consentToken],
          ["decision", "allow"],
          ["name", "Laptop · Example Host"],
          ["scope", "saveslot.read"],
          ["scope", "saveslot.write"],
          ["scope", "saveslot.schema"],
        ]).toString(),
      });
      expect(answer.status).toBe(302);
      const back = new URL(answer.headers.get("location") as string);
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
      expect(back.searchParams.get("state")).toBe("st-e2e");
      expect(back.searchParams.get("iss")).toBe(PUBLIC);

      const t = await fetch(local(asm.token_endpoint), {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: back.searchParams.get("code") as string,
          code_verifier: VERIFIER,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT,
          resource: `${PUBLIC}/mcp`,
        }).toString(),
      });
      expect(t.status).toBe(200);
      const body = (await t.json()) as {
        access_token: string;
        refresh_token: string;
        scope: string;
      };
      expect(body.scope).toBe("saveslot.read saveslot.write saveslot.schema");
      token = body.access_token;
      refresh = body.refresh_token;
      connection = (await (c.cp as ServerControlPlane).credential(tokenHash(token)))
        ?.principal as string;
      expect(connection).toMatch(/^ci_/);
    },
    T,
  );

  it(
    "with the token: initialize, the tools, a read, a write",
    async () => {
      const init = await result(await initialize(token));
      expect(init).toMatchObject({ protocolVersion: PROTOCOL, serverInfo: { name: "saveslot" } });
      const tools = (await result(await rpc(token, "tools/list", {})))["tools"] as {
        name: string;
      }[];
      const names = tools.map((x) => x.name);
      expect(names).toContain("saveslot_schema_draft");
      expect(names).not.toContain("saveslot_delete");
      const written = await result(
        await rpc(token, "tools/call", {
          name: "saveslot_schema_draft",
          arguments: {
            document: {
              slot: "diet",
              base_version: null,
              timezone: "Asia/Shanghai",
              tables: [
                {
                  name: "meals",
                  kind: "base",
                  description: "one row per meal",
                  time: { type: "event", field: "date" },
                  fields: [
                    { name: "date", type: "date", required: true, description: "the day" },
                    { name: "what", type: "text", required: true, description: "what was eaten" },
                  ],
                },
              ],
            },
            task: "start-diet",
          },
        }),
      );
      expect(written["isError"]).not.toBe(true);
      const catalog = await result(
        await rpc(token, "tools/call", { name: "saveslot_catalog", arguments: {} }),
      );
      expect(JSON.stringify(catalog)).toContain("diet");
    },
    T,
  );

  it(
    "a page of another site: 403 before MCP, plain text",
    async () => {
      const r = await initialize(token, { origin: "https://evil.example" });
      expect(r.status).toBe(403);
      expect(r.headers.get("content-type")).toContain("text/plain");
    },
    T,
  );

  it(
    "revoked by its user through /v1: its refresh tokens gone, the same token 401 invalid_token",
    async () => {
      const refreshRows = async () =>
        (
          await c.store.read((tx) =>
            tx.query("SELECT 1 FROM oauth_refresh_tokens WHERE hash = $1", [tokenHash(refresh)]),
          )
        ).rows.length;
      expect(await refreshRows()).toBe(1);
      const r = await fetch(`${base}/v1/connections/${connection}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(r.status).toBe(200);
      expect(await refreshRows()).toBe(0);
      const after = await rpc(token, "tools/list", {});
      expect(after.status).toBe(401);
      const challenge = after.headers.get("www-authenticate") ?? "";
      expect(challenge).toMatch(/^Bearer /);
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain(
        `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`,
      );
    },
    T,
  );
});

// A connection instance an OAuth host was authorized for, revoked by its user through /v1
// (connections.revoke): its refresh tokens go with it, through the OAuth tables the server hands
// serverCallers, so the host cannot get a new access token from one it kept.
describe("runServer: an OAuth connection revoked through /v1", () => {
  const CLIENT_ID = "https://host.example/oauth/client.json";
  const REDIRECT = "https://host.example/callback";
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  let s: RunningServer;
  let c: Awaited<ReturnType<typeof controlDb>>;
  let base = "";
  let session = "";
  beforeAll(async () => {
    c = await controlDb();
    const t = tenants();
    const cfg = config();
    await CursorKeys.createFile(cfg.handleKeyFile);
    const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
      control: c.cp as ServerControlPlane,
      backend: t.backend,
      name: "sasha",
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    });
    session = await sessionFor(c.store, user);
    s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      now: () => NOW,
      fetchClient: async () => ({
        body: new TextEncoder().encode(
          JSON.stringify({ client_id: CLIENT_ID, redirect_uris: [REDIRECT] }),
        ),
      }),
    });
    base = `http://${s.address.host}:${s.address.port}`;
  }, T);
  afterAll(async () => {
    await s?.close();
  }, T);

  /** Signs in at the local accounts' login, consents, redeems the code: the token answer. */
  async function authorize() {
    const pageUrl = `${base}/oauth/authorize?${new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      resource: `${PUBLIC}/mcp`,
      state: "st-1",
    })}`;
    const out = await fetch(pageUrl, { redirect: "manual" });
    const loginAt = new URL(out.headers.get("location") as string, base);
    const form = await fetch(`${base}${loginAt.pathname}${loginAt.search}`);
    const formToken = /name="form_token" value="([^"]+)"/.exec(await form.text())?.[1] as string;
    const login = await fetch(`${base}/account/login`, {
      method: "POST",
      redirect: "manual",
      headers: { ...FORM, cookie: (form.headers.get("set-cookie") ?? "").split(";")[0] as string },
      body: new URLSearchParams({
        form_token: formToken,
        return_to: loginAt.searchParams.get("return_to") as string,
        name: "sasha",
        password: "correct horse battery",
      }).toString(),
    });
    const cookie = login.headers
      .getSetCookie()
      .find((x) => x.startsWith("saveslot_login="))
      ?.split(";")[0] as string;
    const page = await (await fetch(pageUrl, { headers: { cookie } })).text();
    const answer = await fetch(pageUrl, {
      method: "POST",
      redirect: "manual",
      headers: { ...FORM, cookie },
      body: new URLSearchParams([
        ["form_token", /name="form_token" value="([^"]+)"/.exec(page)?.[1] as string],
        ["decision", "allow"],
        ["name", "Example Host"],
        ["scope", "saveslot.read"],
      ]).toString(),
    });
    const code = new URL(answer.headers.get("location") as string).searchParams.get("code");
    const t = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(t.status).toBe(200);
    return (await t.json()) as { access_token: string; refresh_token: string };
  }

  it(
    "its refresh tokens are deleted, and one kept is refused",
    async () => {
      const { access_token, refresh_token } = await authorize();
      const connection = (await (c.cp as ServerControlPlane).credential(tokenHash(access_token)))
        ?.principal as string;
      expect(connection).toMatch(/^ci_/);
      const refreshRows = async () =>
        (
          await c.store.read((tx) =>
            tx.query("SELECT 1 FROM oauth_refresh_tokens WHERE hash = $1", [
              tokenHash(refresh_token),
            ]),
          )
        ).rows.length;
      expect(await refreshRows()).toBe(1);
      const r = await fetch(`${base}/v1/connections/${connection}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(r.status).toBe(200);
      expect(await refreshRows()).toBe(0);
      const again = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token,
          client_id: CLIENT_ID,
        }).toString(),
      });
      expect(again.status).toBe(400);
      expect(((await again.json()) as { error: string }).error).toBe("invalid_grant");
    },
    T,
  );
});

// The bounds on fetching client documents count by the request's source as runServer gives it:
// behind a trusted proxy, the address X-Forwarded-For names, so one source at its bound holds back
// only itself. A document that fails its checks is not cached, so each request is a fetch.
describe("runServer: client document fetches, bounded per source", () => {
  let s: RunningServer;
  let fetches = 0;
  beforeAll(async () => {
    const c = await controlDb();
    const cfg = config();
    await CursorKeys.createFile(cfg.handleKeyFile);
    s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: tenants().backend,
      fetchClient: async () => {
        fetches++;
        return { body: new TextEncoder().encode(JSON.stringify({ client_id: "elsewhere" })) };
      },
    });
  }, T);
  afterAll(async () => {
    await s?.close();
  }, T);

  const authorize = (source: string, i: number) =>
    send(s, {
      path: `/oauth/authorize?${new URLSearchParams({
        client_id: `https://host.example/clients/${source}/${i}.json`,
        redirect_uri: "https://host.example/callback",
        response_type: "code",
      })}`,
      headers: { "x-forwarded-for": source },
    });

  it(
    "a source past its bound gets 429 without a fetch; another source behind the proxy does not",
    async () => {
      const statuses: number[] = [];
      for (let i = 0; i < CLIENT_FETCH_BOUNDS.perSource; i++) {
        statuses.push((await authorize("203.0.113.40", i)).status);
      }
      expect(new Set(statuses)).toEqual(new Set([400]));
      expect(fetches).toBe(CLIENT_FETCH_BOUNDS.perSource);
      expect((await authorize("203.0.113.40", 999)).status).toBe(429);
      expect(fetches).toBe(CLIENT_FETCH_BOUNDS.perSource);
      expect((await authorize("203.0.113.41", 0)).status).toBe(400);
    },
    T,
  );
});

describe("runServer: the identity provider", () => {
  it(
    "the external login's settings given: its path answered, the local login page not; no table made",
    async () => {
      const c = await controlDb({ external: true });
      const cfg = config({ identity: externalSettings() });
      await CursorKeys.createFile(cfg.handleKeyFile);
      const before = await tableNames(c.store);
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: tenants().backend,
        now: () => NOW,
      });
      try {
        expect((await send(s, { path: LOGIN_PAGE })).status).toBe(404);
        expect((await send(s, { path: "/oauth/identity/callback" })).status).not.toBe(404);
        expect(await tableNames(c.store)).toEqual(before);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "none of them given: the local accounts, whose login page answers",
    async () => {
      const c = await controlDb();
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: tenants().backend,
        now: () => NOW,
      });
      try {
        expect((await send(s, { path: LOGIN_PAGE })).status).toBe(200);
        expect((await send(s, { path: "/oauth/identity/callback" })).status).toBe(404);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it("a key file holding a private key: refused before the control database is opened", async () => {
    const cfg = config();
    const keysFile = join(root, `platform-keys${n++}.json`);
    writeFileSync(keysFile, JSON.stringify({ keys: [{ ...TEST_KEY.public, d: TEST_KEY.d }] }), {
      mode: 0o600,
    });
    let opened = 0;
    const e = await runServer({
      config: { ...cfg, identity: { ...externalSettings(), keysFile } },
      version: "0.0.0-test",
      openControl: async () => {
        opened++;
        throw new Error("not to be opened");
      },
      backend: tenants().backend,
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: "ServerIdentityRefused" });
    expect(String((e as Error).message)).toContain("private key");
    expect(opened).toBe(0);
  });
});

describe("runServer: rate limiting", () => {
  it(
    "on: a tenant past its burst gets 429; the next request after it is not served",
    async () => {
      const c = await controlDb();
      const t = tenants();
      const cfg = config({ rateLimit: { perMinute: 1, burst: 2 } });
      await CursorKeys.createFile(cfg.handleKeyFile);
      const cp = c.cp as ServerControlPlane;
      const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: cp,
        backend: t.backend,
        name: "blair",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const token = await sessionFor(c.store, user);
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: t.backend,
        now: () => NOW,
      });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 3; i++) {
          const r = await send(s, {
            path: "/v1/slots",
            headers: { authorization: `Bearer ${token}` },
          });
          statuses.push(r.status);
        }
        expect(statuses).toEqual([200, 200, 429]);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

describe("runServer: what it refuses to start on", () => {
  const start = (c: Awaited<ReturnType<typeof controlDb>>, cfg: ServerConfig) =>
    runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: tenants().backend,
    }).catch((x: unknown) => x);

  it(
    "no control plane tables: refused, naming them; nothing made",
    async () => {
      const c = await controlDb({ control: false });
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const before = await tableNames(c.store);
      const e = await start(c, cfg);
      expect(e).toBeInstanceOf(ServerStartRefused);
      expect(e).toMatchObject({ set: "control", reason: "not_initialized" });
      expect(await tableNames(c.store)).toEqual(before);
      // Refused after it was opened: the control database is closed, once.
      expect(c.closes()).toBe(1);
    },
    T,
  );

  it(
    "no authorization server tables: refused, naming them; none made (that is server init's)",
    async () => {
      const c = await controlDb({ oauth: false });
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const before = await tableNames(c.store);
      const e = await start(c, cfg);
      expect(e).toBeInstanceOf(ServerStartRefused);
      expect(e).toMatchObject({ set: "oauth", reason: "not_initialized" });
      expect(await tableNames(c.store)).toEqual(before);
    },
    T,
  );

  it.each([
    ["accounts", false],
    ["external", true],
  ] as const)(
    "no %s tables for the provider chosen: refused, naming them; none made (that is server init's)",
    async (set, external) => {
      const c = await controlDb({ provider: false });
      const cfg = config(external ? { identity: externalSettings() } : {});
      await CursorKeys.createFile(cfg.handleKeyFile);
      const before = await tableNames(c.store);
      const e = await start(c, cfg);
      expect(e).toBeInstanceOf(IdentityTablesRefused);
      expect(e).toMatchObject({ set, reason: "not_initialized" });
      expect(await tableNames(c.store)).toEqual(before);
      expect(c.closes()).toBe(1);
    },
    T,
  );

  it(
    "the tables of the other provider only: refused as not there",
    async () => {
      const c = await controlDb();
      const cfg = config({ identity: externalSettings() });
      await CursorKeys.createFile(cfg.handleKeyFile);
      expect(await start(c, cfg)).toMatchObject({ set: "external", reason: "not_initialized" });
    },
    T,
  );

  it.each([
    ["control", "format"],
    ["oauth", "oauth_format"],
    ["accounts", "accounts_format"],
  ] as const)(
    "%s tables of another format: refused as of another format",
    async (set, key) => {
      const c = await controlDb();
      await c.store.write((tx) =>
        tx.query("UPDATE control_meta SET value = '99' WHERE key = $1", [key]),
      );
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      expect(await start(c, cfg)).toMatchObject({ set, reason: "format" });
    },
    T,
  );
});

describe("runServer: a staging database an import left", () => {
  it(
    "the tenant's first opening drops it, through the backend's guard, and the directory forgets it",
    async () => {
      const c = await controlDb();
      const t = tenants();
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const cp = c.cp as ServerControlPlane;
      const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: cp,
        backend: t.backend,
        name: "emery",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const tenant = (await cp.tenantOf(user))?.id;
      if (tenant === undefined) throw new Error("no tenant");
      const staging = stagingDatabaseOf(tenant, "IM_0123456789ABCDEF");
      await cp.setStaging(tenant, staging);
      const dropped: Parameters<DiscardDatabase>[0][] = [];
      const token = await sessionFor(c.store, user);
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: t.backend,
        discardDatabase: async (d) => {
          // What the PostgreSQL backend's drop checks first: this one it would drop.
          checkDiscard(d);
          dropped.push(d);
        },
        now: () => NOW,
      });
      try {
        expect((await cp.tenant(tenant))?.staging).toBe(staging);
        const r = await send(s, {
          path: "/v1/slots",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(r.status).toBe(200);
        expect(dropped).toEqual([
          {
            cell: CELL,
            tenantDatabase: databaseOf(tenant),
            current: databaseOf(tenant),
            database: staging,
          },
        ]);
        expect((await cp.tenant(tenant))?.staging).toBeUndefined();
        // Forgotten: the next opening drops nothing.
        await send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${token}` } });
        expect(dropped).toHaveLength(1);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it("the default drop: a tenant of another cell, or a database not the tenant's, is refused before any connection", async () => {
    // The cell's host is not one: anything that got as far as connecting would fail otherwise.
    const drop = cellDiscarder(config());
    const tenant = "tn_01234567890123456789012345";
    const request = {
      tenantDatabase: tenant,
      current: tenant,
      database: `${tenant}_im_0123456789abcdef`,
    };
    await expect(drop({ cell: "elsewhere", ...request })).rejects.toThrow(
      "the tenant's database is not in this server's cell",
    );
    await expect(drop({ cell: CELL, ...request, database: "postgres" })).rejects.toMatchObject({
      code: "discard_refused",
    });
    await expect(drop({ cell: CELL, ...request, database: tenant })).rejects.toMatchObject({
      code: "discard_refused",
    });
  });
});

describe("runServer: POST /v1/import", () => {
  const KEYS = [
    "tenant_id",
    "previous_tenant_id",
    "events",
    "seq",
    "principals_disabled",
    "slots",
    "removed",
    "pending_deletions",
    "exported_at",
    "not_imported",
    "restore_count",
  ];

  /**
   * A server with a source tenant (its genesis, a connection) and the source's export file, and a
   * way to add users with empty tenants. The import's drop goes through the backend's guard and
   * then drops the test's storage of that database.
   */
  async function serverWithSource(
    over: {
      importBodyIdleMs?: number;
      discardDatabase?: DiscardDatabase;
      /** The first drop of a staging database waits for this (a slow DROP DATABASE). */
      holdStagingDrop?: Promise<void>;
    } = {},
  ) {
    const { holdStagingDrop, ...overRun } = over;
    let stagingHeld = false;
    const c = await controlDb();
    const t = tenants();
    const cfg = config();
    await CursorKeys.createFile(cfg.handleKeyFile);
    const cp = c.cp as ServerControlPlane;
    const accounts = c.accounts as NonNullable<typeof c.accounts>;
    const user = async (name: string) => {
      const { user: u } = await addLocalUser(accounts, {
        control: cp,
        backend: t.backend,
        name,
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const tenant = (await cp.tenantOf(u))?.id;
      if (tenant === undefined) throw new Error("no tenant");
      return { tenant, token: await sessionFor(c.store, u) };
    };
    const s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      discardDatabase: async (d) => {
        checkDiscard(d);
        if (holdStagingDrop !== undefined && !stagingHeld && d.database !== d.tenantDatabase) {
          stagingHeld = true;
          await holdStagingDrop;
        }
        await dropTestStorage(join(t.dir, d.cell, d.database));
      },
      now: () => NOW,
      ...overRun,
    });
    const source = await user("source");
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    const issued = await send(s, {
      method: "POST",
      path: "/v1/connections",
      headers: { ...auth(source.token), "content-type": "application/json" },
      body: '{"name":"desk"}',
    });
    expect(issued.status).toBe(200);
    const exported = await send(s, { path: "/v1/export", headers: auth(source.token) });
    expect(exported.status).toBe(200);
    const file = exported.body.split("\n").filter((l) => l !== "");
    return { s, cp, user, source, file, auth, c, t, cfg };
  }

  /** The file as a request body: a line a chunk; `hold` stops it after the first line. */
  async function* bodyOf(lines: readonly string[], hold?: Promise<void>) {
    for (const [i, l] of lines.entries()) {
      yield Buffer.from(`${l}\n`);
      if (i === 0 && hold !== undefined) await hold;
    }
  }

  /** An import request whose body is written as `body` gives it, chunk by chunk. */
  function upload(
    s: RunningServer,
    token: string,
    body: AsyncIterable<Uint8Array>,
    more: Readonly<Record<string, string>> = {},
  ) {
    return new Promise<Reply>((resolve, reject) => {
      const req = request(
        {
          host: s.address.host,
          port: s.address.port,
          method: "POST",
          path: "/v1/import",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-ndjson",
            "transfer-encoding": "chunked",
            ...more,
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8").on("data", (c: string) => {
            text += c;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
          );
        },
      );
      req.on("error", reject);
      void (async () => {
        try {
          for await (const chunk of body) {
            if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
          }
          req.end();
        } catch {
          // The server answered and closed before the body was all written.
        }
      })();
    });
  }

  /** `p`, or a failure that says it never answered: a hang is a failure, not a test's timeout. */
  const within = <R>(p: Promise<R>, what: string, ms = 30_000) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${what} never answered`)), ms).unref(),
      ),
    ]);

  /**
   * The tenant as the anchor and the directory have it: empty, no import left over, once the
   * staging database's drop (after a refusal's answer, outside the exclusive) has finished.
   */
  const leftEmpty = async (cp: ServerControlPlane, tenant: `tn_${string}`) => {
    const a = await cp.anchors.read(tenant);
    expect({ restoreCount: a.restoreCount, importInProgress: a.importInProgress }).toEqual({
      restoreCount: 0,
      importInProgress: undefined,
    });
    // A bounded wait: a drop that never ends is a failure here, not the test's timeout.
    for (let i = 0; i < 600 && (await cp.tenant(tenant))?.staging !== undefined; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await cp.tenant(tenant))?.staging).toBeUndefined();
  };

  it(
    "closed right after an import, the replaced database's drop cut off: close does not wait for it; the tenant's next opening drops it",
    async () => {
      // The drop of the database an import replaced never ends here: as a stop that ends the
      // process in its middle. Other drops go through as usual.
      let reached!: () => void;
      const atDrop = new Promise<void>((r) => {
        reached = r;
      });
      let target: `tn_${string}` | undefined;
      const { s, cp, user, file, c, t, cfg } = await serverWithSource({
        discardDatabase: async (d) => {
          checkDiscard(d);
          if (target !== undefined && d.database === databaseOf(target)) {
            reached();
            await new Promise(() => {});
          }
          await dropTestStorage(join(t.dir, d.cell, d.database));
        },
      });
      const into = await user("target");
      target = into.tenant;
      const r = await within(upload(s, into.token, bodyOf(file)), "the import");
      expect(r.status).toBe(200);
      await atDrop;
      // The answer did not wait for the drop, and neither does closing: the drop is not awaited.
      await within(s.close(), "closing");
      expect((await cp.tenant(into.tenant))?.staging).toBe(databaseOf(into.tenant));
      // The next server, on the same control database and storage: the tenant's first opening
      // drops what the cut-off drop left, and the directory forgets it.
      const dropped: string[] = [];
      const next = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: t.backend,
        discardDatabase: async (d) => {
          checkDiscard(d);
          dropped.push(d.database);
          await dropTestStorage(join(t.dir, d.cell, d.database));
        },
        now: () => NOW,
      });
      try {
        const slots = await send(next, {
          path: "/v1/slots",
          headers: { authorization: `Bearer ${into.token}` },
        });
        expect(slots.status).toBe(200);
        expect(dropped).toEqual([databaseOf(into.tenant)]);
        expect((await cp.tenant(into.tenant))?.staging).toBeUndefined();
      } finally {
        await next.close();
      }
    },
    T,
  );

  it(
    "into an empty tenant: 200 with the contract's result and nothing else, the tenant's log the file's",
    async () => {
      const { s, cp, user, source, file } = await serverWithSource();
      try {
        const target = await user("target");
        // Answered at all: the authentication's use of the tenant has ended before the import
        // takes it, or the import would wait for it for ever.
        const r = await within(upload(s, target.token, bodyOf(file)), "the import");
        expect(r.status).toBe(200);
        const result = JSON.parse(r.body);
        expect(Object.keys(result)).toEqual(KEYS);
        const sourceEnd = JSON.parse(file[0] as string).upto;
        expect(result).toMatchObject({
          tenant_id: target.tenant,
          previous_tenant_id: source.tenant,
          events: sourceEnd,
          seq: sourceEnd + 1,
          restore_count: 1,
          not_imported: ["read_log", "credentials", "external_files"],
        });
        const a = await cp.anchors.read(target.tenant);
        expect({ highWater: a.highWater, restoreCount: a.restoreCount }).toEqual({
          highWater: sourceEnd + 1,
          restoreCount: 1,
        });
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "a page of another site: 403 before the import starts, the tenant left as it was; the external origin goes on",
    async () => {
      const { s, cp, user, file } = await serverWithSource();
      try {
        const target = await user("target");
        const foreign = await within(
          upload(s, target.token, bodyOf(file), { origin: "https://evil.example" }),
          "the import",
        );
        expect(foreign.status).toBe(403);
        expect(foreign.headers["content-type"]).toContain("text/plain");
        await leftEmpty(cp, target.tenant);
        const own = await within(
          upload(s, target.token, bodyOf(file), { origin: PUBLIC }),
          "the import",
        );
        expect(own.status).toBe(200);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "while one holds the tenant: another import is rate_limited (busy) with retry_after, any other request unavailable (importing)",
    async () => {
      const { s, cp, user, file, auth } = await serverWithSource();
      try {
        const target = await user("target");
        let release!: () => void;
        const held = new Promise<void>((r) => {
          release = r;
        });
        const first = upload(s, target.token, bodyOf(file, held));
        // The import holds the tenant once its staging database is recorded.
        for (let i = 0; (await cp.tenant(target.tenant))?.staging === undefined; i++) {
          if (i === 600) throw new Error("the import never began");
          await new Promise((r) => setTimeout(r, 10));
        }
        const second = await within(upload(s, target.token, bodyOf(file)), "the second import");
        expect(second.status).toBe(429);
        expect(second.headers["retry-after"]).toBe("5");
        expect(JSON.parse(second.body).error).toMatchObject({
          code: "rate_limited",
          reason: "busy",
          retry_after: 5,
        });
        const other = await send(s, { path: "/v1/slots", headers: auth(target.token) });
        expect(other.status).toBe(503);
        expect(JSON.parse(other.body).error).toMatchObject({
          code: "unavailable",
          reason: "importing",
        });
        release();
        expect((await within(first, "the first import")).status).toBe(200);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "refused: a tenant not empty (tenant_not_empty), a file that is not one (import_rejected); the tenant left as it was",
    async () => {
      // The staging database's drop held, as a slow DROP DATABASE holds it on a busy PostgreSQL:
      // the refusal answers anyway, the drop running after it.
      let release = () => {};
      const holdStagingDrop = new Promise<void>((r) => {
        release = r;
      });
      const { s, cp, user, source, file, auth } = await serverWithSource({ holdStagingDrop });
      try {
        const notEmpty = await within(upload(s, source.token, bodyOf(file)), "the import");
        expect(notEmpty.status).toBe(400);
        expect(JSON.parse(notEmpty.body).error).toMatchObject({
          code: "invalid_argument",
          reason: "tenant_not_empty",
        });
        const target = await user("target");
        const bad = await within(upload(s, target.token, bodyOf(["not an export"])), "the import");
        expect(bad.status).toBe(422);
        expect(JSON.parse(bad.body).error).toMatchObject({ code: "import_rejected" });
        // Answered with the drop held: the record stays until the drop has finished.
        expect((await cp.tenant(target.tenant))?.staging).toBeDefined();
        // The tenant's next request opens it: the opening leaves the staging database to the drop
        // under way and serves, rather than waiting on a second DROP of it.
        const next = await within(
          send(s, { path: "/v1/slots", headers: auth(target.token) }),
          "the next request",
        );
        expect(next.status).toBe(200);
        expect((await cp.tenant(target.tenant))?.staging).toBeDefined();
        release();
        await leftEmpty(cp, target.tenant);
      } finally {
        release();
        await s.close();
      }
    },
    T,
  );

  it(
    "a body that stops giving bytes: import_rejected (incomplete), the tenant left empty",
    async () => {
      const { s, cp, user, file } = await serverWithSource({ importBodyIdleMs: 300 });
      try {
        const target = await user("target");
        let release!: () => void;
        const r = await within(
          upload(
            s,
            target.token,
            bodyOf(
              file,
              new Promise<void>((resolve) => {
                release = resolve;
              }),
            ),
          ),
          "the stalled import",
        );
        release();
        expect(r.status).toBe(422);
        expect(JSON.parse(r.body).error).toMatchObject({
          code: "import_rejected",
          reason: "incomplete",
        });
        await leftEmpty(cp, target.tenant);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "the server stopping while a body is read: the import is abandoned, import_rejected (incomplete), and the stop does not wait for the client",
    async () => {
      // The body may give nothing for ten minutes: only the stop's abort ends the import sooner.
      const { s, cp, user, file } = await serverWithSource({ importBodyIdleMs: 600_000 });
      const target = await user("target");
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const r = upload(s, target.token, bodyOf(file, held));
      for (let i = 0; (await cp.tenant(target.tenant))?.staging === undefined; i++) {
        if (i === 600) throw new Error("the import never began");
        await new Promise((r) => setTimeout(r, 10));
      }
      await within(s.close(), "the stop", 90_000);
      release();
      const answered = await within(r, "the abandoned import");
      expect(answered.status).toBe(422);
      expect(JSON.parse(answered.body).error).toMatchObject({
        code: "import_rejected",
        reason: "incomplete",
      });
      await leftEmpty(cp, target.tenant);
    },
    T,
  );
});

describe("runServer: closing", () => {
  it(
    "the sweep runs while it is open, deleting what has expired, and close() stops it",
    async () => {
      const c = await controlDb();
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      await (await openOAuthStore(c.store)).putForm("expired", "s-1", "2000-01-01T00:00:00.000Z");
      const forms = async () =>
        (await c.store.read((tx) => tx.query("SELECT hash FROM web_forms"))).rows.length;
      expect(await forms()).toBe(1);
      let sweeps = 0;
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: tenants().backend,
        testing: {
          sweepMs: 10,
          onSweep: () => {
            sweeps++;
          },
        },
      });
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      while (sweeps < 2) await wait(10);
      for (let i = 0; i < 100 && (await forms()) > 0; i++) await wait(10);
      expect(await forms()).toBe(0);
      await s.close();
      const atClose = sweeps;
      await wait(100);
      expect(sweeps).toBe(atClose);
    },
    T,
  );

  it(
    "a request in progress when it closes still gets its answer; the tenant is closed after it",
    async () => {
      const c = await controlDb();
      let opened!: () => void;
      const reached = new Promise<void>((r) => {
        opened = r;
      });
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const gate: { opened?: () => void; release?: Promise<void> } = {};
      const t = tenants(gate);
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const cp = c.cp as ServerControlPlane;
      const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: cp,
        backend: t.backend,
        name: "casey",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const token = await sessionFor(c.store, user);
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: t.backend,
        now: () => NOW,
      });
      // From here the tenant's open waits until released: the request is in progress.
      // Making the user opened and closed its tenant once already.
      const before = t.closed();
      gate.opened = opened;
      gate.release = held;
      const answer = send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${token}` } });
      await reached;
      const closing = s.close();
      release();
      expect((await answer).status).toBe(200);
      expect(c.closes()).toBe(0);
      await closing;
      expect(t.closed()).toBe(before + 1);
      expect(c.closes()).toBe(1);
    },
    T,
  );
});

describe("runServer: closing in three steps", () => {
  /** A server with one user; `gate` holds the tenant's opening back, as tenants() does. */
  async function serverWithUser(
    testing: NonNullable<RunServerOptions["testing"]>,
    gate?: { opened?: () => void; release?: Promise<void> },
  ) {
    const c = await controlDb();
    const t = tenants(gate);
    const cfg = config();
    await CursorKeys.createFile(cfg.handleKeyFile);
    const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
      control: c.cp as ServerControlPlane,
      backend: t.backend,
      name: "jordan",
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    });
    const token = await sessionFor(c.store, user);
    const warned: string[] = [];
    const s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      now: () => NOW,
      warn: (event) => warned.push(event),
      testing,
    });
    return { s, token, warned, c, t };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const state = async (s: RunningServer) =>
    (JSON.parse((await send(s, { path: "/health" })).body) as { state: string }).state;

  it(
    "during the drain: /ready 503 and /health stopping, while /v1 and MCP are served as before; then new connections are refused",
    async () => {
      // The drain held by the case: long enough never to end on its own while the requests below
      // are made (the first use opens the tenant, slow on a loaded machine), ended by hurry().
      const { s, token } = await serverWithUser({ drainMs: 60_000 });
      const auth = { authorization: `Bearer ${token}` };
      const closing = s.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });
      const ready = await send(s, { path: "/ready" });
      expect(ready.status).toBe(503);
      expect(ready.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(ready.body)).toMatchObject({ state: "stopping" });
      const health = await send(s, { path: "/health" });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toMatchObject({ state: "stopping" });
      expect((await send(s, { path: "/v1/slots", headers: auth })).status).toBe(200);
      const mcp = await send(s, {
        method: "POST",
        path: "/mcp",
        headers: {
          ...auth,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "example-host", version: "1" },
          },
        }),
      });
      expect(mcp.status).toBe(200);
      // Still draining: the closing waits for the drain.
      expect(closed).toBe(false);
      s.hurry();
      await closing;
      // Past the drain the server listens no more.
      await expect(send(s, { path: "/ready" })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    },
    T,
  );

  it(
    "a request still in progress at the timeout is cut, and close() goes on: a connection counted in the warning",
    async () => {
      const { s, token, warned } = await serverWithUser({ drainMs: 0, timeoutMs: 300 });
      // A body that never comes in full: the request never ends on its own.
      let cut!: (e: Error) => void;
      const gone = new Promise<Error>((r) => {
        cut = r;
      });
      const req = request({
        host: s.address.host,
        port: s.address.port,
        method: "POST",
        path: "/v1/writes",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": 1000,
        },
      });
      req.on("error", cut);
      req.write('{"sv":1,');
      await wait(100);
      const t0 = performance.now();
      await s.close();
      const took = performance.now() - t0;
      expect(took).toBeGreaterThanOrEqual(250);
      expect(took).toBeLessThan(5000);
      expect((await gone).message).toMatch(/socket hang up|ECONNRESET/);
      expect(warned).toContain("shutdown_connections_cut");
    },
    T,
  );

  it(
    "a use stuck on its tenant does not hold the closing past its bound; the lock is released",
    async () => {
      let opened!: () => void;
      const reached = new Promise<void>((r) => {
        opened = r;
      });
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const gate: { opened?: () => void; release?: Promise<void> } = {};
      const { s, token, warned, c } = await serverWithUser(
        { drainMs: 0, timeoutMs: 200, tenantsCloseMs: 300 },
        gate,
      );
      gate.opened = opened;
      gate.release = held;
      const answer = send(s, {
        path: "/v1/slots",
        headers: { authorization: `Bearer ${token}` },
      }).catch((e: unknown) => e);
      await reached;
      const t0 = performance.now();
      expect(await s.close()).toEqual({ tenantsLeft: true });
      expect(performance.now() - t0).toBeLessThan(5000);
      expect(warned).toEqual(
        expect.arrayContaining(["shutdown_connections_cut", "shutdown_tenants_left"]),
      );
      // Its control database closed: the lock released with it.
      expect(c.closes()).toBe(1);
      expect(await answer).toBeInstanceOf(Error);
      release();
    },
    T,
  );

  it(
    "a request in progress on a keep-alive connection: answered with Connection: close, and close() does not wait out the keep-alive timeout",
    async () => {
      let opened!: () => void;
      const reached = new Promise<void>((r) => {
        opened = r;
      });
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const gate: { opened?: () => void; release?: Promise<void> } = {};
      const { s, token } = await serverWithUser({ drainMs: 0 }, gate);
      gate.opened = opened;
      gate.release = held;
      const agent = new Agent({ keepAlive: true });
      try {
        const answer = new Promise<Reply>((resolve, reject) => {
          const req = request(
            {
              host: s.address.host,
              port: s.address.port,
              path: "/v1/slots",
              headers: { authorization: `Bearer ${token}` },
              agent,
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8").on("data", (c: string) => {
                body += c;
              });
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
              );
            },
          );
          req.on("error", reject);
          req.end();
        });
        await reached;
        const closing = s.close();
        await wait(50);
        const t0 = performance.now();
        release();
        const r = await answer;
        expect(r.status).toBe(200);
        expect(r.headers["connection"]).toBe("close");
        await closing;
        // Well inside Node's 5 s keep-alive timeout.
        expect(performance.now() - t0).toBeLessThan(3000);
      } finally {
        agent.destroy();
      }
    },
    T,
  );

  it(
    "with nothing in flight, the closing waits the drain out",
    async () => {
      const { s } = await serverWithUser({ drainMs: 300 });
      const t0 = performance.now();
      await s.close();
      // A lower bound only: a loaded machine makes it longer, never shorter.
      expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
    },
    T,
  );

  it(
    "hurry() (a second signal) cuts the drain short; before close() it does nothing",
    async () => {
      const { s } = await serverWithUser({ drainMs: 60_000 });
      s.hurry();
      expect(await state(s)).toBe("ready");
      const t0 = performance.now();
      const closing = s.close();
      expect(await state(s)).toBe("stopping");
      s.hurry();
      await closing;
      expect(performance.now() - t0).toBeLessThan(5000);
      // Called again, the same closing; nothing was left.
      expect(await s.close()).toEqual({ tenantsLeft: false });
    },
    T,
  );
});

describe("runServer: at most SAVESLOT_TENANT_CONNECTIONS tenants open", () => {
  /** A server allowing one open tenant, with two users; `gate` holds a tenant's opening back. */
  async function oneTenantServer(
    gate: { opened?: () => void; release?: Promise<void> },
    openWaitMs = 300,
  ) {
    const c = await controlDb();
    const t = tenants(gate);
    const cfg = config({ tenants: { maxOpen: 1, idleSeconds: 300 } });
    await CursorKeys.createFile(cfg.handleKeyFile);
    const make = async (name: string) => {
      const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: c.cp as ServerControlPlane,
        backend: t.backend,
        name,
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      return sessionFor(c.store, user);
    };
    const first = await make("riley");
    const second = await make("morgan");
    const warned: string[] = [];
    const s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      now: () => NOW,
      warn: (event) => warned.push(event),
      testing: { drainMs: 0, openWaitMs },
    });
    return { s, first, second, warned };
  }

  it(
    "with one place, two users' requests in turn are each answered: the idle tenant is closed for the other",
    async () => {
      // The pool's own wait (5 s): closing the other tenant, on PostgreSQL, may take longer than a
      // short one.
      const { s, first, second } = await oneTenantServer({}, 5000);
      for (const token of [first, second, first, second]) {
        expect(
          (await send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${token}` } }))
            .status,
        ).toBe(200);
      }
      await s.close();
    },
    T,
  );

  it(
    "every place held: a request for another tenant gets unavailable (busy) to retry; the control database still answers",
    async () => {
      let opened!: () => void;
      const reached = new Promise<void>((r) => {
        opened = r;
      });
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const gate: { opened?: () => void; release?: Promise<void> } = {};
      const { s, first, second, warned } = await oneTenantServer(gate);
      gate.opened = opened;
      gate.release = held;
      // The first user's tenant is being opened: it holds the one place.
      const pending = send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${first}` } });
      await reached;
      delete gate.opened;
      delete gate.release;
      // What needs only the control database is answered at once: a token it does not hold.
      const t0 = performance.now();
      const unknown = await send(s, {
        path: "/v1/slots",
        headers: { authorization: `Bearer slt_${"A".repeat(43)}` },
      });
      expect(unknown.status).toBe(401);
      expect(performance.now() - t0).toBeLessThan(250);
      // The second user's tenant waits for a place, then is refused, to retry.
      const busy = await send(s, {
        path: "/v1/slots",
        headers: { authorization: `Bearer ${second}` },
      });
      expect(busy.status).toBe(503);
      expect(busy.headers["retry-after"]).toBe("1");
      expect(JSON.parse(busy.body).error).toMatchObject({
        code: "unavailable",
        reason: "busy",
        retry_after: 1,
      });
      expect(warned).toContain("tenant_pool_full");
      release();
      expect((await pending).status).toBe(200);
      // The first user's tenant idle now: it is closed for the second's.
      expect(
        (await send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${second}` } }))
          .status,
      ).toBe(200);
      await s.close();
    },
    T,
  );
});

// PGlite has one connection to a database: another holder of the lock exists on PostgreSQL only.
describe.skipIf(TEST_BACKEND !== "postgres")("runServer: one server a control database", () => {
  const tryLock = (c: Awaited<ReturnType<typeof secondConnection>>) =>
    c.write(async (tx) => {
      const r = await tx.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1) AS got", [
        SERVER_LOCK.toString(),
      ]);
      return r.rows[0]?.got === true;
    });
  const unlock = (c: Awaited<ReturnType<typeof secondConnection>>) =>
    c.write((tx) => tx.query("SELECT pg_advisory_unlock($1)", [SERVER_LOCK.toString()]));

  it(
    "while another holds the lock it does not start; once released, it does",
    async () => {
      const c = await controlDb();
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const other = await secondConnection(c.dir);
      try {
        expect(await tryLock(other)).toBe(true);
        const start = () =>
          runServer({
            config: cfg,
            version: "0.0.0-test",
            openControl: async () => c.db,
            backend: tenants().backend,
          });
        await expect(start()).rejects.toBeInstanceOf(ServerAlreadyRunning);
        await unlock(other);
        const s = await start();
        await s.close();
      } finally {
        await other.close();
      }
    },
    T,
  );

  it(
    "server restore while it runs: refused, nothing done; once it has closed, restore gets past the lock",
    async () => {
      const c = await controlDb();
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: tenants().backend,
      });
      const restore = async () => {
        let err = "";
        const code = await serverRestore(
          cfg,
          { tenant: "tn_99999999999999999999999999" },
          {
            env: {},
            out: () => {},
            err: (l) => {
              err += `${l}\n`;
            },
            openControl: () => secondConnection(c.dir),
            backend: tenants().backend,
          },
        );
        return { code, err };
      };
      try {
        const refused = await restore();
        expect(refused.code).toBe(7);
        expect(refused.err).toContain("server");
      } finally {
        await s.close();
      }
      // Past the lock, the flow is reached: the tenant is not in the directory.
      expect((await restore()).code).toBe(4);
    },
    T,
  );

  it(
    "held while it runs, released when it closes",
    async () => {
      const c = await controlDb();
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend: tenants().backend,
      });
      const other = await secondConnection(c.dir);
      try {
        expect(await tryLock(other)).toBe(false);
        await s.close();
        expect(await tryLock(other)).toBe(true);
        await unlock(other);
      } finally {
        await other.close();
      }
    },
    T,
  );
});

// The cell's backend every server command makes (`server start`, `restore`, `user`): an upgrade of a
// tenant's storage format in its log, a failed step with its SQLSTATE and never the database's
// message (02-architecture §8). PostgreSQL only: it is the PostgreSQL backend.
describe.skipIf(TEST_BACKEND !== "postgres")(
  "cellBackend: a tenant's storage format upgrade, logged",
  () => {
    const pg = testPostgres(cellFromEnv());

    it(
      "a step that fails: upgrading, the step, then upgrade_failed with the step and the SQLSTATE; nothing of the message",
      async () => {
        const db = pg.name();
        const made = await pg.backend.open(pg.ref(db), { create: true });
        await made.close();
        const F = Number(
          (await pg.sql(db, "SELECT value FROM meta WHERE key = 'storage_format'")).rows[0]?.[
            "value"
          ],
        );
        const logged: { event: string; fields: Readonly<Record<string, string>> }[] = [];
        const b = cellBackend(
          config({ cell: pg.cell, cellName: pg.ref(db).cell }),
          (event, fields) => logged.push({ event, fields }),
          { format: F + 1, steps: [{ from: F, sql: "SELECT 'MARK-8b2f-stored'::int;" }] },
        );
        await expect(b.open(pg.ref(db), {})).rejects.toMatchObject({ code: "upgrade_failed" });
        expect(logged.map((l) => l.event)).toEqual(["upgrading", "upgrade_step", "upgrade_failed"]);
        expect(logged.at(-1)?.fields).toEqual({
          database: db,
          step: `${F}->${F + 1}`,
          sql_state: "22P02",
        });
        expect(JSON.stringify(logged)).not.toContain("MARK-8b2f");
      },
      T,
    );
  },
);

// A tenant's connection that went away (02-architecture §7 «连接»): the next use opens the tenant
// again instead of failing until the tenant is closed for being idle. PostgreSQL only, which can end
// a connection from outside. The tenants' databases are the run's (named for it, dropped with it).
describe.skipIf(TEST_BACKEND !== "postgres")("runServer: a tenant's connection gone", () => {
  const pg = testPostgres(cellFromEnv());

  it(
    "the next request opens the tenant again and is answered",
    async () => {
      const name = pg.name();
      const db = await openControlDatabase(pg.cell, name, { create: true });
      const cp = await initControlPlane(db);
      await initOAuthTables(db);
      const accounts = await initLocalAccounts(db);
      const real = new PostgresBackend({ cells: { [CELL]: pg.cell } });
      const named = new Map<string, string>();
      const runs = (database: string) => {
        let n = named.get(database);
        if (n === undefined) {
          n = pg.name();
          named.set(database, n);
        }
        return n;
      };
      const backend: TenantPoolOptions["backend"] = {
        open: (ref, opts) => {
          if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
          return real.open({ ...ref, database: runs(ref.database) }, opts);
        },
      };
      const { user } = await addLocalUser(accounts, {
        control: cp,
        backend,
        name: "quinn",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const token = await db.write((tx) =>
        writeUserSession(tx, user, { expiresAt: "2099-01-01T00:00:00.000Z" }),
      );
      const tenantDb = runs(databaseOf((await cp.tenantOf(user))?.id as TenantId));
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const warned: string[] = [];
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => db,
        backend,
        now: () => NOW,
        warn: (event, fields) => warned.push(`${event} ${JSON.stringify(fields)}`),
      });
      const auth = { authorization: `Bearer ${token}` };
      try {
        expect((await send(s, { path: "/v1/slots", headers: auth })).status).toBe(200);
        // The tenant's connection ended from outside (a restart, a middlebox, an operator).
        await pg.admin(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [tenantDb],
        );
        const after = await send(s, { path: "/v1/slots", headers: auth });
        expect([after.status, after.body.slice(0, 200)]).toEqual([200, expect.any(String)]);
        expect(
          warned.some((w) => w.startsWith("tenant_reopened") && w.includes('"connection"')),
        ).toBe(true);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

// A tenant's connection gone under a use (02-architecture §7 «连接»): the store learns it only when
// the socket's end comes in, so a use can be lent it in between and meet it at its first statement.
// The wrapping backend holds that moment: its stores report usable until they have failed once.
// Certainly not committed (`connection_lost`): unavailable (busy), and a read-only operation is run
// once more on the tenant opened again. Maybe committed (`commit_unknown`): internal, as before.
describe.skipIf(TEST_BACKEND !== "postgres")("runServer: a use meets its connection gone", () => {
  const pg = testPostgres(cellFromEnv());
  const lost = (code: "connection_lost" | "commit_unknown") =>
    Object.assign(new Error("the connection is gone"), { code });

  /**
   * A server on PostgreSQL whose tenant stores are wrapped: `usable` stays true until a store has
   * failed once (the moment before the socket's end comes in); `failNext` makes the next store
   * transaction fail as given (`connection_lost` before it runs; `commit_unknown` after it
   * committed), `failEveryOpened` makes every store opened from then on fail its first one.
   */
  async function lostServer() {
    const name = pg.name();
    const db = await openControlDatabase(pg.cell, name, { create: true });
    const cp = await initControlPlane(db);
    await initOAuthTables(db);
    const accounts = await initLocalAccounts(db);
    const real = new PostgresBackend({ cells: { [CELL]: pg.cell } });
    const named = new Map<string, string>();
    const runs = (database: string) => {
      let n = named.get(database);
      if (n === undefined) {
        n = pg.name();
        named.set(database, n);
      }
      return n;
    };
    const k = {
      opened: 0,
      failNext: undefined as "connection_lost" | "commit_unknown" | undefined,
      /** Only a write transaction takes `failNext`: the request's reads (its authentication) pass. */
      writesOnly: false,
      /** Transactions let through before `failNext` is taken (a request's authentication). */
      passFirst: 0,
      /** `failNext` set to `connection_lost` once a write transaction has committed. */
      afterWrite: false,
      /** Only a read transaction takes `failNext`. */
      readsOnly: false,
      failEveryOpened: false,
    };
    type Store = Awaited<ReturnType<TenantPoolOptions["backend"]["open"]>>;
    const wrap = (store: Store): Store => {
      let failed = false;
      let failFirst = k.failEveryOpened;
      const run = async <T>(go: () => Promise<T>, write: boolean): Promise<T> => {
        // Failed is final, as the store's own failed state is: every call after it refused.
        if (failed) throw lost("connection_lost");
        let armed = k.failNext !== undefined && (write ? !k.readsOnly : !k.writesOnly);
        if (armed && k.passFirst > 0) {
          k.passFirst--;
          armed = false;
        }
        if (failFirst || (armed && k.failNext === "connection_lost")) {
          failFirst = false;
          k.failNext = undefined;
          failed = true;
          throw lost("connection_lost");
        }
        try {
          const r = await go();
          if (write && k.afterWrite) {
            k.afterWrite = false;
            k.readsOnly = true;
            k.failNext = "connection_lost";
          }
          if (armed && k.failNext === "commit_unknown") {
            k.failNext = undefined;
            failed = true;
            throw lost("commit_unknown");
          }
          return r;
        } catch (e) {
          failed = true;
          throw e;
        }
      };
      return {
        write: (fn) => run(() => store.write(fn), true),
        read: (fn) => run(() => store.read(fn), false),
        // A read's record, written before it answers: counted as a read transaction here.
        ...(store.recordReads !== undefined
          ? {
              recordReads: <T>(fn: Parameters<NonNullable<Store["recordReads"]>>[0]) =>
                run(
                  () => (store.recordReads as NonNullable<Store["recordReads"]>)(fn),
                  false,
                ) as Promise<T>,
            }
          : {}),
        purgeResidue: () => store.purgeResidue(),
        snapshot: () => store.snapshot(),
        formatVersion: store.formatVersion,
        ...(store.enforcesStatementTimeout !== undefined
          ? { enforcesStatementTimeout: store.enforcesStatementTimeout }
          : {}),
        close: () => store.close(),
        // Not the store's own: true until it has failed once, as before the socket's end comes in.
        get usable() {
          return !failed;
        },
      };
    };
    const backend: TenantPoolOptions["backend"] = {
      open: async (ref, opts) => {
        if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
        const store = await real.open({ ...ref, database: runs(ref.database) }, opts);
        k.opened++;
        return wrap(store);
      },
    };
    const { user } = await addLocalUser(accounts, {
      control: cp,
      backend,
      name: "quinn",
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    });
    const token = await db.write((tx) =>
      writeUserSession(tx, user, { expiresAt: "2099-01-01T00:00:00.000Z" }),
    );
    const tenantDb = runs(databaseOf((await cp.tenantOf(user))?.id as TenantId));
    const cfg = config({ callRecords: true });
    await CursorKeys.createFile(cfg.handleKeyFile);
    const warned: string[] = [];
    const callLines: string[] = [];
    const s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => db,
      backend,
      now: () => NOW,
      warn: (event, fields) => warned.push(`${event} ${JSON.stringify(fields)}`),
      callRecordSink: async (line) => {
        callLines.push(line);
      },
    });
    const auth = { authorization: `Bearer ${token}` };
    /** Ends the tenant's connection from outside. */
    const terminate = async () => {
      await pg.admin(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [tenantDb],
      );
    };
    const json = (method: string, path: string, body: unknown, more: Record<string, string> = {}) =>
      send(s, {
        method,
        path,
        headers: { ...auth, "content-type": "application/json", ...more },
        body: JSON.stringify(body),
      });
    const reopened = () => warned.filter((w) => w.startsWith("tenant_reopened")).length;
    /** The connections met gone, as logged: one line each, whether the call then succeeded. */
    const lostLines = () => warned.filter((w) => w.startsWith("tenant_connection_lost"));
    /** An MCP POST of `body` as it is: one message, or an array of them. */
    const mcpBody = (body: unknown) =>
      send(s, {
        method: "POST",
        path: "/mcp",
        headers: {
          ...auth,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify(body),
      });
    return { s, k, auth, warned, terminate, json, reopened, lostLines, mcpBody, callLines };
  }

  const INSERT = {
    sv: 1,
    ops: [
      {
        intent: "insert",
        table: "household.expenses",
        set: { date: "2026-11-02", amount: 45, note: "lunch" },
      },
    ],
  };
  const rows = async (x: Awaited<ReturnType<typeof lostServer>>) => {
    const r = await x.json("POST", "/v1/query", { table: "household.expenses" });
    expect(r.status).toBe(200);
    return (JSON.parse(r.body) as { rows: unknown[] }).rows.length;
  };

  it(
    "a read whose connection was ended a moment before: answered, the tenant opened again once",
    async () => {
      const x = await lostServer();
      try {
        expect((await send(x.s, { path: "/v1/slots", headers: x.auth })).status).toBe(200);
        const opened = x.k.opened;
        // Ended from outside; the store does not know it yet when the next request is lent it.
        await x.terminate();
        const after = await send(x.s, { path: "/v1/slots", headers: x.auth });
        expect([after.status, after.body.slice(0, 200)]).toEqual([200, expect.any(String)]);
        expect(x.k.opened).toBe(opened + 1);
        expect(x.reopened()).toBe(1);
        expect(x.lostLines()).toEqual([
          expect.stringMatching(/"tenant":"tn_.*"code":"connection_lost"/),
        ]);
        expect(x.warned.some((w) => w.startsWith("internal"))).toBe(false);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a read whose operation meets it, its authentication done: run once more, answered",
    async () => {
      const x = await lostServer();
      try {
        expect((await send(x.s, { path: "/v1/slots", headers: x.auth })).status).toBe(200);
        const opened = x.k.opened;
        x.k.passFirst = 1;
        x.k.failNext = "connection_lost";
        const after = await send(x.s, { path: "/v1/slots", headers: x.auth });
        expect([after.status, after.body.slice(0, 200)]).toEqual([200, expect.any(String)]);
        expect(x.k.opened).toBe(opened + 1);
        expect(x.reopened()).toBe(1);
        expect(x.lostLines()).toHaveLength(1);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a read whose record meets it, the read itself done: run once more, answered",
    async () => {
      const x = await lostServer();
      try {
        expect((await send(x.s, { path: "/v1/slots", headers: x.auth })).status).toBe(200);
        const opened = x.k.opened;
        // The authentication's read and the operation's read pass; the record's write meets it.
        x.k.passFirst = 2;
        x.k.failNext = "connection_lost";
        const after = await send(x.s, { path: "/v1/slots", headers: x.auth });
        expect([after.status, after.body.slice(0, 200)]).toEqual([200, expect.any(String)]);
        expect(x.k.opened).toBe(opened + 1);
        expect(x.lostLines()).toHaveLength(1);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a write that meets it: unavailable (busy) to retry, nothing written; sent again, written once",
    async () => {
      const x = await lostServer();
      try {
        expect((await x.json("POST", "/v1/drafts", { document: SAMPLE_SLOT })).status).toBe(200);
        // Met by the write's own transaction (its authentication read before it, as it was).
        x.k.writesOnly = true;
        x.k.failNext = "connection_lost";
        const refused = await x.json("POST", "/v1/writes", INSERT);
        expect(refused.status).toBe(503);
        expect(JSON.parse(refused.body)).toMatchObject({
          error: { code: "unavailable", reason: "busy", retry_after: 1 },
        });
        expect(x.lostLines()).toEqual([expect.stringContaining('"code":"connection_lost"')]);
        expect((await x.json("POST", "/v1/writes", INSERT)).status).toBe(200);
        expect(await rows(x)).toBe(1);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a write that committed, its answer's reads meeting it: internal, not busy; in the log once",
    async () => {
      const x = await lostServer();
      try {
        expect((await x.json("POST", "/v1/drafts", { document: SAMPLE_SLOT })).status).toBe(200);
        // Every read after the write's commit meets it: the notices its answer reads.
        x.k.afterWrite = true;
        const r = await x.json("POST", "/v1/writes", INSERT);
        expect(r.status).toBe(500);
        expect(JSON.parse(r.body)).toMatchObject({ error: { code: "internal" } });
        expect(x.lostLines()).toEqual([expect.stringContaining('"after":"effect"')]);
        expect(await rows(x)).toBe(1);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a write whose commit went unanswered: internal, as before; sent again with its key, the receipt given then",
    async () => {
      const x = await lostServer();
      try {
        expect((await x.json("POST", "/v1/drafts", { document: SAMPLE_SLOT })).status).toBe(200);
        const key = { "idempotency-key": "lunch-2026-11-02" };
        // Committed, and the answer lost on the way back.
        x.k.writesOnly = true;
        x.k.failNext = "commit_unknown";
        const unknown = await x.json("POST", "/v1/writes", INSERT, key);
        expect(unknown.status).toBe(500);
        expect(JSON.parse(unknown.body)).toMatchObject({ error: { code: "internal" } });
        expect(x.lostLines()).toEqual([expect.stringContaining('"code":"commit_unknown"')]);
        const again = await x.json("POST", "/v1/writes", INSERT, key);
        expect(again.status).toBe(200);
        expect(await rows(x)).toBe(1);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a read whose second try meets it too: unavailable (busy), and no third",
    async () => {
      const x = await lostServer();
      try {
        expect((await send(x.s, { path: "/v1/slots", headers: x.auth })).status).toBe(200);
        const opened = x.k.opened;
        x.k.failNext = "connection_lost";
        x.k.failEveryOpened = true;
        const after = await send(x.s, { path: "/v1/slots", headers: x.auth });
        expect(after.status).toBe(503);
        expect(JSON.parse(after.body)).toMatchObject({
          error: { code: "unavailable", reason: "busy", retry_after: 1 },
        });
        expect(x.k.opened).toBe(opened + 1);
        // Met twice, told twice.
        expect(x.lostLines()).toHaveLength(2);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "an MCP tool whose operation meets it: the request made once more, answered",
    async () => {
      const x = await lostServer();
      const mcp = (method: string, params: unknown, id: number) =>
        send(x.s, {
          method: "POST",
          path: "/mcp",
          headers: {
            ...x.auth,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
      try {
        expect((await send(x.s, { path: "/v1/slots", headers: x.auth })).status).toBe(200);
        const opened = x.k.opened;
        x.k.passFirst = 1;
        x.k.failNext = "connection_lost";
        const before = x.callLines.length;
        const r = await mcp("tools/call", { name: "saveslot_catalog", arguments: {} }, 2);
        expect(r.status).toBe(200);
        expect(r.body).not.toContain('"isError":true');
        expect(x.k.opened).toBe(opened + 1);
        expect(x.lostLines()).toHaveLength(1);
        // Made twice, answered once: one record, the answered try's.
        await new Promise((done) => setTimeout(done, 50));
        const made = x.callLines.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(made.map((m) => [m["route"], m["outcome"]])).toEqual([["saveslot_catalog", "ok"]]);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "an MCP request of a write and a read, meeting it after the write committed: not made again; the write once, answered by its first run",
    async () => {
      const x = await lostServer();
      try {
        expect((await x.json("POST", "/v1/drafts", { document: SAMPLE_SLOT })).status).toBe(200);
        const opened = x.k.opened;
        x.k.afterWrite = true;
        const r = await x.mcpBody([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "saveslot_write", arguments: INSERT },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "saveslot_catalog", arguments: {} },
          },
        ]);
        const said = `${r.status} ${r.body}`;
        // Not made once more: the tenant not opened again within the request, the write in the
        // log once. Met twice (the write's answer, after it committed; the read), told twice.
        expect(x.k.opened).toBe(opened);
        expect(await rows(x)).toBe(1);
        expect(x.lostLines()).toHaveLength(2);
        // Answered by its first and only run: the write internal (it took effect, its answer was
        // not made), the read busy.
        expect(r.status).toBe(200);
        const answers = said
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map(
            (l) =>
              JSON.parse(l.slice(5)) as {
                id: number;
                result: { isError?: boolean; content: { text: string }[] };
              },
          );
        const byId = new Map(answers.map((a) => [a.id, a.result]));
        expect(byId.get(1)?.isError).toBe(true);
        expect(byId.get(1)?.content[0]?.text).toContain("internal");
        expect(byId.get(2)?.isError).toBe(true);
        expect(byId.get(2)?.content[0]?.text).toContain("busy");
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "an MCP read that meets it: answered, not an error, the tenant opened again once",
    async () => {
      const x = await lostServer();
      const mcp = (method: string, params: unknown, id: number) =>
        send(x.s, {
          method: "POST",
          path: "/mcp",
          headers: {
            ...x.auth,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
      try {
        expect(
          (
            await mcp(
              "initialize",
              {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "example-host", version: "1" },
              },
              1,
            )
          ).status,
        ).toBe(200);
        expect((await send(x.s, { path: "/v1/slots", headers: x.auth })).status).toBe(200);
        const opened = x.k.opened;
        await x.terminate();
        const r = await mcp("tools/call", { name: "saveslot_catalog", arguments: {} }, 2);
        expect(r.status).toBe(200);
        expect(r.body).not.toContain('"isError":true');
        expect(x.k.opened).toBe(opened + 1);
        expect(x.lostLines()).toHaveLength(1);
      } finally {
        await x.s.close();
      }
    },
    T,
  );
});

// What `server start` stands on: the lock is its control database connection's. PostgreSQL only,
// which can end a connection from outside.
describe.skipIf(TEST_BACKEND !== "postgres")(
  "runServer: the control database's connection lost",
  () => {
    const pg = testPostgres(cellFromEnv());

    it(
      "it fails at once: health failed, nothing else served, `failed` resolves; the lock is free",
      async () => {
        const name = pg.name();
        const db = await openControlDatabase(pg.cell, name, { create: true });
        const cp = await initControlPlane(db);
        void cp;
        await initOAuthTables(db);
        await initLocalAccounts(db);
        const cfg = config();
        await CursorKeys.createFile(cfg.handleKeyFile);
        const warned: string[] = [];
        const s = await runServer({
          config: cfg,
          version: "0.0.0-test",
          openControl: async () => db,
          backend: tenants().backend,
          warn: (event) => warned.push(event),
        });
        const other = await openControlDatabase(pg.cell, name);
        const tryLock = () =>
          other.write(async (tx) => {
            const r = await tx.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1) AS got", [
              SERVER_LOCK.toString(),
            ]);
            return r.rows[0]?.got === true;
          });
        try {
          expect(await tryLock()).toBe(false);
          let failed = false;
          void s.failed.then(() => {
            failed = true;
          });
          await pg.admin(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid()
               AND pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted)`,
            [name],
          );
          await s.failed;
          expect(failed).toBe(true);
          expect(warned).toContain("control_database_lost");
          const health = await send(s, { path: "/health" });
          expect(JSON.parse(health.body)).toMatchObject({
            state: "failed",
            reason: "control_database_lost",
          });
          expect((await send(s, { path: "/ready" })).status).toBe(503);
          // On /v1/ the contract's error: the server is stopping (05-surfaces §13, §14).
          const v1 = await send(s, { path: "/v1/slots" });
          expect(v1.status).toBe(503);
          expect(v1.headers["retry-after"]).toBe("1");
          expect(JSON.parse(v1.body).error).toEqual({
            code: "unavailable",
            reason: "stopping",
            retry_after: 1,
            message: "the server is stopping",
          });
          expect((await send(s, { path: LOGIN_PAGE })).status).toBe(503);
          expect((await send(s, { path: "/.well-known/oauth-authorization-server" })).status).toBe(
            503,
          );
          // The lock went with the connection: another server may take it now.
          expect(await tryLock()).toBe(true);
          await other.write((tx) =>
            tx.query("SELECT pg_advisory_unlock($1)", [SERVER_LOCK.toString()]),
          );
        } finally {
          await s.close();
          await other.close();
        }
      },
      T,
    );
  },
);

// A tenant's storage of a newer format than this version knows (02-architecture §7): another version
// upgraded it. The call is answered unavailable (stopping), to retry elsewhere, and this process
// stops answering ready; its health says why. The store's refusal stood in for by a wrapped store.
describe("runServer: a storage newer than this version", () => {
  it(
    "the call is unavailable (stopping, retry_after 1); /ready turns 503 with the reason, /health stays 200",
    async () => {
      const c = await controlDb();
      const t = tenants();
      let newer = false;
      type Store = Awaited<ReturnType<TenantPoolOptions["backend"]["open"]>>;
      const refuse = <T>(go: () => Promise<T>): Promise<T> =>
        newer
          ? Promise.reject(
              Object.assign(new Error("storage format 6 is newer than this version's"), {
                code: "format_too_new",
              }),
            )
          : go();
      const backend: TenantPoolOptions["backend"] = {
        open: async (ref, opts) => {
          const store: Store = await t.backend.open(ref, opts);
          return {
            write: (fn) => refuse(() => store.write(fn)),
            read: (fn) => refuse(() => store.read(fn)),
            purgeResidue: () => store.purgeResidue(),
            snapshot: () => store.snapshot(),
            formatVersion: store.formatVersion,
            close: () => store.close(),
          };
        },
      };
      const cfg = config();
      await CursorKeys.createFile(cfg.handleKeyFile);
      const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: c.cp as ServerControlPlane,
        backend,
        name: "robin",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const token = await sessionFor(c.store, user);
      const warned: string[] = [];
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend,
        now: () => NOW,
        warn: (event) => warned.push(event),
      });
      const auth = { authorization: `Bearer ${token}` };
      try {
        expect((await send(s, { path: "/v1/slots", headers: auth })).status).toBe(200);
        expect((await send(s, { path: "/ready" })).status).toBe(200);
        newer = true;
        const refused = await send(s, { path: "/v1/slots", headers: auth });
        expect(refused.status).toBe(503);
        expect(JSON.parse(refused.body)).toMatchObject({
          error: { code: "unavailable", reason: "stopping", retry_after: 1 },
        });
        const ready = await send(s, { path: "/ready" });
        expect(ready.status).toBe(503);
        expect(JSON.parse(ready.body)).toMatchObject({ reason: "storage_format_newer" });
        expect((await send(s, { path: "/health" })).status).toBe(200);
        expect(warned).toContain("server_outdated");
      } finally {
        await s.close();
      }
    },
    T,
  );
});

// The call records (02-architecture §9 «调用记录»): with SAVESLOT_CALL_RECORDS on, one line a call
// that passed authentication, on the server's output (here a sink of the test's); each /v1 call's ID
// in `Saveslot-Call`, on or off. Nothing of the request in any record: names, task, key and values
// carry a marker no record may hold.
describe("runServer: call records", () => {
  const MARK = "MARKER_q7";
  /** Every record any case here was given: the fields of all of them checked at the end. */
  const all: Record<string, unknown>[] = [];

  async function recordsServer(over: Partial<ServerConfig> = {}) {
    const c = await controlDb();
    const t = tenants();
    const cfg = config({ callRecords: true, ...over });
    await CursorKeys.createFile(cfg.handleKeyFile);
    const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
      control: c.cp as ServerControlPlane,
      backend: t.backend,
      name: "robin",
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: NOW,
    });
    const token = await sessionFor(c.store, user);
    const lines: string[] = [];
    const logged: Record<string, unknown>[] = [];
    const warned: string[] = [];
    const s = await runServer({
      config: cfg,
      version: "0.0.0-test",
      openControl: async () => c.db,
      backend: t.backend,
      now: () => NOW,
      log: (f) => logged.push({ ...f }),
      warn: (event) => warned.push(event),
      callRecordSink: async (line) => {
        lines.push(line);
      },
    });
    const auth = { authorization: `Bearer ${token}` };
    /** The records once there are `n`: written after the answer, within a moment. */
    const records = async (n: number) => {
      for (let i = 0; i < 200 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 5));
      const out = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      return out;
    };
    const json = (method: string, path: string, body: unknown, more: Record<string, string> = {}) =>
      send(s, {
        method,
        path,
        headers: { ...auth, "content-type": "application/json", ...more },
        body: JSON.stringify(body),
      });
    const mcp = (body: unknown, as: Record<string, string> = auth) =>
      send(s, {
        method: "POST",
        path: "/mcp",
        headers: {
          ...as,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify(body),
      });
    return { s, token, auth, lines, logged, warned, records, json, mcp };
  }
  const INSERT = (note: string) => ({
    sv: 1,
    ops: [
      {
        intent: "insert",
        table: "household.expenses",
        set: { date: "2026-11-02", amount: 45, note },
      },
    ],
  });
  const tool = (id: number, name: string, args: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  it(
    "/v1: each call's record, its ID in Saveslot-Call; a write appended and saved, sent again replayed with the same operation",
    async () => {
      const x = await recordsServer();
      try {
        const answers = [
          await x.json("POST", "/v1/drafts", { document: SAMPLE_SLOT }),
          await send(x.s, { path: "/v1/slots", headers: x.auth }),
          await x.json("POST", "/v1/writes", INSERT(`${MARK}_value`), {
            "idempotency-key": `${MARK}_key`,
          }),
          await x.json("POST", "/v1/writes", INSERT(`${MARK}_value`), {
            "idempotency-key": `${MARK}_key`,
          }),
        ];
        expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
        const r = await x.records(4);
        all.push(...r);
        expect(r.map((a) => a["call"])).toEqual(answers.map((a) => a.headers["saveslot-call"]));
        expect(r[0]).toMatchObject({
          record: "call",
          v: 1,
          via: "session",
          surface: "http",
          operation: "schema_draft",
          route: "drafts",
          outcome: "ok",
          effect: "appended",
          restores: 0,
        });
        expect(r[1]).toMatchObject({ operation: "catalog", route: "slots", outcome: "ok" });
        expect(Object.keys(r[1] as object)).not.toContain("effect");
        expect(r[2]).toMatchObject({
          operation: "write",
          route: "writes",
          effect: "appended",
          status: "saved",
          restores: 0,
        });
        expect(r[3]).toMatchObject({
          effect: "replayed",
          seq: (r[2] as { seq: number }).seq,
          restores: 0,
        });
        // The request lines are as they were: no `record` field there.
        expect(x.logged.some((l) => "record" in l)).toBe(false);
        expect(JSON.stringify(r)).not.toContain(MARK);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a contract error with its reason, one with a name of the caller's: nothing of it in the record",
    async () => {
      const x = await recordsServer();
      try {
        await x.json("POST", "/v1/drafts", { document: SAMPLE_SLOT });
        const bad = await x.json(
          "POST",
          "/v1/writes",
          {
            sv: 1,
            ops: [
              { intent: "insert", table: `household.${MARK}_table`, set: { [`${MARK}_field`]: 1 } },
            ],
          },
          { "x-task-id": `${MARK}_task` },
        );
        expect(bad.status).toBeGreaterThanOrEqual(400);
        const unread = await x.json("POST", "/v1/history", {
          mode: "changes",
          table: "household.expenses",
          since: "my_last_read",
        });
        expect(JSON.parse(unread.body)).toMatchObject({ error: { code: "read_first" } });
        const r = await x.records(3);
        all.push(...r);
        expect(r[1]).toMatchObject({
          operation: "write",
          outcome: JSON.parse(bad.body).error.code,
        });
        expect(r[2]).toMatchObject({
          operation: "history",
          outcome: "read_first",
          reason: "no_read",
        });
        expect(JSON.stringify(r)).not.toContain(MARK);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "no record and no header: a credential not good, a path no route has",
    async () => {
      const x = await recordsServer();
      try {
        const none = await send(x.s, { path: "/v1/slots" });
        expect(none.status).toBe(401);
        expect(none.headers["saveslot-call"]).toBeUndefined();
        const nowhere = await send(x.s, { path: "/v1/nothing-here", headers: x.auth });
        expect(nowhere.status).toBe(404);
        expect(nowhere.headers["saveslot-call"]).toBeUndefined();
        await new Promise((r) => setTimeout(r, 50));
        expect(x.lines).toEqual([]);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "MCP: a record a tool call, none for initialize, the tool list or a name no tool has; a failing call's record its error, the request 200",
    async () => {
      const x = await recordsServer();
      try {
        await x.mcp({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "example-host", version: "1" },
          },
        });
        await x.mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        await x.mcp(tool(3, "saveslot_nonexistent", {}));
        const both = await x.mcp([
          tool(4, "saveslot_catalog", {}),
          tool(5, "saveslot_query", { table: `${MARK}_table` }),
        ]);
        expect(both.status).toBe(200);
        expect(both.headers["saveslot-call"]).toBeUndefined();
        // The calls of one request run side by side: their records in either order.
        const r = (await x.records(2)).sort((p, q) =>
          String(p["route"]).localeCompare(String(q["route"])),
        );
        all.push(...r);
        expect(r).toHaveLength(2);
        expect(r.map((a) => [a["surface"], a["route"], a["operation"]])).toEqual([
          ["mcp", "saveslot_catalog", "catalog"],
          ["mcp", "saveslot_query", "query"],
        ]);
        expect(r[0]?.["outcome"]).toBe("ok");
        expect(r[1]?.["outcome"]).not.toBe("ok");
        expect(new Set(r.map((a) => a["call"])).size).toBe(2);
        expect(JSON.stringify(r)).not.toContain(MARK);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "a connection token's calls: via token; a tool it may not call is refused 403, a record for that call",
    async () => {
      const x = await recordsServer();
      try {
        const issued = await x.json("POST", "/v1/connections", {
          name: `${MARK}_name`,
          scopes: ["saveslot.read"],
        });
        expect(issued.status).toBe(200);
        const agent = { authorization: `Bearer ${JSON.parse(issued.body).token}` };
        const refused = await x.mcp(tool(1, "saveslot_write", INSERT("x")), agent);
        expect(refused.status).toBe(403);
        const r = await x.records(2);
        all.push(...r);
        expect(r[0]).toMatchObject({
          operation: "connections.issue",
          via: "session",
          effect: "appended",
        });
        expect(r[1]).toMatchObject({
          via: "token",
          surface: "mcp",
          route: "saveslot_write",
          operation: "write",
          outcome: "insufficient_scope",
        });
        expect(r[1]?.["actor"]).toMatch(/^ci_/);
        expect(JSON.stringify(r)).not.toContain(MARK);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "rate limited, on both surfaces: a record each",
    async () => {
      const x = await recordsServer({ rateLimit: { perMinute: 1, burst: 1 } });
      try {
        expect((await send(x.s, { path: "/v1/slots", headers: x.auth })).status).toBe(200);
        const limited = await send(x.s, { path: "/v1/slots", headers: x.auth });
        expect(limited.status).toBe(429);
        expect(limited.headers["saveslot-call"]).toBeDefined();
        await x.mcp(tool(1, "saveslot_catalog", {}));
        const r = await x.records(3);
        all.push(...r);
        expect(r.slice(1).map((a) => [a["surface"], a["outcome"], a["reason"]])).toEqual([
          ["http", "rate_limited", "quota"],
          ["mcp", "rate_limited", "quota"],
        ]);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "an export: its record once the stream has ended whole",
    async () => {
      const x = await recordsServer();
      try {
        const e = await send(x.s, { path: "/v1/export", headers: x.auth });
        expect(e.status).toBe(200);
        const r = await x.records(1);
        all.push(...r);
        expect(r[0]).toMatchObject({ operation: "export", outcome: "ok", complete: true });
        expect(r[0]?.["call"]).toBe(e.headers["saveslot-call"]);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "off (the default): no record written; the header given all the same",
    async () => {
      const x = await recordsServer({ callRecords: undefined as never });
      try {
        const a = await send(x.s, { path: "/v1/slots", headers: x.auth });
        expect(a.headers["saveslot-call"]).toMatch(/^call_[0-9a-f]{32}$/);
        await new Promise((r) => setTimeout(r, 50));
        expect(x.lines).toEqual([]);
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "every operation that appends gives its record an effect; a first confirmation of an awaiting write: saved",
    async () => {
      const x = await recordsServer();
      try {
        const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;
        const steps: { status: number; headers: Record<string, unknown> }[] = [];
        const step = async (p: Promise<Reply>) => {
          const r = await p;
          steps.push(r);
          return r;
        };
        await step(x.json("POST", "/v1/drafts", { document: SAMPLE_SLOT }));
        const spare = body(
          await step(x.json("POST", "/v1/drafts", { document: { ...SAMPLE_SLOT, slot: "spare" } })),
        );
        // A state table: two stretches, then a third across them, left awaiting confirmation.
        const budget = (amount: number, from: string, more = {}) => ({
          intent: "update",
          table: "household.budgets",
          entity_key: { kind: "food" },
          set: { amount },
          valid_from: from,
          ...more,
        });
        await step(x.json("POST", "/v1/writes", { sv: 1, ops: [budget(5000, "2026-10-01")] }));
        await step(x.json("POST", "/v1/writes", { sv: 1, ops: [budget(4000, "2026-11-10")] }));
        await step(
          x.json("POST", "/v1/writes", {
            sv: 1,
            ops: [budget(4500, "2026-10-15", { valid_to: "open" })],
          }),
        );
        const items = body(await send(x.s, { path: "/v1/pending", headers: x.auth }))["items"] as {
          id: string;
          item_ver: string;
        }[];
        const item = items.at(-1) as { id: string; item_ver: string };
        // Read, then confirmed without its version: the answer carries a warning (the version it
        // fell back to), the receipt copied to add it, the case that lost the effect once.
        await send(x.s, { path: `/v1/pending/${item.id}`, headers: x.auth });
        const confirmed = await step(
          x.json("POST", `/v1/pending/${item.id}/resolution`, { decision: "confirm" }),
        );
        expect(confirmed.status).toBe(200);
        expect(JSON.stringify(body(confirmed)["warnings"])).toContain("item_ver_fallback");
        const issued = body(
          await step(x.json("POST", "/v1/connections", { name: "agent one" })),
        ) as { id: string };
        await step(x.json("PATCH", `/v1/connections/${issued.id}`, { name: "agent two" }));
        await step(
          send(x.s, { method: "DELETE", path: `/v1/connections/${issued.id}`, headers: x.auth }),
        );
        await step(
          send(x.s, { method: "DELETE", path: `/v1/slots/${spare["slot_id"]}`, headers: x.auth }),
        );
        // And on MCP: a write tool's record has its effect too.
        await x.mcp(tool(9, "saveslot_write", INSERT("tea")));
        expect(steps.map((r) => r.status)).toEqual(steps.map(() => 200));
        const r = await x.records(steps.length + 2);
        all.push(...r);
        const appending = r.filter((a) =>
          [
            "write",
            "resolve",
            "schema_draft",
            "connections.issue",
            "connections.update",
            "connections.revoke",
            "slots.remove",
          ].includes(String(a["operation"])),
        );
        expect(appending.length).toBe(steps.length + 1);
        // A listed operation's success with no effect is a defect: none here, none told.
        expect(appending.filter((a) => a["effect"] === undefined)).toEqual([]);
        expect(x.warned).not.toContain("call_effect_missing");
        const resolution = r.find((a) => a["operation"] === "resolve");
        expect(resolution).toMatchObject({ effect: "appended", status: "saved" });
        expect(r.find((a) => a["surface"] === "mcp")).toMatchObject({
          operation: "write",
          effect: "appended",
          status: "saved",
        });
      } finally {
        await x.s.close();
      }
    },
    T,
  );

  it(
    "an MCP request made once more for a connection gone: one record, the answered try's (on either backend)",
    async () => {
      const c = await controlDb();
      const t = tenants();
      // The tenant's stores fail one transaction when armed, after the given ones pass, as a
      // connection ended a moment before does; failed, a store says so, and the pool opens again.
      const k = { passFirst: 0, armed: false, opened: 0 };
      type Store = Awaited<ReturnType<TenantPoolOptions["backend"]["open"]>>;
      const wrap = (store: Store): Store => {
        let failed = false;
        const run = async <T>(go: () => Promise<T>): Promise<T> => {
          if (failed)
            throw Object.assign(new Error("the connection is gone"), { code: "connection_lost" });
          if (k.armed) {
            if (k.passFirst > 0) k.passFirst--;
            else {
              k.armed = false;
              failed = true;
              throw Object.assign(new Error("the connection is gone"), { code: "connection_lost" });
            }
          }
          return go();
        };
        return {
          write: (fn) => run(() => store.write(fn)),
          read: (fn) => run(() => store.read(fn)),
          ...(store.recordReads !== undefined
            ? {
                recordReads: <T>(fn: Parameters<NonNullable<Store["recordReads"]>>[0]) =>
                  run(() =>
                    (store.recordReads as NonNullable<Store["recordReads"]>)(fn),
                  ) as Promise<T>,
              }
            : {}),
          purgeResidue: () => store.purgeResidue(),
          snapshot: () => store.snapshot(),
          formatVersion: store.formatVersion,
          ...(store.enforcesStatementTimeout !== undefined
            ? { enforcesStatementTimeout: store.enforcesStatementTimeout }
            : {}),
          close: () => store.close(),
          get usable() {
            return !failed;
          },
        };
      };
      const backend: TenantPoolOptions["backend"] = {
        open: async (ref, opts) => {
          const store = await t.backend.open(ref, opts);
          k.opened++;
          return wrap(store);
        },
      };
      const cfg = config({ callRecords: true });
      await CursorKeys.createFile(cfg.handleKeyFile);
      const { user } = await addLocalUser(c.accounts as NonNullable<typeof c.accounts>, {
        control: c.cp as ServerControlPlane,
        backend,
        name: "robin",
        password: "correct horse battery",
        cell: CELL,
        cells: new Set([CELL]),
        now: NOW,
      });
      const token = await sessionFor(c.store, user);
      const lines: string[] = [];
      const s = await runServer({
        config: cfg,
        version: "0.0.0-test",
        openControl: async () => c.db,
        backend,
        now: () => NOW,
        callRecordSink: async (line) => {
          lines.push(line);
        },
      });
      const auth = { authorization: `Bearer ${token}` };
      try {
        expect((await send(s, { path: "/v1/slots", headers: auth })).status).toBe(200);
        const opened = k.opened;
        const before = lines.length;
        // The authentication's read passes; the tool's operation meets the connection gone.
        k.passFirst = 1;
        k.armed = true;
        const r = await send(s, {
          method: "POST",
          path: "/mcp",
          headers: {
            ...auth,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify(tool(1, "saveslot_catalog", {})),
        });
        expect(r.status).toBe(200);
        expect(r.body).not.toContain('"isError":true');
        expect(k.opened).toBe(opened + 1);
        await new Promise((done) => setTimeout(done, 50));
        const made = lines.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(made.map((m) => [m["route"], m["outcome"]])).toEqual([["saveslot_catalog", "ok"]]);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it("every record's fields are the table's, and none is left out of it", () => {
    expect(all.length).toBeGreaterThan(0);
    const seen = new Set(all.flatMap((r) => Object.keys(r)));
    expect([...seen].filter((k) => !(CALL_RECORD_FIELDS as readonly string[]).includes(k))).toEqual(
      [],
    );
  });
});
