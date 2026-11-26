// The contract tests on the server mode (02-architecture §11 «测试矩阵»: HTTP and MCP run the same
// contract tests; 05-surfaces §14, §15): the suite the local service runs, driven over TCP against
// `runServer`, once for each shape of deployment — self-hosted (a local account and its tenant, no
// rate limit) and hosted (the external login: a user and tenant made on the first assertion of a
// platform account, rate limits on) — over
// HTTP and over remote MCP in both protocol eras. Each run has a tenant of its own. Then what only
// the server mode has: tenants that do not see each other, a disabled account refused, and the 401
// that points at the protected resource's metadata. On either backend (`pnpm test:postgres` runs
// this file on PostgreSQL). Fictional names.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addLocalUser,
  CursorKeys,
  disableExternalUser,
  disableLocalUser,
  ExternalIdentity,
  type ExternalLogins,
  initControlPlane,
  initExternalLogin,
  initLocalAccounts,
  initOAuthTables,
  type LocalAccounts,
  type ServerControlPlane,
  type TenantPoolOptions,
  type UserId,
  writeUserSession,
} from "@fluxvita/saveslot-service";
import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GOOD_HEADER,
  goodClaims,
  signAssertion,
  TEST_ISSUER,
  TEST_KEY,
} from "../../service/src/external-assertion.fixture.ts";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import { contractSuite, LEDGER, type Outcome } from "./contract-suite.fixture.ts";
import { httpDriver, httpRequest } from "./http-driver.fixture.ts";
import { type Era, MCP_OPERATIONS, mcpDriver, observer } from "./mcp-driver.fixture.ts";
import { type RunningServer, runServer } from "./run-server.ts";
import type { ServerConfig } from "./server-config.ts";

/** A store the test backend opens. */
type Store = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;

const T = 120_000;
const PUBLIC = "http://127.0.0.1:8080";
const CELL = "main";
const SESSION_ENDS = "2099-01-01T00:00:00.000Z";
const root = mkdtempSync(join(tmpdir(), "saveslot-server-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

let n = 0;
const stores: Store[] = [];
afterAll(async () => {
  for (const s of stores) await s.close().catch(() => {});
}, T);

interface Shape {
  readonly name: string;
  /** Users are local accounts (self-hosted), or accounts of a platform's external login (hosted). */
  readonly accounts: "local" | "external";
  readonly rateLimit?: ServerConfig["rateLimit"];
}

const SHAPES: readonly Shape[] = [
  { name: "self-hosted", accounts: "local" },
  // Generous: the suite's calls stay under it; that requests pass the limiter is what is tested.
  { name: "hosted", accounts: "external", rateLimit: { perMinute: 6000, burst: 6000 } },
];

/** A user of a shape: the name or the platform's subject that disables it, and a user session. */
interface ShapeUser {
  readonly name: string;
  readonly user: UserId;
  readonly session: string;
}

/** A server of `shape` on a loopback port, its control database and tenants of the test backend. */
function serverFixture(shape: Shape) {
  const f = {
    server: undefined as RunningServer | undefined,
    obs: observer(),
    at: () => (f.server as RunningServer).address,
    cp: undefined as ServerControlPlane | undefined,
    store: undefined as Store | undefined,
    accounts: undefined as LocalAccounts | undefined,
    logins: undefined as ExternalLogins | undefined,
    /** The platform's first sign-in of an account, on the server's control database. */
    platform: undefined as ExternalIdentity | undefined,
    backend: undefined as TenantPoolOptions["backend"] | undefined,
    /** A user with a tenant of their own and a user session for it. */
    user: async (): Promise<ShapeUser> => {
      const cp = f.cp as ServerControlPlane;
      const backend = f.backend as TenantPoolOptions["backend"];
      const k = n++;
      let user: UserId;
      let name: string;
      if (shape.accounts === "local") {
        name = `user${k}`;
        ({ user } = await addLocalUser(f.accounts as LocalAccounts, {
          control: cp,
          backend,
          name,
          password: "correct horse battery",
          cell: CELL,
          cells: new Set([CELL]),
          now: new Date().toISOString(),
        }));
      } else {
        // The account's first assertion makes its user and tenant; a source of its own each, so
        // that the count of new users per source does not stop the next.
        name = `acct_${k}`;
        const assertion = signAssertion(GOOD_HEADER, {
          ...goodClaims(Date.now(), { purpose: "session", sub: name }),
          aud: PUBLIC,
        });
        const made = await (f.platform as ExternalIdentity).acceptAssertion(
          assertion,
          `198.51.100.${k % 250}`,
        );
        if (made === undefined) throw new Error("the assertion made no user");
        user = made.user;
      }
      const session = await (f.store as Store).write((tx) =>
        writeUserSession(tx, user, { expiresAt: SESSION_ENDS }),
      );
      return { name, user, session };
    },
    /** Disables the user's account, as the shape's operator does. */
    disable: async (u: ShapeUser): Promise<void> => {
      if (shape.accounts === "local") {
        await disableLocalUser(f.accounts as LocalAccounts, { name: u.name });
      } else {
        await disableExternalUser(f.logins as ExternalLogins, {
          issuer: TEST_ISSUER,
          subject: u.name,
        });
      }
    },
  };
  beforeAll(async () => {
    const dir = join(root, `control${n++}`);
    const store = await testBackend().open({ kind: "pglite", dir }, { create: true });
    stores.push(store);
    f.cp = await initControlPlane(store);
    await initOAuthTables(store);
    f.store = store;
    // The tables `server init` makes for the shape's identity provider.
    if (shape.accounts === "local") f.accounts = await initLocalAccounts(store);
    else f.logins = await initExternalLogin(store);
    const tenants = join(root, `tenants${n++}`);
    f.backend = {
      open: (ref, opts) => {
        if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
        return testBackend().open(
          { kind: "pglite", dir: join(tenants, ref.cell, ref.database) },
          opts,
        );
      },
    };
    const keys = join(root, `keys${n++}`);
    mkdirSync(keys, { mode: 0o700 });
    let config: ServerConfig = {
      control: { cell: { host: "unused", user: "unused" }, database: "unused" },
      cell: { host: "unused", user: "unused" },
      cellName: CELL,
      publicUrl: PUBLIC,
      handleKeyFile: join(keys, "handle-key"),
      listen: { host: "127.0.0.1", port: 0 },
      trustedProxies: [],
      allowedOrigins: [],
      shutdown: { drainSeconds: 0, timeoutSeconds: 30 },
      ...(shape.rateLimit !== undefined ? { rateLimit: shape.rateLimit } : {}),
    };
    if (shape.accounts === "external") {
      const keysFile = join(keys, "platform-keys.json");
      writeFileSync(keysFile, JSON.stringify({ keys: [TEST_KEY.public] }), { mode: 0o600 });
      config = {
        ...config,
        identity: {
          issuer: TEST_ISSUER,
          loginUrl: "https://platform.example/login",
          keysFile,
        },
      };
    }
    await CursorKeys.createFile(config.handleKeyFile);
    const db: ControlDatabase = {
      read: store.read.bind(store),
      write: store.write.bind(store),
      close: async () => {},
      onLost: () => {},
    };
    f.server = await runServer({
      config,
      version: "0.0.0-test",
      openControl: async () => db,
      backend: f.backend,
      onToolResult: f.obs.onToolResult,
    });
    if (shape.accounts === "external") {
      f.platform = new ExternalIdentity({
        logins: f.logins as ExternalLogins,
        config: {
          issuer: TEST_ISSUER,
          loginUrl: "https://platform.example/login",
          keys: [TEST_KEY.public],
          audience: PUBLIC,
        },
        control: f.cp,
        backend: f.backend,
        cell: CELL,
        cells: new Set([CELL]),
      });
    }
  }, T);
  afterAll(async () => {
    await f.server?.close();
  }, T);
  return f;
}

const result = (o: Outcome) => {
  if (!("result" in o)) throw new Error(`refused: ${JSON.stringify(o.error)}`);
  return o.result;
};

for (const shape of SHAPES) {
  describe(`the server mode, ${shape.name}`, () => {
    const s = serverFixture(shape);
    const http = httpDriver(s.at);

    describe("the contract over HTTP", () => {
      let session = "";
      beforeAll(async () => {
        ({ session } = await s.user());
      }, T);
      contractSuite(() => ({ driver: http, session }));
    });

    for (const era of ["legacy", "modern"] as const satisfies readonly Era[]) {
      describe(`the contract over remote MCP (${era === "legacy" ? "2025-11-25" : "2026-07-28"})`, () => {
        let session = "";
        beforeAll(async () => {
          ({ session } = await s.user());
        }, T);
        contractSuite(() => ({
          driver: mcpDriver(s.at, era, s.obs),
          session,
          surface: MCP_OPERATIONS,
          admin: http,
        }));
      });
    }

    it(
      "two tenants do not see each other: a slot of one is not found by the other",
      async () => {
        const a = await s.user();
        const b = await s.user();
        const made = result(await http(b.session, "schema_draft", { document: LEDGER }));
        expect(made).toMatchObject({ outcome: "applied" });
        const theirs = result(await http(b.session, "catalog", {}));
        expect(JSON.stringify(theirs)).toContain("ledger");
        const mine = result(await http(a.session, "catalog", {}));
        expect(JSON.stringify(mine)).not.toContain("ledger");
        const slotId = made["slot_id"] as string;
        expect(slotId).toMatch(/^sl_/);
        expect(await http(a.session, "slots.remove", { slot_id: slotId })).toEqual({
          error: expect.objectContaining({ code: "not_found" }),
        });
        // Still there for its own tenant.
        expect(JSON.stringify(result(await http(b.session, "catalog", {})))).toContain(slotId);
      },
      T,
    );

    it("a request without a token: 401, pointing at the protected resource's metadata", async () => {
      const r = await httpRequest(s.at(), { method: "GET", path: "/v1/slots" });
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toContain(
        `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`,
      );
    });

    it(
      "a disabled account: its session and its connections refused from the next request on",
      async () => {
        const u = await s.user();
        const issued = result(await http(u.session, "connections.issue", { name: "agent" }));
        const token = issued["token"] as string;
        result(await http(token, "catalog", {}));
        await s.disable(u);
        for (const credential of [u.session, token]) {
          expect(await http(credential, "catalog", {})).toEqual({
            error: expect.objectContaining({
              code: "unauthenticated",
              reason: "account_disabled",
            }),
          });
        }
      },
      T,
    );
  });
}
