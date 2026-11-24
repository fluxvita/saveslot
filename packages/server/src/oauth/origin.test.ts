// The Origin guard of the server mode's `/mcp` and `/v1`, and the CORS of the origins a deployment
// lists (05-surfaces §13, §14), on requests as Node gives them.

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  allowedOrigin,
  corsHeaders,
  crossOriginPath,
  originGuard,
  PREFLIGHT_HEADERS,
} from "./origin.ts";

const EXT = "https://saveslot.example";
const CONSOLE = "https://console.example";
const LISTED: ReadonlySet<string> = new Set([CONSOLE]);
const req = (...rawHeaders: string[]) => ({ rawHeaders }) as unknown as IncomingMessage;

describe("Origin guard", () => {
  it("no Origin (a host calling from its server): goes on", () => {
    expect(originGuard(req("Host", "saveslot.example"), EXT)).toBeUndefined();
  });

  it("the external origin: goes on", () => {
    expect(originGuard(req("Origin", EXT), EXT)).toBeUndefined();
    expect(originGuard(req("origin", EXT), EXT)).toBeUndefined();
  });

  it.each([
    "https://evil.example",
    "http://saveslot.example",
    "https://saveslot.example:8443",
    "https://saveslot.example.evil.example",
    "null",
    "",
  ])("Origin %j: 403, plain text", (origin) => {
    expect(originGuard(req("Origin", origin), EXT)).toEqual({
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      body: "Requests from this origin are not taken.\n",
    });
  });

  it("Origin given twice, even both the external one: 403", () => {
    expect(originGuard(req("Origin", EXT, "Origin", EXT), EXT)?.status).toBe(403);
  });

  it("a listed origin goes on; one not listed, or given twice, is still 403", () => {
    expect(originGuard(req("Origin", CONSOLE), EXT, LISTED)).toBeUndefined();
    expect(originGuard(req("Origin", EXT), EXT, LISTED)).toBeUndefined();
    expect(originGuard(req("Origin", "https://evil.example"), EXT, LISTED)?.status).toBe(403);
    expect(originGuard(req("Origin", "https://Console.example"), EXT, LISTED)?.status).toBe(403);
    expect(originGuard(req("Origin", CONSOLE, "Origin", CONSOLE), EXT, LISTED)?.status).toBe(403);
    // Listed for nothing when not given: /mcp's.
    expect(originGuard(req("Origin", CONSOLE), EXT)?.status).toBe(403);
  });
});

describe("CORS of the listed origins", () => {
  it("the request's one Origin when listed, compared as written", () => {
    expect(allowedOrigin(req("origin", CONSOLE), LISTED)).toBe(CONSOLE);
    expect(allowedOrigin(req("Origin", `${CONSOLE}/`), LISTED)).toBeUndefined();
    expect(allowedOrigin(req("Origin", CONSOLE, "Origin", CONSOLE), LISTED)).toBeUndefined();
    expect(allowedOrigin(req("Host", "saveslot.example"), LISTED)).toBeUndefined();
  });

  it.each([
    ["/v1/slots", true],
    ["/v1/writes", true],
    ["/oauth/token", true],
    ["/oauth/revoke", true],
    ["/mcp", false],
    ["/v1", false],
    ["/oauth/device", false],
    ["/oauth/authorize", false],
    ["/oauth/token/x", false],
    ["/account/login", false],
  ])("%s covered: %s", (path, covered) => {
    expect(crossOriginPath(path)).toBe(covered);
  });

  it("Vary on every answer while an origin is listed, the origin when it is; none allows credentials", () => {
    expect(corsHeaders(req("Origin", CONSOLE), LISTED)).toEqual({
      "access-control-allow-origin": CONSOLE,
      vary: "Origin",
      "access-control-expose-headers": "Retry-After, WWW-Authenticate",
    });
    expect(corsHeaders(req("Origin", "https://evil.example"), LISTED)).toEqual({ vary: "Origin" });
    expect(corsHeaders(req("Host", "saveslot.example"), LISTED)).toEqual({ vary: "Origin" });
    // None listed: the answers are as they were.
    expect(corsHeaders(req("Origin", CONSOLE), new Set())).toEqual({});
    expect(Object.keys(PREFLIGHT_HEADERS)).not.toContain("access-control-allow-credentials");
  });
});
