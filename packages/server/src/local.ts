// The local listener: HTTP on a unix domain socket (docs/zh-CN/spec/06-cli.md §2 «CLI 怎么连
// saveslot», §8.1). `GET /health` is the only route that takes no token (06 §8.1): it involves no
// principal and no data, and is what `saveslot start` compares versions with and `saveslot mcp`
// checks the service is up with. `/v1/…` goes to the HTTP adapter (`api.ts`) and `/mcp` to the MCP
// adapter (`mcp/handler.ts`), when the service is given. Every other request gets 404 with no body.
//
// The socket file is made 0600 at once; its directory is the caller's (0700).

import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type Api, handleApi } from "./api.ts";
import { createMcpAdapter, handleMcp } from "./mcp/handler.ts";

/** The body of `GET /health`: no paths, no user data. */
export interface HealthBody {
  readonly state: "starting" | "ready" | "stopping" | "failed";
  readonly version: string;
  readonly pid: number;
  /** When the process started, RFC 3339 UTC. */
  readonly since: string;
  /** With `failed`: a stable code. */
  readonly reason?: string;
  /**
   * The home's single-writer lock: held by the answering process, which takes it before it listens
   * (02-architecture §7). Given by the local service.
   */
  readonly writer_lock?: "held";
  /**
   * Whether the answering process runs with V8's baseline compiler only (the local service's
   * `service.low_memory`, 06 §4.2): read off its own Node options. Given by the local service.
   */
  readonly low_memory?: boolean;
  /**
   * The test clock (02-architecture §11 «评测对实现的要求»), only when the service was started with
   * one: its current moment and the moment it started at. Never present in normal operation.
   */
  readonly eval_clock?: { readonly now: string; readonly started_at: string };
  /**
   * The upgrade of the store's storage format at the start (02-architecture §8
   * «格式版本、导出、导入与恢复»): while it runs (`starting`), and when it failed (`failed`,
   * `upgrade_failed`). The formats it goes from and to, and the step it is on or failed at, as
   * `5->6` (none yet before the first). No paths, no user data.
   */
  readonly upgrade?: { readonly from: number; readonly to: number; readonly step?: string };
}

export interface LocalListener {
  /** Stops accepting connections and closes idle ones; resolves when every connection is closed. */
  close(): Promise<void>;
}

export async function listenLocal(o: {
  readonly socketPath: string;
  readonly health: () => HealthBody;
  /** The service, for the HTTP adapter (`/v1/…`) and the MCP adapter (`/mcp`). */
  readonly api?: Api;
}): Promise<LocalListener> {
  const mcp = createMcpAdapter({ version: () => o.health().version });
  const server: Server = createServer((req, res) => {
    if (o.api !== undefined && handleApi(o.api, req, res)) return;
    if (o.api !== undefined && handleMcp(mcp, o.api, req, res)) return;
    // The path alone decides; a query string is not part of the route.
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      const body = JSON.stringify(o.health());
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-length": 0 });
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(o.socketPath, 0o600);
  return {
    close: async () => {
      await mcp.handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}
