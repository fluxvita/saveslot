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
