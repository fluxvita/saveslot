// The per-tenant limit on the surfaces (02-architecture §5 «限流与配额»; 05-surfaces §3, §14): on
// HTTP a request over the limit is 429 `rate_limited` with `Retry-After`, refused before its
// tenant is lent; on MCP a tool call over it is the tool's error, in text; another tenant goes on;
// with no limit, nothing is refused. The callers are a stand-in that counts the tenants it lends,
// and lends one with no storage: a call refused by the limit never reaches it.

import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallerResolver, type Principal, TenantRateLimiter } from "@fluxvita/saveslot-service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiContext } from "./api.ts";
import { type LocalListener, listenLocal } from "./local.ts";

const dir = mkdtempSync(join(tmpdir(), "saveslot-rate-"));
const socketPath = join(dir, "s.sock");
let listener: LocalListener;
let now = 0;
let limit: TenantRateLimiter | undefined;
let lent = 0;

/** A token names its tenant: `t-<tenant>`. */
const callers: CallerResolver = {
  async resolve(authorization) {
    const m = /^Bearer t-(tn_[a-z]+)$/.exec(authorization ?? "");
    if (m === null) return { code: "unauthenticated", reason: "invalid" };
    const principal: Principal = {
      kind: "user",
      actor: `u_${"1".repeat(26)}`,
      scopes: ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"],
      visibility: { kind: "all" },
    };
    return {
      principal,
      tenant: m[1] as `tn_${string}`,
      use: async (fn) => {
        lent++;
        return fn({
          tenant: m[1] as `tn_${string}`,
          store: undefined as never,
          connections: undefined as never,
        });
      },
    };
  },
};

function call(o: {
  path: string;
  method?: string;
  token: string;
  body?: unknown;
}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: o.method ?? "GET",
        path: o.path,
        headers: {
          authorization: `Bearer ${o.token}`,
          ...(o.body !== undefined
            ? {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2025-11-25",
              }
            : {}),
        },
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
    if (o.body !== undefined) req.write(JSON.stringify(o.body));
    req.end();
  });
}

beforeAll(async () => {
  listener = await listenLocal({
    socketPath,
    health: () => ({ state: "ready", version: "t", pid: 1, since: "2026-11-20T00:00:00.000Z" }),
    api: {
      ready: () =>
        ({
          callers,
          ...(limit !== undefined ? { rateLimit: limit } : {}),
          cursors: undefined as never,
          windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
          now: () => "2026-11-20T00:00:00.000Z",
          warn: () => {},
        }) satisfies ApiContext,
      log: () => {},
    },
  });
});

afterAll(async () => {
  await listener.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the per-tenant limit on HTTP", () => {
  it("over the limit: 429 rate_limited with Retry-After, refused before the tenant is lent", async () => {
    now = 0;
    limit = new TenantRateLimiter(2, 2, () => now);
    lent = 0;
    // Under the limit, a request goes on to the router: no such route, 404.
    for (let i = 0; i < 2; i++) {
      expect((await call({ path: "/v1/nowhere", token: "t-tn_a" })).status).toBe(404);
    }
    const r = await call({ path: "/v1/log/end", token: "t-tn_a" });
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("30");
    expect(JSON.parse(r.body)).toEqual({
      error: {
        code: "rate_limited",
        message: "too many requests for this tenant",
        reason: "quota",
        retry_after: 30,
      },
    });
    expect(lent).toBe(0);
    // Another tenant goes on.
    expect((await call({ path: "/v1/nowhere", token: "t-tn_b" })).status).toBe(404);
    // Once a request's worth has come back, the tenant goes on too.
    now = 30_000;
    expect((await call({ path: "/v1/nowhere", token: "t-tn_a" })).status).toBe(404);
  });

  it("a request that is not authenticated is not counted", async () => {
    limit = new TenantRateLimiter(1, 1, () => 0);
    expect((await call({ path: "/v1/nowhere", token: "nobody" })).status).toBe(401);
    expect(limit.size).toBe(0);
  });

  it("with no limit, nothing is refused", async () => {
    limit = undefined;
    for (let i = 0; i < 20; i++) {
      expect((await call({ path: "/v1/nowhere", token: "t-tn_a" })).status).toBe(404);
    }
  });
});

describe("the per-tenant limit on MCP", () => {
  const toolCall = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "saveslot_catalog", arguments: {} },
  });

  it("a tool call over the limit is the tool's error, saying how long to wait", async () => {
    limit = new TenantRateLimiter(1, 1, () => 0);
    limit.take("tn_a");
    const r = await call({ path: "/mcp", method: "POST", token: "t-tn_a", body: toolCall(1) });
    // The tool's error, not the transport's.
    expect(r.status).toBe(200);
    // The response is one server-sent event: its data is the JSON-RPC message.
    const data = r.body
      .split("\n")
      .find((l) => l.startsWith("data: "))
      ?.slice("data: ".length);
    const result = (
      JSON.parse(data ?? "") as { result: { isError: boolean; content: { text: string }[] } }
    ).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rate_limited");
    expect(result.content[0]?.text).toContain("try again in 60 s.");
  });
});
