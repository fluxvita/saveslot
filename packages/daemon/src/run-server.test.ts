// The server mode's process (06-cli §4.1 `saveslot server start`; 02-architecture §5, §9; 05-surfaces
// §14, §15) on a real control database and tenants, on either backend (`pnpm test:postgres` runs this
// file on PostgreSQL): what answers each request, in which order, what it refuses to start on, and
// how it closes. Fictional names.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addLocalUser,
  CursorKeys,
  type DiscardDatabase,
  databaseOf,
  initControlPlane,
  initExternalLogin,
  initLocalAccounts,
  type ServerControlPlane,
  stagingDatabaseOf,
  type TenantPoolOptions,
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
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import {
  cellDiscarder,
  type RunningServer,
  runServer,
  ServerAlreadyRunning,
  ServerStartRefused,
} from "./run-server.ts";
import type { ServerConfig } from "./server-config.ts";
import { IdentityTablesRefused } from "./server-identity.ts";
import { SERVER_LOCK } from "./server-lock.ts";
import { serverRestore } from "./server-restore-command.ts";

/** A store the test backend opens: the control database of these tests. */
type Store = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;

const T = 120_000;
const NOW = "2026-11-21T08:00:00.000Z";
const PUBLIC = "http://127.0.0.1:8080";
const CELL = "main";
const root = mkdtempSync(join(tmpdir(), "saveslot-run-server-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

let n = 0;
const stores: Store[] = [];
afterAll(async () => {
  for (const s of stores) await s.close().catch(() => {});
}, T);

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
      return Object.assign(s, {
        close: async () => {
          closed++;
          await close();
        },
      });
    },
  };
  return { backend, closed: () => closed };
}

/**
 * A control database with the tables `server init` makes for the local accounts, or for the
 * external login with `external`; told to, it leaves the provider's or every table out.
 */
async function controlDb(o: { provider?: boolean; external?: boolean; control?: boolean } = {}) {
  const dir = join(root, `control${n++}`);
  const store = await testBackend().open({ kind: "pglite", dir }, { create: true });
  stores.push(store);
  const cp = o.control === false ? undefined : await initControlPlane(store);
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
  beforeAll(async () => {
    const c = await controlDb();
    const t = tenants();
    const cfg = config();
    await CursorKeys.createFile(cfg.handleKeyFile);
    const accounts = c.accounts as NonNullable<typeof c.accounts>;
    const cp = c.cp as ServerControlPlane;
    const { user } = await addLocalUser(accounts, {
      control: cp,
      backend: t.backend,
      name: "alex",
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

describe("runServer: closing", () => {
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
