// The server mode's process (06-cli §4.1 `saveslot server start`; 02-architecture §5, §9; 05-surfaces
// §14, §15) on a real control database and tenants, on either backend (`pnpm test:postgres` runs this
// file on PostgreSQL): what answers each request, in which order, what it refuses to start on, and
// how it closes. Fictional names.

import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import {
  addLocalUser,
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
import {
  type ControlDatabase,
  checkDiscard,
  openControlDatabase,
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
import {
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

  /** The tenant as the anchor and the directory have it: empty, no import left over. */
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
      const { s, cp, user, source, file } = await serverWithSource({ holdStagingDrop });
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
          expect((await send(s, { path: "/v1/slots" })).status).toBe(503);
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
