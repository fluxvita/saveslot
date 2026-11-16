// The MCP adapter (docs/zh-CN/spec/05-surfaces.md §1–§3, §11): `/mcp`, Streamable HTTP, the
// official SDK serving both protocol eras (2025-11-25 by `initialize`, 2026-07-28 by
// `server/discover`), stateless: every request is served by a server built for it alone, so
// nothing a request does is carried to the next, and no request relies on an earlier one.
//
// For a request to `/mcp`, in this order, before anything reaches the SDK:
//   1. the service not ready: 503 `unavailable` (`starting`);
//   2. the credential: none or not good, 401 `unauthenticated` with `WWW-Authenticate`, as on HTTP;
//   3. the body (POST): at most 1 MiB, cut off past the limit (413 `too_large`);
//   4. a `tools/call` of a tool the credential has no scope for: 403 with
//      `WWW-Authenticate: Bearer error="insufficient_scope", scope="<scope>"` (05 §1 «越权怎么报»).
// Then the SDK, with a server whose tool list is the credential's (05 §1 «工具列表按 scope 裁剪»).
// The SDK sees no `Authorization` header: the credential reaches the tools as the principal it
// was authenticated as.
//
// Logged per request: method, route `mcp`, the tool of a `tools/call` when it is one of the
// tools, status, milliseconds. Never a header, a parameter, a request body or a result.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authenticate,
  ContractError,
  contractError,
  kernelCall,
  type Principal,
  runOperation,
} from "@fluxvita/saveslot-service";
import {
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import {
  type Api,
  type ApiContext,
  errorBody,
  header,
  readBytes,
  send,
  sendError,
} from "../api.ts";
import { HTTP_STATUS } from "../status.ts";
import { BUDGET, budgetFor, plain } from "./budget.ts";
import { renderError, renderResult } from "./render.ts";
import { describe, TOOLS, type Tool, type ToolName, toolsFor } from "./tools.ts";

/** How long a `server/discover` result may be cached (05 §11; 08-open-questions). */
const DISCOVER_TTL_MS = 5 * 60_000;

/** The request headers the SDK is given: the protocol's own. */
const PASSED = /^(content-type|accept|last-event-id|mcp-[a-z-]+)$/;

/** The headers of a request as the SDK is given them: the protocol's own, never the credential. */
export function sdkHeaders(headers: IncomingMessage["headers"]): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (PASSED.test(k) && typeof v === "string") out.set(k, v);
  }
  return out;
}

/** What a server built for one request is built from (the SDK's `authInfo.extra`). */
interface Caller {
  readonly principal: Principal;
  readonly ctx: ApiContext;
}

export interface McpAdapter {
  readonly handler: McpHttpHandler;
}

export function createMcpAdapter(o: { readonly version: () => string }): McpAdapter {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.["caller"] as Caller | undefined;
      // Unreachable: every request is authenticated before the SDK sees it.
      if (caller === undefined) throw new Error("an MCP request reached the SDK unauthenticated");
      return serverFor(caller, o.version());
    },
    { responseMode: "json" },
  );
  return { handler };
}

/**
 * The server one request is served by: the tools of its credential, and no other. This is what
 * keeps a credential to its tools. `missingScope` reads the same body before the SDK does, but only
 * to choose between a 403 and the protocol's error: should the two ever read a body differently, a
 * tool outside the credential's list is still no tool here, and is never run. So this registers
 * only the credential's tools, never all of them behind that check.
 */
function serverFor(caller: Caller, version: string): Server {
  const listed = toolsFor(caller.principal);
  const names = new Set<ToolName>(listed.map((t) => t.name));
  const server = new Server(
    { name: "saveslot", version },
    {
      // The tool list of a credential does not change while it is used (05 §1).
      capabilities: { tools: { listChanged: false } },
      // What a credential is listed is its own: never cached across credentials (05 §11).
      cacheHints: {
        "server/discover": { ttlMs: DISCOVER_TTL_MS, cacheScope: "private" },
        "tools/list": { cacheScope: "private" },
      },
    },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: listed.map((t) => describe(t, names)),
  }));
  server.setRequestHandler("tools/call", async (request) => {
    const tool = listed.find((t) => t.name === request.params.name);
    if (tool === undefined) {
      // A tool that exists but is not this credential's is answered with 403 before the SDK;
      // here a name is no tool at all: the protocol's error, not the contract's (05 §3).
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool");
    }
    return call(caller, tool, request.params.arguments ?? {});
  });
  return server;
}

/** Calls the tool's operation: the result, or the contract's error as an error result. */
async function call(
  { principal, ctx }: Caller,
  tool: Tool,
  args: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  const { operation } = tool;
  try {
    // What MCP does not expose (05 §2) is refused here: the operation itself would take it.
    const withheld =
      Object.keys(args).find((k) => Object.hasOwn(tool.withheld, k)) ?? tool.refuse?.(args);
    if (withheld !== undefined) {
      throw new ContractError("invalid_argument", "not a parameter of this tool", {
        reason: "malformed",
        param: withheld,
      });
    }
    // As on HTTP, the key goes with the call, not in the parameters; an operation that takes
    // none (a read) refuses it.
    const { task, idempotency_key: idempotencyKey, ...params } = args;
    for (const [param, v] of [
      ["task", task],
      ["idempotency_key", idempotencyKey],
    ] as const) {
      if (v !== undefined && typeof v !== "string") {
        throw new ContractError("invalid_argument", `${param} is a string`, {
          reason: "malformed",
          param,
        });
      }
    }
    // Within the result budget (05 §3): a read is kept to what fits, and recorded so.
    const budget = budgetFor(tool.name, BUDGET);
    const run = async (body: Record<string, unknown>) =>
      (await runOperation({
        tenant: ctx.tenant,
        credentials: ctx.credentials,
        cursors: ctx.cursors,
        operation,
        call: kernelCall({
          principal,
          tenant: ctx.tenant,
          operation,
          body,
          ...(typeof task === "string" ? { task } : {}),
          ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
          now: ctx.now(),
          windows: ctx.windows,
          cursors: ctx.cursors,
        }),
        warn: ctx.warn,
        fit: budget.fit,
      })) as Record<string, unknown>;
    // Plain JSON from here on: the text and structuredContent are of the same plain value.
    const result = budget.finish(plain(await run(params)));
    return {
      content: [{ type: "text", text: renderResult(tool.name, result) }],
      structuredContent: result,
    };
  } catch (e) {
    const x = contractError(e, ctx.warn);
    const error = errorBody(x);
    return {
      isError: true,
      content: [{ type: "text", text: renderError(error) }],
      structuredContent: { error },
    };
  }
}

/**
 * The scope a `tools/call` in `body` needs and `principal` does not have, if any: a call of a
 * tool that exists but is not in the credential's list (05 §1 «越权怎么报»).
 */
export function missingScope(body: unknown, principal: Principal): string | undefined {
  for (const m of Array.isArray(body) ? body : [body]) {
    if (m === null || typeof m !== "object") continue;
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    if (method !== "tools/call") continue;
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (tool !== undefined && !principal.scopes.includes(tool.scope)) return tool.scope;
  }
  return undefined;
}

/** Handles `req` when it is a request to `/mcp`: true when it did. */
export function handleMcp(
  adapter: McpAdapter,
  api: Api,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if ((req.url ?? "").split("?")[0] !== "/mcp") return false;
  const started = Date.now();
  let tool: string | undefined;
  const finish = (status: number) =>
    api.log({
      method: req.method ?? "",
      route: "mcp",
      ...(tool !== undefined ? { tool } : {}),
      status,
      ms: Date.now() - started,
    });

  void (async () => {
    const ctx = api.ready();
    if (ctx === undefined) {
      finish(
        sendError(
          req,
          res,
          new ContractError("unavailable", "the service is starting", { reason: "starting" }),
        ),
      );
      return;
    }
    try {
      const who = await authenticate({
        credentials: ctx.credentials,
        tenant: ctx.tenant,
        authorization: header(req, "authorization"),
      });
      if (!("kind" in who)) {
        const status = HTTP_STATUS.unauthenticated;
        send(
          req,
          res,
          status,
          { error: { code: who.code, message: "the credential is not good", reason: who.reason } },
          {
            "www-authenticate":
              who.reason === "missing" ? "Bearer" : 'Bearer error="invalid_token"',
          },
        );
        finish(status);
        return;
      }
      const bytes = req.method === "POST" ? await readBytes(req) : undefined;
      let parsed: unknown;
      if (bytes !== undefined) {
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          // Not JSON: the SDK answers it with the protocol's parse error.
        }
      }
      const called = (Array.isArray(parsed) ? parsed : [parsed]).find(
        (m) => (m as { method?: unknown } | undefined)?.method === "tools/call",
      ) as { params?: { name?: unknown } } | undefined;
      tool = TOOLS.find((t) => t.name === called?.params?.name)?.name;
      const scope = missingScope(parsed, who);
      if (scope !== undefined) {
        const status = HTTP_STATUS.insufficient_scope;
        send(
          req,
          res,
          status,
          {
            error: {
              code: "insufficient_scope",
              message: "the credential may not call this tool",
              required_scope: scope,
            },
          },
          { "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"` },
        );
        finish(status);
        return;
      }
      const headers = sdkHeaders(req.headers);
      const response = await adapter.handler.fetch(
        new Request("http://local/mcp", {
          method: req.method ?? "GET",
          headers,
          ...(bytes !== undefined ? { body: new Uint8Array(bytes) } : {}),
        }),
        {
          authInfo: {
            token: "",
            clientId: who.actor,
            scopes: [...who.scopes],
            extra: { caller: { principal: who, ctx } satisfies Caller },
          },
          ...(parsed !== undefined ? { parsedBody: parsed } : {}),
        },
      );
      const out: Record<string, string> = { "cache-control": "no-store" };
      response.headers.forEach((v, k) => {
        out[k] = v;
      });
      res.writeHead(response.status, out);
      if (response.body !== null) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
      finish(response.status);
    } catch (e) {
      finish(sendError(req, res, contractError(e, ctx.warn)));
    }
  })();
  return true;
}
