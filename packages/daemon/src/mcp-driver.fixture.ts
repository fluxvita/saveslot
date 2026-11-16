// The MCP adapter as the contract suite's driver: the official client over the service's socket,
// speaking either protocol era, calling an operation's tool (05-surfaces §1) and reading the
// outcome from `structuredContent` (05 §3). A refusal at the transport (401, 403: 05 §1, §3) is
// read from the response's body, the contract's error as on HTTP.

import { request } from "node:http";
import { TOOLS } from "@fluxvita/saveslot-server";
import type { Operation } from "@fluxvita/saveslot-service";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Driver, Outcome } from "./contract-suite.fixture.ts";
import { socketFile } from "./service.ts";

/** The protocol era a client speaks: 2025-11-25 by `initialize`, 2026-07-28 by `server/discover`. */
export type Era = "legacy" | "modern";

/** The operations MCP has a tool for. */
export const MCP_OPERATIONS: ReadonlySet<Operation> = new Set(TOOLS.map((t) => t.operation));

interface Sent {
  readonly status: number;
  readonly body: string;
}

/** A fetch on the socket of the service in `home`, with `credential` as the bearer token. */
export function socketFetch(
  home: string,
  credential: string,
  seen: (r: Sent) => void = () => {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.body === null ? undefined : Buffer.from(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    if (credential !== "") headers["authorization"] = `Bearer ${credential}`;
    return new Promise<Response>((resolve, reject) => {
      const r = request(
        {
          socketPath: socketFile(home),
          method: req.method,
          path: new URL(req.url).pathname,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            seen({ status, body: text });
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") h.set(k, v);
            }
            const empty = status === 202 || status === 204 || status === 304;
            resolve(new Response(empty ? null : text, { status, headers: h }));
          });
        },
      );
      r.on("error", reject);
      if (body !== undefined) r.write(body);
      r.end();
    });
  }) as typeof fetch;
}

/** A client of the service in `home`, connected as `credential` in `era`. */
export async function mcpClient(
  home: string,
  credential: string,
  era: Era,
  seen?: (r: Sent) => void,
): Promise<Client> {
  const client = new Client(
    { name: "saveslot-tests", version: "0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://local/mcp"), {
      fetch: socketFetch(home, credential, seen),
    }),
  );
  return client;
}

const toolOf = (operation: Operation) => {
  const tool = TOOLS.find((t) => t.operation === operation);
  if (tool === undefined) throw new Error(`no tool for ${operation}`);
  return tool.name;
};

/** The contract's operations over MCP, on the service in `home()`. */
export const mcpDriver =
  (home: () => string, era: Era): Driver =>
  async (credential, operation, params, o = {}) => {
    let last: Sent | undefined;
    const refused = (): Outcome | undefined => {
      if (last === undefined || (last.status !== 401 && last.status !== 403)) return undefined;
      const { message: _, ...error } = (JSON.parse(last.body) as { error: Record<string, unknown> })
        .error;
      return { error } as Outcome;
    };
    let client: Client | undefined;
    try {
      client = await mcpClient(home(), credential, era, (r) => {
        last = r;
      });
      const r = await client.callTool({
        name: toolOf(operation),
        arguments: {
          ...params,
          ...(o.task !== undefined ? { task: o.task } : {}),
          ...(o.idempotencyKey !== undefined ? { idempotency_key: o.idempotencyKey } : {}),
        },
      });
      const content = r.structuredContent as Record<string, unknown>;
      if (r.isError === true) {
        const { message: _, ...error } = content["error"] as Record<string, unknown>;
        return { error } as Outcome;
      }
      return { result: content };
    } catch (e) {
      const outcome = refused();
      if (outcome !== undefined) return outcome;
      throw e;
    } finally {
      await client?.close().catch(() => {});
    }
  };
