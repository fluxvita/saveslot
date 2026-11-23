// The server mode's process (docs/zh-CN/spec/06-cli.md §4.1 `saveslot server start`, «服务器模式的配置»;
// 02-architecture §5, §7, §9): it only assembles. The control database is opened and every set of
// tables in it checked, never made (that is `saveslot server init`'s); the handle keys are read;
// tenants are lent by the pool; requests are taken on TCP and go, in this order, to:
//
//   GET /health (no token) → the request's source (behind trusted proxies; none: 400) → the
//   identity provider's own paths → the authorization server (/.well-known/oauth-*, /oauth/*) →
//   the HTTP adapter → the MCP adapter → 404.
//
// Expired codes, form tokens, client documents, refresh tokens and device codes are swept every
// SWEEP_MS. A
// connection revoked through /v1 or MCP takes its refresh tokens with it.
//
// Each route is matched on the request target's parsed path, as the adapters match theirs, so an
// absolute-form target (`GET http://host/account/login`) goes where its path does. A request's body
// is read here only on the identity provider's paths, for its form; the authorization server reads
// its own; every other request reaches its handler with its body unread. Closing stops taking
// connections, lets the
// requests in progress end, then closes the tenants (their reads written, their high water moved
// up) and the control database. While it runs it holds the control database's "the server is
// running" lock (./server-lock.ts), taken before anything else: a second server does not start on
// the same control database, and `server restore` does nothing while it runs. The lock is held by
// the control database's connection: when that connection goes away (the database restarted, a
// failover, a middlebox dropping it), the lock is gone too, so the server stops serving at once
// (health `failed`, every other request 503) and `failed` resolves: its host exits for the process
// manager to start it again, which takes the lock anew.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Api,
  type ApiContext,
  clientFetcher,
  createMcpAdapter,
  type HealthBody,
  handleApi,
  handleMcp,
  handleOAuth,
} from "@fluxvita/saveslot-server";
import {
  ContractError,
  CursorKeys,
  type DiscardDatabase,
  importServerRequest,
  type OAuthDeps,
  type OAuthStore,
  openControlPlane,
  openOAuthStore,
  requestSource,
  serverCallers,
  stagingDiscarder,
  TenantPool,
  type TenantPoolOptions,
  TenantRateLimiter,
} from "@fluxvita/saveslot-service";
import {
  type ControlDatabase,
  discardDatabase,
  openControlDatabase,
  PostgresBackend,
} from "@fluxvita/saveslot-store-postgres";
import { identityRequest, readForm, sendIdentityResponse } from "./identity-http.ts";
import type { DatabaseAt, ServerConfig } from "./server-config.ts";
import { openIdentity, readIdentity } from "./server-identity.ts";
import { releaseServerLock, takeServerLock } from "./server-lock.ts";

/** How often expired codes, form tokens, client documents, refresh tokens and device codes are swept. */
export const SWEEP_MS = 10 * 60 * 1000;

/** The control plane's or the authorization server's tables `start` found missing or of another format. */
export class ServerStartRefused extends Error {
  override readonly name = "ServerStartRefused";
  readonly set: "control" | "oauth";
  readonly reason: "not_initialized" | "format";
  constructor(set: ServerStartRefused["set"], reason: ServerStartRefused["reason"]) {
    super(
      `the control database's ${set} tables are ${reason === "format" ? "of another format" : "not there"}`,
    );
    this.set = set;
    this.reason = reason;
  }
}

/** The control database could not be reached; the driver's message is not kept (it may name hosts). */
export class ControlUnreachable extends Error {
  override readonly name = "ControlUnreachable";
}

/** Another server holds the control database's "the server is running" lock. */
export class ServerAlreadyRunning extends Error {
  override readonly name = "ServerAlreadyRunning";
}

export interface RunServerOptions {
  readonly config: ServerConfig;
  /** This saveslot's version, for `/health`. */
  readonly version: string;
  /** Opens the control database (a test gives one of its own backend's). */
  readonly openControl?: (at: DatabaseAt) => Promise<ControlDatabase>;
  /** The tenants' storage (a test gives its own); PostgreSQL in the configured cell otherwise. */
  readonly backend?: TenantPoolOptions["backend"];
  /** Drops a tenant's database an import left behind (a test gives its own); `cellDiscarder`'s otherwise. */
  readonly discardDatabase?: DiscardDatabase;
  readonly now?: () => string;
  /** How long an unused tenant stays open. */
  readonly idleMs?: number;
  readonly log?: (fields: Readonly<Record<string, string | number>>) => void;
  readonly warn?: (event: string, fields: Readonly<Record<string, string>>) => void;
  /** Sees each MCP tool call's contract result (the contract tests' MCP driver reads it). */
  readonly onToolResult?: ApiContext["onToolResult"];
  /** Tests only: how long an import's body may give nothing (local-import.ts's default otherwise). */
  readonly importBodyIdleMs?: number;
  /** Tests only: the sweep's interval (SWEEP_MS otherwise), and a look at each sweep. */
  readonly testing?: { readonly sweepMs?: number; readonly onSweep?: () => void };
  /** Tests only: the client documents' fetcher (the network's otherwise). */
  readonly fetchClient?: OAuthDeps["fetchClient"];
}

/**
 * Drops a database of the one cell (the PostgreSQL backend's `discardDatabase`, whose guard refuses
 * any but the tenant's staging databases and the one an import replaced). A tenant recorded in
 * another cell is refused, nothing dropped: a self-hosted server has one cell.
 */
export function cellDiscarder(config: ServerConfig): DiscardDatabase {
  return async ({ cell, ...request }) => {
    if (cell !== config.cellName) {
      throw new Error("the tenant's database is not in this server's cell");
    }
    await discardDatabase(config.cell, request);
  };
}

export interface RunningServer {
  /** Where it listens (the port the system gave when the configuration asked for 0). */
  readonly address: { readonly host: string; readonly port: number };
  /**
   * Resolves when the server cannot go on: its control database's connection went away, and the
   * lock with it. It serves nothing more; the host closes it and exits.
   */
  readonly failed: Promise<void>;
  /** Stops taking requests, lets those in progress end, closes the tenants and the database. */
  close(): Promise<void>;
}

/**
 * Starts the server mode. Throws `ServerIdentityRefused` for the external login's settings,
 * `ControlUnreachable`, `ServerAlreadyRunning`, `ServerStartRefused` or `IdentityTablesRefused` for
 * tables it cannot use, `HandleKeyFileError` for the key file; nothing is left open.
 */
export async function runServer(o: RunServerOptions): Promise<RunningServer> {
  const { config } = o;
  const now = o.now ?? (() => new Date().toISOString());
  const log = o.log ?? (() => {});
  const warn = o.warn ?? (() => {});
  // The external login's settings read before anything is opened.
  const external = await readIdentity(config);
  let db: ControlDatabase;
  try {
    db = await (o.openControl ?? ((at) => openControlDatabase(at.cell, at.database)))(
      config.control,
    );
  } catch {
    throw new ControlUnreachable("the control database could not be reached");
  }
  let state: HealthBody["state"] = "starting";
  let lost = false;
  let fail!: () => void;
  const failed = new Promise<void>((resolve) => {
    fail = resolve;
  });
  db.onLost(() => {
    lost = true;
    state = "failed";
    warn("control_database_lost", {});
    fail();
  });
  let pool: TenantPool | undefined;
  try {
    // One server a control database (02-architecture §9): held until it closes.
    if (!(await takeServerLock(db))) {
      throw new ServerAlreadyRunning("another server is running on this control database");
    }
    const control = await openControlPlane(db).catch((e: unknown) => {
      const code = (e as { code?: unknown }).code;
      if (code === "control_not_initialized")
        throw new ServerStartRefused("control", "not_initialized");
      if (code === "control_format_mismatch") throw new ServerStartRefused("control", "format");
      throw e;
    });
    const oauth: OAuthStore = await openOAuthStore(db).catch((e: unknown) => {
      const code = (e as { code?: unknown }).code;
      if (code === "oauth_not_initialized")
        throw new ServerStartRefused("oauth", "not_initialized");
      if (code === "control_format_mismatch") throw new ServerStartRefused("oauth", "format");
      throw e;
    });
    const backend = o.backend ?? new PostgresBackend({ cells: { [config.cellName]: config.cell } });
    const identity = await openIdentity({ db, config, external, control, backend, now });
    const cursors = await CursorKeys.fromFile(config.handleKeyFile);
    pool = new TenantPool({
      control,
      backend,
      idleMs: o.idleMs ?? 5 * 60 * 1000,
      now,
      // In the server's own log: the tenant and the step, never the error's message.
      onCloseFailure: (tenant, what, error) =>
        warn("tenant_close_failed", {
          tenant,
          step: what,
          error: (error as Error)?.name ?? "unknown",
        }),
      // A staging database an import left (refused, rolled back, or the one a swap replaced) is
      // dropped and forgotten when its tenant is next opened; a drop that fails is warned of, the
      // tenant serves, and the next opening tries again.
      discardStaging: stagingDiscarder({
        control,
        discardDatabase: o.discardDatabase ?? cellDiscarder(config),
      }),
      onDiscardFailure: (tenant) => warn("tenant_staging_left", { tenant }),
    });
    // Normalized when the configuration was read: one that is not a single address refuses it.
    const trusted = new Set(config.trustedProxies);
    const windows = { requestKey: 600_000, idempotencyKey: 86_400_000 };
    const tenantPool = pool;
    // The imports in progress, each with what abandons its body: a stop does not wait on a client
    // that stalled (`import_rejected`, `incomplete`, before ④; an import past its body ends).
    const imports = new Set<AbortController>();
    const ctx: ApiContext = {
      callers: serverCallers({
        control,
        pool,
        identity,
        oauth,
        now,
      }),
      resourceMetadata: `${config.publicUrl}/.well-known/oauth-protected-resource`,
      ...(config.rateLimit !== undefined
        ? {
            rateLimit: new TenantRateLimiter(
              config.rateLimit.perMinute,
              config.rateLimit.burst,
              () => performance.now(),
            ),
          }
        : {}),
      cursors,
      windows,
      now,
      ...(o.onToolResult !== undefined ? { onToolResult: o.onToolResult } : {}),
      warn,
      import: async (r) => {
        // The route lets only the user's session import; its actor is the user.
        if (r.principal.kind !== "user") {
          throw new ContractError("insufficient_scope", "only the user session imports", {
            required_scope: "user_session",
          });
        }
        const abort = new AbortController();
        imports.add(abort);
        if (state === "stopping") abort.abort();
        try {
          return await importServerRequest({
            control,
            backend,
            pool: tenantPool,
            discardDatabase: o.discardDatabase ?? cellDiscarder(config),
            tenant: r.tenant,
            user: r.principal.actor,
            body: r.body,
            now: r.now as never,
            signal: abort.signal,
            ...(o.importBodyIdleMs !== undefined ? { bodyIdleMs: o.importBodyIdleMs } : {}),
            onDiscardFailure: (tenant) => warn("tenant_staging_left", { tenant }),
          });
        } finally {
          imports.delete(abort);
        }
      },
    };
    const since = new Date().toISOString();
    const api: Api = { ready: () => (state === "ready" ? ctx : undefined), log };
    const mcp = createMcpAdapter({ version: () => o.version });
    const lentPool = pool;
    const oauthDeps: OAuthDeps = {
      store: oauth,
      control,
      pool: { use: (tenant, fn) => lentPool.use(tenant, fn) },
      identity,
      fetchClient: o.fetchClient ?? clientFetcher(),
      external: config.publicUrl,
      windows,
    };

    const server: Server = createServer((req, res) => {
      void (async () => {
        const path = new URL(req.url ?? "/", "http://local").pathname;
        if (req.method === "GET" && path === "/health") {
          const body = JSON.stringify({
            state,
            version: o.version,
            pid: process.pid,
            since,
            ...(lost ? { reason: "control_database_lost" } : {}),
          });
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "cache-control": "no-store",
          });
          res.end(body);
          return;
        }
        const remote = requestSource({
          connection: req.socket.remoteAddress,
          forwardedFor: req.headers["x-forwarded-for"],
          trusted,
        });
        if (remote === undefined) {
          res.writeHead(400, { "content-length": 0 });
          res.end();
          return;
        }
        if (state !== "ready") {
          res.writeHead(503, { "content-length": 0, "retry-after": "1" });
          res.end();
          return;
        }
        if (identity.paths.has(path)) {
          const form = await readForm(req);
          if (form === "too_large") {
            res.writeHead(413, { "content-length": 0 });
            res.end();
            return;
          }
          const answer = await identity.handle(identityRequest(req, remote, form));
          if (answer !== undefined) {
            sendIdentityResponse(res, answer);
            return;
          }
        }
        const oauthCtx = { deps: oauthDeps, identity, remote: () => remote, now, log, warn };
        if (await handleOAuth(req, res, oauthCtx)) return;
        if (handleApi(api, req, res)) return;
        if (handleMcp(mcp, api, req, res)) return;
        res.writeHead(404, { "content-length": 0 });
        res.end();
      })().catch((e: unknown) => {
        warn("server_request_failed", { error: (e as Error).name });
        if (!res.headersSent) res.writeHead(500, { "content-length": 0 });
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen.port, config.listen.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    // Started once the server listens: a start that fails leaves no timer behind.
    const sweep = setInterval(() => {
      o.testing?.onSweep?.();
      oauth.sweep(now()).catch((e: unknown) => {
        warn("oauth_sweep_failed", { error: (e as Error)?.name ?? "unknown" });
      });
    }, o.testing?.sweepMs ?? SWEEP_MS);
    sweep.unref();
    const at = server.address() as AddressInfo;
    const lent = pool;
    if (!lost) state = "ready";
    return {
      address: { host: at.address, port: at.port },
      failed,
      close: async () => {
        if (!lost) state = "stopping";
        // Before the requests in progress are waited for: an import still reading its body ends.
        for (const a of imports) a.abort();
        clearInterval(sweep);
        await new Promise<void>((resolve, reject) => {
          server.close((e) => (e ? reject(e) : resolve()));
          server.closeIdleConnections();
        });
        await mcp.handler.close();
        await lent.closeAll();
        // A lost connection took the lock with it: there is nothing to release, and none to close.
        if (!lost) await releaseServerLock(db);
        await db.close().catch((e: unknown) => {
          if (!lost) throw e;
        });
      },
    };
  } catch (e) {
    await pool?.closeAll().catch(() => {});
    await db.close().catch(() => {});
    throw e;
  }
}
