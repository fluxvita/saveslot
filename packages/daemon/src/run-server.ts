// The server mode's process (docs/zh-CN/spec/06-cli.md §4.1 `saveslot server start`, «服务器模式的配置»;
// 02-architecture §5, §7, §9): it only assembles. The control database is opened and every set of
// tables in it checked, never made (that is `saveslot server init`'s); the handle keys are read;
// tenants are lent by the pool; requests are taken on TCP and go, in this order, to:
//
//   GET /health and GET /ready (no token) → for /v1/, /oauth/token and /oauth/revoke, the CORS headers
//   (05-surfaces §13) → the request's source (behind trusted proxies; none: 400) → a listed
//   origin's preflight answered → the identity provider's own paths → the authorization server
//   (/.well-known/oauth-*, /oauth/*) → for /v1/ and /mcp, a page of another site refused (its
//   `Origin`, 05-surfaces §14; on /v1/ a listed origin is not another site's) → the HTTP adapter →
//   the MCP adapter → 404.
//
// A token issued by an authorization is good only at the address it was issued for (its
// audience, checked with every credential).
// Expired codes, form tokens, client documents, refresh tokens and device codes, and the
// credentials an authorization issued a day after they expired, are swept every SWEEP_MS. A
// connection revoked through /v1 or MCP takes its refresh tokens with it.
//
// Each route is matched on the request target's parsed path, as the adapters match theirs, so an
// absolute-form target (`GET http://host/account/login`) goes where its path does. A request's body
// is read here only on the identity provider's paths, for its form; the authorization server reads
// its own; every other request reaches its handler with its body unread.
//
// `/health` answers 200 in every state, the state in its body; `/ready` answers 200 only while the
// state is `ready`, 503 otherwise: what a load balancer and a readiness probe ask. Closing goes in
// three steps, each bounded (06-cli §4.1 `saveslot server start`): (1) the state turns `stopping`,
// so `/ready` answers 503, while every request is still served as before, for the drain
// (`SAVESLOT_SHUTDOWN_DRAIN`) that lets the load balancer stop sending; (2) no new connection is
// taken and a request on one still open is refused as `stopping`, an import still reading its body
// ends, and the requests in progress are waited for up to the timeout
// (`SAVESLOT_SHUTDOWN_TIMEOUT`), after which the connections still open are cut; (3) the tenants
// are closed (their reads written, their high water moved up), for at most TENANTS_CLOSE_MS, then
// the lock is released and the control database closed. A second signal (`hurry`) skips what is
// left of (1) and (2). While it runs it holds the control database's "the server is
// running" lock (./server-lock.ts), taken before anything else: a second server does not start on
// the same control database, and `server restore` does nothing while it runs. The lock is held by
// the control database's connection: when that connection goes away (the database restarted, a
// failover, a middlebox dropping it), the lock is gone too, so the server stops serving at once
// (health `failed`, every other request 503) and `failed` resolves: its host exits for the process
// manager to start it again, which takes the lock anew.

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Api,
  type ApiContext,
  clientFetcher,
  corsHeaders,
  createMcpAdapter,
  crossOriginPath,
  type HealthBody,
  handleApi,
  handleMcp,
  handleOAuth,
  originGuard,
  PREFLIGHT_HEADERS,
  sendError,
} from "@fluxvita/saveslot-server";
import {
  ContractError,
  CursorKeys,
  checkAudience,
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
  trustedProxies,
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

/** How often the authorization server's expired rows are swept. */
export const SWEEP_MS = 10 * 60 * 1000;

/** How long closing waits for the tenants to close (step 3) before it goes on without them. */
export const TENANTS_CLOSE_MS = 10_000;

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
  /**
   * Tests only: the sweep's interval (SWEEP_MS otherwise), and a look at each sweep; the closing's
   * three bounds in milliseconds (the configuration's, and TENANTS_CLOSE_MS, otherwise).
   */
  readonly testing?: {
    readonly sweepMs?: number;
    readonly onSweep?: () => void;
    readonly drainMs?: number;
    readonly timeoutMs?: number;
    readonly tenantsCloseMs?: number;
  };
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
  /**
   * Closes in the three steps above; called again, the same closing. Resolves once the lock is
   * released and the control database closed.
   */
  close(): Promise<void>;
  /**
   * A second stop signal: what is left of the drain and of the wait for the requests in progress is
   * skipped (the connections still open are cut); the tenants are still closed and the lock
   * released. Before close(), nothing.
   */
  hurry(): void;
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
  // Whether requests are served: from ready until step 2 of closing, or the control database lost.
  // Apart from the state, which turns `stopping` at step 1 while requests are still served.
  let serving = false;
  let lost = false;
  let fail!: () => void;
  const failed = new Promise<void>((resolve) => {
    fail = resolve;
  });
  db.onLost(() => {
    lost = true;
    serving = false;
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
      // tenant serves, and the next opening tries again. One the import is still dropping, after
      // its answer, is left to that drop: the opening does not wait for a DROP DATABASE.
      discardStaging: stagingDiscarder({
        control,
        discardDatabase: o.discardDatabase ?? cellDiscarder(config),
        inFlight: "leave",
      }),
      onDiscardFailure: (tenant) => warn("tenant_staging_left", { tenant }),
      // The server mode makes no log.reconcile scratch database in this version (the operation is
      // not served on any host yet), so an opening has none to drop. Serving it needs a drop of
      // `<tenant>_reconcile` that the store's guard allows, given here.
      discardScratch: async () => {},
    });
    // Checked when the configuration was read: an entry not taken refuses it.
    const trusted = trustedProxies(config.trustedProxies);
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
        checkCredential: checkAudience(oauth, config.publicUrl),
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
    const api: Api = { ready: () => (serving ? ctx : undefined), log };
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
    const externalOrigin = new URL(config.publicUrl).origin;
    const allowed: ReadonlySet<string> = new Set(config.allowedOrigins);

    // The responses in progress, and whether closing has reached its step 2. A response finished on a
    // keep-alive connection after `server.close()` keeps that connection open until the keep-alive
    // timeout (Node 24: its header still says keep-alive; the connection closes 5 s later), which
    // would hold step 2 that long for each: from step 2 a response not yet begun says
    // `Connection: close`, and a finished one has its connection closed once it is idle.
    const inFlight = new Set<ServerResponse>();
    let draining = false;
    const server: Server = createServer((req, res) => {
      inFlight.add(res);
      if (draining) res.setHeader("connection", "close");
      res.on("finish", () => {
        if (draining) setImmediate(() => server.closeIdleConnections());
      });
      res.on("close", () => inFlight.delete(res));
      void (async () => {
        const path = new URL(req.url ?? "/", "http://local").pathname;
        if (req.method === "GET" && (path === "/health" || path === "/ready")) {
          const body = JSON.stringify({
            state,
            version: o.version,
            pid: process.pid,
            since,
            ...(lost ? { reason: "control_database_lost" } : {}),
          });
          res.writeHead(path === "/health" || state === "ready" ? 200 : 503, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "cache-control": "no-store",
          });
          res.end(body);
          return;
        }
        // Set first, so that every response on the path has them: writeHead adds its own to these.
        const cors = crossOriginPath(path) ? corsHeaders(req, allowed) : {};
        for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
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
        if (req.method === "OPTIONS" && cors["access-control-allow-origin"] !== undefined) {
          res.writeHead(204, PREFLIGHT_HEADERS);
          res.end();
          return;
        }
        if (!serving) {
          // On /v1/ the contract's error (05-surfaces §13): starting, or stopping (closing, past
          // its drain, or the control database lost, after which the server stops); elsewhere a
          // bare 503.
          if (path.startsWith("/v1/")) {
            sendError(
              req,
              res,
              new ContractError(
                "unavailable",
                `the server is ${state === "starting" ? "starting" : "stopping"}`,
                {
                  reason: state === "starting" ? "starting" : "stopping",
                  retry_after: 1,
                },
              ),
            );
            return;
          }
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
        if (path.startsWith("/v1/") || path === "/mcp") {
          // A listed origin's page calls /v1/, never /mcp.
          const refused = originGuard(req, externalOrigin, path === "/mcp" ? undefined : allowed);
          if (refused !== undefined) {
            res.writeHead(refused.status, refused.headers);
            res.end(refused.body);
            return;
          }
        }
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
    if (!lost) {
      state = "ready";
      serving = true;
    }
    const drainMs = o.testing?.drainMs ?? config.shutdown.drainSeconds * 1000;
    const timeoutMs = o.testing?.timeoutMs ?? config.shutdown.timeoutSeconds * 1000;
    const tenantsCloseMs = o.testing?.tenantsCloseMs ?? TENANTS_CLOSE_MS;
    // A second signal: the drain and the wait for the requests in progress end at once.
    const hurried = Promise.withResolvers<void>();
    /**
     * Runs `work` for at most `ms` (less once hurried, if `hurrying`): `true` if it ran out first.
     * The timer is cleared either way, so nothing is left to keep the process up.
     */
    const bounded = async (work: Promise<unknown>, ms: number, hurrying: boolean) => {
      let timer: NodeJS.Timeout | undefined;
      const out = new Promise<"out">((resolve) => {
        timer = setTimeout(() => resolve("out"), Math.max(0, ms));
        if (hurrying) void hurried.promise.then(() => resolve("out"));
      });
      try {
        return (await Promise.race([work.then(() => "done" as const), out])) === "out";
      } finally {
        clearTimeout(timer);
      }
    };
    let closing: Promise<void> | undefined;
    const close = async () => {
      // Step 1: out of the load balancer's rotation, still serving. A lost control database
      // serves nothing already: no drain.
      if (!lost) {
        state = "stopping";
        await bounded(new Promise<never>(() => {}), drainMs, true);
      }
      // Step 2: nothing new taken; the requests in progress, for at most the timeout.
      serving = false;
      draining = true;
      for (const res of inFlight) if (!res.headersSent) res.setHeader("connection", "close");
      // Before the requests in progress are waited for: an import still reading its body ends.
      for (const a of imports) a.abort();
      clearInterval(sweep);
      const ended = new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeIdleConnections();
      });
      if (await bounded(ended, timeoutMs, true)) {
        const open = await new Promise<number>((resolve) =>
          server.getConnections((e, n) => resolve(e ? 0 : n)),
        );
        if (open > 0) warn("shutdown_connections_cut", { connections: String(open) });
        server.closeAllConnections();
      }
      await ended;
      await mcp.handler.close();
      // Step 3: the tenants, for at most tenantsCloseMs: a use stuck on a tenant's lock is left.
      const tenantsClosed = lent.closeAll();
      if (await bounded(tenantsClosed, tenantsCloseMs, false)) {
        tenantsClosed.catch(() => {});
        warn("shutdown_tenants_left", {});
      }
      // A lost connection took the lock with it: there is nothing to release, and none to close.
      if (!lost) await releaseServerLock(db);
      await db.close().catch((e: unknown) => {
        if (!lost) throw e;
      });
    };
    return {
      address: { host: at.address, port: at.port },
      failed,
      close: () => {
        closing ??= close();
        return closing;
      },
      hurry: () => {
        if (closing !== undefined) hurried.resolve();
      },
    };
  } catch (e) {
    await pool?.closeAll().catch(() => {});
    await db.close().catch(() => {});
    throw e;
  }
}
