// `saveslot login` through the executable, against a stand-in authorization server on loopback
// HTTP: the process ends once the sign-in is written (06-cli §4.2). The sign-in's own cases are the
// cli package's (login.test.ts).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

let root: string;
let server: Server;
let origin = "";
let polled = 0;

const json = (res: ServerResponse, status: number, v: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "saveslot-login-bin-"));
  mkdirSync(join(root, "home"), { mode: 0o700 });
  polled = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/.well-known/oauth-authorization-server") json(res, 200, { issuer: origin });
      else if (path === "/oauth/device") {
        json(res, 200, {
          device_code: "dc-1",
          user_code: "BCDF-GHJK",
          verification_uri: `${origin}/oauth/device/verify`,
          expires_in: 600,
          interval: 1,
        });
      } else if (path === "/oauth/token") {
        if (polled++ === 0) json(res, 400, { error: "authorization_pending" });
        else {
          json(res, 200, {
            access_token: `sls_${"a".repeat(43)}`,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: `slr_${"r".repeat(43)}`,
          });
        }
      } else json(res, 404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe("saveslot login", () => {
  it("--device: the process ends once the sign-in is written", async () => {
    const home = join(root, "home");
    const p = spawn(
      process.execPath,
      [
        "--conditions=source",
        BIN,
        "login",
        "--device",
        "--server",
        origin,
        "--profile",
        "lab",
        "--home",
        home,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "" } },
    );
    let err = "";
    p.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    // Two polls a second apart, then the end; still running after 8 s: killed, and no exit code.
    const timer = setTimeout(() => p.kill(), 8_000);
    const code = await new Promise<number | null>((r) => p.on("close", (c) => r(c)));
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(err).toContain("BCDF-GHJK");
    expect(existsSync(join(home, "credentials", "lab.json"))).toBe(true);
  }, 30_000);
});
