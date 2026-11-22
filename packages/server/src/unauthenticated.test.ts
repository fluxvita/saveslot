// The 401's challenge (05-surfaces §14; RFC 6750 §3.1, RFC 9728 §5.1): a missing credential gets the
// scheme; any other reason, a reason added later included, `error="invalid_token"`; in the server
// mode every 401 says where the resource's metadata is, on HTTP and on /mcp alike; locally none.

import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthFailure, CallerResolver } from "@fluxvita/saveslot-service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiContext, unauthenticatedChallenge } from "./api.ts";
import { type LocalListener, listenLocal } from "./local.ts";

const META = "https://saveslot.example/.well-known/oauth-protected-resource";

describe("the 401's challenge", () => {
  it.each([
    ["missing", "Bearer", `Bearer resource_metadata="${META}"`],
    [
      "invalid",
      'Bearer error="invalid_token"',
      `Bearer error="invalid_token", resource_metadata="${META}"`,
    ],
    [
      "revoked",
      'Bearer error="invalid_token"',
      `Bearer error="invalid_token", resource_metadata="${META}"`,
    ],
    [
      "expired",
      'Bearer error="invalid_token"',
      `Bearer error="invalid_token", resource_metadata="${META}"`,
    ],
    // A reason the challenge was not written for is a token that is not good too.
    [
      "account_disabled",
      'Bearer error="invalid_token"',
      `Bearer error="invalid_token", resource_metadata="${META}"`,
    ],
  ])("%s: locally %s; in the server mode %s", (reason, local, server) => {
    const failure = { code: "unauthenticated", reason } as AuthFailure;
    expect(unauthenticatedChallenge(failure)).toBe(local);
    expect(unauthenticatedChallenge(failure, META)).toBe(server);
  });
});

describe("the metadata's URL in the challenge", () => {
  it("is a quoted string: a quote or a backslash in it is escaped (RFC 7230 §3.2.6)", () => {
    const failure = { code: "unauthenticated", reason: "missing" } as AuthFailure;
    expect(unauthenticatedChallenge(failure, 'https://saveslot.example/a"b\\c')).toBe(
      'Bearer resource_metadata="https://saveslot.example/a\\"b\\\\c"',
    );
  });
});

describe("the 401 on HTTP and on /mcp in the server mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "saveslot-401-"));
  const socketPath = join(dir, "s.sock");
  let listener: LocalListener;
  const callers: CallerResolver = {
    resolve: async (authorization) =>
      authorization === undefined
        ? { code: "unauthenticated", reason: "missing" }
        : { code: "unauthenticated", reason: "expired" },
  };

  const call = (path: string, method: string, token?: string) =>
    new Promise<{ status: number; challenge: unknown }>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method,
          path,
          headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, challenge: res.headers["www-authenticate"] }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    listener = await listenLocal({
      socketPath,
      health: () => ({ state: "ready", version: "t", pid: 1, since: "2026-11-21T00:00:00.000Z" }),
      api: {
        ready: () =>
          ({
            callers,
            resourceMetadata: META,
            cursors: undefined as never,
            windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
            now: () => "2026-11-21T00:00:00.000Z",
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

  it.each([
    ["/v1/log/end", "GET"],
    ["/mcp", "POST"],
  ])("%s: the metadata's URL, missing or not good", async (path, method) => {
    expect(await call(path, method)).toEqual({
      status: 401,
      challenge: `Bearer resource_metadata="${META}"`,
    });
    expect(await call(path, method, "old")).toEqual({
      status: 401,
      challenge: `Bearer error="invalid_token", resource_metadata="${META}"`,
    });
  });
});
