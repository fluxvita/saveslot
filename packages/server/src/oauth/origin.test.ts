// The Origin guard of the server mode's `/mcp` and `/v1`, on requests as Node gives them.

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { originGuard } from "./origin.ts";

const EXT = "https://saveslot.example";
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
});
