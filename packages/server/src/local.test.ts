// listenLocal: GET /health is the one route (06-cli §8.1); everything else is 404 with no body; the
// socket file is 0600.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LocalListener, listenLocal } from "./local.ts";

const dir = mkdtempSync(join(tmpdir(), "saveslot-server-"));
const socketPath = join(dir, "s.sock");
let listener: LocalListener;

function call(
  method: string,
  path: string,
): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          ...(res.headers["content-type"] !== undefined
            ? { type: res.headers["content-type"] }
            : {}),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  listener = await listenLocal({
    socketPath,
    health: () => ({
      state: "ready",
      version: "1.2.3",
      pid: 42,
      since: "2026-11-14T00:00:00.000Z",
    }),
  });
});

afterAll(async () => {
  await listener.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the local listener", () => {
  it("answers GET /health with the health body, as JSON", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.type).toBe("application/json");
    expect(JSON.parse(r.body)).toEqual({
      state: "ready",
      version: "1.2.3",
      pid: 42,
      since: "2026-11-14T00:00:00.000Z",
    });
    expect((await call("GET", "/health?x=1")).status).toBe(200);
  });

  it.each([
    ["GET", "/"],
    ["GET", "/health/"],
    ["GET", "/Health"],
    ["GET", "/v1/catalog"],
    ["GET", "/mcp"],
    ["POST", "/health"],
    ["HEAD", "/v1/catalog"],
  ])("answers %s %s with 404 and no body", async (method, path) => {
    const r = await call(method, path);
    expect(r).toEqual({ status: 404, body: "" });
  });

  it("makes the socket file 0600", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });
});

describe("the local listener, its service not ready (04-contract «unavailable»)", () => {
  const at = join(dir, "n.sock");
  function get(path: string): Promise<{ status: number; body: string; retryAfter?: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: at, method: "GET", path }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            ...(res.headers["retry-after"] !== undefined
              ? { retryAfter: String(res.headers["retry-after"]) }
              : {}),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }
  it.each([
    [{ reason: "stopping", retryAfter: 1 } as const, "stopping", "1"],
    [{ reason: "stopping" } as const, "stopping", undefined],
    [{ reason: "starting" } as const, "starting", undefined],
    [undefined, "starting", undefined],
  ])("%j: 503 unavailable with reason %s", async (why, reason, retryAfter) => {
    const l = await listenLocal({
      socketPath: at,
      health: () => ({
        state: "starting",
        version: "1.2.3",
        pid: 42,
        since: "2026-11-14T00:00:00.000Z",
      }),
      api: {
        ready: () => undefined,
        ...(why !== undefined ? { notReady: () => why } : {}),
        log: () => {},
      },
    });
    try {
      const r = await get("/v1/slots");
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toMatchObject({ code: "unavailable", reason });
      expect(r.retryAfter).toBe(retryAfter);
      expect(JSON.parse(r.body).error["retry_after"]).toBe(
        retryAfter === undefined ? undefined : Number(retryAfter),
      );
    } finally {
      await l.close();
    }
  });
});
