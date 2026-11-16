// The local listener: HTTP on a unix domain socket (docs/zh-CN/spec/06-cli.md §2 «CLI 怎么连
// saveslot», §8.1). `GET /health` is the only route that takes no token (06 §8.1): it involves no
// principal and no data, and is what `saveslot start` compares versions with and `saveslot mcp`
// checks the service is up with. `/v1/…` goes to the HTTP adapter (`api.ts`), when given. Every
// other request gets 404 with no body. The MCP adapter mounts here later.
//
// The socket file is made 0600 at once; its directory is the caller's (0700).

import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type Api, handleApi } from "./api.ts";

/** The body of `GET /health`: no paths, no user data. */
export interface HealthBody {
  readonly state: "starting" | "ready" | "stopping" | "failed";
  readonly version: string;
  readonly pid: number;
  /** When the process started, RFC 3339 UTC. */
  readonly since: string;
  /** With `failed`: a stable code. */
  readonly reason?: string;
}

export interface LocalListener {
  /** Stops accepting connections and closes idle ones; resolves when every connection is closed. */
  close(): Promise<void>;
}

export async function listenLocal(o: {
  readonly socketPath: string;
  readonly health: () => HealthBody;
  /** The HTTP adapter for `/v1/…`. */
  readonly api?: Api;
}): Promise<LocalListener> {
  const server: Server = createServer((req, res) => {
    if (o.api !== undefined && handleApi(o.api, req, res)) return;
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
